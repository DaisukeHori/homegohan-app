/**
 * Apple の client_secret (ES256 の JWT) を作る (docs/design/mobile/08-sign-in-with-apple.md §11.2。F-14 の形)。
 * ライブラリを足さず node:crypto で署名する (ECDSA P-256 + SHA-256。JOSE の署名は r||s の生の 64 バイトなので dsaEncoding: 'ieee-p1363')。
 */
import { createPrivateKey, sign } from 'node:crypto';

/** client_secret の aud (config.ts の APPLE_CLIENT_SECRET_AUDIENCE と同じ値。このファイルは config.ts を import しない) */
const CLIENT_SECRET_AUDIENCE = 'https://appleid.apple.com';

export interface AppleClientSecretInput {
  /** Apple Developer の Team ID (10 文字) */
  readonly teamId: string;
  /** Sign in with Apple の Key の Key ID (10 文字) */
  readonly keyId: string;
  /** .p8 の中身 (PEM) */
  readonly privateKeyPem: string;
  /** client_id (bundle ID か Services ID)。sub に入れる */
  readonly clientId: string;
  /** 発行の時刻 (UNIX 秒) */
  readonly issuedAtSeconds: number;
  /** 有効期間 (秒)。6 か月 (15,777,000) を超えない */
  readonly ttlSeconds: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function createAppleClientSecret(input: AppleClientSecretInput): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: input.keyId }));
  const payload = base64url(
    JSON.stringify({
      iss: input.teamId,
      iat: input.issuedAtSeconds,
      exp: input.issuedAtSeconds + input.ttlSeconds,
      aud: CLIENT_SECRET_AUDIENCE,
      sub: input.clientId,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: createPrivateKey(input.privateKeyPem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}
