/**
 * #1180: GET /api/super-admin/infra/alerts
 *
 * infra_alerts に書き込む処理 (監視データの収集) は無く、この一覧は常に空になる。
 * 以前の応答は external_sources (SENTRY_DSN / BETTER_STACK_TOKEN の環境変数があるか) を含み、画面が
 * 「Sentry / Better Stack が接続済み」と表示していたが、Sentry / Better Stack を使う処理はリポジトリのどこにも無い。
 * 環境変数があるだけで「接続済み」に見えるのは誤解を招くため、応答から取り除いた。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createFakeSupabase } from './helpers/fake-supabase';

const requireRole = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ supabase: null as unknown }));

vi.mock('@/lib/auth/helpers', () => ({ requireRole }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => state.supabase,
}));

import { GET } from '../src/app/api/super-admin/infra/alerts/route';

const request = (query = '') => new Request(`http://localhost/api/super-admin/infra/alerts${query}`) as never;

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue({ id: 'admin-1', roles: ['super_admin'] });
  state.supabase = createFakeSupabase({ infra_alerts: [{ data: [], error: null, count: 0 }] });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/super-admin/infra/alerts', () => {
  it('アラートの一覧とページ情報だけを返す', async () => {
    const res = await GET(request());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith(['super_admin']);
    expect(json).toEqual({ data: [], meta: { total: 0, page: 1, per_page: 50 } });
  });

  it('SENTRY_DSN / BETTER_STACK_TOKEN があっても、接続状態 (external_sources) を返さない', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://example.invalid/1');
    vi.stubEnv('BETTER_STACK_TOKEN', 'token-for-test');

    const res = await GET(request());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).not.toHaveProperty('external_sources');
    expect(JSON.stringify(json)).not.toMatch(/sentry|better_stack/i);
  });

  it('アラートがあるときは、その行をそのまま返す', async () => {
    const alert = {
      id: 'alert-1',
      metric_name: 'vercel_error_rate',
      threshold: 5,
      comparison: '>',
      triggered_at: '2026-10-08T00:00:00Z',
      resolved_at: null,
    };
    state.supabase = createFakeSupabase({ infra_alerts: [{ data: [alert], error: null, count: 1 }] });

    const res = await GET(request());
    const json = await res.json();

    expect(json.data).toEqual([alert]);
    expect(json.meta.total).toBe(1);
  });

  it('未認証は 401、権限が無ければ 403', async () => {
    requireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    expect((await GET(request())).status).toBe(401);

    requireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED', 'Requires one of: super_admin'));
    expect((await GET(request())).status).toBe(403);
  });
});
