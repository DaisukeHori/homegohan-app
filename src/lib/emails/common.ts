// src/lib/emails/common.ts
// メールの文面 (membership/*, support/*) で共通の部品 (#1194)。
// 送信元・問い合わせ先・サイトの URL は src/lib/site-config.ts で決まる。文面には直接書かない。
import { getSiteUrl } from '@/lib/site-config';

/**
 * 本文の末尾に付ける署名 (区切り線・サービス名・サイトの URL)。末尾に改行は付けない。
 * サイトの URL は NEXT_PUBLIC_APP_URL に従う。
 */
export function emailSignature(): string {
  return `─────────────────
ほめゴハン
${getSiteUrl()}`;
}
