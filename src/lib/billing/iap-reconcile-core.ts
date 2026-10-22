/**
 * ストアの購読の定期の取り直し (billing/04) の定数・Zod・型・ポート・純関数。I/O を持たない (fetch / DB / env を読まない)。
 * import してよいのは zod だけ (tests/billing-iap-reconcile-core.test.ts のテスト 1 が見張る)。
 * 取り直しそのもの (RevenueCat の GET と写像) は billing/03 の iap-core.ts / iap-service.ts にあり、ここでは触らない。
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// 定数 (根拠つき)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 写像 billing_apply_store_subscription の p_source。監査 (system.billing.subscription_status_changed) の details.source で、
 * 定期の取り直しによる変化を見分ける (billing/03 の 'iap_sync' / 'iap_lazy_resync' / 'revenuecat:<event.id>' と並ぶ 4 つ目の出どころ)
 */
export const IAP_RECONCILE_SOURCE = 'iap_reconcile';

/**
 * Vercel Cron の path と予定 (vercel.json と同じ値。一致はテスト 29)。毎時 41 分 (UTC。JST も毎時 41 分)。
 * ほかの cron の分 (app-log-alerts の 0 / 15 / 30 / 45 分・backup-freshness の 37 分) と重ねない。毎分の cron とは関係ない
 */
export const IAP_RECONCILE_CRON_PATH = '/api/cron/iap-reconcile';
export const IAP_RECONCILE_SCHEDULE_UTC = '41 * * * *';
/** 回の間隔 (分)。予定が毎時なので 60。期限を過ぎてから権利が止まるまでの窓の上限 (billing/04 Q-1) */
export const IAP_RECONCILE_CRON_INTERVAL_MINUTES = 60;
/** route の最長実行時間 (秒。Vercel Pro の既定の上限の中)。route には同じ値をリテラルで書く (route segment config はリテラルだけ。一致はテスト 28) */
export const IAP_RECONCILE_MAX_DURATION_SECONDS = 60;
/**
 * 1 回の処理の予算 (ms)。maxDuration (60 秒) の中に、最後の 1 人の取り直しの時間切れ (REVENUECAT_REQUEST_TIMEOUT_MS = 10 秒) +
 * 写像の RPC + 応答が収まる値 (push-outbox の PUSH_OUTBOX_RUN_BUDGET_MS と同じ 40 秒)。超えたら残りを次の回に回す
 */
export const IAP_RECONCILE_RUN_BUDGET_MS = 40_000;
/** 取り直しの開始の間隔 (ms)。RevenueCat の案内 (REST v1 は 1 秒に 1 回程度。billing/04 §2.3 P1) に合わせる */
export const IAP_RECONCILE_REQUEST_INTERVAL_MS = 1_000;
/**
 * 1 回の処理で試せる利用者の数の上限 = 予算 ÷ 間隔 (= 40)。これより多く選んでも予算の中で試せない (試さなかった利用者は印が進まず次の回に回るだけ)
 * ので、環境変数 IAP_RECONCILE_BATCH_SIZE はこれより上に上げられない (下げる向きだけ)。DB 関数の c_max_users (200) 以下 (テスト 10 が migration の文面を読んで見る)
 */
export const IAP_RECONCILE_BATCH_SIZE_MAX = Math.floor(IAP_RECONCILE_RUN_BUDGET_MS / IAP_RECONCILE_REQUEST_INTERVAL_MS);
/** 1 回の処理で選ぶ利用者の数 (既定) = 試せる数の上限。環境変数 IAP_RECONCILE_BATCH_SIZE で 1〜上限に下げられる (RevenueCat への回数を減らす) */
export const IAP_RECONCILE_BATCH_SIZE = IAP_RECONCILE_BATCH_SIZE_MAX;
export const IAP_RECONCILE_BATCH_SIZE_MIN = 1;
/**
 * 期限の後に取り直しても live のままの行 (ストアの猶予期間の past_due など) を、次に取り直すまでの間隔 (時間。既定)。
 * 猶予期間は日の単位で続くので毎時は無駄が多く、6 時間なら 1 日 4 回。環境変数 IAP_RECONCILE_RECHECK_HOURS で上書きできる
 */
export const IAP_RECONCILE_RECHECK_HOURS = 6;
/** 下限は回の間隔 (1 時間)。上限は 7 日 (ストアの猶予期間より長くしない) */
export const IAP_RECONCILE_RECHECK_HOURS_MIN = 1;
const HOURS_PER_DAY = 24;
const IAP_RECONCILE_RECHECK_MAX_DAYS = 7;
export const IAP_RECONCILE_RECHECK_HOURS_MAX = IAP_RECONCILE_RECHECK_MAX_DAYS * HOURS_PER_DAY;
/** RevenueCat の率の制限の応答 (その回を止めて次の回に回す) */
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
/** 鍵の誤り・失効・権限の不足 (どの利用者でも同じ結果になる = 回全体の失敗) */
export const HTTP_STATUS_UNAUTHORIZED = 401;
export const HTTP_STATUS_FORBIDDEN = 403;
/** 4xx の下限 (401 / 403 / 429 以外の 4xx は、その利用者の要求だけの失敗) */
export const HTTP_STATUS_CLIENT_ERROR_MIN = 400;
/** 5xx の下限 (RevenueCat の障害 = 回全体の失敗) */
export const HTTP_STATUS_SERVER_ERROR_MIN = 500;

// ─────────────────────────────────────────────────────────────────────────────
// 環境変数の解釈 (値を読むのは route。ここは文字列を受けて解釈するだけ)
// ─────────────────────────────────────────────────────────────────────────────

export type IapReconcileSettingEnvName = 'IAP_RECONCILE_BATCH_SIZE' | 'IAP_RECONCILE_RECHECK_HOURS';
export interface IapReconcileSettingSources {
  batchSize: string | undefined;
  recheckHours: string | undefined;
}
export interface IapReconcileSettings {
  batchSize: number;
  recheckHours: number;
  /** 範囲外・整数でない値を既定に戻した変数の名前 (route が warn に書く。値は書かない) */
  ignored: IapReconcileSettingEnvName[];
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): { value: number; ignored: boolean } {
  if (raw === undefined || raw.trim() === '') return { value: fallback, ignored: false };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return { value: fallback, ignored: true };
  return { value: n, ignored: false };
}

/** 環境変数の値を解釈する。空は既定、範囲外・整数でない値は既定に戻して名前を ignored に入れる (push-outbox の resolvePushOutboxSettings と同じ規則) */
export function resolveIapReconcileSettings(sources: IapReconcileSettingSources): IapReconcileSettings {
  const batch = boundedInt(sources.batchSize, IAP_RECONCILE_BATCH_SIZE, IAP_RECONCILE_BATCH_SIZE_MIN, IAP_RECONCILE_BATCH_SIZE_MAX);
  const recheck = boundedInt(sources.recheckHours, IAP_RECONCILE_RECHECK_HOURS, IAP_RECONCILE_RECHECK_HOURS_MIN, IAP_RECONCILE_RECHECK_HOURS_MAX);
  const ignored: IapReconcileSettingEnvName[] = [];
  if (batch.ignored) ignored.push('IAP_RECONCILE_BATCH_SIZE');
  if (recheck.ignored) ignored.push('IAP_RECONCILE_RECHECK_HOURS');
  return { batchSize: batch.value, recheckHours: recheck.value, ignored };
}

// ─────────────────────────────────────────────────────────────────────────────
// 候補 (DB 関数 billing_iap_reconcile_candidates の行)・試した利用者の印とポート
// ─────────────────────────────────────────────────────────────────────────────

/** RETURNS TABLE (user_id uuid, period_end timestamptz, synced_at timestamptz) の 1 行 (PostgREST は timestamptz を ISO の文字列で返す) */
export const IapReconcileCandidateSchema = z.object({
  user_id: z.uuid(),
  period_end: z.string().min(1),
  synced_at: z.string().min(1).nullable(),
});
export type IapReconcileCandidate = z.infer<typeof IapReconcileCandidateSchema>;
export const IapReconcileCandidatesSchema = z.array(IapReconcileCandidateSchema);

export interface IapReconcileCandidateQuery {
  /** p_now (候補の判定の「いま」。取り直しの p_fetched_at とは別に、処理の開始に 1 回取る) */
  now: Date;
  /** p_recheck_after (時間) */
  recheckHours: number;
  /** p_limit (1〜IAP_RECONCILE_BATCH_SIZE_MAX) */
  limit: number;
}

/** 回の終わりに書く印 (DB 関数 billing_iap_reconcile_mark_attempted の引数) */
export interface IapReconcileAttemptMark {
  /** p_user_ids: この回に syncStoreSubscriber を呼んだ利用者 (結果を問わない。1〜IAP_RECONCILE_BATCH_SIZE_MAX 人・重複なし)。選んだのに試さなかった利用者は入れない */
  userIds: string[];
  /** p_attempted_at: 回の開始 (候補の判定の now と同じ時刻) */
  attemptedAt: Date;
}

/**
 * 候補を読み、試した利用者に印を書く (実装は iap-reconcile-repository.ts。テストは偽物を渡す)。
 * listReconcileCandidates は何も書かない。markReconcileAttempted は回の終わりに 1 回だけ呼ぶ (試した利用者は次の回で後ろに回る)。
 * billing/03 の IapRepository は変えない (別のポート)
 */
export interface IapReconcileRepository {
  listReconcileCandidates(query: IapReconcileCandidateQuery): Promise<IapReconcileCandidate[]>;
  markReconcileAttempted(mark: IapReconcileAttemptMark): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 取り直しの失敗の分け方 (billing/04 §4.1 の 5)
// ─────────────────────────────────────────────────────────────────────────────

/** 失敗の種類 (要約の failed のキー。固定の語で、RevenueCat の生の文・利用者 ID は入れない) */
export const IAP_RECONCILE_FAILURE_KINDS = [
  'revenuecat_unreachable',
  'revenuecat_unauthorized',
  'revenuecat_server_error',
  'revenuecat_client_error',
  'revenuecat_unexpected_response',
  'internal',
] as const;
export type IapReconcileFailureKind = (typeof IAP_RECONCILE_FAILURE_KINDS)[number];

/**
 * 運営の処置で解消するので、失敗にせず rejected に数える業務エラーのコード (billing/03 §13.3 の BILL_LIVE_ROW_CONFLICT・S15 の
 * BILL_IAP_UNKNOWN_PRODUCT)。写像のほかの業務エラー (BILL_UNKNOWN_PLAN・BILL_UNKNOWN_IAP_STATUS) は親の扱いが失敗なので入れない
 * (classifyReconcileFailure の other → internal → 500。入れると期限を過ぎた live の行が運用メール無しで残り続ける)
 */
export const IAP_RECONCILE_REJECTED_CODES = ['BILL_LIVE_ROW_CONFLICT', 'BILL_IAP_UNKNOWN_PRODUCT'] as const;
export type IapReconcileRejectedCode = (typeof IAP_RECONCILE_REJECTED_CODES)[number];

/** 業務エラーのコードが rejected に数えるもの (IAP_RECONCILE_REJECTED_CODES) か */
export function isIapReconcileRejectedCode(code: string): code is IapReconcileRejectedCode {
  return IAP_RECONCILE_REJECTED_CODES.some((rejected) => rejected === code);
}

/** 失敗の出どころ。RevenueCatApiError なら status (null = 時間切れ・接続の失敗)、それ以外の例外は other */
export type IapReconcileFailureInput = { source: 'revenuecat'; status: number | null } | { source: 'other' };

/**
 * run = 回全体の失敗 (どの利用者でも同じになる。その回を止める)。user = その利用者だけの失敗 (数えて次の利用者へ)。
 * rate_limited = 429 (その回を止めて 200)
 */
export type IapReconcileFailureClass =
  | { scope: 'rate_limited' }
  | { scope: 'run' | 'user'; kind: IapReconcileFailureKind };

/**
 * 取り直しの失敗を分ける。運営の処置が要る 2 つ (isIapReconcileRejectedCode) はここに来ない (service が先に rejected に数える)。
 *   - RevenueCat に届かない (null)・401 / 403・5xx → run
 *   - 429 → rate_limited
 *   - そのほかの 4xx → user (revenuecat_client_error)
 *   - 2xx など (応答の形が RevenueCatCustomerInfoSchema に合わない) → user (revenuecat_unexpected_response)
 *   - RevenueCatApiError 以外 (写像の BILL_UNKNOWN_PLAN / BILL_UNKNOWN_IAP_STATUS (billing/03 §13.3 の扱いは失敗)・P0001 以外の PostgrestError・
 *     行の読み取りの失敗など) → user (internal)
 */
export function classifyReconcileFailure(input: IapReconcileFailureInput): IapReconcileFailureClass {
  if (input.source === 'other') return { scope: 'user', kind: 'internal' };
  const { status } = input;
  if (status === null) return { scope: 'run', kind: 'revenuecat_unreachable' };
  if (status === HTTP_STATUS_TOO_MANY_REQUESTS) return { scope: 'rate_limited' };
  if (status === HTTP_STATUS_UNAUTHORIZED || status === HTTP_STATUS_FORBIDDEN) return { scope: 'run', kind: 'revenuecat_unauthorized' };
  if (status >= HTTP_STATUS_SERVER_ERROR_MIN) return { scope: 'run', kind: 'revenuecat_server_error' };
  if (status >= HTTP_STATUS_CLIENT_ERROR_MIN) return { scope: 'user', kind: 'revenuecat_client_error' };
  return { scope: 'user', kind: 'revenuecat_unexpected_response' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 回の処理の要約と、回の中の純関数
// ─────────────────────────────────────────────────────────────────────────────

/** 途中で止めた理由 (push-outbox の budget / rate_limited に、回全体の失敗の revenuecat_unavailable を足した 3 値) */
export const IAP_RECONCILE_STOP_REASONS = ['budget', 'rate_limited', 'revenuecat_unavailable'] as const;
export type IapReconcileStopReason = (typeof IAP_RECONCILE_STOP_REASONS)[number];

/** route の応答の status */
export const IAP_RECONCILE_RUN_STATUSES = ['maintenance', 'not_configured', 'idle', 'processed'] as const;
export type IapReconcileRunStatus = (typeof IAP_RECONCILE_RUN_STATUSES)[number];

/** 1 回の処理の要約 (件数だけ。利用者 ID・RevenueCat の生の文は入れない)。応答とログにそのまま載せる */
export interface IapReconcileSummary {
  /** 取り出した候補の数 (≤ batchSize) */
  candidates: number;
  /** 取り直しが終わった利用者の数 (結果が applied / stale / ended / no_subscription / user_deleted のどれでも) */
  synced: number;
  /** StoreSyncOutcome の合計 (billing/03 §8.1) */
  applied: number;
  stale: number;
  ended: number;
  no_subscription: number;
  skipped_unknown: number;
  /** 運営の処置が要る業務エラー (IAP_RECONCILE_REJECTED_CODES。billing/03 §13.3・S15) で写せず飛ばした利用者の数 (コード別)。回は失敗にしない */
  rejected: Partial<Record<IapReconcileRejectedCode, number>>;
  /** 取り直せなかった利用者の数 (種類別。classifyReconcileFailure)。1 以上なら回は失敗 (IapReconcileFailedError → 500) */
  failed: Partial<Record<IapReconcileFailureKind, number>>;
  stopped_early: IapReconcileStopReason | null;
  /** 最も古い候補の期限 (ISO)。候補が無ければ null。遅れの大きさを運営が見るため */
  oldest_period_end: string | null;
  /** 処理の開始から要約までの時間 (ms) */
  elapsed_ms: number;
}

export function emptyIapReconcileSummary(candidates: readonly IapReconcileCandidate[]): IapReconcileSummary {
  return {
    candidates: candidates.length,
    synced: 0,
    applied: 0,
    stale: 0,
    ended: 0,
    no_subscription: 0,
    skipped_unknown: 0,
    rejected: {},
    failed: {},
    stopped_early: null,
    oldest_period_end: oldestPeriodEnd(candidates),
    elapsed_ms: 0,
  };
}

/** 候補のうち最も古い期限 (候補は試した時刻の順に並ぶので、先頭とは限らない)。ISO の文字列を Date で比べる */
function oldestPeriodEnd(candidates: readonly IapReconcileCandidate[]): string | null {
  let oldest: IapReconcileCandidate | null = null;
  for (const candidate of candidates) {
    if (oldest === null || Date.parse(candidate.period_end) < Date.parse(oldest.period_end)) oldest = candidate;
  }
  return oldest?.period_end ?? null;
}

/** 要約の failed の合計 (1 以上なら回は失敗) */
export function countReconcileFailures(summary: Pick<IapReconcileSummary, 'failed'>): number {
  let total = 0;
  for (const kind of IAP_RECONCILE_FAILURE_KINDS) total += summary.failed[kind] ?? 0;
  return total;
}

/**
 * 取り直せなかった利用者が 1 人以上いた回 (route が 500 にし、要約を app_logs の error の metadata に残す)。
 * message は固定の語 (利用者 ID・RevenueCat の生の文を入れない)
 */
export class IapReconcileFailedError extends Error {
  readonly summary: IapReconcileSummary;
  constructor(summary: IapReconcileSummary) {
    super('ストアの購読を取り直せなかった利用者がいます');
    this.name = 'IapReconcileFailedError';
    this.summary = summary;
  }
}

/** 次の取り直しを始めるまでに待つ時間 (ms)。最初の 1 人は待たない。前の取り直しの開始から間隔がたっていれば 0 */
export function reconcileFetchDelayMs(lastFetchStartedAtMs: number | null, nowMs: number): number {
  if (lastFetchStartedAtMs === null) return 0;
  return Math.max(0, lastFetchStartedAtMs + IAP_RECONCILE_REQUEST_INTERVAL_MS - nowMs);
}

/** 処理の開始から予算を超えたか (ちょうど予算は超えていない。push-outbox の判定と同じ向き) */
export function isReconcileBudgetExhausted(startedAtMs: number, nowMs: number): boolean {
  return nowMs - startedAtMs > IAP_RECONCILE_RUN_BUDGET_MS;
}
