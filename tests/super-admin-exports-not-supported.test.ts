/**
 * #1126: データエクスポート API (/api/super-admin/exports, /api/super-admin/exports/[id]) は、
 * 全メソッドが 501 (OP_NOT_SUPPORTED) を返す。DB には一切触れない。
 *
 * 以前は、ファイルを作る処理 (cron / worker) も専用テーブルも無いまま、依頼を受け付けていた。
 *   - 専用テーブルが無いため、利用者本人の GDPR 削除要求の表 (gdpr_deletion_requests) を代用していた。
 *     書き込もうとした列 (status / deletion_type / request_details) がその表に無く、依頼は必ず失敗し、
 *     失敗すると偽の ID を作って 201 (処理中) を返していた (依頼は保存されず、完了もしない)。
 *   - DELETE (キャンセル) は、実在する本人の削除要求に cancelled_at を入れて取り消してしまう。
 * ここでは、次を確かめる。
 *   - super_admin には、どのメソッドでも 501 + OP_NOT_SUPPORTED。成功に見える応答 (2xx・偽の ID) を返さない
 *   - 未認証は 401、ロール不足は 403 (未対応とは教えない)
 *   - DB (Supabase クライアント) を作らない。ソースにも gdpr_deletion_requests への参照が無い
 * 実 DB での確認 (本人の削除要求がキャンセルされないこと) は tests/integration/security/super-admin-columns.test.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { EXPORTS_NOT_SUPPORTED_MESSAGE } from '@/lib/super-admin/exports-schemas';

const requireRole = vi.hoisted(() => vi.fn());
/** Supabase クライアントを作ったら記録する (この API は DB に触れてはならない) */
const dbTouched = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/helpers', () => ({ requireRole }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => {
    dbTouched('createClient', ...args);
    throw new Error('exports API must not touch the database');
  },
  getSupabaseAdmin: (...args: unknown[]) => {
    dbTouched('getSupabaseAdmin', ...args);
    throw new Error('exports API must not touch the database');
  },
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser: vi.fn(),
  })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

import * as listRoute from '../src/app/api/super-admin/exports/route';
import * as itemRoute from '../src/app/api/super-admin/exports/[id]/route';

const ROUTES = [
  { name: '/api/super-admin/exports', file: 'src/app/api/super-admin/exports/route.ts', handlers: listRoute },
  { name: '/api/super-admin/exports/[id]', file: 'src/app/api/super-admin/exports/[id]/route.ts', handlers: itemRoute },
] as const;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue({ id: 'admin-1', roles: ['super_admin'] });
});

describe.each(ROUTES)('$name', ({ file, handlers }) => {
  it.each(METHODS)('%s は 501 OP_NOT_SUPPORTED。成功に見える応答 (2xx・偽の ID) を返さず、DB に触れない', async (method) => {
    const handler = handlers[method] as () => Promise<Response>;
    expect(handler).toBeTypeOf('function');

    const res = await handler();
    const json = await res.json();

    expect(res.status).toBe(501);
    expect(json).toEqual({ error: { code: 'OP_NOT_SUPPORTED', message: EXPORTS_NOT_SUPPORTED_MESSAGE } });
    expect(json.error.message).toContain('準備中（未対応）');
    // 偽の依頼 ID や「処理中」の応答を返さない
    expect(json).not.toHaveProperty('data');
    expect(requireRole).toHaveBeenCalledWith(['super_admin']);
    expect(dbTouched).not.toHaveBeenCalled();
  });

  it.each(METHODS)('%s: 未認証は 401、ロール不足は 403。未対応とは教えず、DB にも触れない', async (method) => {
    const handler = handlers[method] as () => Promise<Response>;

    requireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    const unauthenticated = await handler();
    expect(unauthenticated.status).toBe(401);

    requireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED', 'Requires one of: super_admin'));
    const forbidden = await handler();
    expect(forbidden.status).toBe(403);
    expect(JSON.stringify(await forbidden.json())).not.toContain('準備中');

    expect(dbTouched).not.toHaveBeenCalled();
  });

  it('GET / POST / PUT / PATCH / DELETE のすべてを export している (どのメソッドでも 501 になる)', () => {
    for (const method of METHODS) {
      expect(handlers[method], `${method} が export されていない`).toBeTypeOf('function');
    }
  });

  it('ソースが Supabase を import せず、gdpr_deletion_requests を参照しない (コメントを除く)', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    // コメントには、以前の不具合の説明として表名が出てくる。コードだけを見る
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    expect(code).not.toMatch(/gdpr_deletion_requests/);
    expect(code).not.toMatch(/supabase/i);
    expect(code).not.toMatch(/\.from\(/);
  });
});
