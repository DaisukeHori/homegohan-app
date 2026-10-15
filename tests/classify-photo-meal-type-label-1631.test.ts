// @vitest-environment node
/**
 * #1631: 写真の判別 (POST /api/ai/classify-photo) の解析プロンプトで、写真を呼ぶ名前 (食事の区分の表示名) を
 * @homegohan/shared の MEAL_LABELS から引く (以前は 5 値との比較の連鎖を手書きしていた)。
 *
 * 書き直しの前と同じ挙動であることを、本物の route を通して確かめる (差し替えるのは Supabase・AI の呼び出しなど外との境目だけ):
 *   - 5 値は、それぞれの表示名 (朝食・昼食・夕食・おやつ・夜食) でプロンプトに入る
 *   - 区分が無い・5 値のどれでもない・文字列でないときは「食事」
 * 期待する表示名は、正本の定数から求めずに手で書く (正本の値が変わったら、このテストで気づく)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  user: '11111111-1111-4111-8111-111111111111',
  /** 判別の結果の確からしさ (route が「食事の写真」とみなす値より上) */
  confident: 0.9,
  /** 解析プロンプトだけにある語 (判別のプロンプトと見分ける) */
  mealAnalysisMarker: '栄養計算の下準備',
  /** AI (Gemini) へ送ったプロンプト (送った順) */
  prompts: [] as string[],
}));

/** route が「小さすぎる画像」として AI に送らずに返す大きさより大きい画像 */
const IMAGE = 'A'.repeat(4000);

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: h.user } }, error: null }) },
  }),
}));
vi.mock('@/lib/ai/consent-guard', () => ({ requireAiConsent: vi.fn(async () => null) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true })),
  rateLimitExceededResponse: vi.fn(),
}));
vi.mock('@/lib/plan/entitlements', () => ({
  consumeAiUsage: vi.fn(async () => ({ allowed: true })),
  issueAiUsageGrant: vi.fn(async () => null),
  aiDailyLimitResponse: vi.fn(),
}));
vi.mock('@/lib/ai/gemini-json', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/gemini-json')>()),
  generateGeminiJson: vi.fn(async ({ prompt }: { prompt: string }) => {
    h.prompts.push(prompt);
    if (prompt.includes(h.mealAnalysisMarker)) {
      return {
        data: { dishes: [{ name: 'カレー', role: 'main', cookingMethod: 'simmered', visibleIngredients: [] }] },
        model: 'test-model',
      };
    }
    return { data: { type: 'meal', confidence: h.confident }, model: 'test-model' };
  }),
}));

const { POST } = await import('../src/app/api/ai/classify-photo/route');

/** 解析つきの判別を呼び、AI へ送った解析プロンプトを返す */
async function mealAnalysisPromptFor(body: Record<string, unknown>): Promise<string> {
  const res = await POST(
    new Request('http://localhost/api/ai/classify-photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: IMAGE, includeMealAnalysis: true, ...body }),
    }),
  );
  expect(res.status).toBe(200);
  // 1 回目は判別、2 回目は解析 (解析プロンプトまで届いている)
  expect(h.prompts).toHaveLength(2);
  expect(h.prompts[0]).not.toContain(h.mealAnalysisMarker);
  expect(h.prompts[1]).toContain(h.mealAnalysisMarker);
  return h.prompts[1];
}

/** 解析プロンプトの、写真を呼ぶ名前が入る文 (画像が 1 枚のとき) */
function photoSentence(label: string): string {
  return `この${label}の写真に写っている料理を、${h.mealAnalysisMarker}として構造化してください。`;
}

beforeEach(() => {
  h.prompts = [];
});

describe('写真の判別の解析プロンプト — 食事の区分の表示名は MEAL_LABELS から引く (#1631)', () => {
  it.each([
    { mealType: 'breakfast', label: '朝食' },
    { mealType: 'lunch', label: '昼食' },
    { mealType: 'dinner', label: '夕食' },
    { mealType: 'snack', label: 'おやつ' },
    { mealType: 'midnight_snack', label: '夜食' },
  ])('$mealType は「$label」の写真としてプロンプトに入る', async ({ mealType, label }) => {
    expect(await mealAnalysisPromptFor({ mealType })).toContain(photoSentence(label));
  });

  it.each([
    { name: '区分が無い', body: {} },
    { name: '5 値のどれでもない (brunch)', body: { mealType: 'brunch' } },
    { name: '空の文字列', body: { mealType: '' } },
    { name: '文字列でない', body: { mealType: 3 } },
  ])('$name ときは「食事」の写真としてプロンプトに入る', async ({ body }) => {
    expect(await mealAnalysisPromptFor(body)).toContain(photoSentence('食事'));
  });
});
