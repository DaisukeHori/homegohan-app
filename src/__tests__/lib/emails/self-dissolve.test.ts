import { describe, expect, it } from 'vitest';
import { EmailEnvelopeSchema } from '@/lib/emails/envelope';
import { renderSelfDissolveEmail } from '@/lib/emails/membership/self-dissolve';
import { getSiteUrl, getSupportEmail } from '@/lib/site-config';

// #1917 利用者の解散の通知メール (docs/design/family/11-self-dissolve.md §16.1・§21.1)

const TO = 'taro@example.com';
/** 件名で切る名前の長さ (scope-label.ts の MAX_SUBJECT_NAME_CODE_POINTS) を超える長さ */
const LONG_NAME_LENGTH = 80;

describe('renderSelfDissolveEmail (#1917)', () => {
  it('件名は所属先の呼び方 + が解散されました (長い名前は件名だけ切る)。本文に 代表者 / オーナー により解散された旨・個人アカウントが残る旨・問い合わせ先があり、解散した人の名前は無い', () => {
    const family = renderSelfDissolveEmail({ to_email: TO, to_name: '太郎', scope: 'family', scope_name: '山田家' });
    expect(family.subject).toBe('【ほめゴハン】家族グループ「山田家」が解散されました');
    expect(family.text).toContain('家族グループ「山田家」は、代表者により解散されました。');
    expect(family.text).toContain('家族グループのメンバーシップは解除されています。');
    expect(family.text).toContain('あなたのほめゴハンの個人アカウントは、引き続きご利用いただけます。');
    expect(family.text).toContain(getSupportEmail());
    expect(family.text).toContain('太郎 様');

    const org = renderSelfDissolveEmail({ to_email: TO, to_name: '太郎', scope: 'organization', scope_name: '株式会社ほめゴハン' });
    expect(org.subject).toBe('【ほめゴハン】組織「株式会社ほめゴハン」が解散されました');
    expect(org.text).toContain('組織「株式会社ほめゴハン」は、オーナーにより解散されました。');
    expect(org.text).toContain('組織で記録した個人データも、あなたのアカウントに残ります。');

    const longName = 'あ'.repeat(LONG_NAME_LENGTH);
    const long = renderSelfDissolveEmail({ to_email: TO, to_name: null, scope: 'organization', scope_name: longName });
    expect(long.subject).toContain('…」が解散されました');
    expect(long.subject).not.toContain(longName);
    expect(long.text).toContain(longName);
    expect(EmailEnvelopeSchema.safeParse(long).success).toBe(true);

    // 解散した人 (代表者 / オーナー) の名前を載せる欄は無い。理由 (運営の文面の「解散理由」) も無い
    expect(family.text).not.toContain('解散理由');
    expect(family.text).not.toContain('運営');
  });

  it('名前が無い (null) なら宛名はアドレス。scope_name が null なら名前を省いた文面', () => {
    const email = renderSelfDissolveEmail({ to_email: TO, to_name: null, scope: 'family', scope_name: null });
    expect(email.text.startsWith(`${TO} 様`)).toBe(true);
    expect(email.subject).toBe('【ほめゴハン】家族グループが解散されました');
    expect(email.text).toContain('家族グループは、代表者により解散されました。');
    expect(email.text).not.toContain('「');
  });

  it('contains_secret を付けない (リンク・トークンを持たない)。template は self_dissolve', () => {
    const email = renderSelfDissolveEmail({ to_email: TO, to_name: null, scope: 'family', scope_name: '山田家' });
    expect(email.template).toBe('self_dissolve');
    expect(email.to).toBe(TO);
    expect(email).not.toHaveProperty('contains_secret');
    // 本文の URL は署名のサイトの URL だけ (トークンつきのリンクは無い)
    expect(email.text.match(/https?:\/\/\S+/g)).toEqual([getSiteUrl()]);
    expect(EmailEnvelopeSchema.safeParse(email).success).toBe(true);
  });
});
