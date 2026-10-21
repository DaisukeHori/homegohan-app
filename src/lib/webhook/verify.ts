/**
 * Webhook の署名の確認。サーバー専用。#1184
 *
 * 規約の正本は docs/design/cross/04-api-conventions.md §10 (全 Webhook で署名の確認を必須にする)。
 * いまあるのは Resend (Svix の形) と Stripe (t/v1 の形。billing/01 §8.3) と RevenueCat (Stripe と同じ t/v1 の形。billing/03 §8.2)。
 *
 * Resend は Svix の形で署名を付ける (https://resend.com/docs/webhooks/verify-webhooks-requests):
 *   - ヘッダー: svix-id (メッセージ ID) / svix-timestamp (送った時刻。UNIX 秒) / svix-signature ("v1,<base64>" を空白区切りで 1 つ以上)
 *   - 署名: HMAC-SHA256(鍵, "<svix-id>.<svix-timestamp>.<受け取った本文そのまま>") の base64
 *   - 鍵: 管理画面の署名の秘密 ("whsec_<base64>") の whsec_ より後ろを base64 で戻したもの
 * Resend の SDK (resend.webhooks.verify) も中で同じ形 (svix) を確かめている。ここでは SDK の API キーを要らなくするため、
 * node:crypto だけで確かめる (同じ結果になることを src/__tests__/lib/webhook/verify.test.ts が SDK と突き合わせて確かめる)。
 */
import crypto from 'node:crypto';
import { getOptionalEnv } from '@/lib/env';

/**
 * 署名の秘密が無いときに投げる。署名の誤り (呼び出し元は 401) と見分けるため、別の型にする。
 * message に変数名を入れない (応答の本文に出うるため。変数名は getOptionalEnv が警告のログに残す)。
 */
export class WebhookSecretMissingError extends Error {
  constructor() {
    super('Webhook の署名の設定がありません');
    this.name = 'WebhookSecretMissingError';
  }
}

/**
 * 送った時刻と受けた時刻のずれの許容 (秒)。これを超えた署名は、古い (または未来の) ものとして受け付けない (再送の悪用を防ぐ)。
 * Svix の既定 (5 分) と同じ値。Resend の再送は毎回、その時刻で署名し直して届くので、再送がこれで弾かれることはない。
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/** 署名の秘密の前置き (Svix の形)。これより後ろが base64 の鍵 */
const SVIX_SECRET_PREFIX = 'whsec_';
/** 署名の版。v1 = HMAC-SHA256 */
const SVIX_SIGNATURE_VERSION = 'v1';
/** 1 秒のミリ秒 */
const MS_PER_SECOND = 1000;

/** 署名の秘密 ("whsec_<base64>") から HMAC の鍵を取り出す。whsec_ が無ければ全体を base64 として扱う */
function decodeSvixSecret(secret: string): Buffer {
  return Buffer.from(secret.startsWith(SVIX_SECRET_PREFIX) ? secret.slice(SVIX_SECRET_PREFIX.length) : secret, 'base64');
}

/** Svix の 3 つのヘッダー (Request の headers から readSvixHeaders で取り出す) */
export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/** Request のヘッダーから Svix の 3 つを取り出す */
export function readSvixHeaders(headers: Headers): SvixHeaders {
  return {
    id: headers.get('svix-id'),
    timestamp: headers.get('svix-timestamp'),
    signature: headers.get('svix-signature'),
  };
}

/** 確かめた結果。理由は app_logs に残すためだけに使う (応答の本文には出さない) */
export type WebhookVerification =
  | { ok: true }
  | { ok: false; reason: 'missing_headers' | 'invalid_timestamp' | 'timestamp_out_of_tolerance' | 'signature_mismatch' };

/**
 * Svix の形の署名を確かめる (秘密は引数で渡す。純粋な関数)。
 *
 * @param payload 受け取った本文そのまま (JSON として読み直したものではなく、バイト列どおりの文字列)
 * @param headers svix-id / svix-timestamp / svix-signature
 * @param secret  署名の秘密 ("whsec_<base64>"。whsec_ が無ければ全体を base64 として扱う)
 * @param nowMs   いまの時刻 (テストで差し替える)
 */
export function verifySvixSignature(
  payload: string,
  headers: SvixHeaders,
  secret: string,
  nowMs: number = Date.now(),
): WebhookVerification {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_headers' };

  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: 'invalid_timestamp' };
  const sentAtSeconds = Number(timestamp);
  const nowSeconds = Math.floor(nowMs / MS_PER_SECOND);
  if (Math.abs(nowSeconds - sentAtSeconds) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  const key = decodeSvixSecret(secret);
  // 鍵が空 (秘密が "whsec_" だけ・base64 として読めない) だと、誰でも同じ署名を作れてしまう。合わないものとして扱う
  if (key.length === 0) return { ok: false, reason: 'signature_mismatch' };
  const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest();

  // 秘密の入れ替えの間は、新旧の署名が空白区切りで並んで届く。どれか 1 つが合えばよい
  for (const entry of signature.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma < 0) continue;
    if (entry.slice(0, comma) !== SVIX_SIGNATURE_VERSION) continue;
    const given = Buffer.from(entry.slice(comma + 1), 'base64');
    // timingSafeEqual は長さが違うと例外を投げるので、先に長さをそろえて比べる
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: 'signature_mismatch' };
}

/**
 * Resend の Webhook の署名を、環境変数 RESEND_WEBHOOK_SECRET の秘密で確かめる。
 * 秘密が無ければ署名を確かめられないので、受け付けずに WebhookSecretMissingError を投げる (fail-closed)。
 */
export function verifyResendWebhook(payload: string, headers: SvixHeaders, nowMs: number = Date.now()): WebhookVerification {
  const secret = getOptionalEnv('RESEND_WEBHOOK_SECRET');
  // 未設定と、鍵が空になる値 ("whsec_" だけなど) は、どちらも設定の不足として扱う (署名の誤りの 401 ではなく 503)
  if (!secret || decodeSvixSecret(secret.trim()).length === 0) throw new WebhookSecretMissingError();
  return verifySvixSignature(payload, headers, secret.trim(), nowMs);
}

/** Stripe-Signature の要素 (t=…, v1=…)。Stripe の仕様 */
const STRIPE_SIGNATURE_TIMESTAMP_KEY = 't';
const STRIPE_SIGNATURE_SCHEME = 'v1';

export interface StripeSignatureHeader {
  timestamp: string | null;
  /** v1 の署名 (hex)。秘密の入れ替えの間は 2 つ以上並ぶ */
  signatures: string[];
}

/** "t=123,v1=abc,v1=def,v0=…" を分解する。知らない要素は無視する */
export function parseStripeSignatureHeader(header: string | null): StripeSignatureHeader {
  const parsed: StripeSignatureHeader = { timestamp: null, signatures: [] };
  if (!header) return parsed;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === STRIPE_SIGNATURE_TIMESTAMP_KEY) parsed.timestamp = value;
    else if (key === STRIPE_SIGNATURE_SCHEME && value.length > 0) parsed.signatures.push(value);
  }
  return parsed;
}

/**
 * Stripe の Webhook の署名を確かめる (秘密は引数で渡す。純粋な関数)。
 * @param payload 受け取った本文そのまま (JSON として読み直したものではない)
 * @param header  Stripe-Signature ヘッダーの値 (無ければ null)
 * @param secret  署名の秘密 (whsec_…。文字列のまま鍵にする)
 * @param nowMs   いまの時刻 (テストで差し替える)
 */
export function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowMs: number = Date.now(),
): WebhookVerification {
  const { timestamp, signatures } = parseStripeSignatureHeader(header);
  if (!timestamp || signatures.length === 0) return { ok: false, reason: 'missing_headers' };
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: 'invalid_timestamp' };
  const sentAtSeconds = Number(timestamp);
  const nowSeconds = Math.floor(nowMs / MS_PER_SECOND);
  if (Math.abs(nowSeconds - sentAtSeconds) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }
  // 空の秘密では誰でも同じ署名を作れる。合わないものとして扱う
  if (secret.length === 0) return { ok: false, reason: 'signature_mismatch' };
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest();
  for (const given of signatures) {
    const bytes = Buffer.from(given, 'hex');
    // timingSafeEqual は長さが違うと例外を投げるので、先に長さをそろえて比べる
    if (bytes.length === expected.length && crypto.timingSafeEqual(bytes, expected)) return { ok: true };
  }
  return { ok: false, reason: 'signature_mismatch' };
}

/**
 * Stripe の Webhook の署名を、環境変数 STRIPE_WEBHOOK_SECRET の秘密で確かめる。
 * 秘密が無ければ確かめられないので、受け付けずに WebhookSecretMissingError を投げる (fail-closed。route は 503)。
 */
export function verifyStripeWebhook(payload: string, header: string | null, nowMs: number = Date.now()): WebhookVerification {
  const secret = getOptionalEnv('STRIPE_WEBHOOK_SECRET');
  if (!secret || secret.trim().length === 0) throw new WebhookSecretMissingError();
  return verifyStripeSignature(payload, header, secret.trim(), nowMs);
}

/**
 * RevenueCat の Webhook の署名を確かめる (秘密は引数で渡す。純粋な関数。billing/03 §8.2)。
 * RevenueCat の X-RevenueCat-Webhook-Signature は Stripe-Signature と同じ形 (t=<unix 秒>,v1=<HMAC-SHA256 hex>・対象は "<t>.<本文>"・
 * 鍵は秘密の文字列そのまま) なので、Stripe の確認をそのまま使う。時刻の許容も同じ (WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 分)
 * @param payload 受け取った本文そのまま
 * @param header  X-RevenueCat-Webhook-Signature の値 (無ければ null。無い・形が違うときは missing_headers)
 * @param secret  署名の秘密 (RevenueCat の Integrations → Webhooks で 1 回だけ表示される値)
 * @param nowMs   いまの時刻 (テストで差し替える)
 */
export function verifyRevenueCatSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowMs: number = Date.now(),
): WebhookVerification {
  return verifyStripeSignature(payload, header, secret, nowMs);
}

/**
 * RevenueCat の Webhook の署名を、環境変数 REVENUECAT_WEBHOOK_SECRET の秘密で確かめる。
 * 秘密が無ければ受け付けずに WebhookSecretMissingError を投げる (fail-closed。route は 503)
 */
export function verifyRevenueCatWebhook(payload: string, header: string | null, nowMs: number = Date.now()): WebhookVerification {
  const secret = getOptionalEnv('REVENUECAT_WEBHOOK_SECRET');
  if (!secret || secret.trim().length === 0) throw new WebhookSecretMissingError();
  return verifyRevenueCatSignature(payload, header, secret.trim(), nowMs);
}
