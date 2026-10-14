/**
 * 献立生成のリクエストの行 (weekly_menu_requests) が「止まった」か (進まなくなったか) の判定 (#1494)
 *
 * 止まった行を failed にする場所は 4 つある。4 つとも、止まったかの判定はこのファイルの isWeeklyMenuRequestStale
 * (下の【生存信号】) で行い、failed への書き換えはこのファイルの markWeeklyMenuRequestStaleIfUnchanged
 * (下の【読んでから書くまでに進んだ行は failed にしない】) で行う (#1507。しきい値・生存信号・比較つきの更新を 1 か所に置き、
 * 同じことを 2 か所に書かない)。
 *   - GET  /api/ai/menu/weekly/status   … 状態の確認 (1 行。画面が 3 秒ごとに呼ぶ)
 *   - GET  /api/ai/menu/weekly/pending  … 生成中の行の確認 (最新の 1 行)
 *   - GET  /api/ai/menu/meal/pending    … 単一食事の生成中の行の確認 (最新の 10 行まで)
 *   - POST /api/ai/menu/weekly/cleanup  … 週間ページを開くたびの掃除 (本人の生成中の行すべて)
 * #1507 より前は、status・pending の 3 つが updated_at だけで判定していた。claim_menu_request は取り直すときに
 * updated_at を書かないので、20 分を超えて順番待ちした queued の行を cron が processing にした直後
 * (Edge Function が最初の進捗を書くまでの数秒)、status のポーリングがその行を failed にしうった。
 *
 * 【queued は止まったと見なさない】
 * status='queued' の行は、v5/generate が積み (積んだ時点で AI の 1 回を数える。#1149)、cron の process-menu-queue が
 * claim_menu_request で 1 行ずつ取って処理する。混んでいると何分も待つことがあるが、それは止まったのではなく順番待ち。
 * 順番待ちの行を failed にすると、数えた 1 回が成果なしで消える (#1494)。queued の行の後始末 (取り直しの回数を
 * 使い切った行を failed にする) は claim_menu_request が持っている。
 *
 * 【生存信号】
 * 行が最後に生きていた時刻は、作成時刻 (created_at) ではなく次で判定する。
 *   - worker_acquired_at がある行 (キューが取った行): GREATEST(worker_acquired_at, updated_at)
 *     (claim_menu_request の止まりの判定と同じ式。migration 20261007160400_claim_menu_request_lease.sql)。
 *     Edge Function (generate-menu-v5) は進捗を書くたびに updated_at を更新し、claim_menu_request は取り直すたびに
 *     worker_acquired_at を今の時刻にする (updated_at は書かない) ので、どちらか新しい方が生存信号になる。
 *   - worker_acquired_at が無い行 (weekly/request・v4/generate など、キューを経由せず status='processing' で作る行): updated_at
 *   - どちらも無い行: created_at (列の既定値は now() なので、通常は入っている)
 *   - どれも読めない行: 止まったとは判定しない (判定できない行を failed にしない)
 *
 * 【読んでから書くまでに進んだ行は failed にしない】
 * 行を読んでから failed に書くまでのあいだに、Edge Function が進捗を書く・cron が取り直す・生成が終わることがある。
 * failed への書き換えは、読んだときの status・updated_at・worker_acquired_at がそのままの行だけに行う (比較つきの更新)。
 * 書き換わらなかった行は進んだ行なので、呼び出し側は止まったとは扱わない (failed と返さない・スナップショットを復元しない)。
 *
 * 【claim_menu_request の判定を上書きしない】
 * claim_menu_request は、キューが取った processing の行を、生存信号から CLAIM_MENU_REQUEST_LEASE_MINUTES (5 分) たったら
 * 止まったと見なして取り直す (取り直すと worker_acquired_at が今の時刻になり、生存信号が新しくなる)。
 * こちらのしきい値 (WEEKLY_MENU_REQUEST_STALE_MINUTES) はそれより十分に長いので、取り直せる行は先に cron が取り直す。
 * こちらが failed にするのは、取り直しの回数を使い切った行や、キューを経由しない行が、しきい値の間まったく進まなかったときだけ。
 * (しきい値がリースより長いことは src/__tests__/lib/weekly-menu-request-stale.test.ts が migration の値と突き合わせて確かめる)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { WEEKLY_MENU_REQUEST_STALE_MESSAGE } from '@/lib/weekly-menu-request-error';

/** 1 分のミリ秒 */
const MS_PER_MINUTE = 60 * 1000;

/**
 * claim_menu_request が、キューが取った processing の行を止まったと見なすまでの分数
 * (migration 20261007160400_claim_menu_request_lease.sql の interval '5 minutes')。ここでは判定に使わず、
 * WEEKLY_MENU_REQUEST_STALE_MINUTES がこれより長いことを確かめるためだけに置く (値を変えるときは migration と一緒に)。
 */
export const CLAIM_MENU_REQUEST_LEASE_MINUTES = 5;

/**
 * 生成中の行 (pending / processing) が、最後に生きていた時刻からこの分数のあいだ進まなかったら、止まったと見なして failed にする。
 * 根拠: 献立の生成 (v5 の究極モードを含む) は、進捗 (updated_at) を数分おきに書く。claim_menu_request のリース (5 分) で
 * 取り直された行が、再び進み始めるまでの余裕も含めて 20 分とする (#1494 より前から status / pending の route が使っていた値)。
 */
export const WEEKLY_MENU_REQUEST_STALE_MINUTES = 20;

/** WEEKLY_MENU_REQUEST_STALE_MINUTES をミリ秒にしたもの */
export const WEEKLY_MENU_REQUEST_STALE_MS = WEEKLY_MENU_REQUEST_STALE_MINUTES * MS_PER_MINUTE;

/** 止まったかを判定する状態 (queued は含めない。上の説明のとおり、順番待ちは止まったのではない) */
export const WEEKLY_MENU_REQUEST_STALE_TARGET_STATUSES = ['pending', 'processing'] as const;

export type WeeklyMenuRequestStaleTargetStatus = (typeof WEEKLY_MENU_REQUEST_STALE_TARGET_STATUSES)[number];

/** 判定に使う列 (weekly_menu_requests の行の一部) */
export type WeeklyMenuRequestLivenessRow = {
  status: string;
  created_at?: string | null;
  updated_at?: string | null;
  worker_acquired_at?: string | null;
};

/** 止まったかを判定する状態か */
export function isWeeklyMenuRequestStaleTargetStatus(status: string): status is WeeklyMenuRequestStaleTargetStatus {
  return (WEEKLY_MENU_REQUEST_STALE_TARGET_STATUSES as readonly string[]).includes(status);
}

/** この時刻より前に最後に生きていた行は止まったと見なす (今の時刻 - しきい値) */
export function weeklyMenuRequestStaleBefore(nowMs: number = Date.now()): Date {
  return new Date(nowMs - WEEKLY_MENU_REQUEST_STALE_MS);
}

/** 時刻の文字列をミリ秒に (空・読めない値は null) */
function toEpochMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 行が最後に生きていた時刻 (ミリ秒)。読めなければ null。
 * worker_acquired_at がある行は GREATEST(worker_acquired_at, updated_at) (SQL の GREATEST と同じく NULL は無視する)、
 * 無い行は updated_at、どちらも無ければ created_at。
 */
export function weeklyMenuRequestLastAliveAtMs(row: WeeklyMenuRequestLivenessRow): number | null {
  const workerAcquiredAt = toEpochMs(row.worker_acquired_at);
  const updatedAt = toEpochMs(row.updated_at);
  const signals = [workerAcquiredAt, updatedAt].filter((ms): ms is number => ms !== null);
  if (signals.length > 0) return Math.max(...signals);
  return toEpochMs(row.created_at);
}

/**
 * 止まった行か: 状態が pending / processing で、最後に生きていた時刻がしきい値より前。
 * queued・終わった行 (completed / failed)・生存信号が読めない行は止まったと見なさない。
 */
export function isWeeklyMenuRequestStale(row: WeeklyMenuRequestLivenessRow, nowMs: number = Date.now()): boolean {
  if (!isWeeklyMenuRequestStaleTargetStatus(row.status)) return false;
  const lastAliveAt = weeklyMenuRequestLastAliveAtMs(row);
  if (lastAliveAt === null) return false;
  return lastAliveAt < weeklyMenuRequestStaleBefore(nowMs).getTime();
}

/** 比較つきの更新に使う列 (読んだ時点の値。updated_at・worker_acquired_at は列を select して NULL も含めて渡す) */
export type WeeklyMenuRequestStaleUpdateRow = {
  id: string;
  status: string;
  updated_at: string | null;
  worker_acquired_at: string | null;
};

/** failed に書き換えた行 (スナップショットの復元に使う generated_data を、更新の戻り値で受け取る。#1042) */
export type WeeklyMenuRequestStaleUpdatedRow = { id: string; generated_data: unknown };

/** markWeeklyMenuRequestStaleIfUnchanged の結果 */
export type WeeklyMenuRequestStaleUpdateResult = {
  /** 書き換えた行 (読んでから書くまでに進んだ行は含まない。0 行か 1 行) */
  rows: WeeklyMenuRequestStaleUpdatedRow[];
  /** DB が更新を拒んだときのエラー (そのとき行は書き換わっていない) */
  error: unknown;
};

/**
 * 止まったと判定した行を failed にする。読んだときの status・updated_at・worker_acquired_at がそのままの行だけを書き換える
 * (比較つきの更新。冒頭の【読んでから書くまでに進んだ行は failed にしない】)。本人の行 (userId) に絞る。
 *
 * supabase には service role のクライアント (route の queueDb = getAiQueueWriter()) を渡す。weekly_menu_requests は
 * 利用者 (authenticated) から書けない (#1465。tests/ai-queue-writes-contract.test.ts が呼び出し側を確かめる)。
 */
export async function markWeeklyMenuRequestStaleIfUnchanged(params: {
  supabase: SupabaseClient;
  userId: string;
  row: WeeklyMenuRequestStaleUpdateRow;
  /** failed にした時刻 (updated_at に書く。ISO 8601) */
  failedAt: string;
}): Promise<WeeklyMenuRequestStaleUpdateResult> {
  const { row } = params;
  let update = params.supabase
    .from('weekly_menu_requests')
    .update({ status: 'failed', error_message: WEEKLY_MENU_REQUEST_STALE_MESSAGE, updated_at: params.failedAt })
    .eq('id', row.id)
    .eq('user_id', params.userId)
    .eq('status', row.status);
  // 読んだときから生存信号が変わっていない行だけを書き換える (NULL は .is で比べる)
  update = row.updated_at === null ? update.is('updated_at', null) : update.eq('updated_at', row.updated_at);
  update = row.worker_acquired_at === null
    ? update.is('worker_acquired_at', null)
    : update.eq('worker_acquired_at', row.worker_acquired_at);
  const { data, error } = await update.select('id, generated_data');
  if (error) return { rows: [], error };
  const rows: WeeklyMenuRequestStaleUpdatedRow[] = (data ?? []).map((updated: { id: string; generated_data: unknown }) => ({
    id: updated.id,
    generated_data: updated.generated_data,
  }));
  return { rows, error: null };
}
