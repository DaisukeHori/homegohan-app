/**
 * メールの送信待ち (email_outbox) — 定数・型・Zod・worker の本体 (#1193)。DB と Resend は引数で受け取る (純粋)。
 * 登録は send.ts (sendEmail)、worker の起動は src/app/api/cron/email-outbox/route.ts、DB の読み書きは src/lib/emails/outbox-store.ts。
 *
 * 正典: docs/design/operator/10-logs-and-mail-retry.md §6.2。
 * Resend を直接使うのはこのファイル (createResendTransport) だけ (tests/email-resend-boundary-scan.test.ts が見張る)。
 * 循環 import を作らないため、このファイルは send.ts を import しない (send.ts が maskEmailAddress をここから再エクスポートする)。
 */
import { z } from 'zod';
import { Resend } from 'resend';
import type { EmailSuppressionLookup } from '@/lib/emails/suppression';

// ── 定数 (§6.1) ────────────────────────────────────────────────────────────
export const EMAIL_OUTBOX_TABLE = 'email_outbox';
export const EMAIL_OUTBOX_STATUSES = ['queued', 'sent', 'dead'] as const;
export type EmailOutboxStatus = (typeof EMAIL_OUTBOX_STATUSES)[number];
/** 最初の 1 回を含む試行の上限 (既定)。EMAIL_OUTBOX_MAX_ATTEMPTS で上書き。DB の fail_email_outbox が決める */
export const EMAIL_OUTBOX_MAX_ATTEMPTS = 6;
export const EMAIL_OUTBOX_MAX_ATTEMPTS_MIN = 1;
/** fail_email_outbox の p_max_attempts の上限 (migration の 22023 の検査と同じ値) */
export const EMAIL_OUTBOX_MAX_ATTEMPTS_MAX = 20;
/** n 回目の失敗のあと、次の試行まで待つ秒数 (1 分・5 分・15 分・1 時間・4 時間)。表より多い回は最後の値 */
export const EMAIL_OUTBOX_RETRY_DELAYS_SECONDS: readonly number[] = [60, 300, 900, 3600, 14400];
/** 1 回の worker が取る行数 (既定)。EMAIL_OUTBOX_BATCH_SIZE で上書き。claim_email_outbox の上限は 100 */
export const EMAIL_OUTBOX_BATCH_SIZE = 20;
export const EMAIL_OUTBOX_BATCH_SIZE_MIN = 1;
/** claim_email_outbox の p_limit の上限 (migration の 22023 の検査と同じ値) */
export const EMAIL_OUTBOX_BATCH_SIZE_MAX = 100;
/** 取った行のリース (秒)。1 回の実行 (最長 60 秒) の 2 倍。切れた行は次の回が取り直す */
export const EMAIL_OUTBOX_LEASE_SECONDS = 120;
/** 送信の間隔 (ミリ秒)。Resend の上限 2 req/s を下回る */
export const EMAIL_OUTBOX_SEND_INTERVAL_MS = 600;
/** 1 回の実行で送るのに使う時間の上限 (ミリ秒)。超えたら残りを次の回に回す (maxDuration 60 秒に収める) */
export const EMAIL_OUTBOX_RUN_BUDGET_MS = 40_000;
/** これより古い queued は送らず expired で dead にする (招待の期限 7 日と同じ) */
export const EMAIL_OUTBOX_QUEUED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** 運用ログ画面と同じく super_admin 専用の、送信待ちの画面のパス */
export const SUPER_ADMIN_EMAIL_OUTBOX_PATH = '/super-admin/email-outbox';
/** 運用メールの template の接頭辞。dead の通知で数えない (自分の失敗で自分を鳴らさない) */
export const OPS_EMAIL_TEMPLATE_PREFIX = 'ops_';
export const UNKNOWN_EMAIL_TEMPLATE = 'unknown';
/** Resend 由来ではない失敗のコード (email_outbox.last_error_code / SendEmailResult.error.code) */
export const EMAIL_OUTBOX_ERROR_CODES = {
  suppressed: 'suppressed',
  expired: 'expired',
  recipientDeleted: 'recipient_deleted',
  networkError: 'network_error',
  invalidResponse: 'invalid_response',
  outboxFailed: 'outbox_failed',
} as const;

// ── 環境変数 (route が読み、ここは文字列を解釈するだけ) ───────────────────
export type EmailOutboxSettingEnvName = 'EMAIL_OUTBOX_MAX_ATTEMPTS' | 'EMAIL_OUTBOX_BATCH_SIZE';
export interface EmailOutboxSettingSources {
  readonly maxAttempts: string | undefined;
  readonly batchSize: string | undefined;
}
export interface EmailOutboxSettings {
  readonly maxAttempts: number;
  readonly batchSize: number;
  /** 不正で既定に戻した変数の名前 (値は返さない) */
  readonly ignored: readonly EmailOutboxSettingEnvName[];
}
const DECIMAL_INTEGER_PATTERN = /^\d{1,15}$/;
function resolveIntegerSetting(raw: string | undefined, fallback: number, min: number, max: number) {
  const text = raw?.trim();
  if (!text) return { value: fallback, ignored: false };
  if (!DECIMAL_INTEGER_PATTERN.test(text)) return { value: fallback, ignored: true };
  const n = Number(text);
  return n < min || n > max ? { value: fallback, ignored: true } : { value: n, ignored: false };
}
export function resolveEmailOutboxSettings(sources: EmailOutboxSettingSources): EmailOutboxSettings {
  const max = resolveIntegerSetting(sources.maxAttempts, EMAIL_OUTBOX_MAX_ATTEMPTS, EMAIL_OUTBOX_MAX_ATTEMPTS_MIN, EMAIL_OUTBOX_MAX_ATTEMPTS_MAX);
  const batch = resolveIntegerSetting(sources.batchSize, EMAIL_OUTBOX_BATCH_SIZE, EMAIL_OUTBOX_BATCH_SIZE_MIN, EMAIL_OUTBOX_BATCH_SIZE_MAX);
  const ignored: EmailOutboxSettingEnvName[] = [];
  if (max.ignored) ignored.push('EMAIL_OUTBOX_MAX_ATTEMPTS');
  if (batch.ignored) ignored.push('EMAIL_OUTBOX_BATCH_SIZE');
  return { maxAttempts: max.value, batchSize: batch.value, ignored };
}
/** n 回目の失敗 (1 始まり) のあとに待つ秒数 */
export function retryDelaySeconds(failedAttempt: number): number {
  const index = Math.min(Math.max(failedAttempt, 1), EMAIL_OUTBOX_RETRY_DELAYS_SECONDS.length) - 1;
  return EMAIL_OUTBOX_RETRY_DELAYS_SECONDS[index] ?? EMAIL_OUTBOX_RETRY_DELAYS_SECONDS[0];
}

// ── マスク (send.ts から移す。中身は変えない) ───────────────────────────────
/**
 * ログに出す宛先のマスク (taro@example.com → t***@example.com)。ドメインは配信先ごとの傾向を調べるために残す。
 * ローカル部が 2 文字以下なら 1 文字目も隠す。メールアドレスの形でなければ *** だけを返す。
 * app_logs のサニタイザ (log-sanitizer) はメールアドレスを [email] に置き換えるが、* を含むこの形には反応しない。
 */
export function maskEmailAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1) return '***';
  const local = [...address.slice(0, at)]; // サロゲートペアの途中で切るとログごと保存に失敗するので、コードポイント単位で扱う
  const domain = address.slice(at + 1);
  return `${local.length >= 3 ? local[0] : ''}***@${domain}`;
}
// 文章の中のメールアドレス。log-sanitizer の規則と同じ形で、量指定子は上限付き
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,4}\.[A-Za-z]{2,24}/g;
/** エラー文に宛先のメールアドレスが含まれていても、そのままログ・記録に出さない */
export function redactEmailAddresses(text: string): string {
  return text.replace(EMAIL_IN_TEXT, (address) => maskEmailAddress(address));
}

// ── claim_email_outbox が返す行 (Zod が正本) ────────────────────────────────
export const EmailOutboxClaimedRowSchema = z.object({
  id: z.string().uuid(),
  template: z.string().min(1).max(100),
  to_email: z.string().min(3).max(320),
  from_email: z.string().min(3).max(320),
  reply_to: z.string().min(3).max(320).nullable(),
  subject: z.string(),
  text_body: z.string(),
  html_body: z.string().nullable(),
  idempotency_key: z.string().min(1).max(256),
  attempts: z.number().int().min(0),
  created_at: z.string(),
  redact_after_send: z.boolean(),
});
export type EmailOutboxClaimedRow = z.infer<typeof EmailOutboxClaimedRowSchema>;
/** RPC の応答を検証する。形が違えば例外 (黙って 0 件にしない: app-log-alerts と同じ考え方) */
export function parseClaimedRows(data: unknown): EmailOutboxClaimedRow[] {
  return z.array(EmailOutboxClaimedRowSchema).parse(data ?? []);
}

// ── 送る側 (Resend) ────────────────────────────────────────────────────────
export interface EmailTransportFailure {
  code: string;
  /** 宛先のアドレスはマスク済み */
  message: string;
  statusCode: number | null;
  retryable: boolean;
}
export type EmailTransportOutcome = { ok: true; id: string } | { ok: false; failure: EmailTransportFailure };
export interface EmailTransport {
  send(row: EmailOutboxClaimedRow): Promise<EmailTransportOutcome>;
}
/** 429 でも待てば直る種類ではないもの (送信数の上限) */
const QUOTA_ERROR_CODES: ReadonlySet<string> = new Set(['daily_quota_exceeded', 'monthly_quota_exceeded']);
/** statusCode が数値でないとき、名前で再試行の対象と見なすエラー */
const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'rate_limit_exceeded', 'internal_server_error', 'application_error', 'concurrent_idempotent_requests',
]);
interface ResendErrorLike { name?: string; message?: string; statusCode?: number | null }
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;
/** 409 のうち、同じ Idempotency-Key の要求が Resend の中でまだ処理中のもの。待てば直る (リース切れの取り直しで起きうる) */
const CONCURRENT_IDEMPOTENT_REQUESTS = 'concurrent_idempotent_requests';
/** 再試行すれば直る見込みのある失敗か (429 / 5xx / 409 の処理中 / 通信エラー)。400 / 401 / 403 / 422 などは false */
export function isRetryableResendError(error: ResendErrorLike): boolean {
  const code = error.name ?? '';
  if (QUOTA_ERROR_CODES.has(code)) return false;
  const status = error.statusCode;
  // 数値が返っているときはステータスで判断する。409 のうち、同じキーの要求が処理中のものだけは待てば直る (send.ts の現行と同じ)
  if (typeof status === 'number') {
    return status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR_MIN || code === CONCURRENT_IDEMPOTENT_REQUESTS;
  }
  // statusCode が null (または無い) のときは名前で判断する。SDK は通信の失敗を application_error / statusCode: null で返す。
  // 同じ statusCode: null でも、SDK が送る前に弾いた入力の不備 (missing_required_field など) は再試行しても直らない
  return RETRYABLE_ERROR_CODES.has(code);
}
export function createResendTransport(apiKey: string): EmailTransport {
  const resend = new Resend(apiKey);
  return {
    async send(row) {
      try {
        const response = await resend.emails.send(
          { from: row.from_email, to: row.to_email, subject: row.subject, text: row.text_body, html: row.html_body ?? undefined, replyTo: row.reply_to ?? undefined },
          { idempotencyKey: row.idempotency_key },
        );
        if (response.error) {
          const code = response.error.name || 'unknown_error';
          return { ok: false, failure: { code, message: redactEmailAddresses(response.error.message || code), statusCode: response.error.statusCode ?? null, retryable: isRetryableResendError(response.error) } };
        }
        const id = response.data?.id;
        if (!id) return { ok: false, failure: { code: EMAIL_OUTBOX_ERROR_CODES.invalidResponse, message: 'Resend の応答にメール ID がありません', statusCode: null, retryable: false } };
        return { ok: true, id };
      } catch (err) {
        return { ok: false, failure: { code: EMAIL_OUTBOX_ERROR_CODES.networkError, message: redactEmailAddresses(err instanceof Error ? err.message : String(err)), statusCode: null, retryable: true } };
      }
    },
  };
}

// ── DB (実装は outbox-store.ts。ここは契約だけ) ─────────────────────────────
export type OutboxFailOutcome = 'queued' | 'dead' | 'ignored';
export interface OutboxStore {
  claim(workerId: string, limit: number, leaseSeconds: number): Promise<EmailOutboxClaimedRow[]>;
  complete(id: string, workerId: string, resendMessageId: string): Promise<boolean>;
  fail(id: string, workerId: string, failure: EmailTransportFailure, policy: { maxAttempts: number; retryAfterSeconds: number }): Promise<OutboxFailOutcome>;
}

// ── worker の本体 ──────────────────────────────────────────────────────────
export interface OutboxLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, error?: unknown, metadata?: Record<string, unknown>): void;
}
export interface EmailOutboxWorkerDeps {
  store: OutboxStore;
  transport: EmailTransport;
  /** 送る直前の停止リストの引き当て (lookupEmailSuppression)。引けなければ送る */
  suppression: (address: string) => Promise<EmailSuppressionLookup>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: OutboxLogger;
}
export interface EmailOutboxRunOptions {
  workerId: string;
  maxAttempts: number;
  batchSize: number;
  leaseSeconds?: number;
  sendIntervalMs?: number;
  runBudgetMs?: number;
  queuedMaxAgeMs?: number;
}
export interface EmailOutboxRunSummary {
  claimed: number;
  sent: number;
  /** 失敗して再試行を待つ行 */
  requeued: number;
  dead: number;
  /** dead になった行のコード別の数 (通知の判断は DB の email_outbox_dead_counts が行う。ここは応答とログ用) */
  dead_codes: Record<string, number>;
  /** 時間の予算で打ち切った (残りはリース切れ後に次の回が取る) */
  stopped_early: boolean;
}
const EXPIRED_FAILURE: EmailTransportFailure = { code: EMAIL_OUTBOX_ERROR_CODES.expired, message: '作成から 7 日を超えたため送りませんでした', statusCode: null, retryable: false };
const SUPPRESSED_FAILURE: EmailTransportFailure = { code: EMAIL_OUTBOX_ERROR_CODES.suppressed, message: '宛先停止リストに載っている宛先のため送りませんでした', statusCode: null, retryable: false };

export async function processEmailOutbox(deps: EmailOutboxWorkerDeps, options: EmailOutboxRunOptions): Promise<EmailOutboxRunSummary> {
  const leaseSeconds = options.leaseSeconds ?? EMAIL_OUTBOX_LEASE_SECONDS;
  const sendIntervalMs = options.sendIntervalMs ?? EMAIL_OUTBOX_SEND_INTERVAL_MS;
  const runBudgetMs = options.runBudgetMs ?? EMAIL_OUTBOX_RUN_BUDGET_MS;
  const queuedMaxAgeMs = options.queuedMaxAgeMs ?? EMAIL_OUTBOX_QUEUED_MAX_AGE_MS;
  const summary: EmailOutboxRunSummary = { claimed: 0, sent: 0, requeued: 0, dead: 0, dead_codes: {}, stopped_early: false };

  const rows = await deps.store.claim(options.workerId, options.batchSize, leaseSeconds);
  summary.claimed = rows.length;
  const startedAt = deps.now();

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (i > 0) {
      if (deps.now() - startedAt > runBudgetMs) { summary.stopped_early = true; break; }
      await deps.sleep(sendIntervalMs);
    }
    const meta = { outbox_id: row.id, template: row.template, recipient: maskEmailAddress(row.to_email), attempt: row.attempts + 1 };

    let outcome: EmailTransportOutcome;
    const ageMs = deps.now() - Date.parse(row.created_at);
    if (Number.isFinite(ageMs) && ageMs > queuedMaxAgeMs) {
      outcome = { ok: false, failure: EXPIRED_FAILURE };
    } else {
      const suppression = await deps.suppression(row.to_email);
      if (suppression.status === 'suppressed') {
        outcome = { ok: false, failure: SUPPRESSED_FAILURE };
      } else {
        if (suppression.status === 'lookup_failed') deps.log.warn('宛先停止リストを引けなかったため、確かめずに送ります', meta);
        try {
          outcome = await deps.transport.send(row);
        } catch (err) {
          outcome = { ok: false, failure: { code: EMAIL_OUTBOX_ERROR_CODES.networkError, message: redactEmailAddresses(err instanceof Error ? err.message : String(err)), statusCode: null, retryable: true } };
        }
      }
    }

    if (outcome.ok) {
      const done = await deps.store.complete(row.id, options.workerId, outcome.id);
      if (done) summary.sent += 1;
      else deps.log.warn('送れたが、行は別の worker に取り直されたか、退会で伏せられていました (記録は更新していません)', meta);
      continue;
    }
    const next = await deps.store.fail(row.id, options.workerId, outcome.failure, { maxAttempts: options.maxAttempts, retryAfterSeconds: retryDelaySeconds(row.attempts + 1) });
    const failMeta = { ...meta, error_code: outcome.failure.code, status_code: outcome.failure.statusCode, retryable: outcome.failure.retryable };
    if (next === 'dead') {
      summary.dead += 1;
      summary.dead_codes[outcome.failure.code] = (summary.dead_codes[outcome.failure.code] ?? 0) + 1;
      deps.log.error('メールを届けられませんでした (dead)', new Error(outcome.failure.message), failMeta);
    } else if (next === 'queued') {
      summary.requeued += 1;
      deps.log.warn('メールの送信に失敗しました。時間をおいて再試行します', failMeta);
    } else {
      deps.log.warn('失敗の記録先の行が無い、別の worker に取り直された、または退会で伏せられていました', failMeta);
    }
  }
  return summary;
}
