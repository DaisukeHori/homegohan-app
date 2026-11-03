/**
 * Web の AI 相談が始めた献立の生成を、生成が終わるまで見張る (#2195 V1 の整合ゲートの是正)。
 *
 * 問題:
 *   - AI 相談の献立の生成 (generate_day_menu・generate_week_menu・generate_single_meal) は、依頼の行
 *     (weekly_menu_requests。status: processing) を作った時点 (受付) で成功を返し、AI 相談は
 *     AI_CONSULTATION_DATA_CHANGED_EVENT (src/lib/ai/consultation-data-refetch.ts) を 1 回だけ投げる
 *     (detail.result = { requestId, status: 'processing', ... })。献立は裏の処理 (Edge Function generate-menu-v4 / v5) が
 *     後から書くので、受付の時点で取り直しても献立はまだ無い。生成の完了を知らせる通知は無く、開いているページは
 *     自分で読み込み直すまで古い表示のままだった (/menus/weekly で表示中の週の初日から始めた生成だけは、ページの
 *     生成中の依頼の監視が完了で取り直していた)
 *
 * 決まり:
 *   - 受け手の共通の hook (src/hooks/useAiConsultationDataRefetch.ts) が、通知の detail.result が生成の受付
 *     ({ requestId, status: 'processing' }) なら、その依頼を watchAiConsultationGeneration で終わるまで見張り、
 *     終わったらもう一度取り直す (取り直しの番兵 isAiConsultationRefetchBlocked は完了のときにも効かせる)。
 *     各ページに見張りを書かない
 *   - 見張り方は、献立表 (/menus/weekly) の生成の監視と同じ、生成の状態の確認 (GET /api/ai/menu/weekly/status) を一定の間隔で読む形。
 *     status の route は、止まった行 (WEEKLY_MENU_REQUEST_STALE_MINUTES の間進まなかった行) を failed にして返すので、
 *     止まった生成も終わったものとして見張りを終える
 *   - 終わった = completed (献立を書き終えた)・failed (失敗・中止・止まった。途中まで書いた献立や、書き戻した献立がありうる)・
 *     not_found (行が無い)。どれでも取り直す
 *   - 同じ依頼を同じページの複数の受け手 (ページとプロフィールの帯など) が見張っても、状態の確認は 1 つにまとめる
 *   - 見張りには上限の時間 (AI_CONSULTATION_GENERATION_WATCH_MAX_MS) がある。受け手が全部いなくなった (ページを離れた) ら止める
 *
 * このファイルはブラウザでだけ使う (サーバーの依存を import しない)。
 */

/** 生成の状態の確認の道 (献立表の生成の監視と同じ route。?requestId=<依頼の id> を付けて GET する) */
export const AI_CONSULTATION_GENERATION_STATUS_PATH = '/api/ai/menu/weekly/status';

/** 1 秒のミリ秒 */
const MS_PER_SECOND = 1000;
/** 1 分のミリ秒 */
const MS_PER_MINUTE = 60 * MS_PER_SECOND;

/**
 * 生成の状態を確かめる間隔 (ミリ秒)。
 * 根拠: 献立表 (/menus/weekly) の生成の監視 (pollingIntervalRef の setInterval(poll, 3000)) と同じ 3 秒。
 * 生成は数十秒から数分かかるので、これより短くしても終わりが早く見えるだけで、状態の確認の数が増える
 */
export const AI_CONSULTATION_GENERATION_WATCH_INTERVAL_MS = 3 * MS_PER_SECOND;

/**
 * 1 つの依頼を見張る上限の時間 (ミリ秒)。これを過ぎたら、終わりを待たずに見張りをやめる (取り直さない)。
 * 根拠: status の route は、最後に生きていた時刻から 20 分 (WEEKLY_MENU_REQUEST_STALE_MINUTES。src/lib/weekly-menu-request-stale.ts)
 * 進まなかった行を failed にして返す。生成が始まってすぐ止まった行も、20 分のあと最初の確認で failed が返るので、
 * それより長い 30 分にする (この値が 20 分より長いことは tests/ai-consultation-generation-watch-2195.test.tsx が確かめる)
 */
export const AI_CONSULTATION_GENERATION_WATCH_MAX_MS = 30 * MS_PER_MINUTE;

/** 上限の時間までに状態を確かめる回数 */
const AI_CONSULTATION_GENERATION_WATCH_MAX_POLLS = Math.ceil(
  AI_CONSULTATION_GENERATION_WATCH_MAX_MS / AI_CONSULTATION_GENERATION_WATCH_INTERVAL_MS,
);

/**
 * 生成が終わったとみなす状態 (status の route の応答の status)。
 * completed (書き終えた)・failed (失敗・中止・止まった)・not_found (行が無い)
 */
export const AI_CONSULTATION_GENERATION_SETTLED_STATUSES = ['completed', 'failed', 'not_found'] as const;

/** 生成の受付の結果の status (実行の結果の result.status。src/lib/ai/consultation-action-executor.ts の献立の生成 3 種類) */
export const AI_CONSULTATION_GENERATION_ACCEPTED_STATUS = 'processing';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * AI_CONSULTATION_DATA_CHANGED_EVENT の detail が、裏の処理が後から書く生成の受付 (detail.result が
 * { requestId: <空でない文字列>, status: 'processing' }) なら、その依頼の id。そうでなければ null
 */
export function aiConsultationAcceptedGenerationRequestIdOf(detail: unknown): string | null {
  if (!isRecord(detail)) return null;
  const result = detail.result;
  if (!isRecord(result)) return null;
  if (result.status !== AI_CONSULTATION_GENERATION_ACCEPTED_STATUS) return null;
  const requestId = result.requestId;
  return typeof requestId === 'string' && requestId !== '' ? requestId : null;
}

/** status の route の応答の本文が、生成が終わったことを表すか */
function isSettledStatusBody(body: unknown): boolean {
  if (!isRecord(body)) return false;
  return (AI_CONSULTATION_GENERATION_SETTLED_STATUSES as readonly unknown[]).includes(body.status);
}

/** 生成の状態の確認の URL */
export function aiConsultationGenerationStatusUrl(requestId: string): string {
  return `${AI_CONSULTATION_GENERATION_STATUS_PATH}?requestId=${encodeURIComponent(requestId)}`;
}

interface GenerationWatch {
  /** 終わったときに呼ぶもの (受け手ごとに 1 つ) */
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval>;
  /** 確かめた回数 (上限の時間の判定に使う) */
  polls: number;
  /** 状態の確認の応答を待っている間 (重ねて確かめない) */
  inFlight: boolean;
}

/** 見張っている依頼 (依頼の id → 見張り)。同じ依頼の見張りを 1 つにまとめる */
const watches = new Map<string, GenerationWatch>();

function stopWatch(requestId: string, watch: GenerationWatch): void {
  clearInterval(watch.timer);
  if (watches.get(requestId) === watch) watches.delete(requestId);
}

async function pollWatch(requestId: string, watch: GenerationWatch): Promise<void> {
  if (watch.inFlight) return;
  if (watch.polls >= AI_CONSULTATION_GENERATION_WATCH_MAX_POLLS) {
    // 上限の時間を過ぎた: 終わりを待たずにやめる (取り直さない)
    stopWatch(requestId, watch);
    return;
  }
  watch.polls += 1;
  watch.inFlight = true;
  let settled = false;
  try {
    const res = await fetch(aiConsultationGenerationStatusUrl(requestId));
    if (res.ok) settled = isSettledStatusBody(await res.json().catch(() => null));
  } catch {
    // 通信の失敗: 次の回にもう一度確かめる (上限の時間まで)
  } finally {
    watch.inFlight = false;
  }
  // 確かめている間に受け手が全部いなくなった (見張りが止まった) ら、何もしない
  if (!settled || watches.get(requestId) !== watch) return;
  stopWatch(requestId, watch);
  for (const listener of [...watch.listeners]) listener();
}

/**
 * 依頼 requestId の生成が終わる (AI_CONSULTATION_GENERATION_SETTLED_STATUSES) まで見張り、終わったら onSettled を 1 回呼ぶ。
 * 返す関数を呼ぶと見張りをやめる (onSettled は呼ばない)。同じ依頼を見張る受け手が全部やめたら、状態の確認も止める。
 * 上限の時間 (AI_CONSULTATION_GENERATION_WATCH_MAX_MS) を過ぎたら、onSettled を呼ばずに見張りをやめる
 */
export function watchAiConsultationGeneration(requestId: string, onSettled: () => void): () => void {
  let watch = watches.get(requestId);
  if (!watch) {
    const created: GenerationWatch = {
      listeners: new Set(),
      timer: setInterval(() => {
        void pollWatch(requestId, created);
      }, AI_CONSULTATION_GENERATION_WATCH_INTERVAL_MS),
      polls: 0,
      inFlight: false,
    };
    watches.set(requestId, created);
    watch = created;
  }
  const current = watch;
  let active = true;
  const listener = () => {
    if (!active) return;
    active = false;
    current.listeners.delete(listener);
    onSettled();
  };
  current.listeners.add(listener);
  return () => {
    if (!active) return;
    active = false;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) stopWatch(requestId, current);
  };
}
