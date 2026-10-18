/**
 * #1867 「計画上手」(planner) を、AI の週の献立の生成が成功したとき (状態の確認 GET /api/ai/menu/weekly/status が完了を読んだとき) に付ける保険の経路。
 * 付与の本体は、行が completed になった時点で付ける DB のトリガー weekly_menu_requests_award_planner
 * (supabase/migrations/20261018060000_planner_badge_award_on_weekly_menu_completed.sql。tests/integration/security/planner-badge-weekly-menu.test.ts の W-6)。
 *
 * AI で複数の日の献立をまとめて作る生成 (POST /api/ai/menu/weekly/request・v4/generate と v5/generate で対象が複数の日 (2 日以上) にわたるとき・AI 相談の 1 週間分の生成) は、行を作るときに generated_data へ印 (weeklyRequest: true) を書く。
 * Edge Function が献立を保存し終えると行は completed になり (1 食も保存できなかった・中止・止まったときは failed)、
 * 画面は完了を主に行の変化 (Realtime) で知り、この状態の確認は代替の経路。状態の確認は、generated_data 全体を読まずに印だけを weekly_request として読む。
 *
 * 確かめること:
 *   - completed で印のある行: 本人 (user.id) に、service role のクライアントで awardBadge(..., 'planner') を 1 回呼ぶ
 *   - 印の無い行 (1 日・1 食の生成・献立の改善)・印が真偽値の true でない行: 付けない
 *   - completed でない行 (processing / queued / pending / failed): 印があっても付けない
 *   - 止まった行を failed にした応答: 付けない
 *   - 付与に失敗しても、状態の確認の応答 (200・本文) は変えない
 *   - 印だけを読み、generated_data 全体は読まない (#1042)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WEEKLY_MENU_REQUEST_STALE_MINUTES } from '@/lib/weekly-menu-request-stale';

/** テストの「今」(固定) */
const NOW_MS = Date.parse('2026-10-18T03:00:00.000Z');
const MIN = 60 * 1000;
const ago = (minutes: number) => new Date(NOW_MS - minutes * MIN).toISOString();
/** しきい値を超えて止まった分数 */
const STALE_MINUTES = WEEKLY_MENU_REQUEST_STALE_MINUTES + 10;

const mockGetUser = vi.fn();

const selectResultQueue: Array<{ data: unknown; error: unknown }> = [];
const mockMaybeSingle = vi.fn(() => Promise.resolve(selectResultQueue.shift() ?? { data: null, error: null }));
const mockSelectEq2 = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockSelectEq1 = vi.fn(() => ({ eq: mockSelectEq2 }));
const mockSelect = vi.fn((..._args: unknown[]) => ({ eq: mockSelectEq1 }));

const mockFrom = vi.fn((table: string) => {
  if (table === 'weekly_menu_requests') return { select: mockSelect };
  throw new Error(`Unexpected table in test: ${table}`);
});

const mockSupabase = { auth: { getUser: mockGetUser }, from: mockFrom };

// service role のクライアント。止まった行の比較つきの更新 (update(...).eq...select) だけを受ける。
// バッジの付与は awardBadge をモックするので、ここには来ない
const updateResultQueue: Array<{ data: Array<{ id: string; generated_data: unknown }> | null; error: unknown }> = [];
function makeUpdateBuilder() {
  const builder = {
    eq: () => builder,
    is: () => builder,
    select: () => Promise.resolve(updateResultQueue.shift() ?? { data: [], error: null }),
  };
  return builder;
}
const mockUpdate = vi.fn(() => makeUpdateBuilder());
const mockAdminFrom = vi.fn((table: string) => {
  if (table === 'weekly_menu_requests') return { update: mockUpdate };
  throw new Error(`Unexpected table in test (admin): ${table}`);
});
const adminClient = { from: mockAdminFrom };
const mockGetSupabaseAdmin = vi.fn(() => adminClient);

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => mockSupabase),
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}));

const mockAwardBadge = vi.fn();
vi.mock('@/lib/badges/awardBadge', () => ({
  awardBadge: (...args: unknown[]) => mockAwardBadge(...args),
}));

vi.mock('@/lib/planned-meals-snapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planned-meals-snapshot')>();
  return { ...actual, restorePlannedMealsSnapshot: vi.fn(async () => ({ restored: 0, skipped: 0, failed: 0 })) };
});

const { GET } = await import('@/app/api/ai/menu/weekly/status/route');
const { WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_SELECT } = await import('@/lib/ai/weekly-menu-request-origin');

const user = { id: 'user-1' };

const makeRequest = (requestId: string) =>
  new Request(`http://localhost/api/ai/menu/weekly/status?requestId=${requestId}`);

/** status が読む行 (既定は週の献立の生成の印があり、完了した行) */
function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    status: 'completed',
    error_message: null,
    created_at: ago(10),
    updated_at: ago(1),
    worker_acquired_at: null,
    mode: 'v4',
    start_date: '2026-10-19',
    target_meal_id: null,
    progress: { message: '全21件の献立が完成しました！' },
    weekly_request: true,
    ...overrides,
  };
}

const AWARDED = { awarded: true, badge_id: 'b-planner', obtained_at: '2026-10-18T03:00:00.000Z', name: '計画上手', icon_url: '📋' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  selectResultQueue.length = 0;
  updateResultQueue.length = 0;
  mockGetUser.mockResolvedValue({ data: { user }, error: null });
  mockAwardBadge.mockResolvedValue(AWARDED);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/ai/menu/weekly/status: 週の献立の生成が完了したら planner を付ける (#1867)', () => {
  it('印だけを weekly_request として読み、generated_data 全体は読まない', async () => {
    selectResultQueue.push({ data: requestRow({ status: 'processing' }), error: null });

    await GET(makeRequest('req-1'));

    const columns = String(mockSelect.mock.calls[0][0]).split(',').map((c) => c.trim());
    expect(columns).toContain(WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_SELECT);
    expect(WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_SELECT).toBe('weekly_request:generated_data->weeklyRequest');
    expect(columns).not.toContain('generated_data');
    // 読むのは本人の行だけ (付与の相手もこの user.id)
    expect(mockSelectEq1).toHaveBeenCalledWith('id', 'req-1');
    expect(mockSelectEq2).toHaveBeenCalledWith('user_id', user.id);
  });

  it('completed で印のある行は、本人に service role のクライアントで planner を 1 回付ける', async () => {
    selectResultQueue.push({ data: requestRow(), error: null });

    const res = await GET(makeRequest('req-1'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe('completed');
    expect(mockAwardBadge).toHaveBeenCalledTimes(1);
    expect(mockAwardBadge).toHaveBeenCalledWith(adminClient, user.id, 'planner');
  });

  it('付与済み (awarded: false) でも、状態の確認の応答は同じ', async () => {
    mockAwardBadge.mockResolvedValue({ ...AWARDED, awarded: false });
    selectResultQueue.push({ data: requestRow(), error: null });

    const res = await GET(makeRequest('req-1'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      status: 'completed',
      errorMessage: null,
      error_message: null,
      updatedAt: requestRow().updated_at,
      progress: requestRow().progress,
    });
    expect(mockAwardBadge).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['印の無い行 (1 日・1 食の生成・献立の改善)', null],
    ['印が false', false],
    ['印が文字列の "true"', 'true'],
    ['印が 1', 1],
  ])('completed でも %s には付けない', async (_label, weeklyRequest) => {
    selectResultQueue.push({ data: requestRow({ weekly_request: weeklyRequest }), error: null });

    const res = await GET(makeRequest('req-1'));

    expect(res.status).toBe(200);
    expect(mockAwardBadge).not.toHaveBeenCalled();
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it.each(['processing', 'queued', 'pending', 'failed'])('status が %s の行には、印があっても付けない (失敗・中止・生成中)', async (status) => {
    selectResultQueue.push({ data: requestRow({ status }), error: null });

    const res = await GET(makeRequest('req-1'));

    expect(res.status).toBe(200);
    expect(mockAwardBadge).not.toHaveBeenCalled();
  });

  it('止まった行を failed にした応答では付けない', async () => {
    const staleAt = ago(STALE_MINUTES);
    selectResultQueue.push({
      data: requestRow({ status: 'processing', created_at: staleAt, updated_at: staleAt }),
      error: null,
    });
    updateResultQueue.push({ data: [{ id: 'req-1', generated_data: { weeklyRequest: true } }], error: null });

    const res = await GET(makeRequest('req-1'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe('failed');
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockAwardBadge).not.toHaveBeenCalled();
  });

  it('付与に失敗しても (例外)、状態の確認は 200 で同じ本文を返す', async () => {
    mockAwardBadge.mockRejectedValue(Object.assign(new Error('permission denied'), { code: '42501' }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    selectResultQueue.push({ data: requestRow(), error: null });

    const res = await GET(makeRequest('req-1'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      status: 'completed',
      errorMessage: null,
      error_message: null,
      updatedAt: requestRow().updated_at,
      progress: requestRow().progress,
    });
    expect(mockAwardBadge).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
