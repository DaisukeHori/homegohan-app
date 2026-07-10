import { z } from 'zod'

// オンボーディング質問回答 (OB-API-01) の Zod スキーマ
// #1045 (F6-12): 質問フロー (src/app/onboarding/questions/question-flow.ts の QUESTIONS) の
// 選択肢・数値範囲と 1:1 対応させ、enum からの逸脱・数値変換不能値・文字数超過を 400 で弾く。
//
// 質問フローは各ステップごとに部分回答を都度保存するため全フィールド optional。
// 未知キー (将来追加されるフィールドや、まだこのスキーマが把握していないフィールド) は
// z.object のデフォルト挙動 (strip) によりエラーにせず無視する。
// このスキーマの結果はゲート判定にのみ使用し、実際の DB 書き込み値は呼び出し側の
// 元の answers オブジェクトから構築する (値の型・trim 挙動を変えないため)。

const genderEnum = z.enum(['male', 'female', 'unspecified'])
const nutritionGoalEnum = z.enum(['lose_weight', 'gain_muscle', 'maintain', 'athlete_performance'])
const sportTypeEnum = z.enum([
  'soccer', 'basketball', 'volleyball', 'baseball', 'tennis', 'swimming',
  'track_and_field', 'road_cycling', 'martial_arts_general', 'weightlifting', 'custom',
])
const trainingPhaseEnum = z.enum(['training', 'competition', 'cut', 'recovery'])
const exerciseTypeEnum = z.enum([
  'weight_training', 'running', 'cycling', 'swimming', 'yoga',
  'team_sports', 'martial_arts', 'walking', 'none',
])
const exerciseIntensityEnum = z.enum(['light', 'moderate', 'intense', 'athlete'])
const workStyleEnum = z.enum([
  'sedentary', 'light_active', 'moderately_active', 'very_active', 'student', 'homemaker',
])
// health_conditions は日本語ラベルそのものが value のため日本語 enum。
// 'none' は将来的な「なし」選択肢や旧クライアントとの互換のため許容する。
const healthConditionEnum = z.enum([
  '高血圧', '糖尿病', '脂質異常症', '心臓病', '腎臓病', '骨粗しょう症',
  '貧血', '痛風', '消化器系', '甲状腺疾患', '自律神経', 'メンタル', 'none',
])
const bodyConcernEnum = z.enum([
  'cold_sensitivity', 'swelling_prone', 'fatigue', 'stiff_shoulders',
  'headache', 'low_sweating', 'skin_trouble', 'dry_hair',
])
const sleepQualityEnum = z.enum(['good', 'average', 'poor'])
const stressLevelEnum = z.enum(['low', 'medium', 'high'])
const pregnancyStatusEnum = z.enum(['none', 'pregnant', 'nursing'])
const medicationEnum = z.enum([
  'warfarin', 'antihypertensive', 'diabetes_medication', 'diuretic', 'antibiotics', 'steroid', 'none',
])
const dietStyleEnum = z.enum(['normal', 'vegetarian', 'vegan', 'pescatarian', 'gluten_free', 'keto'])
const cookingExperienceEnum = z.enum(['beginner', 'intermediate', 'advanced'])
const cookingTimeEnum = z.enum(['15', '30', '45', '60'])
const cuisinePreferenceEnum = z.enum(['japanese', 'western', 'chinese', 'italian', 'ethnic', 'korean'])
const shoppingFrequencyEnum = z.enum(['daily', '2-3_weekly', 'weekly', 'biweekly'])
const weeklyFoodBudgetEnum = z.enum(['5000', '10000', '15000', '20000', '25000', 'none'])
const kitchenApplianceEnum = z.enum([
  'oven', 'grill', 'pressure_cooker', 'slow_cooker', 'air_fryer', 'food_processor',
])
const stoveTypeEnum = z.enum(['stove:gas', 'stove:ih'])
const weightChangeRateEnum = z.enum(['slow', 'moderate', 'aggressive'])

// #1045 round-2 (Sonnet Warning): クライアント側入力欄 (src/app/onboarding/questions/page.tsx)
// の maxLength/件数上限がこのスキーマの上限と食い違うと、スキーマ側だけが 400 を返して
// user_profiles 行が作られず回答が失われる (詳細は同ファイルの fail-closed 対応コメント参照)。
// 同じ値をクライアント側 UI からも import して単一ソース化する。
export const NICKNAME_MAX_LENGTH = 100
export const OCCUPATION_MAX_LENGTH = 100
export const TAG_MAX_LENGTH = 30
export const TAG_MAX_COUNT = 30
// #1045 round-3 (Fable Warning): age 入力欄に上限が無く、0 や 500 等の範囲外値を
// 入力してもクライアント側では気づけず、スキーマ側で 400 になるまでデッドエンドに
// なっていた (progress 保存が失敗し「次へ」も押せるが進めない)。
// age のスキーマ範囲 (numericInRange) と同じ値を UI 側の min/max・disabled 判定にも使う。
export const AGE_MIN = 1
export const AGE_MAX = 120

const shortText = z.string().max(NICKNAME_MAX_LENGTH)
// 自由入力タグ (アレルギー・苦手な食材・好きな食材・趣味) は enum 化できないため
// 個数と1件あたりの文字数のみ上限を設ける。
const freeTagList = z.array(z.string().max(TAG_MAX_LENGTH)).max(TAG_MAX_COUNT)
const isoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid date format')

// フロントエンドは数値質問の値を文字列 (input.value) のまま送ってくることがあるため
// string|number どちらでも受け付け、Number() 変換後に有限数かつ範囲内かを検証する。
// #1045 (F6-12): age="abc" のような非数値文字列は Number("abc")=NaN となり弾かれる。
function numericInRange(min: number, max: number) {
  return z.union([z.string(), z.number()]).refine((value) => {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) && n >= min && n <= max
  }, `value must be a finite number between ${min} and ${max}`)
}

const servingsMealSchema = z.object({
  breakfast: z.number().int().min(0).max(20).optional(),
  lunch: z.number().int().min(0).max(20).optional(),
  dinner: z.number().int().min(0).max(20).optional(),
})

const servingsConfigSchema = z.object({
  default: z.number().int().min(0).max(20),
  byDayMeal: z.record(z.string(), servingsMealSchema).optional(),
})

export const OnboardingAnswersSchema = z.object({
  nickname: shortText.optional(),
  gender: genderEnum.optional(),
  age: numericInRange(AGE_MIN, AGE_MAX).optional(),
  occupation: shortText.optional(),
  height: numericInRange(30, 280).optional(),
  weight: numericInRange(2, 400).optional(),
  nutrition_goal: nutritionGoalEnum.optional(),
  sport_type: sportTypeEnum.optional(),
  sport_custom_name: shortText.optional(),
  sport_experience: z.string().max(50).optional(),
  training_phase: trainingPhaseEnum.optional(),
  competition_date: isoDateString.optional(),
  target_date: isoDateString.optional(),
  target_weight: numericInRange(20, 400).optional(),
  weight_change_rate: weightChangeRateEnum.optional(),
  exercise_types: z.array(exerciseTypeEnum).max(10).optional(),
  exercise_frequency: numericInRange(0, 7).optional(),
  exercise_intensity: exerciseIntensityEnum.optional(),
  exercise_duration: numericInRange(0, 600).optional(),
  work_style: workStyleEnum.optional(),
  health_conditions: z.array(healthConditionEnum).max(20).optional(),
  body_concerns: z.array(bodyConcernEnum).max(20).optional(),
  sleep_quality: sleepQualityEnum.optional(),
  stress_level: stressLevelEnum.optional(),
  pregnancy_status: pregnancyStatusEnum.optional(),
  medications: z.array(medicationEnum).max(20).optional(),
  allergies: freeTagList.optional(),
  dislikes: freeTagList.optional(),
  favorite_ingredients: freeTagList.optional(),
  diet_style: dietStyleEnum.optional(),
  cooking_experience: cookingExperienceEnum.optional(),
  cooking_time: cookingTimeEnum.optional(),
  cuisine_preference: z.array(cuisinePreferenceEnum).max(10).optional(),
  family_size: numericInRange(1, 20).optional(),
  servings_config: servingsConfigSchema.optional(),
  shopping_frequency: shoppingFrequencyEnum.optional(),
  weekly_food_budget: weeklyFoodBudgetEnum.optional(),
  kitchen_appliances: z.array(kitchenApplianceEnum).max(10).optional(),
  stove_type: stoveTypeEnum.optional(),
  hobbies: freeTagList.optional(),
})

export type OnboardingAnswers = z.infer<typeof OnboardingAnswersSchema>
