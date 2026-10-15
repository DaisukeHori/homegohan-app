/**
 * tests/api/onboarding-status-route.test.ts
 *
 * #1635: GET /api/onboarding/status は、プロフィールの名前が仮置きの 'Guest' のときに nickname を返さない。
 * 以前は `nickname !== 'Guest'` を前後の空白を除かずに比べていたので、' Guest' のような値を名前として返していた。
 * Web・モバイルと同じ @homegohan/shared の normalizeProfileName (前後の空白を除いて 'Guest' と厳密一致なら名前なし) を使う。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ProfileRow {
  nickname: string | null;
  onboarding_started_at: string | null;
  onboarding_completed_at: string | null;
  onboarding_progress: unknown;
}

const state: { profile: ProfileRow | null } = { profile: null };
const mockGetUser = vi.fn();
const mockFrom = vi.fn((table: string) => {
  if (table !== 'user_profiles') throw new Error(`unexpected table ${table}`);
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: state.profile, error: null }),
  };
  return builder;
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser }, from: mockFrom }),
}));

import { GET } from '../../src/app/api/onboarding/status/route';

function profileWithNickname(nickname: string | null): ProfileRow {
  return {
    nickname,
    onboarding_started_at: '2026-10-01T00:00:00.000Z',
    onboarding_completed_at: '2026-10-01T00:10:00.000Z',
    onboarding_progress: null,
  };
}

async function getBody(): Promise<{ status: string; nickname?: string }> {
  const res = await GET();
  expect(res.status).toBe(200);
  return (await res.json()) as { status: string; nickname?: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  state.profile = null;
});

describe('GET /api/onboarding/status の nickname (#1635)', () => {
  it.each(['Guest', ' Guest', 'Guest ', '  Guest\t'])(
    "仮置き '%s' (前後の空白を除くと 'Guest') は名前が付いていないとして nickname を返さない",
    async (nickname) => {
      state.profile = profileWithNickname(nickname);
      const body = await getBody();
      expect(body.status).toBe('completed');
      expect(body).not.toHaveProperty('nickname');
    },
  );

  it.each([null, '', '   '])('名前が無い・空・空白だけ (%j) も nickname を返さない', async (nickname) => {
    state.profile = profileWithNickname(nickname);
    const body = await getBody();
    expect(body).not.toHaveProperty('nickname');
  });

  it.each(['太郎', 'guest', 'GUEST', 'ゲスト', 'Guest太郎'])(
    "'%s' は本人が付けた名前としてそのまま返す",
    async (nickname) => {
      state.profile = profileWithNickname(nickname);
      const body = await getBody();
      expect(body.nickname).toBe(nickname);
    },
  );

  it('本人が付けた名前は前後の空白を除いて返す (Web・モバイルの画面と同じ判定)', async () => {
    state.profile = profileWithNickname('  太郎 ');
    const body = await getBody();
    expect(body.nickname).toBe('太郎');
  });

  it('プロフィールの行が無いときは not_started で nickname を返さない', async () => {
    state.profile = null;
    const body = await getBody();
    expect(body.status).toBe('not_started');
    expect(body).not.toHaveProperty('nickname');
  });
});
