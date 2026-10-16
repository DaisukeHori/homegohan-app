// @vitest-environment node
/**
 * #1169: getCspNonce (src/lib/security/csp-nonce.ts) は、middleware がリクエストヘッダー x-csp-nonce に載せた nonce を読む
 * (docs/design/cross/18-csp-nonce.md §9.2・§15)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestHeaders } = vi.hoisted(() => ({ requestHeaders: { current: new Headers() } }));

// Next 15 以降の headers() は Promise を返す (tests/next15-async-request-api-scan.test.ts の規則と同じ形にする)
vi.mock('next/headers', () => ({
  headers: async () => requestHeaders.current,
}));

const { getCspNonce } = await import('@/lib/security/csp-nonce');
const { CSP_NONCE_HEADER } = await import('@/lib/security/csp');

beforeEach(() => {
  requestHeaders.current = new Headers();
});

describe('getCspNonce (#1169)', () => {
  it('getCspNonce: headers() の x-csp-nonce を返す (next/headers のモックは Promise を返す形)', async () => {
    requestHeaders.current = new Headers({ [CSP_NONCE_HEADER]: 'dGVzdG5vbmNlMTIzNDU2Nzg=' });

    expect(CSP_NONCE_HEADER).toBe('x-csp-nonce');
    await expect(getCspNonce()).resolves.toBe('dGVzdG5vbmNlMTIzNDU2Nzg=');
  });

  it('無ければ null', async () => {
    await expect(getCspNonce()).resolves.toBeNull();
  });
});
