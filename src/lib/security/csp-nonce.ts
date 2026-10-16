// src/lib/security/csp-nonce.ts
import { headers } from 'next/headers';
import { CSP_NONCE_HEADER } from '@/lib/security/csp';

/**
 * このリクエストの CSP の nonce (middleware が x-csp-nonce に載せた値)。middleware の外 (matcher の除外パス・ビルド時) は null。
 * アプリのインラインスクリプトは 0 本なので今は呼ぶ画面が無い。どうしてもインラインの script や next/script が要るときは、
 * これを `nonce` 属性に渡し、tests/csp-no-inline-script.test.ts の ALLOWED_INLINE_SCRIPTS に理由と件数を書く
 * (規則は docs/design/cross/18-csp-nonce.md §9.11)。
 * headers() は await の直下で呼ぶ (tests/next15-async-request-api-scan.test.ts の規則 1)
 */
export async function getCspNonce(): Promise<string | null> {
  return (await headers()).get(CSP_NONCE_HEADER);
}
