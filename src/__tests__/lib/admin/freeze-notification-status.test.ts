/**
 * src/lib/admin/freeze-notification-status.ts の単体テスト (#2026。設計 docs/design/cross/24-freeze-notify-mail.md §7.3・§12)
 */
import { describe, expect, it } from 'vitest';
import {
  FREEZE_NOTIFICATION_NOT_REQUESTED,
  FREEZE_NOTIFICATION_NOT_REQUESTED_MESSAGE,
  FREEZE_NOTIFICATION_SENT_MESSAGE,
  FREEZE_NOTIFICATION_UNKNOWN_MESSAGE,
  describeFreezeNotificationOutcome,
  freezeNotificationOutcomeOf,
  type FreezeNotificationOutcome,
} from '@/lib/admin/freeze-notification-status';

const NOT_CONFIGURED_MESSAGE = 'メール未送信: メール送信の設定が未完了のため、利用者には通知されていません。凍結は済んでいます';
const NO_RECIPIENT_MESSAGE = 'メール未送信: 利用者のメールアドレスを取得できなかったため、通知されていません。凍結は済んでいます';
const SEND_FAILED_MESSAGE = 'メール未送信: メールの送信に失敗しました。凍結は済んでいますが、利用者には通知されていません';

describe('freezeNotificationOutcomeOf (cross/24 §7.3)', () => {
  it('D-1 freezeNotificationOutcomeOf: 4 つの status を読み、表にある reason だけ残す', () => {
    expect(freezeNotificationOutcomeOf({ status: 'sent' })).toEqual({ status: 'sent' });
    expect(freezeNotificationOutcomeOf({ status: 'not_requested' })).toEqual({ status: 'not_requested' });
    expect(freezeNotificationOutcomeOf({ status: 'skipped', reason: 'not_configured' })).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(freezeNotificationOutcomeOf({ status: 'failed', reason: 'no_recipient' })).toEqual({ status: 'failed', reason: 'no_recipient' });
    expect(freezeNotificationOutcomeOf({ status: 'failed', reason: 'send_failed' })).toEqual({ status: 'failed', reason: 'send_failed' });
    // 表に無い reason・文字列でない reason・null の reason は落とす (status は残す)
    expect(freezeNotificationOutcomeOf({ status: 'failed', reason: 'boom' })).toEqual({ status: 'failed' });
    expect(freezeNotificationOutcomeOf({ status: 'skipped', reason: 1 })).toEqual({ status: 'skipped' });
    expect(freezeNotificationOutcomeOf({ status: 'sent', reason: null })).toEqual({ status: 'sent' });
    // ほかの項目 (outbox_id など) は持ち込まない
    expect(freezeNotificationOutcomeOf({ status: 'sent', outbox_id: 'ob-1' })).toEqual({ status: 'sent' });
    expect(FREEZE_NOTIFICATION_NOT_REQUESTED).toEqual({ status: 'not_requested' });
  });

  it('D-2 freezeNotificationOutcomeOf: オブジェクトでない・status が無い・未知の status は null', () => {
    for (const value of [undefined, null, 'sent', 1, true, [], {}, { reason: 'send_failed' }, { status: 'queued' }, { status: 1 }, { status: null }]) {
      expect(freezeNotificationOutcomeOf(value)).toBeNull();
    }
  });
});

describe('describeFreezeNotificationOutcome (cross/24 §7.3)', () => {
  it('D-3 describeFreezeNotificationOutcome: sent / not_requested / 3 つの reason / reason の無い skipped・failed / null の 8 通り', () => {
    const table: ReadonlyArray<[FreezeNotificationOutcome | null, string]> = [
      [{ status: 'sent' }, FREEZE_NOTIFICATION_SENT_MESSAGE],
      [{ status: 'not_requested' }, FREEZE_NOTIFICATION_NOT_REQUESTED_MESSAGE],
      [{ status: 'skipped', reason: 'not_configured' }, NOT_CONFIGURED_MESSAGE],
      [{ status: 'failed', reason: 'no_recipient' }, NO_RECIPIENT_MESSAGE],
      [{ status: 'failed', reason: 'send_failed' }, SEND_FAILED_MESSAGE],
      [{ status: 'skipped' }, NOT_CONFIGURED_MESSAGE],
      [{ status: 'failed' }, SEND_FAILED_MESSAGE],
      [null, FREEZE_NOTIFICATION_UNKNOWN_MESSAGE],
    ];
    for (const [outcome, expected] of table) {
      expect(describeFreezeNotificationOutcome(outcome)).toBe(expected);
    }
    expect(FREEZE_NOTIFICATION_SENT_MESSAGE).toBe('通知メールを送信待ちに登録しました (届くまで数分かかることがあります)');
    expect(FREEZE_NOTIFICATION_NOT_REQUESTED_MESSAGE).toBe('通知メールは送っていません');
    expect(FREEZE_NOTIFICATION_UNKNOWN_MESSAGE).toBe(
      '通知メールの結果を確認できませんでした (運営最上位の画面の監査ログ閲覧 /super-admin/audit-logs で admin.user.ban の行を展開し、details の notification を確認してください)',
    );
  });
});
