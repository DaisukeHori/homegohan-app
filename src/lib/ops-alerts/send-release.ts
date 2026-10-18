/**
 * 運用メール (OPS_ALERT_EMAIL) を送れなかったとき、取った「送る権利」(claim_ops_alert) を返すかどうかの規則 (#1577 の 8)。
 *
 * 権利を取って運用メールを送る cron (app-log-alerts・backup-freshness) が共有する。送り直しの規則を route ごとに
 * 書き分けると、片方だけ「同じ結果になる送り直し」を繰り返す (#1577 の 8 の残り: backup-freshness が suppressed でも返していた)。
 *
 * 純粋なモジュール (DB・Resend・ロガーを読み込まない)。呼び出し側のテストが sendEmail をモックしても実物のまま使える。
 */

/**
 * sendEmail の結果が ok: false でも、送る権利 (と届けられなかったメールの印) を返さない失敗のコード (#1577 の 8)。
 * 宛先が停止リストに載っている (suppressed)・文面の不備 (invalid_envelope) は、送り直しても同じ結果になり、
 * 権利を返すと cron の回ごとの繰り返し (送信待ちの dead の行と warn) になるため。クールダウンの抑止を効かせる
 * (suppressed は dead の行が画面に残る)。
 * それ以外 (送信の設定が未完了 not_configured・送信待ちへの登録の失敗 outbox_failed など) は権利を返し、次の回でもう一度試す
 */
export const NON_RELEASING_SEND_ERROR_CODES: ReadonlySet<string> = new Set(['suppressed', 'invalid_envelope']);
