/**
 * ログイン履歴・不審なログインの通知・セッションの一覧と失効の定数 (#1190・#1189)。
 * 設計の正典 docs/design/cross/16-auth-history-sessions.md §12.1。SQL (migration の auth_history_sessions) と同じ値を持つものは、
 * 契約テスト tests/auth-history-sessions-migration-contract.test.ts が突き合わせる。
 */

/** IPv4 で「同じ場所」とみなす範囲の長さ (/24)。携帯回線・家庭の回線は接続のたびに末尾が変わるので、ホスト単位では比べない。SQL の auth_session_created と同じ値 */
export const IP_NETWORK_PREFIX_V4 = 24;
/** IPv6 の同じ範囲 (/48 = 1 契約に割り当てられる典型の幅)。SQL と同じ値 */
export const IP_NETWORK_PREFIX_V6 = 48;
/** 終わったセッションの行 (= ログイン履歴) を残す日数。SQL の cleanup_ended_user_sessions_metadata と同じ値。不審の判定は期間で絞らず残っている行をすべて見て、アカウントの年齢がこれを超えて履歴が空なら「履歴が消えた」とみなす (§10.1) */
export const LOGIN_HISTORY_RETENTION_DAYS = 90;
/** 不審の判定で読む前の行の上限 (新しい順)。1 人が保持の 90 日の間にこれを超えてログインすることは想定しない。超えた分 (古い側) を見落としても、判定は「新しい端末」= 送る側に倒れる */
export const LOGIN_ALERT_PRIOR_MAX_ROWS = 1000;
/** 更新 (refresh) の無いまま終える日数 (cross/01 §4.1 の個人の絶対タイムアウト)。SQL の expire_idle_auth_sessions と同じ値 */
export const SESSION_IDLE_EXPIRE_DAYS = 30;
/** worker が 1 回 (1 分) で処理する行数の上限。1 行 = DB 2〜3 回 + メール 1 通で、1 分の中に収まる量 */
export const LOGIN_ALERT_BATCH_SIZE = 100;
/** 作成からこの秒数は判定しない。Web の route が同じ要求の中で IP / UA / 国を上書きするのを待つ (§13.5) */
export const LOGIN_ALERT_MIN_AGE_SECONDS = 15;
/** processing のまま止まった行 (関数が途中で死んだ) を取り直すまでの分数。Vercel の関数の最長 (60 秒) より十分長い */
export const LOGIN_ALERT_RECLAIM_MINUTES = 10;
/** 例外で失敗した行を諦めるまでの回数 */
export const LOGIN_ALERT_MAX_ATTEMPTS = 3;
/**
 * 作成からこの時間を過ぎた通知の待ちの行は、判定も送信もせずに done にする (claim_login_alerts の p_max_age_hours §11.4)。
 * 段 A のデプロイから段 B の worker まで・worker が止まっていた間に溜まった行を、後からまとめて送らない (何日も前のログインのメールは、
 * 本人が自分のログインかを確かめにくく、まとめて届くと読まれない)。1 日以内の遅れは、乗っ取りに気づいて失効させるのに間に合う範囲として送る。
 * 取り直し (LOGIN_ALERT_RECLAIM_MINUTES) × 試行 (LOGIN_ALERT_MAX_ATTEMPTS) より十分長い (ふつうの再試行は期限の前に終わる)
 */
export const LOGIN_ALERT_MAX_AGE_HOURS = 24;
/** 一覧 (利用者・運営) に出す履歴の件数 */
export const LOGIN_HISTORY_PAGE_SIZE = 20;
/** 通知を止めるスイッチ。値を読むのは src/app/api/cron/login-alerts/route.ts だけ (env.ts の readOnlyBy) */
export const AUTH_LOGIN_ALERT_ENV_NAME = 'AUTH_LOGIN_ALERT';

export type LoginAlertMode = 'on' | 'off';
export interface LoginAlertSetting { readonly mode: LoginAlertMode; readonly ignored: boolean }
/** 未設定・空白は on。on / off 以外は on に戻して ignored = true (resolveLoginFailureResetMinutes と同じ扱い) */
export function resolveLoginAlertMode(raw: string | undefined): LoginAlertSetting {
  const text = raw?.trim().toLowerCase();
  if (!text) return { mode: 'on', ignored: false };
  if (text === 'on' || text === 'off') return { mode: text, ignored: false };
  return { mode: 'on', ignored: true };
}
