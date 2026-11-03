/**
 * #2195 V1 の整合ゲートの是正: AI 相談が始めた献立の生成は、受付と完了の両方で取り直す
 * (src/hooks/useAiConsultationDataRefetch.ts と src/lib/ai/consultation-generation-watch.ts)
 *
 * 問題 (直す前):
 *   - AI 相談の献立の生成 (generate_day_menu・generate_week_menu・generate_single_meal) は、依頼の行を作った時点
 *     (status: processing) で成功を知らせる。受け手の hook はその 1 回の通知で取り直すだけで、生成が終わったときに
 *     取り直す手段が無かった (献立は裏の処理が後から書くので、受付の取り直しではまだ無い)
 *
 * 直したあと: 通知の detail.result が生成の受付 ({ requestId, status: 'processing' }) なら、受け手の共通の hook が
 * その依頼を生成の状態の確認 (GET /api/ai/menu/weekly/status) で終わるまで見張り、終わったら (completed / failed / not_found)
 * もう一度取り直す。完了のときも取り直しの番兵 (isAiConsultationRefetchBlocked) を効かせ、ページを離れたら見張りをやめる。
 *
 * 時間は setInterval / clearInterval だけを偽の時計にする (取得の連鎖を流す setTimeout(0) は本物のまま)。
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiConsultationDataRefetch } from '@/hooks/useAiConsultationDataRefetch';
import { AI_CONSULTATION_DATA_CHANGED_EVENT } from '@/lib/ai/consultation-data-refetch';
import {
  AI_CONSULTATION_GENERATION_SETTLED_STATUSES,
  AI_CONSULTATION_GENERATION_STATUS_PATH,
  AI_CONSULTATION_GENERATION_WATCH_INTERVAL_MS,
  AI_CONSULTATION_GENERATION_WATCH_MAX_MS,
  aiConsultationAcceptedGenerationRequestIdOf,
} from '@/lib/ai/consultation-generation-watch';
import { AI_CONSULTATION_DEFERRED_WRITE_ACTIONS } from '@/lib/ai/consultation-refetch-coverage';
import { WEEKLY_MENU_REQUEST_STALE_MS } from '@/lib/weekly-menu-request-stale';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 取得の連鎖 (fetch → res.json() → 取り直し) を流しきるまでに回すタスクの数 */
const SETTLE_TASKS = 10;
/** 状態の確認 1 回 (fetch → res.json()) の Promise を流しきるまでに回す microtask の数 */
const MICROTASK_FLUSHES = 10;
const OK_STATUS = 200;
const SERVER_ERROR_STATUS = 500;
/** ページと同じ起点 (fetch のモックで URL を解く) */
const PAGE_ORIGIN = 'http://localhost';
const REQUEST_ID = '21950000-0000-4000-8000-00000000a001';
const OTHER_REQUEST_ID = '21950000-0000-4000-8000-00000000a002';
/** 上限の時間までに確かめる回数より多い回数 (上限を過ぎたあとも時計を進める) */
const POLLS_PAST_MAX = Math.ceil(AI_CONSULTATION_GENERATION_WATCH_MAX_MS / AI_CONSULTATION_GENERATION_WATCH_INTERVAL_MS) + 2;

/**
 * 実行の結果 (src/lib/ai/consultation-action-executor.ts の献立の生成 3 種類が受付で返す形)。
 * 種類は AI_CONSULTATION_DEFERRED_WRITE_ACTIONS の watched と一致する (下の最初のテストが確かめる)
 */
const ACCEPTED_RESULTS: Readonly<Record<string, Record<string, unknown>>> = {
  generate_day_menu: { date: '2026-11-05', requestId: REQUEST_ID, status: 'processing' },
  generate_week_menu: { startDate: '2026-11-04', requestId: REQUEST_ID, status: 'processing' },
  generate_single_meal: { requestId: REQUEST_ID, status: 'processing', message: '11月5日の夕食を作っています' },
};

/** 依頼の id → status の route が今返す status (無い依頼は processing) */
let statuses: Map<string, string>;
let statusCalls: string[];
let fetchFails: boolean;
let refetchCount: number;
let container: HTMLDivElement;
let root: Root;

function Receiver({ name }: { name: string }) {
  useAiConsultationDataRefetch(() => {
    refetchCount += 1;
  });
  return <p>{name}</p>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  statuses = new Map();
  statusCalls = [];
  fetchFails = false;
  refetchCount = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), PAGE_ORIGIN);
      if (url.pathname !== AI_CONSULTATION_GENERATION_STATUS_PATH) throw new Error(`知らない URL: ${String(input)}`);
      const requestId = url.searchParams.get('requestId') ?? '';
      statusCalls.push(requestId);
      if (fetchFails) return { ok: false, status: SERVER_ERROR_STATUS, json: async () => ({}) };
      return { ok: true, status: OK_STATUS, json: async () => ({ status: statuses.get(requestId) ?? 'processing' }) };
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < SETTLE_TASKS; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

async function renderReceivers(names: string[] = ['受け手']) {
  await act(async () => {
    root.render(
      <div>
        {names.map((name) => (
          <Receiver key={name} name={name} />
        ))}
      </div>,
    );
  });
}

async function notify(actionType: string, result: unknown) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(AI_CONSULTATION_DATA_CHANGED_EVENT, { detail: { actionType, result } }));
  });
  await settle();
}

/** 生成の状態を確かめる間隔を n 回ぶん進める */
async function advancePolls(n = 1) {
  for (let i = 0; i < n; i += 1) {
    await act(async () => {
      vi.advanceTimersByTime(AI_CONSULTATION_GENERATION_WATCH_INTERVAL_MS);
    });
    await settle();
  }
}

describe('AI 相談が始めた献立の生成は、受付と完了の両方で取り直す (#2195 V1 の整合ゲートの是正)', () => {
  it('見張る操作の一覧は、閉じた表 (AI_CONSULTATION_DEFERRED_WRITE_ACTIONS) の watched と一致する', () => {
    const watched = Object.entries(AI_CONSULTATION_DEFERRED_WRITE_ACTIONS)
      .filter(([, entry]) => entry?.kind === 'watched')
      .map(([action]) => action)
      .sort();
    expect(Object.keys(ACCEPTED_RESULTS).sort()).toEqual(watched);
  });

  it.each(Object.entries(ACCEPTED_RESULTS))('%s: 受付で 1 回、生成が終わったらもう 1 回取り直す', async (actionType, result) => {
    await renderReceivers();
    await notify(actionType, result);
    // 受付の取り直し (献立はまだ無い)
    expect(refetchCount).toBe(1);

    // 生成中の間は取り直さない
    await advancePolls();
    expect(statusCalls).toEqual([REQUEST_ID]);
    expect(refetchCount).toBe(1);

    // 生成が終わった
    statuses.set(REQUEST_ID, 'completed');
    await advancePolls();
    expect(refetchCount).toBe(2);

    // 終わったら見張りをやめる (もう確かめない・取り直さない)
    const callsAfterSettled = statusCalls.length;
    await advancePolls(2);
    expect(statusCalls.length).toBe(callsAfterSettled);
    expect(refetchCount).toBe(2);
  });

  it.each(AI_CONSULTATION_GENERATION_SETTLED_STATUSES)('生成の状態が %s になったら取り直す (失敗・行が無いときも、途中まで書いた献立や書き戻した献立を出す)', async (status) => {
    await renderReceivers();
    await notify('generate_day_menu', ACCEPTED_RESULTS.generate_day_menu);
    statuses.set(REQUEST_ID, status);
    await advancePolls();
    expect(refetchCount).toBe(2);
  });

  it('生成の受付でない結果 (書き終えた操作・受付に失敗した生成) では見張らない', async () => {
    await renderReceivers();
    await notify('update_meal', { mealId: 'meal-1', updated: true });
    await notify('generate_week_menu', { startDate: '2026-11-04', requestId: REQUEST_ID, status: 'failed' });
    await notify('delete_meal', null);
    await advancePolls(2);
    expect(statusCalls).toEqual([]);
    expect(refetchCount).toBe(3);
    expect(aiConsultationAcceptedGenerationRequestIdOf({ result: { requestId: '', status: 'processing' } })).toBeNull();
    expect(aiConsultationAcceptedGenerationRequestIdOf({ result: { status: 'processing' } })).toBeNull();
    expect(aiConsultationAcceptedGenerationRequestIdOf(null)).toBeNull();
    expect(aiConsultationAcceptedGenerationRequestIdOf({ result: { requestId: REQUEST_ID, status: 'processing' } })).toBe(REQUEST_ID);
  });

  it('生成が終わったときに入力の部品やモーダルが出ていたら、取り直さない (受付と同じ番兵)', async () => {
    await renderReceivers();
    await notify('generate_day_menu', ACCEPTED_RESULTS.generate_day_menu);
    expect(refetchCount).toBe(1);

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    try {
      statuses.set(REQUEST_ID, 'completed');
      await advancePolls();
      expect(statusCalls).toEqual([REQUEST_ID]);
      expect(refetchCount).toBe(1);
    } finally {
      dialog.remove();
    }
  });

  it('ページを離れたら (アンマウント) 見張りをやめる', async () => {
    await renderReceivers();
    await notify('generate_week_menu', ACCEPTED_RESULTS.generate_week_menu);
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    statuses.set(REQUEST_ID, 'completed');
    await advancePolls(2);
    expect(statusCalls).toEqual([]);
    expect(refetchCount).toBe(1);
  });

  it('同じページの複数の受け手が同じ依頼を見張っても、状態の確認は 1 つにまとめ、受け手はそれぞれ取り直す', async () => {
    await renderReceivers(['ページ', 'プロフィールの帯']);
    await notify('generate_single_meal', ACCEPTED_RESULTS.generate_single_meal);
    expect(refetchCount).toBe(2);
    await advancePolls();
    expect(statusCalls).toEqual([REQUEST_ID]);
    statuses.set(REQUEST_ID, 'completed');
    await advancePolls();
    expect(statusCalls).toEqual([REQUEST_ID, REQUEST_ID]);
    expect(refetchCount).toBe(4);
  });

  it('別の依頼はそれぞれ見張り、終わったものから取り直す', async () => {
    await renderReceivers();
    await notify('generate_day_menu', ACCEPTED_RESULTS.generate_day_menu);
    await notify('generate_week_menu', { startDate: '2026-11-09', requestId: OTHER_REQUEST_ID, status: 'processing' });
    expect(refetchCount).toBe(2);
    statuses.set(OTHER_REQUEST_ID, 'completed');
    await advancePolls();
    expect(refetchCount).toBe(3);
    statuses.set(REQUEST_ID, 'completed');
    await advancePolls();
    expect(refetchCount).toBe(4);
  });

  it('状態の確認に失敗しても見張りを続け、次の回に終わりを見つける', async () => {
    await renderReceivers();
    await notify('generate_day_menu', ACCEPTED_RESULTS.generate_day_menu);
    fetchFails = true;
    statuses.set(REQUEST_ID, 'completed');
    await advancePolls();
    expect(refetchCount).toBe(1);
    fetchFails = false;
    await advancePolls();
    expect(refetchCount).toBe(2);
  });

  it('上限の時間を過ぎたら、終わりを待たずに見張りをやめる (取り直さない)', async () => {
    await renderReceivers();
    await notify('generate_week_menu', ACCEPTED_RESULTS.generate_week_menu);
    // 回数が多いので、描画を流さずに (取り直しは呼ばれない間) 状態の確認の応答だけを流す
    for (let i = 0; i < POLLS_PAST_MAX; i += 1) {
      vi.advanceTimersByTime(AI_CONSULTATION_GENERATION_WATCH_INTERVAL_MS);
      for (let j = 0; j < MICROTASK_FLUSHES; j += 1) await Promise.resolve();
    }
    const callsAtMax = statusCalls.length;
    expect(callsAtMax).toBe(Math.ceil(AI_CONSULTATION_GENERATION_WATCH_MAX_MS / AI_CONSULTATION_GENERATION_WATCH_INTERVAL_MS));
    statuses.set(REQUEST_ID, 'completed');
    await advancePolls(2);
    expect(statusCalls.length).toBe(callsAtMax);
    expect(refetchCount).toBe(1);
  });

  it('見張りの上限の時間は、止まった生成を status の route が failed にして返すまでの時間 (WEEKLY_MENU_REQUEST_STALE_MS) より長い', () => {
    expect(AI_CONSULTATION_GENERATION_WATCH_MAX_MS).toBeGreaterThan(WEEKLY_MENU_REQUEST_STALE_MS);
  });
});
