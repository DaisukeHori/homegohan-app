/**
 * #1146: 栄養分析 API (GET /api/ai/nutrition-analysis) の糖質の目標
 *
 * 糖質を「炭水化物 − 食物繊維」で正しく計算すると、1日の実績は 200〜300g 前後になる。
 * 以前の目標 (WHO の遊離糖の目安 ≒ 25g、保存値が無いときの既定値 50g) と比べると常に「過剰」と判定されてしまうため、
 * 目標も 炭水化物の目標 − 食物繊維の目標 から求める。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetUser, mockFrom, mockCreateCompletion } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockFrom: vi.fn(),
  mockCreateCompletion: vi.fn(),
}));

// 同意の判定 (T15 / #1154) は「同意済み」に差し替える。同意が無いときに止めることは tests/ai-consent-enforcement.test.ts が確かめる
vi.mock('@/lib/ai/consent-guard', () => import('./helpers/ai-consent-guard-allowed'));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));

vi.mock('@/lib/ai/fast-llm', () => ({
  getFastLLMClient: () => ({ chat: { completions: { create: mockCreateCompletion } } }),
  getFastLLMModel: () => 'test-model',
}));

vi.mock('@/lib/generate-menu-v4-retry', () => ({
  callGenerateMenuV4WithRetry: vi.fn(),
  markWeeklyMenuRequestFailed: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true })),
  rateLimitExceededResponse: vi.fn(),
}));

/** select チェーンを返すモック。末尾の .single() は Promise、チェーンをそのまま await しても data/error を持つ */
function makeSelectChain(finalValue: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {
    data: finalValue.data,
    error: finalValue.error,
  };
  for (const method of ['select', 'eq', 'gte', 'lte']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}

function mealWithSugar(sugar_g: number | null) {
  return {
    calories_kcal: 650,
    protein_g: 25,
    fat_g: 20,
    carbs_g: 95,
    fiber_g: 7,
    sodium_g: 2,
    sugar_g,
    potassium_mg: 800,
    calcium_mg: 200,
    iron_mg: 3,
    vitamin_c_mg: 30,
    vitamin_d_ug: 2,
    cholesterol_mg: 100,
    user_daily_meals: { day_date: '2026-10-08' },
  };
}

function setup(params: { targets: Record<string, unknown> | null; meals: unknown[] }) {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'sugar-target-user' } }, error: null });
  mockFrom.mockImplementation((table: string) => {
    if (table === 'user_profiles') {
      return makeSelectChain({
        data: { age: 30, gender: 'male', health_conditions: [], medications: [], nutrition_goal: 'maintain' },
        error: null,
      });
    }
    if (table === 'nutrition_targets') {
      return makeSelectChain({ data: params.targets, error: params.targets ? null : { code: 'PGRST116' } });
    }
    if (table === 'planned_meals') {
      return makeSelectChain({ data: params.meals, error: null });
    }
    throw new Error(`unexpected table: ${table}`);
  });
}

async function analyze(query = '') {
  const { GET } = await import('../src/app/api/ai/nutrition-analysis/route');
  const res = await GET(new Request(`http://localhost/api/ai/nutrition-analysis?period=today${query}`));
  expect(res.status).toBe(200);
  return (await res.json()) as {
    analysis: {
      aggregated: Record<string, number>;
      dailyAverage: Record<string, number>;
      comparison: Record<string, { actual: number; target: number; percentage: number; status: string }>;
      issues: string[];
    };
  };
}

describe('nutrition-analysis: 糖質の目標 = 炭水化物の目標 − 食物繊維の目標 (#1146)', () => {
  beforeEach(() => {
    mockGetUser.mockReset();
    mockFrom.mockReset();
    mockCreateCompletion.mockReset();
    mockCreateCompletion.mockResolvedValue({ choices: [{ message: { content: 'アドバイス: 野菜を増やしましょう' } }] });
  });

  it('以前に保存された WHO 遊離糖の目安 (sugar_g = 25) ではなく、炭水化物 − 食物繊維 と比べる', async () => {
    // 1日 3食で 糖質 240g (炭水化物 − 食物繊維 の実績)。保存済みの sugar_g は旧式の 25g のまま
    setup({
      targets: { daily_calories: 2144, carbs_g: 295, fiber_g: 21, sugar_g: 25 },
      meals: [mealWithSugar(80), mealWithSugar(80), mealWithSugar(80)],
    });

    const { analysis } = await analyze();

    expect(analysis.dailyAverage.sugar).toBe(240);
    expect(analysis.comparison.sugar.target).toBe(274); // 295 - 21
    expect(analysis.comparison.sugar.percentage).toBe(88);
    expect(analysis.comparison.sugar.status).toBe('ok');
    expect(analysis.issues.some((issue) => issue.includes('糖質'))).toBe(false);
  });

  it('糖質が目標を大きく超えたときは、これまでどおり「過剰」と判定する', async () => {
    setup({
      targets: { daily_calories: 2144, carbs_g: 295, fiber_g: 21, sugar_g: 25 },
      meals: [mealWithSugar(120), mealWithSugar(120), mealWithSugar(120)], // 360g = 目標 274g の 131%
    });

    const { analysis } = await analyze();

    expect(analysis.comparison.sugar.percentage).toBe(131);
    expect(analysis.comparison.sugar.status).toBe('excess');
    expect(analysis.issues).toContain('糖質が過剰です（131%）');
  });

  it('手動で変えた炭水化物・食物繊維の目標に追従する', async () => {
    setup({
      targets: { daily_calories: 1800, carbs_g: 150, fiber_g: 25, sugar_g: 45 },
      meals: [mealWithSugar(40), mealWithSugar(40), mealWithSugar(40)],
    });

    const { analysis } = await analyze();

    expect(analysis.comparison.sugar.target).toBe(125); // 150 - 25
    expect(analysis.comparison.sugar.percentage).toBe(96);
    expect(analysis.comparison.sugar.status).toBe('ok');
  });

  it('炭水化物・食物繊維の目標が未設定なら、既定値 (炭水化物 300g / 食物繊維 21g) から導く。50g の固定値は使わない', async () => {
    setup({
      targets: { daily_calories: 2000 },
      meals: [mealWithSugar(90), mealWithSugar(90), mealWithSugar(90)],
    });

    const { analysis } = await analyze();

    expect(analysis.comparison.carbs.target).toBe(300);
    expect(analysis.comparison.fiber.target).toBe(21);
    expect(analysis.comparison.sugar.target).toBe(279); // 300 - 21
    expect(analysis.comparison.sugar.status).toBe('ok');
  });

  it('糖質が保存されていない食事 (null) は 0 として集計し、エラーにならない', async () => {
    setup({
      targets: { daily_calories: 2000, carbs_g: 300, fiber_g: 21 },
      meals: [mealWithSugar(null), mealWithSugar(100)],
    });

    const { analysis } = await analyze();

    expect(analysis.aggregated.sugar).toBe(100);
    expect(analysis.comparison.sugar.actual).toBe(100);
  });

  it('糖質の目標が 0 以下になる場合 (食物繊維の目標 ≧ 炭水化物の目標) は、0 で割らずに比較から外す', async () => {
    setup({
      targets: { daily_calories: 1200, carbs_g: 20, fiber_g: 25, sugar_g: 25 },
      meals: [mealWithSugar(10)],
    });

    const { analysis } = await analyze();

    expect(analysis.comparison.sugar).toBeUndefined();
    // 他の栄養素の比較は続けて行われる
    expect(analysis.comparison.carbs.target).toBe(20);
    expect(Object.values(analysis.comparison).every((c) => Number.isFinite(c.percentage))).toBe(true);
  });

  describe('AI へのプロンプトに書く糖質の目標', () => {
    /** 直近の AI 呼び出しに渡したプロンプト本文 */
    function lastPrompt(): string {
      const call = mockCreateCompletion.mock.calls.at(-1);
      expect(call).toBeDefined();
      return String(call![0].messages[0].content);
    }

    function sugarLine(prompt: string): string {
      const line = prompt.split('\n').find((l) => l.startsWith('- 糖質:'));
      expect(line).toBeDefined();
      return line!;
    }

    it('栄養目標があれば、炭水化物の目標 − 食物繊維の目標 を書く', async () => {
      setup({
        targets: { daily_calories: 2144, carbs_g: 295, fiber_g: 21, sugar_g: 25 },
        meals: [mealWithSugar(80), mealWithSugar(80), mealWithSugar(80)],
      });

      await analyze('&includeAdvice=true');

      expect(sugarLine(lastPrompt())).toBe('- 糖質: 240g（目標: 274g）');
    });

    it('糖質の目標が 0 以下で比較から外れたときは、既定値 (279g) ではなく「目標: なし」と書く', async () => {
      setup({
        targets: { daily_calories: 1200, carbs_g: 20, fiber_g: 25, sugar_g: 25 },
        meals: [mealWithSugar(10)],
      });

      await analyze('&includeAdvice=true');

      const line = sugarLine(lastPrompt());
      expect(line).toBe('- 糖質: 10g（目標: なし）');
      expect(line).not.toContain('279');
    });

    it('栄養目標そのものが無いときは、既定値 (炭水化物 300g − 食物繊維 21g = 279g) を書く', async () => {
      setup({
        targets: null,
        meals: [mealWithSugar(90), mealWithSugar(90), mealWithSugar(90)],
      });

      await analyze('&includeAdvice=true');

      expect(sugarLine(lastPrompt())).toBe('- 糖質: 270g（目標: 279g）');
    });
  });
});
