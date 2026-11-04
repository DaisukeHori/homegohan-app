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
 *     健康のグラフ・バッジ) は useAiConsultationReceiver (#2206 G1 で受け手の hook を移した) でこの通知を受け、ページの既存の取得をもう一度呼ぶ (ページ全体の reload はしない)
 *   - 入力の部品・開いているモーダルがページにある間は取り直さない。ただし AI 相談の吹き出しの中 (MainLayout が
 *     data-ai-consultation-chat-root で包む) は数えない (吹き出しは送信の入力欄を持ったまま成功を知らせるため)
 *   - 入力欄がいつも出ている部品 (栄養目標の再設定) は、入力欄の値が取得した値のままの間だけ data-ai-consultation-unedited-inputs で
 *     包み、その中の入力の部品は数えない (付けないとページが一度も取り直せない。入力欄を変えたら印を外して止める)
 *   - 受け手のページのモーダルは role="dialog" を持つ (中に入力の部品が無い状態 — マイページの編集の競技タブなど — でも止めるため)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, useState } from 'react';
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
    const { fetchMock, callsTo } = installFetchMock(responses);
    // 記録と健診は読めて 0 件 (道に日付が付くので道の頭で答える)。読めないと目標との比較の欄を出さない (#2227 H3)
    const READ_OK_EMPTY: ReadonlyArray<{ prefix: string; body: unknown }> = [
      { prefix: '/api/health/records?', body: { records: [] } },
      { prefix: '/api/health/checkups?', body: { checkups: [] } },
    ];
    vi.stubGlobal('fetch', async (input: unknown) => {
      const empty = READ_OK_EMPTY.find(({ prefix }) => String(input).startsWith(prefix));
      return empty ? Response.json(empty.body) : fetchMock(input);
    });
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
 * 受け手に渡していることをソースで確かめる (受け手の動きそのものは tests/ai-consultation-receiver-2206.test.tsx で確かめる)。
 * マイページは、上で描画して編集のモーダルが取り直しを止めることも確かめている。
 * 献立表が取り直して出すもの (生成中の依頼の監視・買い物リスト・月のカレンダー・人数の設定・家族の切り替えの名前) は、
 * tests/ai-consultation-weekly-refetch-2195.test.tsx が献立表を描画して確かめる
 */
describe('受け手の配線 (#2195 V1)', () => {
  /** 受け手の hook (src/hooks/useAiConsultationReceiver.ts) の import。どの配線の行のファイルもこれを持つ (#2206 G1 §17 G-5) */
  const RECEIVER_HOOK_IMPORT = /from "@\/hooks\/useAiConsultationReceiver";/;
  /** 配線の行 */
  interface WiringRow {
    readonly page: string;
    readonly file: string;
    readonly wiring: RegExp;
  }

  const WIRING: readonly WiringRow[] = [
    {
      // 取り直しは表示中の期間 (periodTypeRef) を読む。開いたとき・期間の切り替えの読み取りだけが中断の印 (signal) を渡す
      page: '比較 (/comparison): 開いたとき・期間の切り替えは表示中の期間の鍵で読み込み中にし、取り直しは表示中の期間を読む',
      file: 'src/app/(main)/comparison/page.tsx',
      wiring: /const receiver = useAiConsultationReceiver\(\(read\) => readRankings\(read, periodTypeRef\.current\), \{\s*initialLoadingKeys: \[rankingsKey\(INITIAL_PERIOD_TYPE\)\],\s*\}\);[\s\S]*?void receiver\.read\(\{ loadingKeys: \[rankingsKey\(periodType\)\] \}, \(read\) => readRankings\(read, periodType, controller\.signal\)\);\s*return \(\) => controller\.abort\(\);\s*\}, \[periodType, receiver, readRankings\]\);/,
    },
    {
      page: '冷蔵庫 (/pantry): fetchItems',
      file: 'src/app/(main)/pantry/page.tsx',
      wiring: /const receiver = useAiConsultationReceiver\(fetchItems, \{ initialLoadingKeys: \[KEY_ITEMS\] \}\);[\s\S]*?useEffect\(\(\) => \{\s*void receiver\.read\(\{ loadingKeys: \[KEY_ITEMS\] \}, fetchItems\);\s*\}, \[receiver, fetchItems\]\);/,
    },
    {
      page: '健康目標 (/health/goals): fetchGoals',
      file: 'src/app/(main)/health/goals/page.tsx',
      wiring: /const receiver = useAiConsultationReceiver\(fetchGoals, \{ initialLoadingKeys: \[KEY_GOALS\] \}\);[\s\S]*?useEffect\(\(\) => \{\s*void receiver\.read\(\{ loadingKeys: \[KEY_GOALS\] \}, fetchGoals\);\s*\}, \[receiver, fetchGoals\]\);/,
    },
    {
      // 「再読み込み」は開いたときと同じ読み取り (#2206 G5 の profileReloadKey の数は消した)
      page: 'マイページ (/profile): readProfile (開いたとき・「再読み込み」・取り直し)',
      file: 'src/app/(main)/profile/page.tsx',
      wiring: /const receiver = useAiConsultationReceiver\(readProfile, \{ initialLoadingKeys: \[KEY_PROFILE\] \}\);[\s\S]*?useEffect\(\(\) => \{\s*void receiver\.read\(\{ loadingKeys: \[KEY_PROFILE\] \}, readProfile\);\s*\}, \[receiver, readProfile\]\);[\s\S]*?onClick=\{\(\) => void receiver\.read\(\{ loadingKeys: \[KEY_PROFILE\] \}, readProfile\)\}/,
    },
    {
      page: '健康 (/health): fetchData と、出している選んだ日のパネルの記録',
      file: 'src/app/(main)/health/page.tsx',
      // 取り直しは開いたときに読むもの (fetchData) と、出している選んだ日のパネルの記録 (日を選んだときと同じ readSelectedDateRecord) を
      // 同じ read で読む。開いたときの読み込みは画面全体の読み込み中の鍵を立てる (最初の描画からも立てる。#2206 G1 §9 #12)
      wiring: /await Promise\.all\(\[fetchData\(read\), date === null \? undefined : readSelectedDateRecord\(read, date\)\]\);\s*\}, \[fetchData, readSelectedDateRecord\]\);[\s\S]*?const receiver = useAiConsultationReceiver\(refetchAfterAiConsultation, \{ initialLoadingKeys: HEALTH_PAGE_LOADING_KEYS \}\);[\s\S]*?void receiver\.read\(\{ loadingKeys: HEALTH_PAGE_LOADING_KEYS \}, fetchData\);/,
    },
    {
      // 受け手は useHomeData (#2206 G1 段 D。home/page.tsx は hook を呼ばない)。取り直し (refetchHome) は同じ取り直しの読み取りで
      // 分析を AI を付けずに読み始め、ページの読み取り (fetchHomeData) は全画面の読み込み中の鍵を立てて主のデータを読む。
      // 分析はその読み取りの今日 (readHomeData が始めに 1 回読んだ JST の今日) で読む (#2245 K2)
      page: 'ホーム (/home): useHomeData の refetchHome と fetchHomeData',
      file: 'src/hooks/useHomeData.ts',
      wiring:
        /const refetchHome = \(read: AiConsultationRead\) =>\s*readHomeData\(read, \(refetchRead, userId, today\) => \{\s*void fetchNutritionAnalysis\(refetchRead, \{ analysisWithoutAi: true \}\);\s*void fetchPerformanceAnalysis\(userId, refetchRead, today\);\s*\}\);[\s\S]*?const receiver = useAiConsultationReceiver\(refetchHome, \{ initialLoadingKeys: \[KEY_HOME_LOADING\] \}\);[\s\S]*?const fetchHomeData = \(\) =>\s*receiver\.read\(\{ loadingKeys: \[KEY_HOME_LOADING\] \}, \(read\) =>\s*readHomeData\(read,/,
    },
    {
      page: '献立表 (/menus/weekly): 週のキャッシュ (捨てる前に読み始めた応答も書かない discard。#2201 U1) と取得済みの月を捨て、生成中の依頼を確かめ、表示中の週・冷蔵庫・人数の設定・家族の一覧と名前・月のカレンダーの印を同じ取り直しの読み取りで読む (#2206 G1)',
      file: 'src/app/(main)/menus/weekly/page.tsx',
      wiring:
        /const refetchAfterAiConsultation = useCallback\(async \(read: AiConsultationRead\) => \{\s*weekDataCache\.current\.discard\(\);\s*fetchedMonthsRef\.current\.clear\(\);[\s\S]*?void checkPendingRequests\(weekStartKeyRef\.current\);\s*await Promise\.all\(\[\s*readDisplayedWeek\(read, WEEK_PLACEMENT_REREAD\),\s*fetchPantry\(read\),\s*fetchUserSettings\(read\),\s*loadFamilyData\(read\),\s*fetchAndCacheMealDates\(read, \.\.\.weekWindowOf\(weekStartRef\.current\)\),\s*fetchAndCacheMealDates\(read, \.\.\.monthWindowOf\(displayMonthRef\.current\)\),\s*\]\);\s*\}, \[readDisplayedWeek, fetchPantry, fetchUserSettings, loadFamilyData, fetchAndCacheMealDates, checkPendingRequests\]\);[\s\S]*?const receiver = useAiConsultationReceiver\(refetchAfterAiConsultation, \{ initialLoadingKeys: \[KEY_WEEK_LOADING\] \}\);/,
    },
  ];

  it.each(WIRING)('$page', ({ file, wiring }) => {
    const source = readRepoFile(file);
    expect(source).toMatch(RECEIVER_HOOK_IMPORT);
    expect(source).toMatch(wiring);
  });

  it('献立表の pantry・人数の設定の取得は、初めの取得と取り直しで同じ関数', () => {
    const source = readRepoFile('src/app/(main)/menus/weekly/page.tsx');
    // 読み取りの関数は read (#2206 G1。開いたときは receiver.read が渡す 'mount'、取り直しは hook が渡す 'refetch') を受け取り、
    // 応答は read.place で置く (古い応答・取り直しの番兵の判断は place の中)。開いたときの effect は receiver.read で始める
    expect(source).toMatch(
      /const fetchPantry = useCallback\(async \(read: AiConsultationRead\) => \{\s*try \{\s*const res = await fetch\('\/api\/pantry'\);/,
    );
    expect(source).toMatch(/useEffect\(\(\) => \{\s*void receiver\.read\(\{\}, fetchPantry\);\s*\}, \[receiver, fetchPantry\]\);/);
    expect(source).toMatch(
      /const fetchUserSettings = useCallback\(async \(read: AiConsultationRead\) => \{[\s\S]*?const res = await fetch\('\/api\/profile'\);/,
    );
    expect(source).toMatch(/useEffect\(\(\) => \{\s*void receiver\.read\(\{ loadingKeys: \[KEY_SETTINGS\] \}, fetchUserSettings\);\s*\}, \[receiver, fetchUserSettings\]\);/);
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
    // 受け手は useAiConsultationReceiver を呼ぶ (#2206 G1)。/home は useHomeData が受け手で、ページは useHomeData() を呼ぶ
    expect(source, '受け手のページではない').toMatch(/useAiConsultationReceiver\(|useHomeData\(\)/);
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
