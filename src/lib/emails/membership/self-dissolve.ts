// src/lib/emails/membership/self-dissolve.ts
// #1917 代表者 / オーナーが自分で解散したときの、メンバー (解散した本人を含む) への通知メール (docs/design/family/11-self-dissolve.md §16)。
// 運営の強制解散の文面 (operator-force-dissolve.ts。「運営側の判断により」「解散理由」) とは別の文面。理由は無い。
import type { EmailEnvelope } from '@/lib/emails/envelope';
import { emailSignature } from '@/lib/emails/common';
import { getEmailFrom, getSupportEmail } from '@/lib/site-config';
import {
  describeScope,
  describeScopeForSubject,
  membershipScopeLabel,
  type MembershipScope,
} from '@/lib/emails/membership/scope-label';

export interface SelfDissolveEmailVars {
  /** 宛先 (メンバー本人の登録メールアドレス) */
  to_email: string;
  /** 宛名。名前が無い (空・空白だけ・仮置きの 'Guest') ときは null (アドレスを宛名にする。#1649) */
  to_name: string | null;
  scope: MembershipScope;
  /** 家族グループ名 / 組織名。読めなかったときは null (名前を省いた文面にする) */
  scope_name: string | null;
}

/** 解散した人の呼び方 (家族: 代表者 / 組織: オーナー) */
function dissolverLabel(scope: MembershipScope): string {
  return scope === 'organization' ? 'オーナー' : '代表者';
}

/**
 * 利用者の解散の通知メール。
 * subject: 「【ほめゴハン】家族グループ「山田家」が解散されました」
 * 載せるのは所属先の名前と、何が起きたか (と本人のアカウントへの影響) だけ。解散した人の名前・ほかのメンバーの個人情報は載せない。
 */
export function renderSelfDissolveEmail(vars: SelfDissolveEmailVars): EmailEnvelope {
  const label = membershipScopeLabel(vars.scope);
  const greeting = vars.to_name ?? vars.to_email;

  return {
    // template の名前は定数にせず、文字列のリテラルで 1 行に書く (メールの番兵 2 本がソースのこの形の行から名前を拾う。§16.1・§23)
    template: 'self_dissolve',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: `【ほめゴハン】${describeScopeForSubject(vars.scope, vars.scope_name)}が解散されました`,
    text: `${greeting} 様

ほめゴハンをご利用いただきありがとうございます。

${describeScope(vars.scope, vars.scope_name)}は、${dissolverLabel(vars.scope)}により解散されました。
${label}のメンバーシップは解除されています。

あなたのほめゴハンの個人アカウントは、引き続きご利用いただけます。
${label}で記録した個人データも、あなたのアカウントに残ります。

心当たりがない場合や、ご不明な点がございましたら ${getSupportEmail()} までお問い合わせください。

${emailSignature()}
`,
  };
}
