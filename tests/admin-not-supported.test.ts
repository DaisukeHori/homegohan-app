/**
 * #1126 #1128 #1149: 運営 API の「未対応 (準備中)」の共通応答 (src/lib/admin/not-supported.ts)
 *
 * 実処理がまだ無い機能の API は、成功に見せかけず 501 + OP_NOT_SUPPORTED を返す。
 * 認可 (401 / 403) は先に行い、権限のある人にだけ「未対応」と伝える。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';

const requireRole = vi.hoisted(() => vi.fn());
/** createLogger(...).error の呼び出し (想定外の例外の記録) */
const logError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/helpers', () => ({ requireRole }));

vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: logError,
    withUser: vi.fn(),
  })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

const { OP_NOT_SUPPORTED, notSupportedResponse, respondNotSupported } = await import('@/lib/admin/not-supported');

const MESSAGE = 'この機能は準備中（未対応）です';

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue({ id: 'admin-1', roles: ['super_admin'] });
});

describe('notSupportedResponse', () => {
  it('501 と OP_NOT_SUPPORTED を返す', async () => {
    const res = notSupportedResponse(MESSAGE);

    expect(OP_NOT_SUPPORTED).toBe('OP_NOT_SUPPORTED');
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: { code: 'OP_NOT_SUPPORTED', message: MESSAGE } });
  });
});

describe('respondNotSupported', () => {
  const options = { routeName: 'GET /api/test', roles: ['super_admin'] as const, message: MESSAGE };

  it('認可を通った人には 501 を返す。指定したロールで認可する', async () => {
    const res = await respondNotSupported(options);

    expect(requireRole).toHaveBeenCalledWith(['super_admin']);
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: { code: 'OP_NOT_SUPPORTED', message: MESSAGE } });
  });

  it('未認証は 401。未対応とは教えない', async () => {
    requireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));

    const res = await respondNotSupported(options);
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe('UNAUTHORIZED');
    expect(JSON.stringify(json)).not.toContain(MESSAGE);
  });

  it('ロール不足は 403。未対応とは教えない', async () => {
    requireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED', 'Requires one of: super_admin'));

    const res = await respondNotSupported(options);
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('FORBIDDEN');
    expect(JSON.stringify(json)).not.toContain(MESSAGE);
  });

  it('想定外の例外は 500 の汎用メッセージにして記録する (例外の文は画面に出さない)', async () => {
    const boom = new Error('boom: internal detail');
    requireRole.mockRejectedValueOnce(boom);

    const res = await respondNotSupported(options);
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('internal detail');
    expect(logError).toHaveBeenCalledWith(expect.any(String), boom);
  });
});
