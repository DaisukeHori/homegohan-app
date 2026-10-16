/**
 * Push 通知の送信待ち (push_outbox) — 定数・型・Zod・worker の本体 (#1136)。DB と Expo は引数で受け取る (純粋)。
 * 登録は DB (enqueue_push_notification。トリガーが呼ぶ)、worker の起動は src/app/api/cron/push-outbox/route.ts、
 * DB の読み書きは src/lib/push/outbox-store.ts、Expo への HTTP は src/lib/push/expo-transport.ts、文面は src/lib/push/render.ts。
 */
import { z } from 'zod';
import { isAccountFrozen } from '@/lib/auth/frozen';
import { isExpoPushToken } from '@/lib/push-tokens';
import { hasAcceptedCurrentLegalDocuments } from '@homegohan/shared';

// ── 定数 (§6.1) ────────────────────────────────────────────────────────────
/** worker がその行を処理する回数の上限 (既定)。PUSH_OUTBOX_MAX_ATTEMPTS で上書き。DB の fail_push_outbox が決める */
export const PUSH_OUTBOX_MAX_ATTEMPTS = 3;
export const PUSH_OUTBOX_MAX_ATTEMPTS_MIN = 1;
export const PUSH_OUTBOX_MAX_ATTEMPTS_MAX = 10;
/** n 回目の失敗のあと、次の試行まで待つ秒数 (1 分・5 分・15 分)。表より多い回は最後の値 */
export const PUSH_OUTBOX_RETRY_DELAYS_SECONDS: readonly number[] = [60, 300, 900];
/** 1 回の worker が取る行数 (既定)。PUSH_OUTBOX_BATCH_SIZE で上書き。claim_push_outbox の上限は 500 */
export const PUSH_OUTBOX_BATCH_SIZE = 100;
export const PUSH_OUTBOX_BATCH_SIZE_MIN = 1;
export const PUSH_OUTBOX_BATCH_SIZE_MAX = 500;
/** Expo の 1 要求の上限 (送信 100 件・receipt 1000 件) */
export const EXPO_PUSH_SEND_CHUNK_SIZE = 100;
export const EXPO_PUSH_RECEIPT_CHUNK_SIZE = 1000;
/** 取った行のリース (秒)。1 回の実行 (最長 60 秒) の 2 倍。切れた行は次の回が取り直す */
export const PUSH_OUTBOX_LEASE_SECONDS = 120;
/** 1 回の実行で送るのに使う時間の上限 (ミリ秒)。超えたら残りを次の回に回す (maxDuration 60 秒に収める) */
export const PUSH_OUTBOX_RUN_BUDGET_MS = 40_000;
/** これより古い queued は送らず expired で dead にする (1 日たった「献立ができました」は届けても意味が薄い) */
export const PUSH_OUTBOX_QUEUED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** receipt を確かめ始めるまでの時間と、諦めるまでの時間 (Expo 公式: 約 15 分後から取れ、24 時間で消える) */
export const PUSH_RECEIPT_CHECK_DELAY_SECONDS = 15 * 60;
export const PUSH_RECEIPT_MAX_AGE_SECONDS = 24 * 60 * 60;
/** 夜間の判定の時計。JST (UTC+9) 固定。利用者ごとの時刻帯を足すときはここを利用者の値に置き換える */
export const PUSH_QUIET_HOURS_UTC_OFFSET_MINUTES = 9 * 60;
/** notification_preferences.quiet_hours_start/end が NULL のときの既定 (列の既定と同じ 22:00 / 07:00) */
export const PUSH_QUIET_HOURS_DEFAULT_START_MINUTES = 22 * 60;
export const PUSH_QUIET_HOURS_DEFAULT_END_MINUTES = 7 * 60;
/** Android の通知チャンネル。アプリが登録時に作る "default" (apps/mobile/src/lib/pushNotifications.ts) */
export const EXPO_DEFAULT_ANDROID_CHANNEL_ID = 'default';
/** Expo の ticket / receipt の error のうち、端末の行を消すもの */
export const EXPO_DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';
/** 429: この回の送信をやめて次の回に回す (Expo 公式の上限 600 通/秒) */
export const HTTP_TOO_MANY_REQUESTS = 429;
const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1000;
/** ログに出す token の末尾の文字数 (全体は出さない) */
const PUSH_TOKEN_SUFFIX_CHARS = 4;

/** 行の last_error_code に入る、こちらで決めた値 (Expo の error はその名前のまま入る: DeviceNotRegistered など) */
export const PUSH_OUTBOX_ERROR_CODES = {
  ACCOUNT_FROZEN: 'account_frozen',
  CONSENT_OUTDATED: 'consent_outdated',
  NOTIFICATIONS_DISABLED: 'notifications_disabled',
  PROFILE_MISSING: 'profile_missing',
  EXPIRED: 'expired',
  /** token が Expo の push token の形でない (isExpoPushToken が false)。Expo に渡さない (同じ要求のほかの行を巻き込まない。R-24) */
  INVALID_TOKEN: 'invalid_token',
  UNKNOWN_KIND: 'unknown_kind',
  INVALID_PAYLOAD: 'invalid_payload',
  NETWORK_ERROR: 'network_error',
  INVALID_RESPONSE: 'invalid_response',
  HTTP_ERROR: 'expo_http_error',
  TICKET_ERROR: 'expo_ticket_error',
} as const;

// ── 型・Zod ────────────────────────────────────────────────────────────────
export type PushPriority = 'default' | 'normal' | 'high';
/** Expo に渡す 1 件 (docs.expo.dev/push-notifications/sending-notifications の message) */
export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  channelId: string;
  priority: PushPriority;
  ttl: number;
}
const ExpoErrorDetailsSchema = z.object({ error: z.string().optional() }).optional();
export const ExpoPushTicketSchema = z.union([
  z.object({ status: z.literal('ok'), id: z.string().min(1) }),
  z.object({ status: z.literal('error'), message: z.string().optional(), details: ExpoErrorDetailsSchema }),
]);
export type ExpoPushTicket = z.infer<typeof ExpoPushTicketSchema>;
export const ExpoPushReceiptSchema = z.union([
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('error'), message: z.string().optional(), details: ExpoErrorDetailsSchema }),
]);
export type ExpoPushReceipt = z.infer<typeof ExpoPushReceiptSchema>;
export interface PushTransportFailure { code: string; message: string; statusCode: number | null; retryable: boolean }
export type PushSendOutcome = { ok: true; tickets: ExpoPushTicket[] } | { ok: false; failure: PushTransportFailure };
export type PushReceiptsOutcome = { ok: true; receipts: Record<string, ExpoPushReceipt> } | { ok: false; failure: PushTransportFailure };
export interface PushTransport {
  send(messages: readonly PushMessage[]): Promise<PushSendOutcome>;
  getReceipts(receiptIds: readonly string[]): Promise<PushReceiptsOutcome>;
}

export const PushOutboxClaimedRowSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  push_token_id: z.uuid(),
  expo_push_token: z.string().min(1),
  kind: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  attempts: z.number().int().nonnegative(),
  created_at: z.string().min(1),
});
export type PushOutboxClaimedRow = z.infer<typeof PushOutboxClaimedRowSchema>;
export const PushOutboxReceiptRowSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  push_token_id: z.uuid(),
  expo_push_token: z.string().min(1),
  receipt_id: z.string().min(1),
  sent_at: z.string().min(1),
});
export type PushOutboxReceiptRow = z.infer<typeof PushOutboxReceiptRowSchema>;
/** RPC の戻り (SETOF push_outbox) から、worker が使う列だけを検証して取り出す。形が違えば throw (route が 500 にする) */
export function parseClaimedRows(rows: unknown): PushOutboxClaimedRow[] {
  return z.array(PushOutboxClaimedRowSchema).parse(rows);
}
export function parseReceiptRows(rows: unknown): PushOutboxReceiptRow[] {
  return z.array(PushOutboxReceiptRowSchema).parse(rows);
}

/** 送る条件の材料 (user_profiles + notification_preferences。行が無ければ prefs は既定) */
export interface PushUserEligibility {
  frozenAt: string | null;
  unbanAt: string | null;
  termsVersionAccepted: string | null;
  privacyVersionAccepted: string | null;
  notificationsEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}
/** 種類の方針のうち worker が使う部分 (packages/shared の PushNotificationKindSpec がこれを満たす) */
export interface PushKindPolicy { path: string; quietHours: 'send' | 'defer'; ttlSeconds: number; priority: 'default' | 'high' }
/** 文面 (この型の正はここ。render.ts は import する)。data はアプリに届き、path を NotificationRouter が行き先に使う */
export interface RenderedPushMessage { title: string; body: string; data: Record<string, unknown> }
export type PushOutboxFailOutcome = 'requeued' | 'dead' | 'ignored';
export interface PushOutboxFailInput {
  id: string; workerId: string; errorCode: string; errorMessage: string | null; statusCode: number | null;
  retryable: boolean; maxAttempts: number; retryAfterSeconds: number;
}
export interface PushOutboxStore {
  claimQueued(workerId: string, limit: number, leaseSeconds: number): Promise<PushOutboxClaimedRow[]>;
  loadEligibility(userIds: readonly string[]): Promise<ReadonlyMap<string, PushUserEligibility>>;
  complete(id: string, workerId: string, receiptId: string): Promise<boolean>;
  fail(input: PushOutboxFailInput): Promise<PushOutboxFailOutcome>;
  defer(id: string, workerId: string, untilIso: string): Promise<boolean>;
  claimReceipts(workerId: string, limit: number, minAgeSeconds: number, leaseSeconds: number): Promise<PushOutboxReceiptRow[]>;
  recordReceipt(id: string, workerId: string, status: 'ok' | 'error' | 'missing' | null, error: string | null): Promise<boolean>;
  /** user_push_tokens の行を消す (push_outbox の行は FK の CASCADE で消える)。消せたら true */
  deleteToken(pushTokenId: string): Promise<boolean>;
  /** cleanup_push_outbox: 24 時間を超えた queued を expired に・sent / dead を期限で消す。鍵が無い回も route が呼ぶ (R-12) */
  cleanup(): Promise<PushOutboxCleanupResult>;
}
export interface PushOutboxCleanupResult { expired: number; sent: number; dead: number }
export interface PushOutboxLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}
export interface PushOutboxWorkerDeps {
  store: PushOutboxStore;
  transport: PushTransport;
  kinds: Readonly<Record<string, PushKindPolicy | undefined>>;
  render: (kind: string, payload: Record<string, unknown>, path: string) => RenderedPushMessage | null;
  now: () => number;
  log: PushOutboxLogger;
}
export interface PushOutboxRunOptions { workerId: string; maxAttempts: number; batchSize: number; legalConsentEnforced: boolean }
export interface PushOutboxRunSummary {
  claimed: number; sent: number; requeued: number; deferred: number; dead: number; dead_codes: Record<string, number>;
  receipts_claimed: number; receipts_ok: number; receipts_error: number; receipts_missing: number; receipts_pending: number;
  tokens_removed: number; cleaned_expired: number; cleaned_sent: number; cleaned_dead: number; stopped_early: 'budget' | 'rate_limited' | null;
}

// ── 設定・小さな純粋関数 ──────────────────────────────────────────────────
export type PushOutboxSettingEnvName = 'PUSH_OUTBOX_MAX_ATTEMPTS' | 'PUSH_OUTBOX_BATCH_SIZE';
export interface PushOutboxSettingSources { maxAttempts: string | undefined; batchSize: string | undefined }
export interface PushOutboxSettings { maxAttempts: number; batchSize: number; ignored: PushOutboxSettingEnvName[] }
function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): { value: number; ignored: boolean } {
  if (raw === undefined || raw.trim() === '') return { value: fallback, ignored: false };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return { value: fallback, ignored: true };
  return { value: n, ignored: false };
}
/** 環境変数の値を解釈する。範囲外・整数でない値は既定に戻し、名前を ignored に入れる (route が warn に書く) */
export function resolvePushOutboxSettings(sources: PushOutboxSettingSources): PushOutboxSettings {
  const attempts = boundedInt(sources.maxAttempts, PUSH_OUTBOX_MAX_ATTEMPTS, PUSH_OUTBOX_MAX_ATTEMPTS_MIN, PUSH_OUTBOX_MAX_ATTEMPTS_MAX);
  const batch = boundedInt(sources.batchSize, PUSH_OUTBOX_BATCH_SIZE, PUSH_OUTBOX_BATCH_SIZE_MIN, PUSH_OUTBOX_BATCH_SIZE_MAX);
  const ignored: PushOutboxSettingEnvName[] = [];
  if (attempts.ignored) ignored.push('PUSH_OUTBOX_MAX_ATTEMPTS');
  if (batch.ignored) ignored.push('PUSH_OUTBOX_BATCH_SIZE');
  return { maxAttempts: attempts.value, batchSize: batch.value, ignored };
}
/** n 回目 (1 始まり) の失敗のあとに待つ秒数 */
export function retryDelaySeconds(failedAttempts: number): number {
  const index = Math.min(Math.max(failedAttempts, 1), PUSH_OUTBOX_RETRY_DELAYS_SECONDS.length) - 1;
  return PUSH_OUTBOX_RETRY_DELAYS_SECONDS[index] ?? 0;
}
/** ログに出す token: 'ExponentPushToken[…abcd]' (末尾 4 文字だけ) */
export function maskPushToken(token: string): string {
  const open = token.indexOf('[');
  const inner = open > 0 && token.endsWith(']') ? token.slice(open + 1, -1) : token;
  const suffix = inner.slice(-PUSH_TOKEN_SUFFIX_CHARS);
  return open > 0 ? `${token.slice(0, open)}[…${suffix}]` : `…${suffix}`;
}
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
const CLOCK_PATTERN = /^(\d{2}):(\d{2})/;
/** 'HH:MM:SS' (time 列の文字列) → その日の分。形が違えば fallback */
export function parseClockMinutes(value: string | null | undefined, fallback: number): number {
  const match = value ? CLOCK_PATTERN.exec(value) : null;
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return fallback;
  return hours * 60 + minutes;
}
/** 時刻帯のずれ (分) を足した、その日の分 (0〜1439) */
export function localMinutesOfDay(nowMs: number, offsetMinutes: number): number {
  const total = Math.floor(nowMs / MS_PER_MINUTE) + offsetMinutes;
  return ((total % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}
/** 夜間か。start = end は「夜間なし」。日付をまたぐ (22:00〜07:00) 形にも対応 */
export function isWithinQuietHours(nowMinutes: number, startMinutes: number, endMinutes: number): boolean {
  if (startMinutes === endMinutes) return false;
  return startMinutes < endMinutes
    ? nowMinutes >= startMinutes && nowMinutes < endMinutes
    : nowMinutes >= startMinutes || nowMinutes < endMinutes;
}
/** 夜間の終わり (次の endMinutes) の時刻 (ms)。分の切り捨てから数える */
export function quietHoursEndMs(nowMs: number, nowMinutes: number, endMinutes: number): number {
  const delta = (((endMinutes - nowMinutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return Math.floor(nowMs / MS_PER_MINUTE) * MS_PER_MINUTE + delta * MS_PER_MINUTE;
}
export type PushEligibility = { ok: true } | { ok: false; code: string };
/** 送る条件 (§7.1 の行)。順に、プロフィール無し → 期限切れ → token の形 → 凍結 → 未同意 (強制のときだけ) → 設定 off */
export function decideEligibility(
  row: PushOutboxClaimedRow,
  user: PushUserEligibility | undefined,
  options: { nowMs: number; legalConsentEnforced: boolean },
): PushEligibility {
  if (!user) return { ok: false, code: PUSH_OUTBOX_ERROR_CODES.PROFILE_MISSING };
  if (options.nowMs - Date.parse(row.created_at) > PUSH_OUTBOX_QUEUED_MAX_AGE_MS) return { ok: false, code: PUSH_OUTBOX_ERROR_CODES.EXPIRED };
  if (!isExpoPushToken(row.expo_push_token)) return { ok: false, code: PUSH_OUTBOX_ERROR_CODES.INVALID_TOKEN };
  if (isAccountFrozen({ frozenAt: user.frozenAt, unbanAt: user.unbanAt })) return { ok: false, code: PUSH_OUTBOX_ERROR_CODES.ACCOUNT_FROZEN };
  if (
    options.legalConsentEnforced &&
    !hasAcceptedCurrentLegalDocuments({ terms_version_accepted: user.termsVersionAccepted, privacy_version_accepted: user.privacyVersionAccepted })
  ) {
    return { ok: false, code: PUSH_OUTBOX_ERROR_CODES.CONSENT_OUTDATED };
  }
  if (!user.notificationsEnabled) return { ok: false, code: PUSH_OUTBOX_ERROR_CODES.NOTIFICATIONS_DISABLED };
  return { ok: true };
}
/**
 * Expo が要求ごと拒んだ (HTTP 4xx。429 を除く) か。拒まれた要求は 1 件も送られていないので、分けて送り直しても 2 通は届かない。
 * 429・5xx・通信エラー (retryable) と、応答の形の誤り (statusCode null。Expo が受け付けたあとかもしれない) は false
 */
export function isRequestLevelRejection(failure: PushTransportFailure): boolean {
  return !failure.retryable && failure.statusCode !== null;
}

// ── worker の本体 ──────────────────────────────────────────────────────────
type Pending = { row: PushOutboxClaimedRow; message: PushMessage };
type RowRef = Pick<PushOutboxClaimedRow, 'id' | 'user_id' | 'push_token_id' | 'expo_push_token' | 'kind' | 'attempts'>;

async function recordFailure(
  deps: PushOutboxWorkerDeps, options: PushOutboxRunOptions, summary: PushOutboxRunSummary, row: RowRef, failure: PushTransportFailure,
): Promise<void> {
  const outcome = await deps.store.fail({
    id: row.id, workerId: options.workerId, errorCode: failure.code, errorMessage: failure.message, statusCode: failure.statusCode,
    retryable: failure.retryable, maxAttempts: options.maxAttempts, retryAfterSeconds: retryDelaySeconds(row.attempts + 1),
  });
  if (outcome === 'requeued') summary.requeued += 1;
  if (outcome === 'dead') {
    summary.dead += 1;
    summary.dead_codes[failure.code] = (summary.dead_codes[failure.code] ?? 0) + 1;
    deps.log.warn('Push 通知を届けられませんでした', {
      kind: row.kind, user_id: row.user_id, token: maskPushToken(row.expo_push_token),
      error_code: failure.code, status_code: failure.statusCode, attempts: row.attempts + 1,
    });
  }
}
function notSent(code: string): PushTransportFailure {
  return { code, message: code, statusCode: null, retryable: false };
}
async function removeToken(deps: PushOutboxWorkerDeps, summary: PushOutboxRunSummary, row: RowRef): Promise<void> {
  if (await deps.store.deleteToken(row.push_token_id)) {
    summary.tokens_removed += 1;
    deps.log.warn('端末の行を消しました (DeviceNotRegistered)', { user_id: row.user_id, token: maskPushToken(row.expo_push_token) });
  }
}

async function sendQueued(deps: PushOutboxWorkerDeps, options: PushOutboxRunOptions, summary: PushOutboxRunSummary, startedAt: number): Promise<void> {
  const rows = await deps.store.claimQueued(options.workerId, options.batchSize, PUSH_OUTBOX_LEASE_SECONDS);
  summary.claimed = rows.length;
  if (rows.length === 0) return;
  const users = await deps.store.loadEligibility(Array.from(new Set(rows.map((row) => row.user_id))));
  const pending: Pending[] = [];
  for (const row of rows) {
    const nowMs = deps.now();
    const user = users.get(row.user_id);
    const eligibility = decideEligibility(row, user, { nowMs, legalConsentEnforced: options.legalConsentEnforced });
    if (!eligibility.ok) { await recordFailure(deps, options, summary, row, notSent(eligibility.code)); continue; }
    const policy = deps.kinds[row.kind];
    if (!policy) { await recordFailure(deps, options, summary, row, notSent(PUSH_OUTBOX_ERROR_CODES.UNKNOWN_KIND)); continue; }
    if (policy.quietHours === 'defer' && user) {
      const nowMinutes = localMinutesOfDay(nowMs, PUSH_QUIET_HOURS_UTC_OFFSET_MINUTES);
      const start = parseClockMinutes(user.quietHoursStart, PUSH_QUIET_HOURS_DEFAULT_START_MINUTES);
      const end = parseClockMinutes(user.quietHoursEnd, PUSH_QUIET_HOURS_DEFAULT_END_MINUTES);
      if (isWithinQuietHours(nowMinutes, start, end)) {
        const until = new Date(quietHoursEndMs(nowMs, nowMinutes, end)).toISOString();
        if (await deps.store.defer(row.id, options.workerId, until)) summary.deferred += 1;
        continue;
      }
    }
    const rendered = deps.render(row.kind, row.payload, policy.path);
    if (!rendered) { await recordFailure(deps, options, summary, row, notSent(PUSH_OUTBOX_ERROR_CODES.INVALID_PAYLOAD)); continue; }
    pending.push({ row, message: {
      to: row.expo_push_token, title: rendered.title, body: rendered.body, data: rendered.data,
      sound: 'default', channelId: EXPO_DEFAULT_ANDROID_CHANNEL_ID, priority: policy.priority, ttl: policy.ttlSeconds,
    } });
  }
  for (const batch of chunk(pending, EXPO_PUSH_SEND_CHUNK_SIZE)) {
    if ((await sendBatch(deps, options, summary, batch, startedAt)) === 'stop') return;
  }
}

/**
 * 1 つの要求で送り、ticket を同じ順の行に対応させる。'stop' = この回の送信をやめる (時間切れ・429)。残りの行はリースのまま。
 * 要求ごと拒まれた 2 件以上の塊は、どの 1 件が原因か分からない (別の Expo プロジェクトの token が混ざった
 * PUSH_TOO_MANY_EXPERIENCE_IDS など) ので、1 件ずつの要求に分けて送り直し、失敗を原因の 1 件だけに留める (R-24)
 */
async function sendBatch(
  deps: PushOutboxWorkerDeps, options: PushOutboxRunOptions, summary: PushOutboxRunSummary, batch: readonly Pending[], startedAt: number,
): Promise<'continue' | 'stop'> {
  // 時間切れ: 残りはリースが切れたあとの回が取り直す (attempts は増えない)
  if (deps.now() - startedAt > PUSH_OUTBOX_RUN_BUDGET_MS) { summary.stopped_early = 'budget'; return 'stop'; }
  const outcome = await deps.transport.send(batch.map((item) => item.message));
  if (!outcome.ok) {
    if (batch.length > 1 && isRequestLevelRejection(outcome.failure)) {
      deps.log.warn('Expo が要求ごと拒んだため、1 件ずつ送り直します', {
        error_code: outcome.failure.code, status_code: outcome.failure.statusCode, count: batch.length,
      });
      for (const item of batch) {
        if ((await sendBatch(deps, options, summary, [item], startedAt)) === 'stop') return 'stop';
      }
      return 'continue';
    }
    for (const item of batch) await recordFailure(deps, options, summary, item.row, outcome.failure);
    if (outcome.failure.statusCode === HTTP_TOO_MANY_REQUESTS) { summary.stopped_early = 'rate_limited'; return 'stop'; }
    return 'continue';
  }
  for (let index = 0; index < batch.length; index += 1) {
    const row = batch[index]!.row;
    const ticket = outcome.tickets[index];
    if (!ticket) { await recordFailure(deps, options, summary, row, notSent(PUSH_OUTBOX_ERROR_CODES.INVALID_RESPONSE)); continue; }
    if (ticket.status === 'ok') {
      if (await deps.store.complete(row.id, options.workerId, ticket.id)) summary.sent += 1;
      continue;
    }
    const code = ticket.details?.error ?? PUSH_OUTBOX_ERROR_CODES.TICKET_ERROR;
    await recordFailure(deps, options, summary, row, { code, message: ticket.message ?? code, statusCode: null, retryable: false });
    if (code === EXPO_DEVICE_NOT_REGISTERED) await removeToken(deps, summary, row);
  }
  return 'continue';
}

async function checkReceipts(deps: PushOutboxWorkerDeps, options: PushOutboxRunOptions, summary: PushOutboxRunSummary): Promise<void> {
  const rows = await deps.store.claimReceipts(options.workerId, EXPO_PUSH_RECEIPT_CHUNK_SIZE, PUSH_RECEIPT_CHECK_DELAY_SECONDS, PUSH_OUTBOX_LEASE_SECONDS);
  summary.receipts_claimed = rows.length;
  if (rows.length === 0) return;
  const outcome = await deps.transport.getReceipts(rows.map((row) => row.receipt_id));
  if (!outcome.ok) {
    deps.log.warn('Expo の receipt を取れませんでした (次の回で確かめ直します)', { error_code: outcome.failure.code, status_code: outcome.failure.statusCode, count: rows.length });
    for (const row of rows) await deps.store.recordReceipt(row.id, options.workerId, null, null);
    summary.receipts_pending += rows.length;
    return;
  }
  const nowMs = deps.now();
  for (const row of rows) {
    const receipt = outcome.receipts[row.receipt_id];
    if (!receipt) {
      const gaveUp = nowMs - Date.parse(row.sent_at) > PUSH_RECEIPT_MAX_AGE_SECONDS * MS_PER_SECOND;
      await deps.store.recordReceipt(row.id, options.workerId, gaveUp ? 'missing' : null, null);
      if (gaveUp) summary.receipts_missing += 1; else summary.receipts_pending += 1;
      continue;
    }
    if (receipt.status === 'ok') { await deps.store.recordReceipt(row.id, options.workerId, 'ok', null); summary.receipts_ok += 1; continue; }
    const code = receipt.details?.error ?? PUSH_OUTBOX_ERROR_CODES.TICKET_ERROR;
    await deps.store.recordReceipt(row.id, options.workerId, 'error', code);
    summary.receipts_error += 1;
    deps.log.warn('Push 通知の receipt がエラーでした', { receipt_error: code, user_id: row.user_id, token: maskPushToken(row.expo_push_token) });
    if (code === EXPO_DEVICE_NOT_REGISTERED) await removeToken(deps, summary, { ...row, kind: '', attempts: 0 });
  }
}

/** 1 回の実行: 送る → receipt を確かめる → 掃除。例外は投げたまま (route が 500 にする) */
export async function processPushOutbox(deps: PushOutboxWorkerDeps, options: PushOutboxRunOptions): Promise<PushOutboxRunSummary> {
  const startedAt = deps.now();
  const summary: PushOutboxRunSummary = {
    claimed: 0, sent: 0, requeued: 0, deferred: 0, dead: 0, dead_codes: {},
    receipts_claimed: 0, receipts_ok: 0, receipts_error: 0, receipts_missing: 0, receipts_pending: 0,
    tokens_removed: 0, cleaned_expired: 0, cleaned_sent: 0, cleaned_dead: 0, stopped_early: null,
  };
  await sendQueued(deps, options, summary, startedAt);
  await checkReceipts(deps, options, summary);
  const cleaned = await deps.store.cleanup();
  summary.cleaned_expired = cleaned.expired;
  summary.cleaned_sent = cleaned.sent;
  summary.cleaned_dead = cleaned.dead;
  return summary;
}
