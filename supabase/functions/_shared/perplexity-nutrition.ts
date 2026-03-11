import type { EstimatedIngredient } from './ingredient-matcher.ts'

export type PerplexityNutritionConfidence = 'high' | 'medium' | 'low'

export interface PerplexityNutritionEstimate {
  calories_kcal: number
  protein_g: number
  fat_g: number
  carbs_g: number
  fiber_g: number
  salt_eq_g: number
  confidence: PerplexityNutritionConfidence
}

export interface PerplexityDishInput {
  name: string
  role: string
  cookingMethod: string
  visiblePortionWeightG: number
  visibleIngredients: EstimatedIngredient[]
}

const PERPLEXITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['calories_kcal', 'protein_g', 'fat_g', 'carbs_g', 'fiber_g', 'salt_eq_g', 'confidence'],
  properties: {
    calories_kcal: { type: 'number', minimum: 0, maximum: 3000 },
    protein_g: { type: 'number', minimum: 0, maximum: 300 },
    fat_g: { type: 'number', minimum: 0, maximum: 300 },
    carbs_g: { type: 'number', minimum: 0, maximum: 500 },
    fiber_g: { type: 'number', minimum: 0, maximum: 100 },
    salt_eq_g: { type: 'number', minimum: 0, maximum: 20 },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
} as const

const CANONICAL_DISH_NAME_RE =
  /豚汁|味噌汁|みそ汁|けんちん汁|親子丼|牛丼|カツ丼|天丼|海鮮丼|中華丼|カレー|カレーライス|オムライス|ハンバーグ|唐揚げ|から揚げ|竜田揚げ|とんかつ|ロースカツ|メンチカツ|ミックスフライ|エビフライ|コロッケ|チキン南蛮|生姜焼き|焼き魚|焼鮭|焼き鮭|さば味噌|麻婆豆腐|回鍋肉|青椒肉絲|酢豚|肉じゃが|おでん|うどん|そば|ラーメン|焼きそば|ナポリタン|グラタン|ドリア|チャーハン|炒飯|餃子|しゅうまい|シュウマイ/

function normalizeDishName(name: string): string {
  return String(name ?? '').replace(/[\s　]+/g, '').trim()
}

export function isPerplexityNutritionCandidate(dish: PerplexityDishInput, confidence?: string): boolean {
  const normalizedName = normalizeDishName(dish.name)
  if (!normalizedName || normalizedName === '不明な料理') return false
  if (confidence !== 'low') return false
  if (dish.role === 'soup') return true
  return CANONICAL_DISH_NAME_RE.test(normalizedName)
}

function normalizeEstimate(raw: unknown): PerplexityNutritionEstimate | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>

  const calories_kcal = Number(input.calories_kcal)
  const protein_g = Number(input.protein_g)
  const fat_g = Number(input.fat_g)
  const carbs_g = Number(input.carbs_g)
  const fiber_g = Number(input.fiber_g)
  const salt_eq_g = Number(input.salt_eq_g)
  const confidence = input.confidence

  if (
    !Number.isFinite(calories_kcal) ||
    !Number.isFinite(protein_g) ||
    !Number.isFinite(fat_g) ||
    !Number.isFinite(carbs_g) ||
    !Number.isFinite(fiber_g) ||
    !Number.isFinite(salt_eq_g) ||
    (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low')
  ) {
    return null
  }

  return {
    calories_kcal: Math.max(0, calories_kcal),
    protein_g: Math.max(0, protein_g),
    fat_g: Math.max(0, fat_g),
    carbs_g: Math.max(0, carbs_g),
    fiber_g: Math.max(0, fiber_g),
    salt_eq_g: Math.max(0, salt_eq_g),
    confidence,
  }
}

export async function estimateNutritionWithPerplexity(
  dish: PerplexityDishInput,
): Promise<PerplexityNutritionEstimate | null> {
  const apiKey = Deno.env.get('PERPLEXITY_API_KEY')
  if (!apiKey) return null

  const ingredientLines = dish.visibleIngredients
    .slice(0, 8)
    .map((ingredient) => `- ${ingredient.name}: ${ingredient.amount_g}g`)
    .join('\n')

  const prompt = [
    'あなたは日本の一般的な定食・家庭料理の標準栄養を見積もる栄養士です。',
    '写真から料理名は既に確定しています。以下の料理1皿について、日本の一般的な相場と見た目量をもとに現実的な1人前栄養を推定してください。',
    'JSON Schema に厳密準拠してください。',
    '',
    `料理名: ${dish.name}`,
    `役割: ${dish.role}`,
    `調理法: ${dish.cookingMethod}`,
    `見た目の皿量(g): ${dish.visiblePortionWeightG}`,
    '見えている主要材料:',
    ingredientLines || '- 主要材料不明',
    '',
    'ルール:',
    '- 日本の一般的な定食・家庭料理の相場を使うこと',
    '- 調理法から自然に入る油・衣・汁の塩分などは栄養に含めること',
    '- 見えていない小鉢や追加ソースは増やさないこと',
    '- confidence は、この料理名だけで標準栄養を推定する自信を high / medium / low で返すこと',
  ].join('\n')

  const response = await fetch('https://api.perplexity.ai/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      preset: 'fast-search',
      input: prompt,
      language_preference: 'ja',
      max_output_tokens: 220,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'dish_nutrition_estimate_v1',
          schema: PERPLEXITY_SCHEMA,
        },
      },
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    console.warn('[perplexity-nutrition] request failed', {
      status: response.status,
      body: text.slice(0, 400),
    })
    return null
  }

  const payload = await response.json()
  const text = payload?.output?.find?.((item: { type?: string }) => item.type === 'message')
    ?.content?.find?.((part: { type?: string }) => part.type === 'output_text')
    ?.text

  if (typeof text !== 'string' || !text.trim()) {
    console.warn('[perplexity-nutrition] empty response')
    return null
  }

  try {
    return normalizeEstimate(JSON.parse(text))
  } catch (error) {
    console.warn('[perplexity-nutrition] invalid json', {
      error: error instanceof Error ? error.message : String(error),
      text: text.slice(0, 400),
    })
    return null
  }
}
