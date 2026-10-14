/**
 * #1041 round-2 (B/H) 回帰防止 contract テスト
 * GET /api/experiments/[key]/assignment
 *
 * 従来は requireUser() (一般ユーザー) + user-scoped client のままだったため、
 * `experiments_select_super_admin` (FOR ALL, super_admin のみ) の RLS で
 * experiments の SELECT が常に空になり 404、experiment_assignments への
 * INSERT も拒否されていた (running にしても runtime で完全に無効)。
 *
 * 検証観点:
 *  - requireUser() 通過後に service-role (`getSupabaseAdmin()`) が使われること
 *  - 認可前に service-role へ切り替わらないこと (権限昇格穴が無いこと)
 *  - experiment_assignments へのクエリが必ず caller 自身の userId (session の
 *    user id) にスコープされること (IDOR 防止。userId はリクエストの
 *    body/param からではなく requireUser() の戻り値からのみ得られる)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './helpers/fake-supabase';

const mockRequireUser = vi.fn();
const mockGetSupabaseAdmin = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireUser: (...args: unknown[]) => mockRequireUser(...args),
}));

let fakeSupabase: ReturnType<typeof createFakeSupabase>;

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}));

const { GET } = await import('@/app/api/experiments/[key]/assignment/route');

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSupabaseAdmin.mockImplementation(() => fakeSupabase);
});

function findFromCallBuilder(fake: ReturnType<typeof createFakeSupabase>, table: string) {
  const idx = fake.from.mock.calls.findIndex((call) => call[0] === table);
  if (idx === -1) return undefined;
  return fake.from.mock.results[idx]!.value as { eq: ReturnType<typeof vi.fn> };
}

describe('GET /api/experiments/[key]/assignment (#1041 round-2 B)', () => {
  it('401: 未認証 (service-role へは切り替わらない)', async () => {
    const { AuthError } = await import('@/lib/auth/errors');
    mockRequireUser.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));
    fakeSupabase = createFakeSupabase({});

    const res = await GET(new Request('http://localhost/api/experiments/exp-1/assignment'), {
      params: { key: 'exp-1' },
    });

    expect(res.status).toBe(401);
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('service-role (getSupabaseAdmin) を使い、caller 自身の userId にスコープして割当を取得する', async () => {
    mockRequireUser.mockResolvedValue({ id: 'user-self', email: 'self@example.com' });
    fakeSupabase = createFakeSupabase({
      experiments: [
        {
          data: { id: 'exp-1', key: 'exp-1', status: 'running', variants: [{ key: 'a', weight: 1 }] },
          error: null,
        },
      ],
      experiment_assignments: [{ data: { variant_key: 'a' }, error: null }],
    });

    const res = await GET(new Request('http://localhost/api/experiments/exp-1/assignment'), {
      params: { key: 'exp-1' },
    });

    expect(mockGetSupabaseAdmin).toHaveBeenCalled();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { assigned: boolean; variant_key: string } };
    expect(json.data.assigned).toBe(true);
    expect(json.data.variant_key).toBe('a');

    // experiment_assignments への問い合わせが caller 自身の userId (user-self) に
    // スコープされていること (他ユーザーの割当を読み書きしない — IDOR 防止)
    const builder = findFromCallBuilder(fakeSupabase, 'experiment_assignments');
    expect(builder).toBeTruthy();
    expect(builder!.eq).toHaveBeenCalledWith('user_id', 'user-self');
  });

  it('割当が無い場合は新規作成する。作成 INSERT も caller 自身の userId であること', async () => {
    mockRequireUser.mockResolvedValue({ id: 'user-new', email: 'new@example.com' });
    fakeSupabase = createFakeSupabase({
      experiments: [
        {
          data: { id: 'exp-2', key: 'exp-2', status: 'running', variants: [{ key: 'a', weight: 1 }, { key: 'b', weight: 1 }] },
          error: null,
        },
      ],
      experiment_assignments: [
        { data: null, error: null }, // 既存チェック: なし
        { data: { variant_key: 'b' }, error: null }, // insert().select().single()
      ],
    });

    const res = await GET(new Request('http://localhost/api/experiments/exp-2/assignment'), {
      params: { key: 'exp-2' },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { assigned: boolean; variant_key: string } };
    expect(json.data.assigned).toBe(true);
    expect(['a', 'b']).toContain(json.data.variant_key);

    // 2 回目の from('experiment_assignments') が insert() 呼び出しであること
    const insertIdx = fakeSupabase.from.mock.calls
      .map((call, i) => ({ call, i }))
      .filter(({ call }) => call[0] === 'experiment_assignments')[1]?.i;
    expect(insertIdx).toBeDefined();
    const insertBuilder = fakeSupabase.from.mock.results[insertIdx!]!.value as { insert: ReturnType<typeof vi.fn> };
    expect(insertBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ experiment_id: 'exp-2', user_id: 'user-new' }),
    );
  });

  it('実験が見つからない場合は 404', async () => {
    mockRequireUser.mockResolvedValue({ id: 'user-self' });
    fakeSupabase = createFakeSupabase({ experiments: [{ data: null, error: null }] });

    const res = await GET(new Request('http://localhost/api/experiments/missing/assignment'), {
      params: { key: 'missing' },
    });
    expect(res.status).toBe(404);
  });

  it('running でない実験は割当を作らず assigned:false を返す', async () => {
    mockRequireUser.mockResolvedValue({ id: 'user-self' });
    fakeSupabase = createFakeSupabase({
      experiments: [{ data: { id: 'exp-3', key: 'exp-3', status: 'draft', variants: [] }, error: null }],
    });

    const res = await GET(new Request('http://localhost/api/experiments/exp-3/assignment'), {
      params: { key: 'exp-3' },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { assigned: boolean; reason: string } };
    expect(json.data.assigned).toBe(false);
    expect(json.data.reason).toBe('not_running');
    // experiment_assignments には一切触れない (割当を作らない)
    expect(fakeSupabase.from.mock.calls.some((call) => call[0] === 'experiment_assignments')).toBe(false);
  });

  it('experiments 取得エラー時は 500 (fail-closed)', async () => {
    mockRequireUser.mockResolvedValue({ id: 'user-self' });
    fakeSupabase = createFakeSupabase({
      experiments: [{ data: null, error: { message: 'connection lost' } }],
    });

    const res = await GET(new Request('http://localhost/api/experiments/exp-4/assignment'), {
      params: { key: 'exp-4' },
    });
    expect(res.status).toBe(500);
  });
});
