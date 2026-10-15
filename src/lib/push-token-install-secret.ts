/**
 * 端末の秘密の値 (install secret) の発行とハッシュ (#1636)。POST /api/push-tokens/claim・release が使う (Node の route だけ)。
 * 取り決め (形・長さ・使い方) は packages/shared/src/push-token-claim.ts。
 *
 * サーバーは値そのものを持たず、SHA-256 のハッシュ (16 進の小文字 64 文字) だけを user_push_tokens.install_secret_hash に持つ。
 * 値は 256 bit の乱数なので、塩や遅いハッシュ (パスワード用) は要らない (辞書や総当たりで元の値を探せない)。
 */
import { createHash, randomBytes } from 'node:crypto';
import { PUSH_INSTALL_SECRET_BYTES } from '@homegohan/shared';

/** user_push_tokens.install_secret_hash の形 (migration の CHECK と同じ。SHA-256 の 16 進の小文字) */
export const PUSH_INSTALL_SECRET_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** 新しい端末の秘密の値を作る (32 バイトの乱数の base64url。詰め物の = なし。43 文字) */
export function generatePushInstallSecret(): string {
  return randomBytes(PUSH_INSTALL_SECRET_BYTES).toString('base64url');
}

/** 端末の秘密の値のハッシュ (DB に持つ値)。値の形の確認は呼び出し側 (isPushInstallSecret) で済ませる */
export function hashPushInstallSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}
