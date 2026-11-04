/**
 * #2195 V1 Web の AI 相談の成功で、開いているページのデータを取り直す
 *
 * 問題 (直す前):
 *   - Web の AI 相談 (src/components/AIChatBubble.tsx) は、献立の作成・変更・買い物リストへの追加などが成功すると window に
 *     'mealPlanUpdated' を投げるが、受け取るページが 1 つも無かった。チャットには『✅ …を実行しました！』が出るのに、
 *     開いている献立表などは古い表示のまま (自分で読み込み直すまで) だった
 *
 * 直したあと:
 *   - データを出すページ (献立表・ホーム・比較・冷蔵庫・健康・健康目標・マイページ・栄養目標の根拠・食事の詳細・連続記録・
 *     健康のグラフ・バッジ) は useAiConsultationDataRefetch でこの通知を受け、ページの既存の取得をもう一度呼ぶ (ページ全体の reload はしない)
 *   - 入力の部品・開いているモーダルがページにある間は取り直さない。ただし AI 相談の吹き出しの中 (MainLayout が
 *     data-ai-consultation-chat-root で包む) は数えない (吹き出しは送信の入力欄を持ったまま成功を知らせるため)
 *   - 入力欄がいつも出ている部品 (栄養目標の再設定) は、入力欄の値が取得した値のままの間だけ data-ai-consultation-unedited-inputs で
 *     包み、その中の入力の部品は数えない (付けないとページが一度も取り直せない。入力欄を変えたら印を外して止める)
 *   - 受け手のページのモーダルは role="dialog" を持つ (中に入力の部品が無い状態 — マイページの編集の競技タブなど — でも止めるため)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { readFileSync } from 'node:fs';
import type {
  AiConsultationFetchStream,
  AiConsultationFetchStreamOrder,
  AiConsultationFetchTicket,
  AiConsultationLoadingState,
  AiConsultationPendingWrites,
  AiConsultationRefetchControl,
  AiConsultationWriteInFlightRef,
} from '@/hooks/useAiConsultationDataRefetch';
import path from 'node:path';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/home',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
// 冷蔵庫のページの同意の状況の取得 (AI の入口) はこの検査に関係しないので止める
vi.mock('@/hooks/useAiConsent', () => ({
  useAiConsent: () => ({ ensureAiConsent: vi.fn(async () => 'consented'), consentModal: null }),
}));
// MainLayout の部品のうち、この検査に関係しないものを止める
vi.mock('@/components/icons', () => ({ Icons: new Proxy({}, { get: () => () => null }) }));
vi.mock('@/components/native-app/NativeAppTabRouter', () => ({ NativeAppTabRouter: () => null }));
vi.mock('@/components/native-app/NativeSessionWatcher', () => ({ NativeSessionWatcher: () => null }));
// 吹き出しは、送信の入力欄とモーダルを持つ素の部品に差し替える (MainLayout が印の要素で包むかを見る)
vi.mock('@/components/AIChatBubble', () => ({
  default: () => (
    <div data-testid="fake-ai-chat-bubble">
      <input type="text" data-testid="fake-ai-chat-input" />
      <div role="dialog" aria-modal="true">1日献立変更</div>
    </div>
  ),
}));
/** Supabase のモックの状態。既定はログインしていない (user: null)。マイページの検査だけがログインした人と行を入れる */
const supabaseMock = vi.hoisted(() => ({
  user: null as { id: string } | null,
  profileRow: null as Record<string, unknown> | null,
  /** user_profiles を 1 行読んだ回数 (マイページの取得の回数) */
  profileReads: 0,
}));
vi.mock('@/lib/supabase/client', () => {
  const readProfile = async (table: string) => {
    if (table === 'user_profiles') supabaseMock.profileReads += 1;
    return { data: supabaseMock.profileRow, error: null };
  };
  const channel = {
    on: () => channel,
    subscribe: () => channel,
  };
  return {
    createClient: () => ({
      auth: {
        getUser: async () => ({ data: { user: supabaseMock.user }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      },
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            single: () => readProfile(table),
            maybeSingle: () => readProfile(table),
          }),
        }),
      }),
      // 健康のグラフの Realtime の購読 (この検査では何も届かない)
      channel: () => channel,
      removeChannel: async () => 'ok',
    }),
  };
});

const {
  AI_CONSULTATION_CHAT_ROOT_ATTRIBUTE,
  AI_CONSULTATION_DATA_CHANGED_EVENT,
  AI_CONSULTATION_REFETCH_BLOCKING_SELECTOR,
  AI_CONSULTATION_REFETCH_INPUT_SELECTOR,
  AI_CONSULTATION_REFETCH_MODAL_SELECTOR,
  AI_CONSULTATION_UNEDITED_INPUTS_ATTRIBUTE,
  isAiConsultationRefetchBlocked,
} = await import('@/lib/ai/consultation-data-refetch');
const {
  useAiConsultationDataRefetch,
  useAiConsultationFetchStream,
  useAiConsultationLoading,
  useAiConsultationPendingWrites,
  useAiConsultationRefetchKey,
  useAiConsultationRefetchRun,
} = await import('@/hooks/useAiConsultationDataRefetch');
const { AI_CONSULTATION_WRITES_ATTRIBUTE } = await import('@/hooks/useAiConsultationReceiver');
const { default: MainLayout } = await import('@/app/(main)/MainLayout');
const { default: ComparisonPage } = await import('@/app/(main)/comparison/page');
const { default: PantryPage } = await import('@/app/(main)/pantry/page');
const { default: HealthGoalsPage } = await import('@/app/(main)/health/goals/page');
const { default: ProfilePage } = await import('@/app/(main)/profile/page');
const { default: MealDetailPage } = await import('@/app/(main)/meals/[id]/page');
const { default: StreaksPage } = await import('@/app/(main)/health/streaks/page');
const { default: HealthGraphsPage } = await import('@/app/(main)/health/graphs/page');
const { default: NutritionTargetsPage } = await import('@/app/(main)/profile/nutrition-targets/page');
const { default: BadgesPage } = await import('@/app/(main)/badges/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPO_ROOT = path.resolve(__dirname, '..');
const readRepoFile = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** 投げる側 (AIChatBubble) と同じ名前を手で書いた期待値 */
const EXPECTED_EVENT_NAME = 'mealPlanUpdated';

let container: HTMLDivElement;
let root: Root;
/** テストが document.body に足した、ページの外の要素 (入力欄など)。後片付けで消す */
let extraElements: HTMLElement[];

beforeEach(() => {
  extraElements = [];
  supabaseMock.user = null;
  supabaseMock.profileRow = null;
  supabaseMock.profileReads = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  for (const el of extraElements) el.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** document.body に HTML の断片を足す (ページの外にある入力欄・モーダルの代わり) */
function addToBody(html: string): HTMLElement {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  document.body.appendChild(holder);
  extraElements.push(holder);
  return holder;
}

/** AI 相談の成功を知らせる (AIChatBubble と同じ形) */
async function notifyAiConsultationSucceeded(eventName: string = AI_CONSULTATION_DATA_CHANGED_EVENT) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(eventName, { detail: { actionType: 'update_meal', result: {} } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** fetch → res.json() → setState の連鎖を流しきる */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('isAiConsultationRefetchBlocked — 入力の部品・開いているモーダルがある間は取り直さない (#2195 V1)', () => {
  const BLOCKING_CASES: ReadonlyArray<{ label: string; html: string }> = [
    { label: '文字の入力欄', html: '<input type="text">' },
    { label: 'type の無い入力欄', html: '<input>' },
    { label: '数の入力欄', html: '<input type="number">' },
    { label: '範囲の入力 (ホームのチェックインの睡眠時間)', html: '<input type="range">' },
    { label: 'チェックボックス', html: '<input type="checkbox">' },
    { label: '日付の入力欄', html: '<input type="date">' },
    { label: 'textarea', html: '<textarea></textarea>' },
    { label: 'select', html: '<select><option>a</option></select>' },
    { label: '編集できる要素', html: '<div contenteditable="true"></div>' },
    { label: '値の無い contenteditable', html: '<div contenteditable></div>' },
    { label: 'role="dialog"', html: '<div role="dialog"></div>' },
    { label: 'aria-modal="true"', html: '<div aria-modal="true"></div>' },
    { label: '開いた <dialog>', html: '<dialog open></dialog>' },
  ];
  it.each(BLOCKING_CASES)('$label があると止める', ({ html }) => {
    const holder = addToBody(html);
    expect(isAiConsultationRefetchBlocked(holder)).toBe(true);
    expect(isAiConsultationRefetchBlocked(document)).toBe(true);
  });

  const NON_BLOCKING_CASES: ReadonlyArray<{ label: string; html: string }> = [
    { label: '何も無い', html: '<p>表示だけ</p>' },
    { label: 'hidden の input', html: '<input type="hidden" value="x">' },
    { label: 'ファイルの選択 (/pantry の「写真で追加」は画面に出さずに置いてある)', html: '<input type="file" class="hidden">' },
    { label: 'contenteditable="false"', html: '<div contenteditable="false"></div>' },
    { label: '閉じた <dialog>', html: '<dialog></dialog>' },
    { label: 'aria-modal="false"', html: '<div aria-modal="false"></div>' },
    { label: 'ボタンとリンク', html: '<button type="button">押す</button><a href="/home">ホーム</a>' },
  ];
  it.each(NON_BLOCKING_CASES)('$label だけなら止めない', ({ html }) => {
    const holder = addToBody(html);
    expect(isAiConsultationRefetchBlocked(holder)).toBe(false);
    expect(isAiConsultationRefetchBlocked(document)).toBe(false);
  });

  it('AI 相談の吹き出しの中 (印の要素の中) の入力欄・モーダルは数えない', () => {
    addToBody(
      `<div ${AI_CONSULTATION_CHAT_ROOT_ATTRIBUTE}=""><div><input type="text"><div role="dialog"><input type="date"></div></div></div>`,
    );
    expect(isAiConsultationRefetchBlocked(document)).toBe(false);
  });

  it('吹き出しの中にあっても、吹き出しの外に 1 つでもあれば止める', () => {
    addToBody(`<div ${AI_CONSULTATION_CHAT_ROOT_ATTRIBUTE}=""><input type="text"></div>`);
    addToBody('<div role="dialog"><button type="button">閉じる</button></div>');
    expect(isAiConsultationRefetchBlocked(document)).toBe(true);
  });

  it('何も変えていない入力欄の部品の中 (印の要素の中) の入力の部品は数えない', () => {
    addToBody(
      `<section ${AI_CONSULTATION_UNEDITED_INPUTS_ATTRIBUTE}=""><input type="number" value="65"><textarea></textarea><select><option>a</option></select><div contenteditable="true"></div></section>`,
    );
    expect(isAiConsultationRefetchBlocked(document)).toBe(false);
  });

  it('何も変えていない入力欄の部品の中でも、モーダルは数える', () => {
    addToBody(`<section ${AI_CONSULTATION_UNEDITED_INPUTS_ATTRIBUTE}=""><div role="dialog"><p>確認</p></div></section>`);
    expect(isAiConsultationRefetchBlocked(document)).toBe(true);
  });

  it('印の外に入力の部品が 1 つでもあれば止める', () => {
    addToBody(`<section ${AI_CONSULTATION_UNEDITED_INPUTS_ATTRIBUTE}=""><input type="number" value="65"></section>`);
    addToBody('<input type="text" value="打ちかけ">');
    expect(isAiConsultationRefetchBlocked(document)).toBe(true);
  });

  it('止める並びは、入力の部品の並びとモーダルの並びをつないだもの', () => {
    expect(AI_CONSULTATION_REFETCH_BLOCKING_SELECTOR).toBe(
      `${AI_CONSULTATION_REFETCH_INPUT_SELECTOR}, ${AI_CONSULTATION_REFETCH_MODAL_SELECTOR}`,
    );
  });
});

describe('モバイルの読み込み直しの番兵と同じ並び (#2195 V1・#2206 G1)', () => {
  /** モバイルの定数の名前 (並びの中でテンプレートの式として書く。#2206 G1) */
  const MOBILE_WRITES_ATTRIBUTE_CONSTANT = 'AI_CONSULTATION_WRITES_ATTRIBUTE';

  it('モバイルの止める要素は、Web の番兵の並び + input の type="file" + html[data-ai-consultation-writes]。属性の名前はモバイルの定数と同じ', () => {
    // モバイルのファイルは react-native を読み込むので、vitest では文字列として読んで並びを取り出す
    const mobileSource = readRepoFile('apps/mobile/src/lib/webViewBridge.ts');
    const attribute = new RegExp(`export const ${MOBILE_WRITES_ATTRIBUTE_CONSTANT} = '([^']*)';`).exec(mobileSource);
    expect(attribute, `モバイルの ${MOBILE_WRITES_ATTRIBUTE_CONSTANT} の定義が見つからない`).not.toBeNull();
    // Web の受け手が html に付ける属性の名前と、モバイルが止める要素として見る属性の名前は同じ
    expect(attribute![1]).toBe(AI_CONSULTATION_WRITES_ATTRIBUTE);
    expect(AI_CONSULTATION_WRITES_ATTRIBUTE).toBe('data-ai-consultation-writes');

    const block = /export const AI_CONSULTATION_RELOAD_BLOCKING_SELECTOR = \[([\s\S]*?)\]\.join\(', '\);/.exec(mobileSource);
    expect(block, 'モバイルの AI_CONSULTATION_RELOAD_BLOCKING_SELECTOR の定義が見つからない').not.toBeNull();
    // 文字列 ('…') と、定数を埋めたテンプレート (`html[${…}]`) の両方を並びの部品として読む
    const mobileParts = Array.from(block![1].matchAll(/'([^']*)'|`([^`]*)`/g), (m) =>
      m[1] ?? m[2].replaceAll(`\${${MOBILE_WRITES_ATTRIBUTE_CONSTANT}}`, attribute![1]),
    );
    expect(mobileParts.length).toBeGreaterThan(0);

    const webParts = AI_CONSULTATION_REFETCH_BLOCKING_SELECTOR.split(', ');
    const MOBILE_INPUT_PART = 'input:not([type="hidden"])';
    const WEB_INPUT_PART = 'input:not([type="hidden"]):not([type="file"])';
    /** Web の書き込みの印 (モバイルだけが見る。Web の番兵は hook の書き込みの数で判断し、この属性を数えない) */
    const MOBILE_WRITES_PART = `html[${AI_CONSULTATION_WRITES_ATTRIBUTE}]`;
    expect(mobileParts).toContain(MOBILE_INPUT_PART);
    expect(mobileParts).toContain(MOBILE_WRITES_PART);
    expect(webParts).not.toContain(MOBILE_WRITES_PART);
    expect(webParts).toEqual(
      mobileParts.filter((part) => part !== MOBILE_WRITES_PART).map((part) => (part === MOBILE_INPUT_PART ? WEB_INPUT_PART : part)),
    );

    // 印が外れたことをモバイルの見張り (MutationObserver の attributeFilter) が受け取れる
    const observed = /export const AI_CONSULTATION_DEFERRED_RELOAD_OBSERVED_ATTRIBUTES = \[([\s\S]*?)\] as const;/.exec(mobileSource);
    expect(observed, 'モバイルの AI_CONSULTATION_DEFERRED_RELOAD_OBSERVED_ATTRIBUTES の定義が見つからない').not.toBeNull();
    expect(observed![1].split(',').map((part) => part.trim())).toContain(MOBILE_WRITES_ATTRIBUTE_CONSTANT);
  });
});

describe('投げる側との名前の一致 (#2195 V1)', () => {
  it('受け手が聞くイベントの名前は mealPlanUpdated', () => {
    expect(AI_CONSULTATION_DATA_CHANGED_EVENT).toBe(EXPECTED_EVENT_NAME);
  });

  it('AIChatBubble が window に投げるデータの更新の通知は、どれも受け手が聞く名前', () => {
    const bubbleSource = readRepoFile('src/components/AIChatBubble.tsx');
    const dispatchedNames = Array.from(
      bubbleSource.matchAll(/window\.dispatchEvent\(\s*new CustomEvent\(\s*'([^']+)'/g),
      (m) => m[1],
    );
    expect(dispatchedNames.length).toBeGreaterThan(0);
    expect(new Set(dispatchedNames)).toEqual(new Set([AI_CONSULTATION_DATA_CHANGED_EVENT]));
  });
});

describe('useAiConsultationDataRefetch (#2195 V1)', () => {
  function Receiver({ refetch }: { refetch: () => unknown }) {
    useAiConsultationDataRefetch(refetch);
    return <p>表示だけのページ</p>;
  }

  it('AI 相談の成功を受けたら 1 回だけ取り直す', async () => {
    const refetch = vi.fn();
    await act(async () => {
      root.render(<Receiver refetch={refetch} />);
    });
    expect(refetch).not.toHaveBeenCalled();

    await notifyAiConsultationSucceeded();
    expect(refetch).toHaveBeenCalledTimes(1);

    await notifyAiConsultationSucceeded();
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it('ほかの名前のイベントでは取り直さない', async () => {
    const refetch = vi.fn();
    await act(async () => {
      root.render(<Receiver refetch={refetch} />);
    });
    await notifyAiConsultationSucceeded('somethingElseUpdated');
    expect(refetch).not.toHaveBeenCalled();
  });

  it('ページに入力欄があれば取り直さない・閉じたら止めた成功のぶん 1 回取り直す (#2201 U2)', async () => {
    const refetch = vi.fn();
    await act(async () => {
      root.render(<Receiver refetch={refetch} />);
    });
    const holder = addToBody('<input type="text" value="打ちかけ">');

    // 止めている間に何回来ても、外れたときの取り直しは 1 回
    await notifyAiConsultationSucceeded();
    await notifyAiConsultationSucceeded();
    expect(refetch).not.toHaveBeenCalled();

    await act(async () => {
      holder.remove();
    });
    expect(refetch).toHaveBeenCalledTimes(1);

    // 外れたあとの成功は、これまでどおりすぐ取り直す
    await notifyAiConsultationSucceeded();
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it('ページにモーダルが開いていれば取り直さない・閉じたら 1 回取り直す (#2201 U2)', async () => {
    const refetch = vi.fn();
    await act(async () => {
      root.render(<Receiver refetch={refetch} />);
    });
    const modal = addToBody('<div role="dialog"><p>確認</p></div>');
    await notifyAiConsultationSucceeded();
    expect(refetch).not.toHaveBeenCalled();

    // role を外す (属性の変化) でも番兵が外れる
    await act(async () => {
      modal.firstElementChild!.removeAttribute('role');
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('止めた成功が無ければ、モーダルを閉じても取り直さない (#2201 U2)', async () => {
    const refetch = vi.fn();
    await act(async () => {
      root.render(<Receiver refetch={refetch} />);
    });
    const modal = addToBody('<div role="dialog"><p>確認</p></div>');
    await act(async () => {
      modal.remove();
    });
    expect(refetch).not.toHaveBeenCalled();
  });

  it('止めている間にページを離れたら (アンマウント)、あとで番兵が外れても取り直さない (#2201 U2)', async () => {
    const refetch = vi.fn();
    await act(async () => {
      root.render(<Receiver refetch={refetch} />);
    });
    const modal = addToBody('<div role="dialog"><p>確認</p></div>');
    await notifyAiConsultationSucceeded();
    await act(async () => {
      root.render(<p>別のページ</p>);
    });
    await act(async () => {
      modal.remove();
    });
    expect(refetch).not.toHaveBeenCalled();
  });

  it('AI 相談の吹き出しの中の入力欄だけなら取り直す', async () => {
    const refetch = vi.fn();
    await act(async () => {
      root.render(<Receiver refetch={refetch} />);
    });
    addToBody(`<div ${AI_CONSULTATION_CHAT_ROOT_ATTRIBUTE}=""><input type="text" value="次の相談"></div>`);
    await notifyAiConsultationSucceeded();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('描画のたびに渡し直された最新の関数を呼び、購読は 1 回だけ', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const first = vi.fn();
    const second = vi.fn();
    await act(async () => {
      root.render(<Receiver refetch={first} />);
    });
    await act(async () => {
      root.render(<Receiver refetch={second} />);
    });
    await notifyAiConsultationSucceeded();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(addSpy.mock.calls.filter(([name]) => name === AI_CONSULTATION_DATA_CHANGED_EVENT)).toHaveLength(1);
  });

  it('ページを離れたら (アンマウント) 取り直さない', async () => {
    const refetch = vi.fn();
    await act(async () => {
      root.render(<Receiver refetch={refetch} />);
    });
    await act(async () => {
      root.render(<p>別のページ</p>);
    });
    await notifyAiConsultationSucceeded();
    expect(refetch).not.toHaveBeenCalled();
  });
});

describe('useAiConsultationDataRefetch の世代番号・失敗・書き込みの印 (#2201 U1 + U2)', () => {
  function WriteReceiver({
    refetch,
    writeInFlightRef,
    onControl,
  }: {
    refetch: (ticket: AiConsultationFetchTicket) => unknown;
    writeInFlightRef?: AiConsultationWriteInFlightRef;
    onControl?: (control: AiConsultationRefetchControl) => void;
  }) {
    const control = useAiConsultationDataRefetch(refetch, { writeInFlightRef });
    onControl?.(control);
    return <p>書き込みのあるページ</p>;
  }

  it('取り直しのたびに新しい札を渡し、あとから始めた取得 (beginFetch) があれば前の札は最新でなくなる', async () => {
    const tickets: AiConsultationFetchTicket[] = [];
    let control: AiConsultationRefetchControl | null = null;
    await act(async () => {
      root.render(<WriteReceiver refetch={(ticket) => tickets.push(ticket)} onControl={(c) => (control = c)} />);
    });
    await notifyAiConsultationSucceeded();
    expect(tickets).toHaveLength(1);
    expect(tickets[0].isLatest()).toBe(true);

    await notifyAiConsultationSucceeded();
    expect(tickets).toHaveLength(2);
    expect(tickets[0].isLatest(), '先の取り直しの札が最新のまま').toBe(false);
    expect(tickets[1].isLatest()).toBe(true);

    // ページの取得 (開いたとき・週の移動など) も同じ世代を進める
    const pageTicket = control!.beginFetch();
    expect(tickets[1].isLatest(), 'ページの取得のあとも取り直しの札が最新のまま').toBe(false);
    expect(pageTicket.isLatest()).toBe(true);
  });

  it('取り直しが reject しても・同期で投げても拾う (未処理の Promise 拒否にしない)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await act(async () => {
        root.render(<WriteReceiver refetch={() => Promise.reject(new Error('通信の失敗'))} />);
      });
      await notifyAiConsultationSucceeded();
      await act(async () => {
        root.render(
          <WriteReceiver
            refetch={() => {
              throw new Error('同期の失敗');
            }}
          />,
        );
      });
      await notifyAiConsultationSucceeded();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(unhandled).not.toHaveBeenCalled();
      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        '[ai-consultation-refetch] refetch failed:',
        '[ai-consultation-refetch] refetch failed:',
      ]);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('書き込みの印が立っている間は取り直さず、notifyWriteSettled で止めた成功のぶん 1 回だけ取り直す', async () => {
    const refetch = vi.fn();
    const writeInFlightRef = { current: false };
    let control: AiConsultationRefetchControl | null = null;
    await act(async () => {
      root.render(<WriteReceiver refetch={refetch} writeInFlightRef={writeInFlightRef} onControl={(c) => (control = c)} />);
    });

    // 止めた成功が無ければ、書き込みが終わっても取り直さない
    await act(async () => {
      control!.notifyWriteSettled();
    });
    expect(refetch).not.toHaveBeenCalled();

    writeInFlightRef.current = true;
    await notifyAiConsultationSucceeded();
    await notifyAiConsultationSucceeded();
    expect(refetch).not.toHaveBeenCalled();

    // 印を下ろさずに知らせても取り直さない
    await act(async () => {
      control!.notifyWriteSettled();
    });
    expect(refetch).not.toHaveBeenCalled();

    writeInFlightRef.current = false;
    await act(async () => {
      control!.notifyWriteSettled();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      control!.notifyWriteSettled();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('書き込みが終わったときにモーダルが出ていれば、閉じたときに取り直す', async () => {
    const refetch = vi.fn();
    const writeInFlightRef = { current: true };
    let control: AiConsultationRefetchControl | null = null;
    await act(async () => {
      root.render(<WriteReceiver refetch={refetch} writeInFlightRef={writeInFlightRef} onControl={(c) => (control = c)} />);
    });
    await notifyAiConsultationSucceeded();
    const modal = addToBody('<div role="dialog"></div>');
    writeInFlightRef.current = false;
    await act(async () => {
      control!.notifyWriteSettled();
    });
    expect(refetch).not.toHaveBeenCalled();
    await act(async () => {
      modal.remove();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('重なった書き込み (useAiConsultationPendingWrites) は、全部終わったときに自分で知らせ、1 回だけ取り直す', async () => {
    const refetch = vi.fn();
    let writes: AiConsultationPendingWrites | null = null;
    function PendingWritesReceiver() {
      const pendingWrites = useAiConsultationPendingWrites();
      writes = pendingWrites;
      useAiConsultationDataRefetch(refetch, { writeInFlightRef: pendingWrites });
      return <p>一覧の行ごとの書き込み</p>;
    }
    await act(async () => {
      root.render(<PendingWritesReceiver />);
    });
    const endFirst = writes!.begin();
    const endSecond = writes!.begin();
    expect(writes!.current).toBe(true);
    await notifyAiConsultationSucceeded();

    // 先の書き込みが終わっても、あとの書き込みの途中なら取り直さない
    await act(async () => {
      endFirst();
      endFirst();
    });
    expect(writes!.current).toBe(true);
    expect(refetch).not.toHaveBeenCalled();

    await act(async () => {
      endSecond();
    });
    expect(writes!.current).toBe(false);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * 取り直しの応答を置く時点の番兵 (札の deferIfHeld。#2201 U1 + U2)。
 * 取り直しでは読み込み中の表示を出さないので、応答を待つあいだも入力欄・モーダルを開くボタン・書き込みのボタンが出ている。
 * 番兵と書き込みの印を通知の時点にしか見ないと、その間に開いたモーダル・打ち始めた入力・始めた書き込みを、届いた応答
 * (それより前に読んだ値) で上書きする
 */
describe('取り直しの応答を置く時点の番兵・書き込みの印 (札の deferIfHeld。#2201 U1 + U2)', () => {
  function TicketReceiver({
    tickets,
    writeInFlightRef,
    onControl,
  }: {
    tickets: AiConsultationFetchTicket[];
    writeInFlightRef?: AiConsultationWriteInFlightRef;
    onControl?: (control: AiConsultationRefetchControl) => void;
  }) {
    const control = useAiConsultationDataRefetch((ticket) => tickets.push(ticket), { writeInFlightRef });
    onControl?.(control);
    return <p>取り直しの札を受けるページ</p>;
  }

  it('番兵も書き込みも無ければ置く (false)。取り直しを足さない', async () => {
    const tickets: AiConsultationFetchTicket[] = [];
    await act(async () => {
      root.render(<TicketReceiver tickets={tickets} />);
    });
    await notifyAiConsultationSucceeded();
    expect(tickets).toHaveLength(1);
    await act(async () => {
      expect(tickets[0].deferIfHeld()).toBe(false);
    });
    expect(tickets).toHaveLength(1);
  });

  it('応答を待つあいだにモーダルを開いたら置かず (true)、閉じたら 1 回取り直す', async () => {
    const tickets: AiConsultationFetchTicket[] = [];
    await act(async () => {
      root.render(<TicketReceiver tickets={tickets} />);
    });
    await notifyAiConsultationSucceeded();
    expect(tickets).toHaveLength(1);

    const modal = addToBody('<div role="dialog"><input type="number" value="63.4"></div>');
    await act(async () => {
      expect(tickets[0].deferIfHeld(), '応答を待つあいだに開いたモーダルがあるのに置く').toBe(true);
      // 何度見ても、取り直しは閉じたときの 1 回
      expect(tickets[0].deferIfHeld()).toBe(true);
    });
    expect(tickets, 'モーダルが開いているのに取り直した').toHaveLength(1);

    await act(async () => {
      modal.remove();
    });
    expect(tickets, '閉じても止めた取り直しをしない').toHaveLength(2);
    await act(async () => {
      expect(tickets[1].deferIfHeld()).toBe(false);
    });
    expect(tickets).toHaveLength(2);
  });

  it('ページが自分で始めた取得の札 (beginFetch) は、番兵が立っていても置く (false)', async () => {
    const tickets: AiConsultationFetchTicket[] = [];
    let control: AiConsultationRefetchControl | null = null;
    await act(async () => {
      root.render(<TicketReceiver tickets={tickets} onControl={(c) => (control = c)} />);
    });
    const pageTicket = control!.beginFetch();
    addToBody('<div role="dialog"></div>');
    await act(async () => {
      expect(pageTicket.deferIfHeld()).toBe(false);
    });
    expect(tickets).toHaveLength(0);
  });

  it('応答を待つあいだに書き込みを始めたら、書き込みの途中は置かず (true)、全部終わったら 1 回取り直す', async () => {
    const tickets: AiConsultationFetchTicket[] = [];
    let writes: AiConsultationPendingWrites | null = null;
    function PendingWritesTicketReceiver() {
      const pendingWrites = useAiConsultationPendingWrites();
      writes = pendingWrites;
      useAiConsultationDataRefetch((ticket) => tickets.push(ticket), { writeInFlightRef: pendingWrites });
      return <p>楽観的な更新のあるページ</p>;
    }
    await act(async () => {
      root.render(<PendingWritesTicketReceiver />);
    });
    await notifyAiConsultationSucceeded();
    expect(tickets).toHaveLength(1);

    const endWrite = writes!.begin();
    await act(async () => {
      expect(tickets[0].deferIfHeld(), '書き込みの途中に届いた応答を置く').toBe(true);
    });
    expect(tickets, '書き込みの途中に取り直した').toHaveLength(1);
    await act(async () => {
      endWrite();
    });
    expect(tickets, '書き込みが終わっても止めた取り直しをしない').toHaveLength(2);
  });

  it('応答を待つあいだに書き込みを始めて終えていたら、置かず (true)、すぐに 1 回取り直す (書き込みの前に読んだ値を置かない)', async () => {
    const tickets: AiConsultationFetchTicket[] = [];
    let writes: AiConsultationPendingWrites | null = null;
    function PendingWritesTicketReceiver() {
      const pendingWrites = useAiConsultationPendingWrites();
      writes = pendingWrites;
      useAiConsultationDataRefetch((ticket) => tickets.push(ticket), { writeInFlightRef: pendingWrites });
      return <p>楽観的な更新のあるページ</p>;
    }
    await act(async () => {
      root.render(<PendingWritesTicketReceiver />);
    });
    await notifyAiConsultationSucceeded();
    expect(tickets).toHaveLength(1);
    const startedBefore = writes!.startedCount;

    await act(async () => {
      writes!.begin()();
    });
    expect(writes!.startedCount).toBe(startedBefore + 1);
    expect(writes!.current).toBe(false);
    // 書き込みの間に来た通知は無いので、書き込みが終わっただけでは取り直さない
    expect(tickets).toHaveLength(1);

    await act(async () => {
      expect(tickets[0].deferIfHeld(), '書き込みの前に読んだかもしれない応答を置く').toBe(true);
    });
    expect(tickets, '置かなかった応答のぶん取り直さない').toHaveLength(2);
    // 書き込みのあとに始めた取り直しの応答は置く
    await act(async () => {
      expect(tickets[1].deferIfHeld()).toBe(false);
    });
    expect(tickets).toHaveLength(2);
  });

  it('1 つの取り直しの応答を何か所かに分けて置くページが置く場所ごとに見ても、置かずに取り直すのは 1 回 (#2201 U2)', async () => {
    const tickets: AiConsultationFetchTicket[] = [];
    let writes: AiConsultationPendingWrites | null = null;
    function PendingWritesTicketReceiver() {
      const pendingWrites = useAiConsultationPendingWrites();
      writes = pendingWrites;
      useAiConsultationDataRefetch((ticket) => tickets.push(ticket), { writeInFlightRef: pendingWrites });
      return <p>応答を何か所かに分けて置くページ</p>;
    }
    await act(async () => {
      root.render(<PendingWritesTicketReceiver />);
    });
    await notifyAiConsultationSucceeded();
    expect(tickets).toHaveLength(1);

    // 応答を待つあいだに書き込みを始めて終えた (番兵も書き込みの途中の印も立っていない)
    await act(async () => {
      writes!.begin()();
    });
    // 献立・買い物リスト・カレンダーの印のように、置く場所ごとに見る
    await act(async () => {
      expect(tickets[0].deferIfHeld(), '書き込みの前に読んだかもしれない応答を置く').toBe(true);
      expect(tickets[0].deferIfHeld(), '一度置かなかった札の応答を、ほかの場所では置く').toBe(true);
      expect(tickets[0].deferIfHeld()).toBe(true);
    });
    expect(tickets, '置く場所ごとに取り直しを足した').toHaveLength(2);
  });

  it('書き込みの印が真偽の ref のときは、応答を置く時点で書き込みの途中かだけを見る', async () => {
    const tickets: AiConsultationFetchTicket[] = [];
    const writeInFlightRef = { current: false };
    let control: AiConsultationRefetchControl | null = null;
    await act(async () => {
      root.render(<TicketReceiver tickets={tickets} writeInFlightRef={writeInFlightRef} onControl={(c) => (control = c)} />);
    });
    await notifyAiConsultationSucceeded();
    writeInFlightRef.current = true;
    await act(async () => {
      expect(tickets[0].deferIfHeld()).toBe(true);
    });
    expect(tickets).toHaveLength(1);
    writeInFlightRef.current = false;
    await act(async () => {
      control!.notifyWriteSettled();
    });
    expect(tickets).toHaveLength(2);
  });

  it('ページを離れたあと (アンマウント) に届いた応答では、取り直しを足さない', async () => {
    const tickets: AiConsultationFetchTicket[] = [];
    await act(async () => {
      root.render(<TicketReceiver tickets={tickets} />);
    });
    await notifyAiConsultationSucceeded();
    const modal = addToBody('<div role="dialog"></div>');
    await act(async () => {
      root.render(<p>別のページ</p>);
    });
    await act(async () => {
      expect(tickets[0].deferIfHeld()).toBe(true);
    });
    await act(async () => {
      modal.remove();
    });
    expect(tickets).toHaveLength(1);
  });

  it('useAiConsultationRefetchKey: 最後に数を増やした取り直しの札を返す (増やす前は null)', async () => {
    let state: { refetchKey: number; refetchTicket: () => AiConsultationFetchTicket | null } | null = null;
    function KeyTicketView() {
      const keyState = useAiConsultationRefetchKey();
      state = keyState;
      return <p data-testid="refetch-key">{keyState.refetchKey}</p>;
    }
    await act(async () => {
      root.render(<KeyTicketView />);
    });
    expect(state!.refetchTicket()).toBeNull();

    await notifyAiConsultationSucceeded();
    expect(state!.refetchKey).toBe(1);
    const ticket = state!.refetchTicket();
    expect(ticket).not.toBeNull();

    // 応答を待つあいだにモーダルを開いた: 置かず、閉じたら 1 つ増える
    const modal = addToBody('<div role="dialog"></div>');
    await act(async () => {
      expect(ticket!.deferIfHeld()).toBe(true);
    });
    expect(state!.refetchKey).toBe(1);
    await act(async () => {
      modal.remove();
    });
    expect(state!.refetchKey).toBe(2);
    expect(state!.refetchTicket()).not.toBe(ticket);
  });
});

describe('useAiConsultationRefetchKey (#2195 V1)', () => {
  function KeyView() {
    const { refetchKey } = useAiConsultationRefetchKey();
    return <p data-testid="refetch-key">{refetchKey}</p>;
  }
  const keyText = () => container.querySelector('[data-testid="refetch-key"]')?.textContent;

  it('成功のたびに 1 つ増え、入力欄がある間は増えない', async () => {
    await act(async () => {
      root.render(<KeyView />);
    });
    expect(keyText()).toBe('0');

    await notifyAiConsultationSucceeded();
    expect(keyText()).toBe('1');

    const holder = addToBody('<textarea>打ちかけ</textarea>');
    await notifyAiConsultationSucceeded();
    expect(keyText()).toBe('1');

    // 外れたら止めた成功のぶん 1 つ増える (#2201 U2)
    await act(async () => {
      holder.remove();
    });
    expect(keyText()).toBe('2');

    await notifyAiConsultationSucceeded();
    expect(keyText()).toBe('3');
  });
});

describe('取得の流れ (useAiConsultationFetchStream。#2201 U1 + U2)', () => {
  /** 取得の流れを 1 本持ち、AI 相談の成功の取り直しの札を受けるページ */
  function renderStreamPage(order: AiConsultationFetchStreamOrder, writeInFlightRef?: AiConsultationWriteInFlightRef) {
    const page: { stream: AiConsultationFetchStream | null; tickets: AiConsultationFetchTicket[] } = { stream: null, tickets: [] };
    function StreamPage() {
      page.stream = useAiConsultationFetchStream(order);
      useAiConsultationDataRefetch((ticket) => page.tickets.push(ticket), { writeInFlightRef });
      return <p>取得の流れを持つページ</p>;
    }
    return { page, element: <StreamPage /> };
  }

  it("'latestStarted': 最後に始めた取得の応答だけを置く (開いたときの読み込みの応答が取り直しの応答より後に届いても置かない)", async () => {
    const { page, element } = renderStreamPage('latestStarted');
    await act(async () => {
      root.render(element);
    });
    const placed: string[] = [];
    const mount = page.stream!.begin();
    await notifyAiConsultationSucceeded();
    const refetch = page.stream!.begin(page.tickets[0]);
    expect(mount.isLatest()).toBe(false);
    expect(refetch.isLatest()).toBe(true);

    await act(async () => {
      expect(refetch.place(() => placed.push('取り直し'))).toBe('placed');
      expect(mount.place(() => placed.push('開いたとき')), '古い応答を置いた').toBe('superseded');
    });
    expect(placed).toEqual(['取り直し']);

    // あとの取得がまだ何も置いていなくても、先に始めた取得の応答は置かない
    const older = page.stream!.begin();
    const newer = page.stream!.begin();
    await act(async () => {
      expect(older.place(() => placed.push('先'))).toBe('superseded');
      expect(newer.place(() => placed.push('あと'))).toBe('placed');
    });
    expect(placed).toEqual(['取り直し', 'あと']);
  });

  it("'newerThanPlaced': 置いた応答より新しい取得の応答を置く (あとの取得がまだ置いていなければ、先に始めた取得の応答も置く)", async () => {
    const { page, element } = renderStreamPage('newerThanPlaced');
    await act(async () => {
      root.render(element);
    });
    const placed: string[] = [];
    const older = page.stream!.begin();
    const newer = page.stream!.begin();
    await act(async () => {
      // あとの取得が失敗した・まだ届いていない: 先に始めた取得の応答を置く
      expect(older.place(() => placed.push('先'))).toBe('placed');
      expect(newer.place(() => placed.push('あと'))).toBe('placed');
    });
    const late = page.stream!.begin();
    const early = page.stream!.begin();
    await act(async () => {
      expect(early.place(() => placed.push('あとに始めた'))).toBe('placed');
      expect(late.place(() => placed.push('先に始めた')), 'もう置いた新しい応答を古い応答で上書きした').toBe('superseded');
    });
    expect(placed).toEqual(['先', 'あと', 'あとに始めた']);
  });

  it("'newerThanPlaced' は鍵 (対象) ごとに順序を持つ: 別の対象の応答を置いても、選び直した対象の先に始めた取得の応答を古いと見なさない (A→B→A)", async () => {
    const { page, element } = renderStreamPage('newerThanPlaced');
    await act(async () => {
      root.render(element);
    });
    const placed: string[] = [];
    const firstA = page.stream!.begin(null, '日 A');
    const otherB = page.stream!.begin(null, '日 B');
    const secondA = page.stream!.begin(null, '日 A');
    await act(async () => {
      expect(otherB.place(() => placed.push('B'))).toBe('placed');
      expect(firstA.place(() => placed.push('A (先に始めた)')), '別の対象 (B) の応答を置いたことで、A の応答を古いと見なした').toBe('placed');
      expect(secondA.place(() => placed.push('A (あとに始めた)'))).toBe('placed');
    });
    // 同じ対象の中では、もう置いた新しい応答を古い応答で上書きしない
    const lateA = page.stream!.begin(null, '日 A');
    const earlyA = page.stream!.begin(null, '日 A');
    await act(async () => {
      expect(earlyA.place(() => placed.push('A (さらにあと)'))).toBe('placed');
      expect(lateA.place(() => placed.push('A (古い)'))).toBe('superseded');
    });
    expect(placed).toEqual(['B', 'A (先に始めた)', 'A (あとに始めた)', 'A (さらにあと)']);
  });

  it('鍵ごとに別々の順序を持つ (ほかの範囲の取得で古くならない)', async () => {
    const { page, element } = renderStreamPage('latestStarted');
    await act(async () => {
      root.render(element);
    });
    const placed: string[] = [];
    const weekRange = page.stream!.begin(null, '週の範囲');
    const monthRange = page.stream!.begin(null, '月の範囲');
    const weekRangeAgain = page.stream!.begin(null, '週の範囲');
    await act(async () => {
      expect(monthRange.place(() => placed.push('月'))).toBe('placed');
      expect(weekRange.place(() => placed.push('週 (古い)'))).toBe('superseded');
      expect(weekRangeAgain.place(() => placed.push('週'))).toBe('placed');
    });
    expect(placed).toEqual(['月', '週']);
  });

  it('取り直しの札を渡した取得は、応答を置く時点にモーダルが開いていれば置かず (deferred)、閉じたら 1 回取り直す。古い応答では止めた通知の印を付けない', async () => {
    const { page, element } = renderStreamPage('latestStarted');
    await act(async () => {
      root.render(element);
    });
    const placed: string[] = [];
    await notifyAiConsultationSucceeded();
    await notifyAiConsultationSucceeded();
    expect(page.tickets).toHaveLength(2);
    const olderRefetch = page.stream!.begin(page.tickets[0]);
    const newerRefetch = page.stream!.begin(page.tickets[1]);
    // 開いたときの読み込み (札なし) は番兵を見ない
    const modal = addToBody('<div role="dialog"></div>');
    await act(async () => {
      expect(olderRefetch.place(() => placed.push('先の取り直し')), '古い応答で番兵を見た').toBe('superseded');
      expect(newerRefetch.place(() => placed.push('あとの取り直し'))).toBe('deferred');
      // 1 つの取得の応答を何か所かに分けて置く: 一度止めた取得は、ほかの場所でも置かない
      expect(newerRefetch.place(() => placed.push('あとの取り直しの別の場所'))).toBe('deferred');
    });
    expect(placed).toEqual([]);
    expect(page.tickets, 'モーダルが開いているのに取り直した').toHaveLength(2);
    await act(async () => {
      modal.remove();
    });
    // 止めた取り直しのぶん 1 回だけ (古い応答は印を付けていない)
    expect(page.tickets, '閉じても止めた取り直しをしない・古い応答のぶんも取り直した').toHaveLength(3);
    const flushed = page.stream!.begin(page.tickets[2]);
    await act(async () => {
      expect(flushed.place(() => placed.push('閉じたあとの取り直し'))).toBe('placed');
    });
    expect(placed).toEqual(['閉じたあとの取り直し']);
  });

  it('札を渡さない取得 (開いたとき・書き込みのあとの読み直し) は、番兵が立っていても置く', async () => {
    const { page, element } = renderStreamPage('latestStarted');
    await act(async () => {
      root.render(element);
    });
    const placed: string[] = [];
    addToBody('<div role="dialog"></div>');
    const mount = page.stream!.begin();
    await act(async () => {
      expect(mount.place(() => placed.push('開いたとき'))).toBe('placed');
    });
    expect(placed).toEqual(['開いたとき']);
    expect(page.tickets).toHaveLength(0);
  });

  it('段ごとに置く取得は、途中であとの取得が始まったら次の段を置かない', async () => {
    const { page, element } = renderStreamPage('latestStarted');
    await act(async () => {
      root.render(element);
    });
    const placed: string[] = [];
    const first = page.stream!.begin();
    await act(async () => {
      expect(first.place(() => placed.push('1 段目'))).toBe('placed');
    });
    page.stream!.begin();
    await act(async () => {
      expect(first.place(() => placed.push('2 段目'))).toBe('superseded');
    });
    expect(placed).toEqual(['1 段目']);
  });
});

describe('開いたときの読み込み中に始まった取り直しは、その読み込みの役を引き継ぐ (#2201 U1)', () => {
  it('useAiConsultationLoading: 読み込み中の表示を出している間の取り直しの読み方は mount、下ろしたあとは refetch。下ろすのは最後の札だけ', async () => {
    let state: AiConsultationLoadingState | null = null;
    let control: AiConsultationRefetchControl | null = null;
    function LoadingProbe() {
      state = useAiConsultationLoading();
      control = useAiConsultationDataRefetch(() => undefined);
      return <p data-testid="loading">{String(state.loading)}</p>;
    }
    const loadingText = () => container.querySelector('[data-testid="loading"]')?.textContent;
    await act(async () => {
      root.render(<LoadingProbe />);
    });
    expect(loadingText()).toBe('true');
    expect(state!.refetchReadMode(), '開いたときの読み込み中の取り直しが、取り直しの扱い (失敗を隠す) になる').toBe('mount');

    // 開いたときの札のあとに取り直しの札を作った: 開いたときの札では下ろさない (取り直しの応答を待っている)
    const mountTicket = control!.beginFetch();
    const refetchTicket = control!.beginFetch();
    await act(async () => {
      state!.settleLoading(mountTicket);
    });
    expect(loadingText(), '最後でない札で読み込み中の表示を下ろした').toBe('true');
    // 取り直しの札 (最後の札) が下ろす
    await act(async () => {
      state!.settleLoading(refetchTicket);
    });
    expect(loadingText(), '最後の札 (取り直し) で読み込み中の表示を下ろさない').toBe('false');
    expect(state!.refetchReadMode()).toBe('refetch');

    // 描画の前でも、setLoading の直後から読み方が変わる (「再試行」で読み込み中の表示を出した直後に来た成功)
    await act(async () => {
      state!.setLoading(true);
      expect(state!.refetchReadMode()).toBe('mount');
    });
  });

  it('useAiConsultationRefetchRun: 読み込み中の表示を出している間に増えた回は取り直しの扱いにしない。下ろしたあとに増えた回は取り直し', async () => {
    const runs: boolean[] = [];
    let setLoading: ((loading: boolean) => void) | null = null;
    function RunProbe() {
      const { refetchKey } = useAiConsultationRefetchKey();
      const [loading, setLoadingState] = useState(true);
      setLoading = setLoadingState;
      const takeRun = useAiConsultationRefetchRun(refetchKey, loading);
      useEffect(() => {
        runs.push(takeRun());
      }, [refetchKey, takeRun]);
      return null;
    }
    await act(async () => {
      root.render(<RunProbe />);
    });
    expect(runs).toEqual([false]);

    // 開いたときの読み込み中に成功が来た: 開いたときの回の役を引き継ぐ (取り直しの扱いにしない)
    await notifyAiConsultationSucceeded();
    expect(runs).toEqual([false, false]);

    await act(async () => {
      setLoading!(false);
    });
    await notifyAiConsultationSucceeded();
    expect(runs, '読み込み中の表示を下ろしたあとの成功が取り直しの扱いにならない').toEqual([false, false, true]);
  });

  it('useAiConsultationRefetchRun: 読み込み中の表示を渡さない部品は、数が増えたかだけで決める', async () => {
    const runs: boolean[] = [];
    function RunProbe() {
      const { refetchKey } = useAiConsultationRefetchKey();
      const takeRun = useAiConsultationRefetchRun(refetchKey);
      useEffect(() => {
        runs.push(takeRun());
      }, [refetchKey, takeRun]);
      return null;
    }
    await act(async () => {
      root.render(<RunProbe />);
    });
    await notifyAiConsultationSucceeded();
    expect(runs).toEqual([false, true]);
  });
});

describe('MainLayout が AI 相談の吹き出しを印の要素で包む (#2195 V1)', () => {
  it('吹き出しの入力欄・モーダルは取り直しを止めず、ページの入力欄は止める', async () => {
    function PageWithInput() {
      const [editing, setEditing] = useState(false);
      return (
        <div>
          <button type="button" data-testid="start-editing" onClick={() => setEditing(true)}>
            編集
          </button>
          {editing && <input type="text" data-testid="page-input" />}
        </div>
      );
    }
    await act(async () => {
      root.render(
        <MainLayout initialIsNativeApp>
          <PageWithInput />
        </MainLayout>,
      );
    });

    const chatInput = container.querySelector('[data-testid="fake-ai-chat-input"]');
    expect(chatInput, '吹き出しが描かれていない').not.toBeNull();
    expect(chatInput!.closest(`[${AI_CONSULTATION_CHAT_ROOT_ATTRIBUTE}]`)).not.toBeNull();
    // ページの本体は印の外
    expect(container.querySelector('[data-testid="start-editing"]')!.closest(`[${AI_CONSULTATION_CHAT_ROOT_ATTRIBUTE}]`)).toBeNull();
    expect(isAiConsultationRefetchBlocked(document)).toBe(false);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="start-editing"]')!.click();
    });
    expect(container.querySelector('[data-testid="page-input"]')).not.toBeNull();
    expect(isAiConsultationRefetchBlocked(document)).toBe(true);
  });
});

/** fetch のモック。URL ごとの呼ばれた回数を数える */
function installFetchMock(responses: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url in responses) return Response.json(responses[url]);
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const callsTo = (url: string) => fetchMock.mock.calls.filter(([input]) => String(input) === url).length;
  return { fetchMock, callsTo };
}

/** 打ちかけの値を持ちうる入力の部品 (モーダルを除いた番兵の並び)。「モーダルの中に入力の部品が無い」ことを確かめるのに使う */
const INPUT_PARTS_SELECTOR = AI_CONSULTATION_REFETCH_INPUT_SELECTOR;

/** 中の文字 (空白を詰めたもの) が text と一致するボタン */
function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.replace(/\s+/g, '') === text);
}

/** 中の文字に text を含むボタン (説明の文を添えたメニューの項目など) */
function buttonContaining(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(text));
}

/** 文字が label の <p> の、すぐ前 (side: 'previous') か すぐ後 (side: 'next') の要素の文字 (見出しと値の組) */
function textBeside(label: string, side: 'previous' | 'next'): string | null | undefined {
  const labelElement = Array.from(container.querySelectorAll('p')).find((p) => p.textContent === label);
  const sibling = side === 'previous' ? labelElement?.previousElementSibling : labelElement?.nextElementSibling;
  return sibling?.textContent;
}

/** React の制御された入力欄に打ち込む (value の setter を通してから input を投げる) */
function typeInto(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setValue?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ページが AI 相談の成功で取り直す (#2195 V1)', () => {
  it('比較 (/comparison): 表示中の期間の順位をもう一度取る。入力欄があれば取らない', async () => {
    const RANKINGS_URL = '/api/comparison/rankings?periodType=weekly';
    const { callsTo } = installFetchMock({
      [RANKINGS_URL]: {
        rankings: [],
        highlights: [],
        userMetrics: [],
        periodType: 'weekly',
        periodStart: '2026-11-01',
        periodEnd: '2026-11-07',
      },
    });
    await act(async () => {
      root.render(<ComparisonPage />);
    });
    await settle();
    expect(callsTo(RANKINGS_URL)).toBe(1);

    await notifyAiConsultationSucceeded();
    await settle();
    expect(callsTo(RANKINGS_URL)).toBe(2);

    addToBody('<input type="text">');
    await notifyAiConsultationSucceeded();
    await settle();
    expect(callsTo(RANKINGS_URL)).toBe(2);
  });

  it('冷蔵庫 (/pantry): 食材の一覧をもう一度取る (画面に出さないファイルの選択は止める理由にしない)', async () => {
    const PANTRY_URL = '/api/pantry';
    const { callsTo } = installFetchMock({ [PANTRY_URL]: { items: [] } });
    await act(async () => {
      root.render(<PantryPage />);
    });
    await settle();
    expect(callsTo(PANTRY_URL)).toBe(1);
    // ページ自身が「写真で追加」のファイルの選択をいつも置いている
    expect(container.querySelector('input[type="file"]')).not.toBeNull();

    await notifyAiConsultationSucceeded();
    await settle();
    expect(callsTo(PANTRY_URL)).toBe(2);

    addToBody('<div role="dialog"></div>');
    await notifyAiConsultationSucceeded();
    await settle();
    expect(callsTo(PANTRY_URL)).toBe(2);
  });

  it('健康目標 (/health/goals): 目標の一覧をもう一度取る。モーダルが開いていれば取らない', async () => {
    const GOALS_URL = '/api/health/goals?status=all';
    const { callsTo } = installFetchMock({ [GOALS_URL]: { goals: [] } });
    await act(async () => {
      root.render(<HealthGoalsPage />);
    });
    await settle();
    expect(callsTo(GOALS_URL)).toBe(1);

    await notifyAiConsultationSucceeded();
    await settle();
    expect(callsTo(GOALS_URL)).toBe(2);

    addToBody('<div aria-modal="true"></div>');
    await notifyAiConsultationSucceeded();
    await settle();
    expect(callsTo(GOALS_URL)).toBe(2);
  });

  it('マイページ (/profile): 編集のモーダルが開いている間は、入力の部品が 1 つも無い競技タブでも取り直さず、打ちかけの値を残す', async () => {
    const PROFILE_USER_ID = '21950000-0000-4000-8000-000000000001';
    const SAVED_NICKNAME = 'ほり';
    const EDITED_NICKNAME = 'ほり (打ちかけ)';
    supabaseMock.user = { id: PROFILE_USER_ID };
    supabaseMock.profileRow = { id: PROFILE_USER_ID, nickname: SAVED_NICKNAME };
    installFetchMock({});
    await act(async () => {
      root.render(<ProfilePage />);
    });
    await settle();
    expect(supabaseMock.profileReads).toBe(1);

    // モーダルが閉じていれば取り直す (受け手が配線されている)
    await notifyAiConsultationSucceeded();
    await settle();
    expect(supabaseMock.profileReads).toBe(2);

    // 編集のモーダルを基本情報タブで開き、ニックネームを打ちかける (保存はしない)
    await act(async () => {
      buttonContaining('基本情報')!.click();
    });
    const nicknameInput = () => container.querySelector<HTMLInputElement>('input[placeholder="例: たろう"]');
    expect(nicknameInput()?.value).toBe(SAVED_NICKNAME);
    await act(async () => {
      typeInto(nicknameInput()!, EDITED_NICKNAME);
    });
    expect(nicknameInput()!.value).toBe(EDITED_NICKNAME);

    // 競技タブ (競技を選んでいない間は入力の部品が 1 つも無い) へ切り替える
    await act(async () => {
      buttonByText('🏆競技')!.click();
    });
    expect(nicknameInput()).toBeNull();
    expect(document.querySelectorAll(INPUT_PARTS_SELECTOR)).toHaveLength(0);

    await notifyAiConsultationSucceeded();
    await settle();
    expect(supabaseMock.profileReads).toBe(2);

    // 基本タブへ戻っても、打ちかけの値が取得した値で上書きされていない
    await act(async () => {
      buttonByText('👤基本')!.click();
    });
    expect(nicknameInput()!.value).toBe(EDITED_NICKNAME);
  });

  it('食事の詳細 (/meals/[id]): 表示中の食事をもう一度取る。削除の確認のモーダルが開いていれば取らない', async () => {
    const MEAL_ID = 'meal-2195';
    const MEAL_URL = `/api/meals/${MEAL_ID}`;
    const { callsTo } = installFetchMock({
      [MEAL_URL]: {
        id: MEAL_ID,
        daily_meal_id: 'day-2195',
        meal_type: 'dinner',
        mode: 'cook',
        dish_name: '取り直しの検査の料理',
        is_completed: false,
        completed_at: null,
        user_daily_meals: { day_date: '2026-11-03' },
      },
    });
    await act(async () => {
      root.render(<MealDetailPage params={Promise.resolve({ id: MEAL_ID })} />);
    });
    await settle();
    expect(container.textContent).toContain('取り直しの検査の料理');
    expect(callsTo(MEAL_URL)).toBe(1);

    await notifyAiConsultationSucceeded();
    await settle();
    expect(callsTo(MEAL_URL)).toBe(2);

    // 右上のメニュー → 「削除する」で削除の確認のモーダルを開く (中に入力の部品は無い)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('div.relative > button')!.click();
    });
    await act(async () => {
      buttonByText('削除する')!.click();
    });
    expect(container.textContent).toContain('この献立を削除しますか？');
    expect(document.querySelectorAll(INPUT_PARTS_SELECTOR)).toHaveLength(0);

    await notifyAiConsultationSucceeded();
    await settle();
    expect(callsTo(MEAL_URL)).toBe(2);
  });

  it('連続記録 (/health/streaks): 連続記録をもう一度取る。バッジの詳細のモーダルが開いていれば取らない', async () => {
    const STREAKS_URL = '/api/health/streaks';
    const { callsTo } = installFetchMock({
      [STREAKS_URL]: {
        streak: { current_streak: 3, longest_streak: 5, achieved_badges: [], total_records: 8, streak_type: 'daily_record' },
        nextBadge: 7,
        daysToNextBadge: 4,
        weeklyRecords: [],
      },
    });
    await act(async () => {
      root.render(<StreaksPage />);
    });
    await settle();
    expect(callsTo(STREAKS_URL)).toBe(1);

    await notifyAiConsultationSucceeded();
    await settle();
    expect(callsTo(STREAKS_URL)).toBe(2);

    await act(async () => {
      buttonByText('7日未達成')!.click();
    });
    expect(container.textContent).toContain('7日連続で記録を続けると獲得できます');
    expect(document.querySelectorAll(INPUT_PARTS_SELECTOR)).toHaveLength(0);

    await notifyAiConsultationSucceeded();
    await settle();
    expect(callsTo(STREAKS_URL)).toBe(2);
  });

  it('健康のグラフ (/health/graphs): 目標をもう一度取り、体重の目標が無くなったら目標の線の欄を消す', async () => {
    const GOALS_URL = '/api/health/goals?status=active';
    const TARGET_WEIGHT_TEXT = '目標体重: 60kg';
    const responses: Record<string, unknown> = {
      [GOALS_URL]: { goals: [{ goal_type: 'weight', target_value: 60 }] },
    };
    const { callsTo } = installFetchMock(responses);
    await act(async () => {
      root.render(<HealthGraphsPage />);
    });
    await settle();
    expect(callsTo(GOALS_URL)).toBe(1);
    expect(container.textContent).toContain(TARGET_WEIGHT_TEXT);

    // AI 相談で体重の目標が消された
    responses[GOALS_URL] = { goals: [] };
    await notifyAiConsultationSucceeded();
    await settle();
    expect(callsTo(GOALS_URL)).toBe(2);
    expect(container.textContent).not.toContain(TARGET_WEIGHT_TEXT);
  });

  describe('栄養目標の根拠 (/profile/nutrition-targets)', () => {
    const USER_ID = '21950000-0000-4000-8000-000000000002';
    const TARGETS_URL = '/api/nutrition/targets';
    const PROFILE_URL = '/api/profile';
    const PROTEIN_BEFORE = 60;
    const PROTEIN_AFTER = 80;
    const CALORIES_BEFORE = 2000;
    const CALORIES_AFTER = 2100;
    const SAVED_TARGET_WEIGHT = 65;
    const EDITED_TARGET_WEIGHT = '60';
    const FETCH_FAILED_TEXT = 'データの取得に失敗しました';
    /** GET /api/nutrition/targets の応答 (栄養目標 1 行。src/app/api/nutrition/targets/route.ts の camelCase の形) */
    const targetsBody = (proteinG: number, dailyCalories: number) => ({
      targets: {
        id: 'nt-2195',
        dailyCalories,
        proteinG,
        fatG: 60,
        carbsG: 250,
        autoCalculate: true,
        calculationBasis: null,
        lastCalculatedAt: '2026-11-01T00:00:00Z',
      },
    });
    /** 再設定 (NutritionTargetPlanner) の目標体重の入力欄 (読み込んだあとはいつも出ている) */
    const targetWeightInput = () => container.querySelector<HTMLInputElement>('input[placeholder="例: 72"]');

    beforeEach(() => {
      supabaseMock.user = { id: USER_ID };
      supabaseMock.profileRow = { id: USER_ID, age: 30, gender: 'male', height: 170, weight: 70 };
    });

    async function renderPage() {
      await act(async () => {
        root.render(<NutritionTargetsPage />);
      });
      // ページの取得 → 再設定の描画 → 再設定の取得 (2 つの fetch を並べて待つ) まで流す
      await settle();
      await settle();
      await settle();
    }

    it('根拠と再設定の両方をもう一度取る。再設定の入力欄を変えている間は取らず、打ちかけの値を残す', async () => {
      const responses: Record<string, unknown> = {
        [TARGETS_URL]: targetsBody(PROTEIN_BEFORE, CALORIES_BEFORE),
        [PROFILE_URL]: { target_weight: SAVED_TARGET_WEIGHT, weight: 70 },
      };
      const { callsTo } = installFetchMock(responses);
      await renderPage();
      // 根拠のページと再設定が 1 回ずつ栄養目標を読む
      expect(callsTo(TARGETS_URL)).toBe(2);
      expect(callsTo(PROFILE_URL)).toBe(1);
      expect(supabaseMock.profileReads).toBe(1);
      expect(textBeside('タンパク質 (g)', 'previous')).toBe(String(PROTEIN_BEFORE));
      expect(textBeside('現在の目標', 'next')).toBe(String(CALORIES_BEFORE));
      // 再設定の入力欄はいつも出ているが、何も変えていない間は取り直しを止めない
      expect(targetWeightInput()?.value).toBe(String(SAVED_TARGET_WEIGHT));
      expect(isAiConsultationRefetchBlocked(document)).toBe(false);

      // AI 相談で栄養目標が変わった (update_nutrition_target)
      responses[TARGETS_URL] = targetsBody(PROTEIN_AFTER, CALORIES_AFTER);
      await notifyAiConsultationSucceeded();
      await settle();
      await settle();
      await settle();
      expect(callsTo(TARGETS_URL)).toBe(4);
      expect(callsTo(PROFILE_URL)).toBe(2);
      expect(supabaseMock.profileReads).toBe(2);
      expect(textBeside('タンパク質 (g)', 'previous')).toBe(String(PROTEIN_AFTER));
      expect(textBeside('現在の目標', 'next')).toBe(String(CALORIES_AFTER));

      // 目標体重を打ちかける (保存はしない): 印が外れて、取り直さない
      await act(async () => {
        typeInto(targetWeightInput()!, EDITED_TARGET_WEIGHT);
      });
      expect(targetWeightInput()!.value).toBe(EDITED_TARGET_WEIGHT);
      expect(container.querySelector(`[${AI_CONSULTATION_UNEDITED_INPUTS_ATTRIBUTE}]`)).toBeNull();
      expect(isAiConsultationRefetchBlocked(document)).toBe(true);
      await notifyAiConsultationSucceeded();
      await settle();
      expect(callsTo(TARGETS_URL)).toBe(4);
      expect(callsTo(PROFILE_URL)).toBe(2);
      expect(supabaseMock.profileReads).toBe(2);
      expect(targetWeightInput()!.value).toBe(EDITED_TARGET_WEIGHT);

      // 取得した値に戻すと、また取り直せる
      await act(async () => {
        typeInto(targetWeightInput()!, String(SAVED_TARGET_WEIGHT));
      });
      expect(isAiConsultationRefetchBlocked(document)).toBe(false);
    });

    it('最初の取得に失敗した画面も、AI 相談の成功で取り直して戻す', async () => {
      let failTargets = true;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url === TARGETS_URL) {
            if (failTargets) throw new TypeError('Failed to fetch');
            return Response.json(targetsBody(PROTEIN_BEFORE, CALORIES_BEFORE));
          }
          if (url === PROFILE_URL) return Response.json({ target_weight: SAVED_TARGET_WEIGHT, weight: 70 });
          return new Response('{}', { status: 404 });
        }),
      );
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await renderPage();
      expect(container.textContent).toContain(FETCH_FAILED_TEXT);

      failTargets = false;
      await notifyAiConsultationSucceeded();
      await settle();
      await settle();
      await settle();
      expect(container.textContent).not.toContain(FETCH_FAILED_TEXT);
      expect(textBeside('タンパク質 (g)', 'previous')).toBe(String(PROTEIN_BEFORE));
    });
  });

  it('バッジ (/badges): バッジをもう一度取り、新しく取ったバッジを出す。詳細のモーダルが開いていれば取らない', async () => {
    const BADGES_URL = '/api/badges';
    const BADGE_CODE = 'first_bite';
    const NEW_BADGE_TEXT = '新しいバッジを獲得！';
    /** GET /api/badges の行 (バッジのマスター + earned。src/app/api/badges/route.ts) */
    const badgeRow = (earned: boolean) => ({
      id: 'badge-2195',
      code: BADGE_CODE,
      name: 'はじめの一口',
      description: '食事を 1 回記録する',
      earned,
      obtainedAt: earned ? '2026-11-03T00:00:00Z' : undefined,
      periodAwards: null,
    });
    const responses: Record<string, unknown> = {
      [BADGES_URL]: { badges: [badgeRow(false)], newEarnedCount: 0, newEarnedBadgeCodes: [] },
    };
    const { callsTo } = installFetchMock(responses);
    await act(async () => {
      root.render(<BadgesPage />);
    });
    await settle();
    expect(callsTo(BADGES_URL)).toBe(1);
    expect(container.textContent).not.toContain(NEW_BADGE_TEXT);

    // AI 相談で食事を完了にした (complete_meal) ので、GET /api/badges がその場でバッジを取らせる
    responses[BADGES_URL] = { badges: [badgeRow(true)], newEarnedCount: 1, newEarnedBadgeCodes: [BADGE_CODE] };
    await notifyAiConsultationSucceeded();
    await settle();
    expect(callsTo(BADGES_URL)).toBe(2);
    expect(container.textContent).toContain(NEW_BADGE_TEXT);
    // お祝いの知らせ (role="status"。操作を受けない) は取り直しを止めない
    expect(document.querySelector('[role="status"]')?.textContent).toContain(NEW_BADGE_TEXT);
    expect(isAiConsultationRefetchBlocked(document)).toBe(false);

    // バッジの詳細のモーダル (role="dialog") を開く
    await act(async () => {
      container.querySelector<HTMLElement>(`[data-badge-code="${BADGE_CODE}"]`)!.click();
    });
    expect(document.querySelector('[data-testid="badge-detail-modal"]')).not.toBeNull();
    await notifyAiConsultationSucceeded();
    await settle();
    expect(callsTo(BADGES_URL)).toBe(2);
  });
});

/**
 * 描画の重いページ (献立表は 6,000 行を超え、ホーム・健康は Supabase の取得が多い) は、ページが既存の取得の関数を
 * 受け手に渡していることをソースで確かめる (受け手の動きそのものは上の useAiConsultationDataRefetch のテストで確かめる)。
 * マイページは、上で描画して編集のモーダルが取り直しを止めることも確かめている。
 * 献立表が取り直して出すもの (生成中の依頼の監視・買い物リスト・月のカレンダー・人数の設定・家族の切り替えの名前) は、
 * tests/ai-consultation-weekly-refetch-2195.test.tsx が献立表を描画して確かめる
 */
describe('受け手の配線 (#2195 V1)', () => {
  /** 旧の hook (src/hooks/useAiConsultationDataRefetch.ts) の import。段 F で消す (#2206 G1 §17 G-5) */
  const HOOK_IMPORT = /from "@\/hooks\/useAiConsultationDataRefetch";/;
  /**
   * 配線の行。hookImport は、そのページが hook をどこから import するか (移行前は旧の HOOK_IMPORT。移行した段は新しい hook の import に替える)。
   * 行は受け手の段 (#2206 G1 §16) ごとの配列に分ける。各段は自分の段の配列の行だけを書き換える (並行する段の取り込みで同じ行を触らない)
   */
  interface WiringRow {
    readonly page: string;
    readonly file: string;
    readonly hookImport: RegExp;
    readonly wiring: RegExp;
  }

  // 段 B
  const WIRING_STAGE_B: readonly WiringRow[] = [
    {
      page: '比較 (/comparison): 取得の useEffect の依存に数を足す',
      file: 'src/app/(main)/comparison/page.tsx',
      hookImport: HOOK_IMPORT,
      wiring: /const \{ refetchKey: aiConsultationRefetchKey \} = useAiConsultationRefetchKey\(\);[\s\S]*?\}, \[periodType, aiConsultationRefetchKey, takeAiConsultationRefetchRun\]\);/,
    },
    {
      page: '冷蔵庫 (/pantry): fetchItems',
      file: 'src/app/(main)/pantry/page.tsx',
      hookImport: HOOK_IMPORT,
      // 取り直しの読み方は refetchReadMode (開いたときの読み込み中に始まった取り直しは 'mount'。#2201 U1 + U2)
      wiring: /useAiConsultationDataRefetch\(\s*\(ticket\) => fetchItems\(ticket, refetchReadMode\(\)\),\s*\{ writeInFlightRef: pendingWrites \},\s*\);/,
    },
    {
      page: '健康目標 (/health/goals): fetchGoals',
      file: 'src/app/(main)/health/goals/page.tsx',
      hookImport: HOOK_IMPORT,
      wiring: /useAiConsultationDataRefetch\(\s*\(ticket\) => fetchGoals\(ticket, refetchReadMode\(\)\),\s*\{ writeInFlightRef: pendingWrites \},\s*\);/,
    },
    {
      // 依存の profileReloadKey は、開いたときの読み込みに失敗したあとの「再読み込み」の数 (#2206 G5)
      page: 'マイページ (/profile): 取得の useEffect の依存に数を足す',
      file: 'src/app/(main)/profile/page.tsx',
      hookImport: HOOK_IMPORT,
      wiring: /const \{ refetchKey: aiConsultationRefetchKey, refetchTicket: aiConsultationRefetchTicket \} = useAiConsultationRefetchKey\(\);[\s\S]*?useEffect\(\(\) => \{[\s\S]*?const getData = async \(\) => \{[\s\S]*?void getData\(\);[\s\S]*?\}, \[aiConsultationRefetchKey, profileReloadKey, takeAiConsultationRefetchRun, aiConsultationRefetchTicket\]\);/,
    },
  ];

  // 段 C
  const WIRING_STAGE_C: readonly WiringRow[] = [
    {
      page: '健康 (/health): fetchData と、出している選んだ日のパネルの記録',
      file: 'src/app/(main)/health/page.tsx',
      hookImport: HOOK_IMPORT,
      // 取り直しの読み方は refetchReadMode (開いたときの読み込み中に始まった取り直しは 'mount'。#2201 U1)。
      // 選んだ日のパネルの読み直しは、日を選んだときの読み取りと同じ取得の流れ (selectedDateFetchStream) で置く (#2201 U1)
      wiring: /await Promise\.all\(\[fetchData\(ticket, refetchReadMode\(\)\), reloadSelectedDate\(\)\]\);\s*\}, \[fetchData, refetchReadMode, selectedDateFetchStream\]\);[\s\S]*?useAiConsultationDataRefetch\(refetchAfterAiConsultation\);/,
    },
  ];

  // 段 D
  const WIRING_STAGE_D: readonly WiringRow[] = [
    {
      // 受け手は useHomeData (#2206 G1 段 D。home/page.tsx は hook を呼ばない)。取り直し (refetchHome) は同じ取り直しの読み取りで
      // 分析を AI を付けずに読み始め、ページの読み取り (fetchHomeData) は全画面の読み込み中の鍵を立てて主のデータを読む
      page: 'ホーム (/home): useHomeData の refetchHome と fetchHomeData',
      file: 'src/hooks/useHomeData.ts',
      hookImport: /from "@\/hooks\/useAiConsultationReceiver";/,
      wiring:
        /const refetchHome = \(read: AiConsultationRead\) =>\s*readHomeData\(read, \(refetchRead, userId\) => \{\s*void fetchNutritionAnalysis\(refetchRead, \{ analysisWithoutAi: true \}\);\s*void fetchPerformanceAnalysis\(userId, refetchRead\);\s*\}\);[\s\S]*?const receiver = useAiConsultationReceiver\(refetchHome, \{ initialLoadingKeys: \[KEY_HOME_LOADING\] \}\);[\s\S]*?const fetchHomeData = \(\) =>\s*receiver\.read\(\{ loadingKeys: \[KEY_HOME_LOADING\] \}, \(read\) =>\s*readHomeData\(read,/,
    },
  ];

  // 段 E
  const WIRING_STAGE_E: readonly WiringRow[] = [
    {
      page: '献立表 (/menus/weekly): 表示中の週・冷蔵庫・人数の設定・家族の一覧と名前を取り直し、週のキャッシュ (捨てる前に読み始めた応答も書かない discard。#2201 U1) と取得済みの範囲を捨ててから回数を増やす (どれにも取り直しの札を渡す。#2201 U2)',
      file: 'src/app/(main)/menus/weekly/page.tsx',
      hookImport: HOOK_IMPORT,
      wiring:
        /const refetchAfterAiConsultation = useCallback\(\(ticket: AiConsultationFetchTicket\) => \{\s*weekDataCache\.current\.discard\(\);\s*fetchedRangesRef\.current\.clear\(\);\s*aiConsultationRefetchTicketRef\.current = ticket;\s*void refreshMealPlan\(ticket\);\s*void fetchPantry\(ticket\);\s*void fetchUserSettings\(ticket\);\s*void loadFamilyData\('refetch', ticket\);\s*setAiConsultationRefetchRound\(\(round\) => round \+ 1\);\s*\}, \[refreshMealPlan, fetchPantry, fetchUserSettings, loadFamilyData\]\);\s*useAiConsultationDataRefetch\(refetchAfterAiConsultation, \{ writeInFlightRef: pendingWrites \}\);/,
    },
  ];

  const WIRING: readonly WiringRow[] = [...WIRING_STAGE_B, ...WIRING_STAGE_C, ...WIRING_STAGE_D, ...WIRING_STAGE_E];
  it.each(WIRING)('$page', ({ file, hookImport, wiring }) => {
    const source = readRepoFile(file);
    expect(source).toMatch(hookImport);
    expect(source).toMatch(wiring);
  });

  it('献立表の pantry・人数の設定の取得は、初めの取得と取り直しで同じ関数', () => {
    const source = readRepoFile('src/app/(main)/menus/weekly/page.tsx');
    // 取り直しのときだけ札を渡す (#2201 U2。初めの取得は札なし)。初めの取得と取り直しは同じ取得の流れで始める (#2201 U1。
    // 初めの取得の応答が取り直しの応答より後に届いても、古い答えで上書きしない)
    expect(source).toMatch(
      /const fetchPantry = useCallback\(async \(refetchTicket: AiConsultationFetchTicket \| null = null\) => \{\s*const order = pantryFetchStream\.begin\(refetchTicket\);\s*try \{\s*const res = await fetch\('\/api\/pantry'\);/,
    );
    expect(source).toMatch(/useEffect\(\(\) => \{\s*void fetchPantry\(\);\s*\}, \[fetchPantry\]\);/);
    expect(source).toMatch(
      /const fetchUserSettings = useCallback\(async \(refetchTicket: AiConsultationFetchTicket \| null = null\) => \{\s*const order = settingsFetchStream\.begin\(refetchTicket\);[\s\S]*?const res = await fetch\('\/api\/profile'\);/,
    );
    expect(source).toMatch(/useEffect\(\(\) => \{\s*void fetchUserSettings\(\);\s*\}, \[fetchUserSettings\]\);/);
  });
});

/**
 * 受け手のページの中に直接書いたモーダル (fixed inset-0 の覆い) は role="dialog" と aria-modal="true" を持つ。
 * 番兵 (isAiConsultationRefetchBlocked) はモーダルを role・aria-modal で見分けるので、中に入力の部品が無い状態
 * (マイページの編集の競技タブ・削除の確認・バッジの詳細など) でもモーダルが開いている間は取り直さない。
 * 別の部品に切り出したモーダル (<…Modal />。献立表の各モーダル・ConfirmDeleteModal) は部品の側が BottomSheet などで役割を持つ
 */
describe('受け手のページのモーダルは role="dialog" を持つ (#2195 V1)', () => {
  /** 受け手のページと、その中に直接書いた覆い (fixed inset-0) の数。数を書くのは、覆いを見落として検査が素通りしないため */
  const RECEIVER_PAGES: ReadonlyArray<{ file: string; overlays: number }> = [
    // 中身は別の部品のモーダル (activeModal の覆い) と、生成の結果のダイアログの覆い 2 つ
    { file: 'src/app/(main)/menus/weekly/page.tsx', overlays: 3 },
    { file: 'src/app/(main)/home/page.tsx', overlays: 1 },
    { file: 'src/app/(main)/comparison/page.tsx', overlays: 0 },
    { file: 'src/app/(main)/pantry/page.tsx', overlays: 1 },
    { file: 'src/app/(main)/health/page.tsx', overlays: 1 },
    { file: 'src/app/(main)/health/goals/page.tsx', overlays: 3 },
    { file: 'src/app/(main)/health/streaks/page.tsx', overlays: 1 },
    { file: 'src/app/(main)/health/graphs/page.tsx', overlays: 0 },
    { file: 'src/app/(main)/profile/page.tsx', overlays: 1 },
    { file: 'src/app/(main)/profile/nutrition-targets/page.tsx', overlays: 0 },
    { file: 'src/app/(main)/meals/[id]/page.tsx', overlays: 1 },
    // バッジの詳細のモーダルと、新しく取ったバッジのお祝い (操作を受けない知らせ。role="status")
    { file: 'src/app/(main)/badges/page.tsx', overlays: 2 },
  ];
  const OVERLAY = 'fixed inset-0';
  /** 操作を受けない知らせの覆い (モーダルではない)。覆いの要素の開きタグで、className より前に書く */
  const ANNOUNCEMENT_ROLE = 'role="status"';
  const NOT_INTERACTIVE = 'pointer-events-none';
  const OPEN_PRESENCE = '<AnimatePresence';
  const CLOSE_PRESENCE = '</AnimatePresence>';
  const SEPARATE_MODAL_COMPONENT = /<[A-Z]\w*Modal\b/;

  it.each(RECEIVER_PAGES)('$file', ({ file, overlays }) => {
    const source = readRepoFile(file);
    expect(source, '受け手のページではない').toMatch(/useAiConsultation(DataRefetch|RefetchKey)\(/);
    let checked = 0;
    for (let at = source.indexOf(OVERLAY); at !== -1; at = source.indexOf(OVERLAY, at + OVERLAY.length)) {
      const start = source.lastIndexOf(OPEN_PRESENCE, at);
      const end = source.indexOf(CLOSE_PRESENCE, at);
      expect(start, `${file} の ${OVERLAY} が AnimatePresence の外にある`).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(at);
      const block = source.slice(start, end);
      checked += 1;
      if (SEPARATE_MODAL_COMPONENT.test(block)) continue;
      const line = source.slice(0, at).split('\n').length;
      // 覆いの要素の開きタグの、className までの部分と className の値
      const openingTag = source.slice(source.lastIndexOf('<', at), at);
      const classNameValue = source.slice(at, source.indexOf('"', at));
      if (openingTag.includes(ANNOUNCEMENT_ROLE)) {
        // 知らせの覆いは操作を受けない (下のページを押せる)。モーダルとして数えないので、取り直しも止めない
        expect(classNameValue, `${file}:${line} の知らせの覆いが操作を受ける (${NOT_INTERACTIVE} が無い)`).toContain(NOT_INTERACTIVE);
        continue;
      }
      expect(block, `${file}:${line} のモーダルに role="dialog" が無い`).toContain('role="dialog"');
      expect(block, `${file}:${line} のモーダルに aria-modal="true" が無い`).toContain('aria-modal="true"');
    }
    expect(checked, `${file} の覆いの数が変わった (新しいモーダルなら role="dialog" を付け、この表の数を直す)`).toBe(overlays);
  });
});
