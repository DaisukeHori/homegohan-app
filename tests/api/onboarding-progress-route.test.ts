/**
 * tests/api/onboarding-progress-route.test.ts
 *
 * Issue #1045 (F6-12): /api/onboarding/progress の answers 無バリデーション対策の
 * route レベル回帰テスト。
 *
 *   - age="abc" / gender 不正値 → 400
 *   - nickname に <script> を含めても raw のまま保存される (二重エスケープしない)
 *   - nutrition_goal が athlete_performance でなくなったら performance_profile が null になる (F6-13 連携)
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── supabase/server モック ────────────────────────────────────────────────────
const mockGetUser = vi.fn();
const mockSingle = vi.fn();
const mockUpsert = vi.fn();

function makeBuilder() {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn().mockReturnValue(builder);
  builder.eq = vi.fn().mockReturnValue(builder);
  builder.single = mockSingle;
  builder.upsert = mockUpsert;
  return builder;
}

const supabaseClient = {
  auth: { getUser: mockGetUser },
  from: vi.fn(() => makeBuilder()),
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => supabaseClient,
}));

import { POST } from '../../src/app/api/onboarding/progress/route';

function makeRequest(body: unknown): Request {
  return new Request('https://homegohan-app.vercel.app/api/onboarding/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  // upsert(...).select(...).single() が返すチェーン
  mockUpsert.mockReturnValue({
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({
        data: { onboarding_progress: { currentStep: 1, answers: {}, totalQuestions: 30 } },
        error: null,
      }),
    }),
  });
  // 既存プロファイル fetch (select().eq().single()) の戻り値
  mockSingle.mockResolvedValue({
    data: { onboarding_started_at: null, onboarding_completed_at: null },
    error: null,
  });
});

const baseBody = {
  currentStep: 1,
  totalQuestions: 30,
};

describe('#1045 F6-12: age/gender バリデーション', () => {
  it('age="abc" は 400 を返す (NaN が age_group に混入するのを防ぐ)', async () => {
    const req = makeRequest({ ...baseBody, answers: { age: 'abc' } });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('gender が不正な値の場合 400 を返す', async () => {
    const req = makeRequest({ ...baseBody, answers: { gender: 'invalid_value' } });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('age/gender が妥当な場合は 200 で保存される', async () => {
    const req = makeRequest({ ...baseBody, answers: { age: '25', gender: 'male' } });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ age: 25, age_group: '20s', gender: 'male' }),
    );
  });
});

describe('#1045 F6-12: nickname raw 保存', () => {
  it('<script> を含む nickname が HTML エスケープされずに raw のまま保存される', async () => {
    const req = makeRequest({
      ...baseBody,
      answers: { nickname: '<script>alert(1)</script>' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ nickname: '<script>alert(1)</script>' }),
    );
  });
});

describe('#1045 F6-13: performance_profile のクリア', () => {
  it('nutrition_goal が athlete_performance 以外に変わったら performance_profile が null で保存される', async () => {
    const req = makeRequest({
      ...baseBody,
      answers: { nutrition_goal: 'lose_weight', target_weight: '60' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ performance_profile: null }),
    );
  });

  it('nutrition_goal が athlete_performance のときは performance_profile が構築される', async () => {
    const req = makeRequest({
      ...baseBody,
      answers: { nutrition_goal: 'athlete_performance', sport_type: 'soccer' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const call = mockUpsert.mock.calls[0][0];
    expect(call.performance_profile).not.toBeNull();
    expect(call.performance_profile.sport.id).toBe('soccer');
  });
});
