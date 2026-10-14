import { describe, it, expect } from 'vitest';
import { describeReplyEmailOutcome } from '@/lib/admin/support-reply-email-status';

describe('describeReplyEmailOutcome', () => {
  it('送信済み (sent) は案内を出さない', () => {
    expect(describeReplyEmailOutcome({ status: 'sent' })).toBeNull();
  });

  it.each([undefined, null, 'sent', 123, []])(
    '結果が読み取れない応答 (%j、内部メモは email を返さない) は案内を出さない',
    (value) => {
      expect(describeReplyEmailOutcome(value)).toBeNull();
    },
  );

  it('status が未知の値なら案内を出さない', () => {
    expect(describeReplyEmailOutcome({ status: 'queued' })).toBeNull();
    expect(describeReplyEmailOutcome({})).toBeNull();
  });

  it('skipped + not_configured: メール送信の設定が未完了と案内する', () => {
    const message = describeReplyEmailOutcome({ status: 'skipped', reason: 'not_configured' });
    expect(message).toContain('メール未送信');
    expect(message).toContain('メール送信の設定が未完了');
    expect(message).toContain('返信メッセージは保存済み');
  });

  it('failed + no_recipient: メールアドレスを取得できなかったと案内する', () => {
    const message = describeReplyEmailOutcome({ status: 'failed', reason: 'no_recipient' });
    expect(message).toContain('メール未送信');
    expect(message).toContain('メールアドレスを取得できなかった');
  });

  it('failed + send_failed: 送信に失敗したと案内する', () => {
    const message = describeReplyEmailOutcome({ status: 'failed', reason: 'send_failed' });
    expect(message).toContain('メール未送信');
    expect(message).toContain('メールの送信に失敗');
  });

  it('理由が無い / 未知のときは status から推定して案内する', () => {
    expect(describeReplyEmailOutcome({ status: 'skipped' })).toContain('メール送信の設定が未完了');
    expect(describeReplyEmailOutcome({ status: 'failed' })).toContain('メールの送信に失敗');
    expect(describeReplyEmailOutcome({ status: 'failed', reason: 'something_new' })).toContain(
      'メールの送信に失敗',
    );
  });

  it('理由に Object のプロパティ名 (toString など) が来ても案内文として扱う', () => {
    // 辞書の継承プロパティを引いて関数が返らないこと
    expect(describeReplyEmailOutcome({ status: 'failed', reason: 'toString' })).toContain('メール未送信');
    expect(describeReplyEmailOutcome({ status: 'failed', reason: '__proto__' })).toContain('メール未送信');
  });
});
