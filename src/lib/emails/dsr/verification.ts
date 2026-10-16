// src/lib/emails/dsr/verification.ts
// #1178 個人情報の請求 (開示・訂正・利用停止・消去) の本人確認のお願い。請求を作ったとき・確認メールを再送したときに本人へ送る。
// 本文に請求の内容 (details) は載せない (メールは転送・盗み見されうる。設計 cross/15 §10)。
import type { EmailEnvelope } from '../envelope';
import { emailSignature } from '../common';
import { getEmailFrom, getSupportEmail } from '@/lib/site-config';
import { DSR_VERIFICATION_TTL_HOURS, type DsrRequestType } from '@/lib/data-subject-requests/core';
import { dsrSummaryLines } from './format';

export interface DsrVerificationEmailVars {
  /** 宛先 (請求した本人の auth.users の登録メールアドレス) */
  to_email: string;
  request_type: DsrRequestType;
  /** 請求の id (先頭 8 桁を受付番号として出す) */
  request_id: string;
  /** 本人確認のリンク (buildDsrVerifyUrl で作った絶対 URL) */
  verify_url: string;
}

/**
 * subject: 「【ほめゴハン】個人情報の請求の本人確認のお願い」
 * 載せるもの: 種類・受付番号・確認リンク・有効期限 (DSR_VERIFICATION_TTL_HOURS 時間)・ログインしてから開く案内・心当たりが無いときの問い合わせ先
 */
export function renderDsrVerificationEmail(vars: DsrVerificationEmailVars): EmailEnvelope {
  return {
    template: 'dsr_verification',
    // 本人確認のリンク (verify_url) に生のトークンが入る (DB には sha256 だけを置く約束: cross/15 §3.1)。送れた・届けられなかったあとに送信待ちの行の宛先・件名・本文を伏せる (#1708)
    contains_secret: true,
    to: vars.to_email,
    from: getEmailFrom(),
    subject: '【ほめゴハン】個人情報の請求の本人確認のお願い',
    text: `いつもほめゴハンをご利用いただきありがとうございます。

設定画面から、個人情報について次の請求を受け付けました。
請求を出したのがご本人であることを確かめるため、下のリンクを開いてください。

${dsrSummaryLines(vars.request_type, vars.request_id)}

▼ 本人確認のリンク (${DSR_VERIFICATION_TTL_HOURS} 時間有効)
${vars.verify_url}

リンクは、ほめゴハンにログインしてから開いてください。
ログインしていない状態で開いた場合は、ログインのあとに、このメールのリンクをもう一度開いてください。
有効期限が過ぎた場合は、設定画面の「確認メールを再送」から新しいリンクを受け取れます。

この請求に心当たりが無い場合は、リンクを開かずに ${getSupportEmail()} までお問い合わせください。

${emailSignature()}
`,
  };
}
