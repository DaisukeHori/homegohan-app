/**
 * #2206 G1: AI 相談の成功の取り直しの受け手の hook (src/hooks/useAiConsultationReceiver.ts) の単体。
 * 設計書の正本は docs/design/cross/26-ai-consultation-refetch-receivers.md (§7.1 の正典コード・§8 の facade 契約・§13.1 の T-1〜T-28)。
 *
 * 確かめること (hook の中だけで判断すること):
 *   - 順序: 鍵ごとに「置いた世代」より古い読み取りの応答は 'superseded' (newerThanPlaced。失敗した読み取りは何も置かないので、
 *     先に始めた開いたときの読み取りの応答も置ける)
 *   - 番兵: 取り直し (mode 'refetch') だけが、置く時点の番兵・書き込み中・始めたあとの書き込みで 'deferred' (止めた通知の印は 1 回)
 *   - 読み込み中の印 (loadingKeys・initialLoadingKeys)・書き込みの窓 (beginWrite・html の data-ai-consultation-writes)・
 *     止めた通知 (外れたら 1 回)・生成の受付の見張り・失敗を握る・receiver の参照が一生同じ
 * T-23 (モバイルの止める要素と Web の番兵の並びの一致) は tests/ai-consultation-data-refetch-2195.test.tsx の
 * 「モバイルの読み込み直しの番兵と同じ並び」の節にある (§17 G-2)。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する (renderHook の代わりに小さな部品で hook を呼ぶ)。
 */
import { act, useCallback, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AiConsultationPlaceResult,
  AiConsultationRead,
  AiConsultationReadFn,
  AiConsultationReceiver,
  AiConsultationReceiverOptions,
} from '@/hooks/useAiConsultationReceiver';

/** 生成の見張りの呼び出し (受付の通知で hook が見張りを始めたか・終わったときに呼ぶ関数・やめる関数) */
const generationWatch = vi.hoisted(() => ({
  calls: [] as { requestId: string; onSettled: () => void; stopped: boolean }[],
}));
vi.mock('@/lib/ai/consultation-generation-watch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/consultation-generation-watch')>();
  return {
    ...actual,
    // 状態の確認 (fetch とタイマー) は tests/ai-consultation-generation-watch-2195.test.tsx が確かめる。ここでは hook が見張りを
    // 始めること・終わったら取り直すこと・離れたらやめることだけを見る
    watchAiConsultationGeneration: (requestId: string, onSettled: () => void) => {
      const call = { requestId, onSettled, stopped: false };
      generationWatch.calls.push(call);
      return () => {
        call.stopped = true;
      };
    },
  };
});

const { AI_CONSULTATION_DATA_CHANGED_EVENT } = await import('@/lib/ai/consultation-data-refetch');
const { AI_CONSULTATION_GENERATION_ACCEPTED_STATUS } = await import('@/lib/ai/consultation-generation-watch');
const { AI_CONSULTATION_WRITES_ATTRIBUTE, aiConsultationDocumentWriteCountForTests, useAiConsultationReceiver } = await import(
  '@/hooks/useAiConsultationReceiver'
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 投げる側 (src/components/AIChatBubble.tsx) と同じ名前を手で書いた期待値 */
const EXPECTED_EVENT_NAME = 'mealPlanUpdated';
/** 置き場所の鍵 (テストの中だけの名前) */
const KEY = 'items';
const OTHER_KEY = 'other';
/** 生成の受付の依頼の id (テストの中だけの値) */
const REQUEST_ID = 'request-1';

let container: HTMLDivElement;
let root: Root;
/** テストが document.body に足した要素 (モーダル・入力欄)。後片付けで消す */
let extraElements: HTMLElement[];

beforeEach(() => {
  extraElements = [];
  generationWatch.calls.length = 0;
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
  vi.restoreAllMocks();
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 止めた Promise の続き・DOM の見張り (MutationObserver は microtask で知らせる) を流しきる */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** AI 相談の成功を知らせる (AIChatBubble と同じ形) */
async function notify(detail: unknown = { actionType: 'update_meal', result: {} }, eventName: string = AI_CONSULTATION_DATA_CHANGED_EVENT) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(eventName, { detail }));
  });
  await flush();
}

/** ページの外のモーダル (番兵が止める要素) を開く。返す関数で閉じる */
async function openModal(): Promise<() => Promise<void>> {
  const modal = document.createElement('div');
  modal.setAttribute('role', 'dialog');
  await act(async () => {
    document.body.appendChild(modal);
  });
  extraElements.push(modal);
  return async () => {
    await act(async () => {
      modal.remove();
    });
    await flush();
  };
}

/**
 * 取り直しの関数。呼ばれるたびに読み取り (read) を記録し、テストが解くまで止まる (gate)。
 * 解いたあとに onReleased (place を呼ぶ処理) を走らせる
 */
function controlledRefetch() {
  const calls: { read: AiConsultationRead; gate: Deferred<void> }[] = [];
  const fn = vi.fn(async (read: AiConsultationRead) => {
    const gate = deferred();
    calls.push({ read, gate });
    await gate.promise;
  });
  return { fn, calls };
}

interface Probe {
  /** 最後の描画の receiver */
  readonly receiver: AiConsultationReceiver;
  /** 描画ごとの receiver (参照の同一性を見る) */
  readonly receivers: AiConsultationReceiver[];
  /** 描画ごとの isLoading(watchKey) の値 */
  readonly loadingByRender: boolean[];
}

/** hook を呼ぶだけの部品 (renderHook の代わり)。描画のたびに receiver と isLoading(watchKey) を記録する */
function HookProbe({
  refetch,
  options,
  watchKey,
  onRender,
}: {
  refetch: AiConsultationReadFn;
  options?: AiConsultationReceiverOptions;
  watchKey: string;
  onRender: (receiver: AiConsultationReceiver, loading: boolean) => void;
}) {
  const receiver = useAiConsultationReceiver(refetch, options);
  onRender(receiver, receiver.isLoading(watchKey));
  return null;
}

async function renderReceiver(
  refetch: AiConsultationReadFn,
  options?: AiConsultationReceiverOptions,
  watchKey: string = KEY,
  target: Root = root,
): Promise<Probe> {
  const receivers: AiConsultationReceiver[] = [];
  const loadingByRender: boolean[] = [];
  await act(async () => {
    target.render(
      <HookProbe
        refetch={refetch}
        options={options}
        watchKey={watchKey}
        onRender={(receiver, loading) => {
          receivers.push(receiver);
          loadingByRender.push(loading);
        }}
      />,
    );
  });
  return {
    get receiver() {
      const last = receivers[receivers.length - 1];
      if (last === undefined) throw new Error('hook が一度も描画されていない');
      return last;
    },
    receivers,
    loadingByRender,
  };
}

/**
 * ページの読み取りを 1 つ始め (mode 'mount')、テストが解くまで止める。解いたあとに読み取りの終わり (fn の終わり) まで流す
 */
async function startPageRead(receiver: AiConsultationReceiver, loadingKeys: readonly string[] = []) {
  const gate = deferred();
  let captured: AiConsultationRead | null = null;
  let done: Promise<void> = Promise.resolve();
  await act(async () => {
    done = receiver.read({ loadingKeys }, async (read) => {
      captured = read;
      await gate.promise;
    });
  });
  const read = captured as AiConsultationRead | null;
  if (read === null) throw new Error('ページの読み取りが始まっていない');
  return {
    read,
    /** 読み取りの fn を終える (読み取りの終わり。立てた読み込み中の印を下ろす) */
    finish: async () => {
      gate.resolve();
      await act(async () => {
        await done;
      });
    },
  };
}

/** place を act の中で呼ぶ (置いたら読み込み中の印が変わって描画し直すため) */
async function placeIn(read: AiConsultationRead, key: string, apply: () => void = () => undefined): Promise<AiConsultationPlaceResult> {
  let result: AiConsultationPlaceResult | null = null;
  await act(async () => {
    result = read.place(key, apply);
  });
  if (result === null) throw new Error('place が結果を返していない');
  return result;
}

describe('useAiConsultationReceiver の取り直しと順序 (#2206 G1)', () => {
  it("AI 相談の成功を受けたら refetch を 1 回呼ぶ (mode は 'refetch')", async () => {
    const refetch = vi.fn();
    await renderReceiver(refetch);
    expect(refetch).not.toHaveBeenCalled();

    await notify();
    expect(refetch).toHaveBeenCalledTimes(1);
    expect((refetch.mock.calls[0][0] as AiConsultationRead).mode).toBe('refetch');

    await notify();
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("続けて 2 回の成功の、先の取り直しの応答が後から届いても置かない (同じ鍵で新しい世代が置いたあとは 'superseded')", async () => {
    const refetch = controlledRefetch();
    await renderReceiver(refetch.fn);
    await notify();
    await notify();
    expect(refetch.calls).toHaveLength(2);
    const [first, second] = refetch.calls;

    const applied: string[] = [];
    expect(await placeIn(second.read, KEY, () => applied.push('second'))).toBe('placed');
    expect(await placeIn(first.read, KEY, () => applied.push('first'))).toBe('superseded');
    expect(applied).toEqual(['second']);
  });

  it('先の取り直しの応答が先に届けば置き、後の取り直しで置き換える', async () => {
    const refetch = controlledRefetch();
    await renderReceiver(refetch.fn);
    await notify();
    await notify();
    const [first, second] = refetch.calls;

    const applied: string[] = [];
    expect(await placeIn(first.read, KEY, () => applied.push('first'))).toBe('placed');
    expect(await placeIn(second.read, KEY, () => applied.push('second'))).toBe('placed');
    expect(applied).toEqual(['first', 'second']);
  });

  it('開いたときの読み取りの応答待ちに始まった取り直しが失敗しても、開いたときの応答を置き、読み込み中の表示を下ろす', async () => {
    const refetch = controlledRefetch();
    const probe = await renderReceiver(refetch.fn);
    const mount = await startPageRead(probe.receiver, [KEY]);
    expect(probe.receiver.isLoading(KEY)).toBe(true);

    // 取り直しが始まり、失敗する (mode 'refetch' の失敗は何も置かない)
    await notify();
    expect(refetch.calls).toHaveLength(1);
    refetch.calls[0].gate.resolve();
    await flush();
    expect(probe.receiver.isLoading(KEY)).toBe(true);

    const applied: string[] = [];
    expect(await placeIn(mount.read, KEY, () => applied.push('mount'))).toBe('placed');
    expect(applied).toEqual(['mount']);
    expect(probe.receiver.isLoading(KEY)).toBe(false);
    expect(probe.loadingByRender[probe.loadingByRender.length - 1]).toBe(false);
    await mount.finish();
    expect(probe.receiver.isLoading(KEY)).toBe(false);
  });

  it('開いたときの応答待ちに取り直しの応答が先に届いたら置いて読み込み中を下ろし、あとから届いた開いたときの応答は置かない', async () => {
    const refetch = controlledRefetch();
    const probe = await renderReceiver(refetch.fn);
    const mount = await startPageRead(probe.receiver, [KEY]);
    await notify();
    const [refetchRead] = refetch.calls;

    const applied: string[] = [];
    expect(await placeIn(refetchRead.read, KEY, () => applied.push('refetch'))).toBe('placed');
    expect(probe.receiver.isLoading(KEY)).toBe(false);
    expect(await placeIn(mount.read, KEY, () => applied.push('mount'))).toBe('superseded');
    expect(applied).toEqual(['refetch']);
    await mount.finish();
    expect(probe.receiver.isLoading(KEY)).toBe(false);
  });

  it('同じ読み取りが同じ鍵にもう一度置くのは通し、その間に新しい読み取りが置いたら 2 回目は置かない (hook の決まり。受け手はこれに頼らず 1 つの読み取りで 1 つの鍵に 1 回だけ置く。§8 の 8)', async () => {
    const probe = await renderReceiver(vi.fn());
    const older = await startPageRead(probe.receiver);
    expect(await placeIn(older.read, KEY)).toBe('placed');
    expect(await placeIn(older.read, KEY)).toBe('placed');

    const newer = await startPageRead(probe.receiver);
    expect(await placeIn(newer.read, KEY)).toBe('placed');
    const applied: string[] = [];
    expect(await placeIn(older.read, KEY, () => applied.push('older'))).toBe('superseded');
    expect(applied).toEqual([]);
  });

  it('鍵ごとに別々の順序を持つ (別の鍵の応答で古くならない。A→B→A で A の最初の応答を A の鍵で置く)', async () => {
    const probe = await renderReceiver(vi.fn());
    const keyA = 'selectedDate:A';
    const keyB = 'selectedDate:B';
    const firstA = await startPageRead(probe.receiver, [keyA]);
    const b = await startPageRead(probe.receiver, [keyB]);
    const secondA = await startPageRead(probe.receiver, [keyA]);

    expect(await placeIn(b.read, keyB)).toBe('placed');
    // B の鍵に新しい世代が置いても、A の鍵の順序は変わらない
    expect(await placeIn(firstA.read, keyA)).toBe('placed');
    expect(await placeIn(secondA.read, keyA)).toBe('placed');
    // A の鍵に新しい世代が置いたあとの最初の A の応答は古い
    expect(await placeIn(firstA.read, keyA)).toBe('superseded');
  });
});

describe('useAiConsultationReceiver の番兵と書き込みの印 (#2206 G1)', () => {
  it("取り直しの応答を置く時点にモーダルがあれば 'deferred' で置かず、閉じたら 1 回取り直す。印を付けるのは読み取りごとに 1 回", async () => {
    const refetch = controlledRefetch();
    await renderReceiver(refetch.fn);
    await notify();
    const closeModal = await openModal();

    const applied: string[] = [];
    expect(await placeIn(refetch.calls[0].read, KEY, () => applied.push(KEY))).toBe('deferred');
    // 同じ読み取りの以後の place は全部 'deferred' (別の鍵も)
    expect(await placeIn(refetch.calls[0].read, OTHER_KEY, () => applied.push(OTHER_KEY))).toBe('deferred');
    expect(applied).toEqual([]);
    expect(refetch.fn).toHaveBeenCalledTimes(1);

    await closeModal();
    expect(refetch.fn).toHaveBeenCalledTimes(2);
    expect(refetch.calls[1].read.mode).toBe('refetch');
    await flush();
    expect(refetch.fn).toHaveBeenCalledTimes(2);
  });

  it("取り直しの応答を置く時点に書き込み中なら 'deferred'、全部終わったら 1 回取り直す", async () => {
    const refetch = controlledRefetch();
    const probe = await renderReceiver(refetch.fn);
    await notify();
    const endFirst = probe.receiver.beginWrite();
    const endSecond = probe.receiver.beginWrite();

    expect(await placeIn(refetch.calls[0].read, KEY)).toBe('deferred');
    await act(async () => {
      endFirst();
    });
    await flush();
    expect(refetch.fn).toHaveBeenCalledTimes(1);
    await act(async () => {
      endSecond();
    });
    await flush();
    expect(refetch.fn).toHaveBeenCalledTimes(2);
  });

  it("取り直しを始めたあとに書き込みを始めて終えていたら 'deferred' で、すぐに 1 回取り直す", async () => {
    const refetch = controlledRefetch();
    const probe = await renderReceiver(refetch.fn);
    await notify();
    // 取り直しの応答を待つあいだに書き込みを始めて終える (置く時点では書き込み中でない)
    const endWrite = probe.receiver.beginWrite();
    await act(async () => {
      endWrite();
    });
    await flush();
    expect(refetch.fn).toHaveBeenCalledTimes(1);

    const applied: string[] = [];
    expect(await placeIn(refetch.calls[0].read, KEY, () => applied.push(KEY))).toBe('deferred');
    expect(applied).toEqual([]);
    await flush();
    expect(refetch.fn).toHaveBeenCalledTimes(2);
    // 新しい取り直しは書き込みのあとに始めたので置ける
    expect(await placeIn(refetch.calls[1].read, KEY)).toBe('placed');
  });

  it("ページの読み取り (mode 'mount') は番兵・書き込み中でも置く", async () => {
    const probe = await renderReceiver(vi.fn());
    await openModal();
    const page = await startPageRead(probe.receiver, [KEY]);
    expect(page.read.mode).toBe('mount');
    const endWrite = probe.receiver.beginWrite();

    const applied: string[] = [];
    expect(await placeIn(page.read, KEY, () => applied.push(KEY))).toBe('placed');
    expect(applied).toEqual([KEY]);
    endWrite();
  });

  it("古い応答では止めた通知の印を付けない ('superseded' が先)", async () => {
    const refetch = controlledRefetch();
    await renderReceiver(refetch.fn);
    await notify();
    await notify();
    const [first, second] = refetch.calls;
    expect(await placeIn(second.read, KEY)).toBe('placed');

    const closeModal = await openModal();
    expect(await placeIn(first.read, KEY)).toBe('superseded');
    await closeModal();
    // 止めた通知の印は付いていないので、閉じても取り直さない
    expect(refetch.fn).toHaveBeenCalledTimes(2);
  });

  it('通知の時点で番兵・書き込み中なら取り直さず、外れたら 1 回だけ取り直す (何回来ても 1 回)', async () => {
    const refetch = vi.fn();
    const probe = await renderReceiver(refetch);

    const closeModal = await openModal();
    await notify();
    await notify();
    expect(refetch).not.toHaveBeenCalled();
    await closeModal();
    expect(refetch).toHaveBeenCalledTimes(1);

    const endWrite = probe.receiver.beginWrite();
    await notify();
    await notify();
    expect(refetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      endWrite();
    });
    await flush();
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("アンマウント後は取り直さず、届いた応答の place は 'superseded'、印も付けない", async () => {
    const refetch = controlledRefetch();
    await renderReceiver(refetch.fn);
    await notify();
    const pending = refetch.calls[0];
    await openModal();

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);

    const applied: string[] = [];
    expect(pending.read.place(KEY, () => applied.push(KEY))).toBe('superseded');
    expect(applied).toEqual([]);
    pending.gate.resolve();
    await notify();
    expect(refetch.fn).toHaveBeenCalledTimes(1);
  });

  it('refetch が reject しても・同期で投げても握る', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const rejecting = vi.fn(async () => {
        throw new Error('取り直しの失敗');
      });
      await renderReceiver(rejecting);
      await notify();
      expect(rejecting).toHaveBeenCalledTimes(1);

      const throwing = vi.fn(() => {
        throw new Error('同期の失敗');
      });
      await renderReceiver(throwing);
      await notify();
      expect(throwing).toHaveBeenCalledTimes(1);
      await flush();

      expect(warn).toHaveBeenCalledTimes(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('beginWrite の終わりは 2 回呼んでも 1 回しか効かない', async () => {
    const refetch = vi.fn();
    const probe = await renderReceiver(refetch);
    const before = aiConsultationDocumentWriteCountForTests();
    const endFirst = probe.receiver.beginWrite();
    const endSecond = probe.receiver.beginWrite();
    expect(aiConsultationDocumentWriteCountForTests()).toBe(before + 2);

    endFirst();
    endFirst();
    expect(aiConsultationDocumentWriteCountForTests()).toBe(before + 1);
    // まだ 1 つ書き込み中なので取り直さない
    await notify();
    expect(refetch).not.toHaveBeenCalled();

    await act(async () => {
      endSecond();
    });
    await flush();
    expect(aiConsultationDocumentWriteCountForTests()).toBe(before);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('書き込みが 1 つでも進んでいる間 html に data-ai-consultation-writes (合計) が付き、全部終わったら消える (受け手が 2 つでも合計)', async () => {
    expect(AI_CONSULTATION_WRITES_ATTRIBUTE).toBe('data-ai-consultation-writes');
    const html = document.documentElement;
    expect(html.hasAttribute(AI_CONSULTATION_WRITES_ATTRIBUTE)).toBe(false);

    const first = await renderReceiver(vi.fn());
    const otherContainer = document.createElement('div');
    document.body.appendChild(otherContainer);
    extraElements.push(otherContainer);
    const otherRoot = createRoot(otherContainer);
    const second = await renderReceiver(vi.fn(), undefined, KEY, otherRoot);

    const endFirst = first.receiver.beginWrite();
    expect(html.getAttribute(AI_CONSULTATION_WRITES_ATTRIBUTE)).toBe('1');
    const endSecond = second.receiver.beginWrite();
    expect(html.getAttribute(AI_CONSULTATION_WRITES_ATTRIBUTE)).toBe('2');

    endFirst();
    expect(html.getAttribute(AI_CONSULTATION_WRITES_ATTRIBUTE)).toBe('1');
    endSecond();
    expect(html.hasAttribute(AI_CONSULTATION_WRITES_ATTRIBUTE)).toBe(false);
    await act(async () => {
      otherRoot.unmount();
    });
  });

  it('生成の受付の通知は、完了を見張って終わったらもう一度取り直す (番兵は完了のときにも効く)。アンマウントで見張りをやめる', async () => {
    const refetch = vi.fn();
    await renderReceiver(refetch);
    await notify({ actionType: 'generate_week_menu', result: { requestId: REQUEST_ID, status: AI_CONSULTATION_GENERATION_ACCEPTED_STATUS } });
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(generationWatch.calls.map((call) => call.requestId)).toEqual([REQUEST_ID]);

    // 完了のときにモーダルが開いていれば取り直さず、閉じたら 1 回
    const closeModal = await openModal();
    await act(async () => {
      generationWatch.calls[0].onSettled();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
    await closeModal();
    expect(refetch).toHaveBeenCalledTimes(2);

    // 受付でない通知では見張らない
    await notify();
    expect(generationWatch.calls).toHaveLength(1);

    // もう 1 つ受付を見張っている間に離れたら、見張りをやめる
    await notify({ actionType: 'generate_week_menu', result: { requestId: 'request-2', status: AI_CONSULTATION_GENERATION_ACCEPTED_STATUS } });
    expect(generationWatch.calls).toHaveLength(2);
    expect(generationWatch.calls[1].stopped).toBe(false);
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    expect(generationWatch.calls[1].stopped).toBe(true);
  });

  it('受け手が聞くイベントの名前は mealPlanUpdated (既存の節を新しい hook に向ける)', async () => {
    expect(AI_CONSULTATION_DATA_CHANGED_EVENT).toBe(EXPECTED_EVENT_NAME);
    const refetch = vi.fn();
    await renderReceiver(refetch);
    await notify(undefined, 'somethingElseUpdated');
    expect(refetch).not.toHaveBeenCalled();
    await notify(undefined, EXPECTED_EVENT_NAME);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('useAiConsultationReceiver の読み込み中の印と receiver の参照 (#2206 G1)', () => {
  it('loadingKeys: 立てた鍵は、置かれたとき・立てた読み取りが終わったときに下ろす。別の読み取りが同じ鍵を立て直したら、古い読み取りの終わりでは下ろさない', async () => {
    const probe = await renderReceiver(vi.fn());
    expect(probe.receiver.isLoading(KEY)).toBe(false);

    // 置かれたら下ろす
    const placing = await startPageRead(probe.receiver, [KEY]);
    expect(probe.receiver.isLoading(KEY)).toBe(true);
    expect(probe.loadingByRender[probe.loadingByRender.length - 1]).toBe(true);
    await placeIn(placing.read, KEY);
    expect(probe.receiver.isLoading(KEY)).toBe(false);
    expect(probe.loadingByRender[probe.loadingByRender.length - 1]).toBe(false);
    await placing.finish();

    // 置かずに終わっても下ろす
    const notPlacing = await startPageRead(probe.receiver, [KEY]);
    expect(probe.receiver.isLoading(KEY)).toBe(true);
    await notPlacing.finish();
    expect(probe.receiver.isLoading(KEY)).toBe(false);

    // 立て直した読み取りがあれば、古い読み取りの終わりでは下ろさない
    const older = await startPageRead(probe.receiver, [KEY]);
    const newer = await startPageRead(probe.receiver, [KEY]);
    await older.finish();
    expect(probe.receiver.isLoading(KEY)).toBe(true);
    await newer.finish();
    expect(probe.receiver.isLoading(KEY)).toBe(false);

    // fn が投げても下ろす (reject はそのまま返す)
    let thrown: unknown = null;
    await act(async () => {
      await probe.receiver
        .read({ loadingKeys: [KEY] }, async () => {
          throw new Error('読み取りの失敗');
        })
        .catch((error: unknown) => {
          thrown = error;
        });
    });
    expect(thrown).toBeInstanceOf(Error);
    expect(probe.receiver.isLoading(KEY)).toBe(false);
  });

  it('取り直しは読み込み中の鍵を立てない', async () => {
    const refetch = controlledRefetch();
    const probe = await renderReceiver(refetch.fn);
    await notify();
    expect(refetch.calls).toHaveLength(1);
    expect(probe.receiver.isLoading(KEY)).toBe(false);
    expect(probe.loadingByRender.every((loading) => !loading)).toBe(true);
  });

  it('apply が投げたら置いた世代は進まず、同じ読み取りがもう一度置ける', async () => {
    const probe = await renderReceiver(vi.fn());
    const older = await startPageRead(probe.receiver, [KEY]);
    const newer = await startPageRead(probe.receiver, [KEY]);

    expect(() =>
      newer.read.place(KEY, () => {
        throw new Error('置き方の失敗');
      }),
    ).toThrow('置き方の失敗');
    // 置いた世代は進まず、読み込み中の印も下りない
    expect(probe.receiver.isLoading(KEY)).toBe(true);
    // 先に始めた読み取りの応答も置ける (newer の世代は置かれていない)
    expect(await placeIn(older.read, KEY)).toBe('placed');
    // 同じ読み取りがもう一度置ける
    expect(await placeIn(newer.read, KEY)).toBe('placed');
    await older.finish();
    await newer.finish();
  });

  it('receiver は描画をまたいで同じ参照 (読み込み中の鍵が立って下りても・書き込みの窓を開け閉めしても)', async () => {
    const refetch = controlledRefetch();
    const probe = await renderReceiver(refetch.fn);
    const page = await startPageRead(probe.receiver, [KEY]);
    await placeIn(page.read, KEY);
    await page.finish();
    const endWrite = probe.receiver.beginWrite();
    await act(async () => {
      endWrite();
    });
    await notify();
    expect(probe.receivers.length).toBeGreaterThan(1);
    expect(new Set(probe.receivers).size).toBe(1);

    // 描画し直しても (refetch を描画のたびに作り直しても) 同じ参照
    const rerendered = await renderReceiver(controlledRefetch().fn);
    expect(rerendered.receiver).toBe(probe.receiver);
  });

  it('useEffect の依存に receiver と読み取りの関数を入れた開いたときの読み取りは 1 回だけ走る (読み込み中の鍵が立って下りても読み直さない)', async () => {
    const reads: AiConsultationRead[] = [];
    let renders = 0;
    const gate = deferred();

    function Page() {
      renders += 1;
      const fetchItems = useCallback(async (read: AiConsultationRead) => {
        reads.push(read);
        await gate.promise;
        read.place(KEY, () => undefined);
      }, []);
      const receiver = useAiConsultationReceiver(fetchItems, { initialLoadingKeys: [KEY] });
      useEffect(() => {
        void receiver.read({ loadingKeys: [KEY] }, fetchItems);
      }, [receiver, fetchItems]);
      return <p>{receiver.isLoading(KEY) ? '読み込み中' : '読み込み済み'}</p>;
    }

    await act(async () => {
      root.render(<Page />);
    });
    expect(container.textContent).toBe('読み込み中');
    gate.resolve();
    await flush();
    expect(container.textContent).toBe('読み込み済み');
    expect(renders).toBeGreaterThan(1);
    expect(reads).toHaveLength(1);
    expect(reads[0].mode).toBe('mount');
  });

  it('initialLoadingKeys の鍵は最初の描画から isLoading が true で、開いたときの読み取りが置いたとき・終わったときに下りる。取り直しが先に置いても下りる', async () => {
    // 置いたときに下りる
    const placed = await renderReceiver(vi.fn(), { initialLoadingKeys: [KEY] });
    expect(placed.loadingByRender[0]).toBe(true);
    const mount = await startPageRead(placed.receiver, [KEY]);
    expect(placed.receiver.isLoading(KEY)).toBe(true);
    await placeIn(mount.read, KEY);
    expect(placed.receiver.isLoading(KEY)).toBe(false);
    await mount.finish();
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);

    // 置かずに終わったら下りる
    const ended = await renderReceiver(vi.fn(), { initialLoadingKeys: [KEY] });
    expect(ended.loadingByRender[0]).toBe(true);
    const failing = await startPageRead(ended.receiver, [KEY]);
    await failing.finish();
    expect(ended.receiver.isLoading(KEY)).toBe(false);
    expect(ended.loadingByRender[ended.loadingByRender.length - 1]).toBe(false);
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);

    // 開いたときの読み取りの応答待ちに、取り直しが先に置いたら下りる
    const refetch = controlledRefetch();
    const overtaken = await renderReceiver(refetch.fn, { initialLoadingKeys: [KEY] });
    expect(overtaken.loadingByRender[0]).toBe(true);
    const slowMount = await startPageRead(overtaken.receiver, [KEY]);
    await notify();
    expect(await placeIn(refetch.calls[0].read, KEY)).toBe('placed');
    expect(overtaken.receiver.isLoading(KEY)).toBe(false);
    await slowMount.finish();
    expect(overtaken.receiver.isLoading(KEY)).toBe(false);
  });

  it('place の apply の中で呼んだ isLoading(key) は、その鍵を下ろす前の値 (読み込み中なら true) を返し、apply が戻ったあとは false', async () => {
    const probe = await renderReceiver(vi.fn(), { initialLoadingKeys: [KEY] });
    const mount = await startPageRead(probe.receiver, [KEY]);
    let loadingInApply: boolean | null = null;
    await placeIn(mount.read, KEY, () => {
      loadingInApply = probe.receiver.isLoading(KEY);
    });
    expect(loadingInApply).toBe(true);
    expect(probe.receiver.isLoading(KEY)).toBe(false);
    await mount.finish();
  });

  it("開いたときの読み取りの応答待ちに、取り直しが別の鍵 (失敗でも置く片づけの鍵) にだけ置いても、開いたときの応答は自分の鍵に 'placed' で置け、その鍵の読み込み中の印を下ろす (片づけの鍵の place は、ほかの鍵の置いた世代と読み込み中の印に触れない。§6.2)", async () => {
    const scoreKey = 'nutritionScore';
    const consentNoticeKey = 'nutritionConsentNotice';
    const refetch = controlledRefetch();
    const probe = await renderReceiver(refetch.fn, undefined, scoreKey);
    const mount = await startPageRead(probe.receiver, [scoreKey]);
    await notify();

    // 取り直しは成功の鍵に置けず (読み取りの失敗)、片づけの鍵にだけ置く
    expect(await placeIn(refetch.calls[0].read, consentNoticeKey)).toBe('placed');
    expect(probe.receiver.isLoading(scoreKey)).toBe(true);

    const applied: string[] = [];
    expect(await placeIn(mount.read, scoreKey, () => applied.push(scoreKey))).toBe('placed');
    expect(applied).toEqual([scoreKey]);
    expect(probe.receiver.isLoading(scoreKey)).toBe(false);
    // 開いたときの読み取りは、片づけの鍵には取り直しより古い
    expect(await placeIn(mount.read, consentNoticeKey)).toBe('superseded');
    await mount.finish();
  });
});
