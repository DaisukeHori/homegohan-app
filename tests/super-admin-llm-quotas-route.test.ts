/**
 * #1149: GET / PATCH /api/super-admin/llm/quotas
 *
 * LLM 利用クォータの管理は準備中 (未対応)。
 *   - GET が返すのはコードに直接書いた目安の値で、DB には保存されておらず、AI の呼び出し (献立生成・相談・栄養計算など) には
 *     適用されていない。応答に enforced: false を付けて、「この値で制限されている」と読めないようにする
 *   - 以前の PATCH は、値をどこにも保存せず、監査ログ (super_admin.llm_quota.override) だけを残して、受け取った値を
 *     そのまま返していた。変更できたように見えるが何も変わらず、監査ログにも事実と異なる記録が残った。
 *     いまの PATCH は何も保存せず、監査ログも残さず、501 OP_NOT_SUPPORTED を返す
 * オーナー判断: 海外の AI プロバイダーへのデータ送信は止めない (この API は AI の呼び出しを止めたり制限したりしない)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { LLM_QUOTAS_NOT_ENFORCED_NOTE, LLM_QUOTA_UPDATE_NOT_SUPPORTED_MESSAGE } from '@/lib/super-admin/llm-schemas';

const requireRole = vi.hoisted(() => vi.fn());
/** Supabase クライアントを作ったら記録する (クォータの API は DB に触れてはならない) */
const dbTouched = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/helpers', () => ({ requireRole }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => {
    dbTouched('createClient', ...args);
    throw new Error('quotas API must not touch the database');
  },
  getSupabaseAdmin: (...args: unknown[]) => {
    dbTouched('getSupabaseAdmin', ...args);
    throw new Error('quotas API must not touch the database');
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

import { GET, PATCH } from '../src/app/api/super-admin/llm/quotas/route';

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue({ id: 'admin-1', roles: ['super_admin'] });
});

describe('GET /api/super-admin/llm/quotas', () => {
  it('目安の値を返し、enforced: false で「AI の呼び出しには適用されていない」と伝える', async () => {
    const res = await GET();
    const json = (await res.json()) as {
      data: Array<{ plan_key: string; daily_limit: number | null; monthly_limit: number | null }>;
      enforced: boolean;
      note: string;
    };

    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith(['super_admin']);
    expect(json.enforced).toBe(false);
    expect(json.note).toBe(LLM_QUOTAS_NOT_ENFORCED_NOTE);
    expect(json.note).toContain('適用されておらず');

    // 目安の値 (operator/06-ai-llm.md §5.1) は従来のまま
    const byPlan = new Map(json.data.map((row) => [row.plan_key, row]));
    expect(json.data).toHaveLength(8);
    expect(byPlan.get('free')).toEqual({ plan_key: 'free', daily_limit: 50, monthly_limit: 1000 });
    expect(byPlan.get('org_enterprise')).toEqual({ plan_key: 'org_enterprise', daily_limit: null, monthly_limit: null });
    expect(dbTouched).not.toHaveBeenCalled();
  });

  it('未認証は 401、権限が無ければ 403', async () => {
    requireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    expect((await GET()).status).toBe(401);

    requireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED', 'Requires one of: super_admin'));
    expect((await GET()).status).toBe(403);
  });
});

describe('PATCH /api/super-admin/llm/quotas', () => {
  it('501 OP_NOT_SUPPORTED を返す。変更できたように見える応答 (受け取った値の echo) を返さない', async () => {
    const res = await PATCH();
    const json = await res.json();

    expect(res.status).toBe(501);
    expect(requireRole).toHaveBeenCalledWith(['super_admin']);
    expect(json).toEqual({ error: { code: 'OP_NOT_SUPPORTED', message: LLM_QUOTA_UPDATE_NOT_SUPPORTED_MESSAGE } });
    expect(json.error.message).toContain('準備中（未対応）');
    expect(json).not.toHaveProperty('data');
  });

  it('何も保存せず、監査ログ (super_admin.llm_quota.override) も残さない: Supabase に一切触れない', async () => {
    await PATCH();

    expect(dbTouched).not.toHaveBeenCalled();
  });

  it('未認証は 401、権限が無ければ 403 (未対応とは教えない)', async () => {
    requireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    expect((await PATCH()).status).toBe(401);

    requireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED', 'Requires one of: super_admin'));
    const forbidden = await PATCH();
    expect(forbidden.status).toBe(403);
    expect(JSON.stringify(await forbidden.json())).not.toContain('準備中');

    expect(dbTouched).not.toHaveBeenCalled();
  });
});
