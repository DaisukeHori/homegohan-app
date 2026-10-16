/**
 * 不審なログインの通知の worker (#1190)。GET /api/cron/login-alerts (Vercel Cron。毎分) が呼ぶ。
 * 設計の正典 docs/design/cross/16-auth-history-sessions.md §13.3 (シグネチャと deps)・§13.4 (1 行の順)・§10・§10.2。
 *
 * 1 回の実行: 取り置き (RPC claim_login_alerts) → 行ごとに判定 (decideLoginAlert) → 送る (sendEmail = 送信待ち email_outbox への登録)
 * → 記録 (finishLoginAlert)。例外の行は戻す (RPC release_login_alert)。
 *
 * 「送る」は送信待ちに登録すること: sendEmail の ok が真なら alert_sent_at = 登録した日時 (届いたかは含まない)。
 * 届けるのは GET /api/cron/email-outbox の worker で、再試行・dead・運用メールは送信待ちの仕組み (operator/10) が受け持つ。
 * 本書の行には配信の結果を書き戻さない (§7.1)。sendEmail が登録できなかった (ok: false) ときも再送せず done にする。
 *
 * 件数・ログには、メールアドレス・IP・UA を入れない (件数だけ §13.4 の 7)。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { renderLoginNewDeviceEmail } from '@/lib/emails/account/login-new-device';
import { sendEmail } from '@/lib/emails/send';
import {
  LOGIN_ALERT_BATCH_SIZE,
  LOGIN_ALERT_MAX_AGE_HOURS,
  LOGIN_ALERT_MAX_ATTEMPTS,
  LOGIN_ALERT_MIN_AGE_SECONDS,
  LOGIN_ALERT_PRIOR_MAX_ROWS,
  LOGIN_ALERT_RECLAIM_MINUTES,
  LOGIN_HISTORY_RETENTION_DAYS,
  type LoginAlertMode,
} from './constants';
import { deviceFamilyOf, deviceLabelOf } from './device-family';
import { decideLoginAlert } from './login-alert-policy';
import { claimLoginAlerts, finishLoginAlert, listPriorLogins, releaseLoginAlert } from './store';

/**
 * 取り置いた行のうち worker が使う列 (store.ts の SessionRow はこの形に代入できる)。ip_address は完全な IP (メールの「IP アドレス」の行・一覧と同じ値)、ip_network は判定に使う範囲。
 * device_name は持たない (利用者が書ける値をメールに載せない §7.1。メールの端末は deviceLabelOf(deviceFamilyOf(user_agent)) だけ)
 */
export interface LoginAlertRow {
  session_id: string; user_id: string; user_agent: string | null; ip_address: string | null; ip_network: string | null;
  country_code: string | null; created_at: string;
}
export interface PriorLogin { deviceFamilyKey: string; ipNetwork: string | null; countryCode: string | null }
/** 判定と宛先に使う利用者の情報 */
export interface LoginAlertAccount {
  /** 登録メールアドレス。無ければ null (送らない) */
  email: string | null;
  /** auth.users.created_at (§10.1 の「アカウントの年齢」) */
  createdAt: Date;
}
export interface LoginAlertWorkerDeps {
  claim(): Promise<LoginAlertRow[]>;
  /**
   * listPriorLogins(admin, { userId: row.user_id, sessionId: row.session_id, createdAt: row.created_at, limit: LOGIN_ALERT_PRIOR_MAX_ROWS }) を
   * PriorLogin にしたもの (device_family が NULL の行は deviceFamilyOf(user_agent).key)。期間では絞らない (§10.1)
   */
  priorLogins(row: LoginAlertRow): Promise<PriorLogin[]>;
  /** auth.admin.getUserById(user_id) の user.email と user.created_at。利用者が居なければ null */
  accountOf(userId: string): Promise<LoginAlertAccount | null>;
  /**
   * createLoginAlertWorkerDeps の send。deviceLabel = deviceLabelOf(deviceFamilyOf(row.user_agent)) (決まった言葉だけ §13.4)。
   * ok = sendEmail が送信待ち (email_outbox) に登録できた (SendEmailResult.ok。届いたかは含まない。配信は GET /api/cron/email-outbox の worker §10.2)。
   * 登録できなかった (ok: false = suppressed・not_configured (skipped: true)・invalid_envelope・outbox_failed) は { ok: false } で返り、例外にしない
   */
  send(row: LoginAlertRow, deviceLabel: string, to: string): Promise<{ ok: boolean }>;
  /** sentAt = 送信待ちに登録できた (send の ok が真) ときの now() (alert_sent_at)。それ以外 (送らない判定・宛先無し・ok: false) は null (§13.4 の 5) */
  finish(sessionId: string, result: { deviceFamily: string; isNewDevice: boolean; isNewIp: boolean; isNewCountry: boolean; sentAt: Date | null }): Promise<void>;
  release(sessionId: string): Promise<void>;
  now(): Date;
}
/**
 * 件数だけ。claimed = claim() が返した行の数。どの行も queued・skipped・failed のどれか 1 つだけに数える (claimed = queued + skipped + failed)。
 * queued と skipped は finish が戻った後に数える (§13.4 の 5)。queued = 通知メールを送信待ちに登録し、finish でその日時を記録できた行 (届いたかは含まない)。
 * skipped = 送らない判定・宛先無し・登録できなかった行で、finish が戻った行。
 * failed = §13.4 の 1〜5 で例外になった行 (release を呼ぶ。release も例外でも failed。send が ok: true の後に finish が例外になった行も failed だけで、queued に数えない §10.2 #10・#11)
 */
export interface LoginAlertWorkerSummary { claimed: number; queued: number; skipped: number; failed: number }

/** 1 行を処理した結果 (finish が戻った後の数え方 §13.4 の 5) */
type RowOutcome = 'queued' | 'skipped';

/** 1 行の処理 (§13.4 の 1〜5)。例外はそのまま投げ、呼ぶ側 (processLoginAlerts) が release して failed に数える */
async function processRow(deps: LoginAlertWorkerDeps, row: LoginAlertRow, alertMode: LoginAlertMode): Promise<RowOutcome> {
  // 1. 端末の種類・前の行・利用者
  const family = deviceFamilyOf(row.user_agent);
  const prior = await deps.priorLogins(row);
  const account = await deps.accountOf(row.user_id);
  // 2. 利用者が消えた → 送らずに印を false で終える
  if (account === null) {
    await deps.finish(row.session_id, { deviceFamily: family.key, isNewDevice: false, isNewIp: false, isNewCountry: false, sentAt: null });
    return 'skipped';
  }
  // 3. 判定
  const decision = decideLoginAlert(
    { deviceFamilyKey: family.key, ipNetwork: row.ip_network, countryCode: row.country_code },
    prior,
    { accountCreatedAt: account.createdAt, now: deps.now(), retentionDays: LOGIN_HISTORY_RETENTION_DAYS },
  );
  // 4. 送るのは shouldNotify かつ on のときだけ。端末の文言は UA から決まる言葉だけ (行の device_name は使わない §7.1)。ここではまだ数えない
  let sent: { ok: boolean } | null = null;
  if (decision.shouldNotify && alertMode === 'on' && account.email !== null) {
    sent = await deps.send(row, deviceLabelOf(family), account.email);
  }
  // 5. 記録 (送らない判定の行も finish する)。sentAt = 送信待ちに登録した日時 (届いたかは含まない)
  const queued = sent?.ok === true;
  await deps.finish(row.session_id, {
    deviceFamily: family.key,
    isNewDevice: decision.isNewDevice,
    isNewIp: decision.isNewIp,
    isNewCountry: decision.isNewCountry,
    sentAt: queued ? deps.now() : null,
  });
  // finish が戻った後に数える (finish が例外なら呼ぶ側で failed だけ)
  return queued ? 'queued' : 'skipped';
}

/**
 * 取り置いた行を 1 行ずつ処理する (§13.4)。claim 自体の失敗は例外 (route が 500 にする)。
 * 1 行の例外は release して failed に数え、次の行へ進む (release の例外も握る)。同じ回の中で send をやり直さない
 */
export async function processLoginAlerts(
  deps: LoginAlertWorkerDeps,
  options: { alertMode: LoginAlertMode },
): Promise<LoginAlertWorkerSummary> {
  const rows = await deps.claim();
  const summary: LoginAlertWorkerSummary = { claimed: rows.length, queued: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    try {
      const outcome = await processRow(deps, row, options.alertMode);
      summary[outcome] += 1;
    } catch {
      // 6. 戻す (attempts + 1、LOGIN_ALERT_MAX_ATTEMPTS 回目で done)。release も失敗すれば processing のまま残り、取り直しの対象になる (§10)
      summary.failed += 1;
      try {
        await deps.release(row.session_id);
      } catch {
        // 握る (行は LOGIN_ALERT_RECLAIM_MINUTES の後の取り置きで取り直される)
      }
    }
  }
  // 7. 件数だけを返す
  return summary;
}

/** auth.admin.getUserById の「利用者が居ない」 */
const HTTP_NOT_FOUND = 404;

/** 本物の deps (§13.3 の表)。cron の route が getSupabaseAdmin() を渡して呼ぶ */
export function createLoginAlertWorkerDeps(admin: SupabaseClient): LoginAlertWorkerDeps {
  return {
    claim: () =>
      claimLoginAlerts(admin, {
        batchSize: LOGIN_ALERT_BATCH_SIZE,
        minAgeSeconds: LOGIN_ALERT_MIN_AGE_SECONDS,
        reclaimMinutes: LOGIN_ALERT_RECLAIM_MINUTES,
        maxAgeHours: LOGIN_ALERT_MAX_AGE_HOURS,
      }),
    priorLogins: async (row) => {
      const rows = await listPriorLogins(admin, {
        userId: row.user_id,
        sessionId: row.session_id,
        createdAt: row.created_at,
        limit: LOGIN_ALERT_PRIOR_MAX_ROWS,
      });
      return rows.map((p) => ({
        deviceFamilyKey: p.device_family ?? deviceFamilyOf(p.user_agent).key,
        ipNetwork: p.ip_network,
        countryCode: p.country_code,
      }));
    },
    accountOf: async (userId) => {
      const { data, error } = await admin.auth.admin.getUserById(userId);
      if (error) {
        if (error.status === HTTP_NOT_FOUND) return null;
        throw error;
      }
      const user = data.user;
      if (!user) return null;
      return { email: user.email ?? null, createdAt: new Date(user.created_at) };
    },
    send: async (row, deviceLabel, to) => {
      // 送信待ち (email_outbox) への登録。ok: true = 登録できた (届いたかは含まない §10.2)。
      // userId は email_outbox.user_id (退会時の伏せ字 prepare_account_deletion の 1b)。redactAfterSend は渡さない (文面は秘密を含まず、dead の行を再送できるようにする §18)
      const result = await sendEmail(
        renderLoginNewDeviceEmail({
          to_email: to,
          logged_in_at: new Date(row.created_at),
          device_label: deviceLabel,
          ip_address: row.ip_address,
          country_code: row.country_code,
        }),
        { idempotencyKey: `login-alert:${row.session_id}`, userId: row.user_id },
      );
      return { ok: result.ok };
    },
    // alert_sent_at に入るのは「送信待ちに登録した日時」(段 A の store.ts は値の経路だけを持つ §21.4)
    finish: (sessionId, result) => finishLoginAlert(admin, { sessionId, ...result }),
    release: (sessionId) => releaseLoginAlert(admin, { sessionId, maxAttempts: LOGIN_ALERT_MAX_ATTEMPTS }),
    now: () => new Date(),
  };
}
