type AnyRecord = Record<string, any>;

const CUISINE_LABELS: Record<string, string> = {
  japanese: "和食",
  western: "洋食",
  chinese: "中華",
  italian: "イタリアン",
  ethnic: "エスニック",
  korean: "韓国料理",
};

const NUTRITION_GOAL_LABELS: Record<string, string> = {
  lose_weight: "減量・ダイエット",
  gain_muscle: "筋肉増量・バルクアップ",
  maintain: "現状維持・健康管理",
  athlete_performance: "競技パフォーマンス",
};

const WEIGHT_CHANGE_RATE_LABELS: Record<string, string> = {
  slow: "ゆっくり",
  moderate: "普通",
  aggressive: "積極的",
};

const WORK_STYLE_LABELS: Record<string, string> = {
  sedentary: "デスクワーク（座り仕事）",
  light_active: "オフィス（立ち座り半々）",
  moderately_active: "立ち仕事・移動多め",
  very_active: "肉体労働",
  student: "学生",
  homemaker: "主婦/主夫",
};

const EXERCISE_INTENSITY_LABELS: Record<string, string> = {
  light: "軽い",
  moderate: "普通",
  intense: "激しい",
  athlete: "アスリート",
};

const COOKING_EXPERIENCE_LABELS: Record<string, string> = {
  beginner: "初心者",
  intermediate: "中級者",
  advanced: "上級者",
};

const MEDICATION_LABELS: Record<string, string> = {
  warfarin: "ワーファリン",
  antihypertensive: "降圧剤",
  diabetes_medication: "糖尿病薬",
  diuretic: "利尿剤",
  antibiotics: "抗生物質",
  steroid: "ステロイド",
  none: "特になし",
};

function toOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return s ? s : null;
}

function toOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function toStringArray(value: unknown, opts: { max?: number } = {}): string[] {
  const max = opts.max ?? 50;
  if (!Array.isArray(value)) return [];
  const out = value
    .map((v) => String(v ?? "").trim())
    .filter(Boolean);
  return out.slice(0, max);
}

function mapCodesToLabels(values: string[], mapping: Record<string, string>): string[] {
  const out: string[] = [];
  for (const v of values) {
    const key = String(v ?? "").trim();
    if (!key) continue;
    const label = mapping[key] ?? key;
    if (!label || label === "特になし") continue;
    out.push(label);
  }
  return out;
}

export function formatCuisinePreferences(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "未設定";
  const entries = Object.entries(value as AnyRecord)
    .map(([k, v]) => [String(k), Number(v)] as const)
    .filter(([, v]) => Number.isFinite(v))
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => CUISINE_LABELS[k] ?? k);
  return entries.slice(0, 6).join("、") || "未設定";
}

export function buildUserContextForPrompt(input: {
  profile: any;
  nutritionTargets?: any | null;
  note?: string | null;
}) {
  const p = input.profile ?? {};
  const t = input.nutritionTargets ?? null;

  const allergies = toStringArray(p?.diet_flags?.allergies);
  const dislikes = toStringArray(p?.diet_flags?.dislikes);
  const healthConditions = toStringArray(p?.health_conditions);
  const medicationsRaw = toStringArray(p?.medications);
  const medications = mapCodesToLabels(medicationsRaw, MEDICATION_LABELS);

  const nutritionGoalCode = toOptionalString(p?.nutrition_goal);
  const weightChangeRateCode = toOptionalString(p?.weight_change_rate);
  const nutritionGoal = nutritionGoalCode ? (NUTRITION_GOAL_LABELS[nutritionGoalCode] ?? nutritionGoalCode) : null;
  const weightChangeRate = weightChangeRateCode ? (WEIGHT_CHANGE_RATE_LABELS[weightChangeRateCode] ?? weightChangeRateCode) : null;

  const cuisinePrefsText = formatCuisinePreferences(p?.cuisine_preferences);

  const workStyleCode = toOptionalString(p?.work_style);
  const workStyle = workStyleCode ? (WORK_STYLE_LABELS[workStyleCode] ?? workStyleCode) : null;

  const exerciseTypes = toStringArray(p?.exercise_types);
  const exerciseFrequency = toOptionalNumber(p?.exercise_frequency);
  const exerciseIntensityCode = toOptionalString(p?.exercise_intensity);
  const exerciseIntensity = exerciseIntensityCode ? (EXERCISE_INTENSITY_LABELS[exerciseIntensityCode] ?? exerciseIntensityCode) : null;
  const exerciseDuration = toOptionalNumber(p?.exercise_duration_per_session);

  const cookingExperienceCode = toOptionalString(p?.cooking_experience);
  const cookingExperience = cookingExperienceCode ? (COOKING_EXPERIENCE_LABELS[cookingExperienceCode] ?? cookingExperienceCode) : null;
  const weekdayCookingMinutes = toOptionalNumber(p?.weekday_cooking_minutes);
  const weekendCookingMinutes = toOptionalNumber(p?.weekend_cooking_minutes);
  const familySize = toOptionalNumber(p?.family_size);

  const ctx = {
    hard: {
      allergies, // 絶対除外
    },
    goals: {
      nutrition_goal: nutritionGoal,
      weight_change_rate: weightChangeRate,
      nutrition_targets: t
        ? {
            daily_calories: t?.daily_calories ?? null,
            protein_g: t?.protein_g ?? null,
            sodium_g: t?.sodium_g ?? null,
          }
        : null,
    },
    feasibility: {
      cooking_experience: cookingExperience,
      weekday_cooking_minutes: weekdayCookingMinutes,
      weekend_cooking_minutes: weekendCookingMinutes,
      family_size: familySize,
    },
    preferences: {
      cuisine_preferences: cuisinePrefsText,
      dislikes, // できれば避ける
    },
    lifestyle: {
      work_style: workStyle,
      exercise_types: exerciseTypes,
      exercise_frequency_per_week: exerciseFrequency,
      exercise_intensity: exerciseIntensity,
      exercise_duration_minutes_per_session: exerciseDuration,
    },
    medical: {
      health_conditions: healthConditions,
      medications,
    },
    profile: {
      nickname: p?.nickname ?? null,
      age: p?.age ?? null,
      gender: p?.gender ?? null,
      height_cm: p?.height ?? null,
      weight_kg: p?.weight ?? null,
      diet_style: p?.diet_style ?? null,
    },
    weekly: {
      note: input.note ?? null,
    },
  };

  return ctx;
}

export function buildUserSummary(profile: any, nutritionTargets?: any | null, note?: string | null): string {
  const ctx = buildUserContextForPrompt({ profile, nutritionTargets, note });

  const lines: string[] = [];
  lines.push(`- ニックネーム: ${ctx.profile.nickname ?? "未設定"}`);
  lines.push(`- 年齢: ${ctx.profile.age ?? "不明"}歳`);
  lines.push(`- 性別: ${ctx.profile.gender ?? "不明"}`);
  lines.push(`- 身長: ${ctx.profile.height_cm ?? "不明"}cm / 体重: ${ctx.profile.weight_kg ?? "不明"}kg`);

  lines.push(`- 持病・注意点: ${(ctx.medical.health_conditions ?? []).join(", ") || "なし"}`);
  lines.push(`- 服薬: ${(ctx.medical.medications ?? []).join(", ") || "なし"}`);

  lines.push(`- アレルギー（絶対除外）: ${(ctx.hard.allergies ?? []).join(", ") || "なし"}`);
  lines.push(`- 苦手なもの（避ける）: ${(ctx.preferences.dislikes ?? []).join(", ") || "なし"}`);
  lines.push(`- 食事スタイル: ${ctx.profile.diet_style ?? "未設定"}`);
  lines.push(`- 好みの料理ジャンル: ${ctx.preferences.cuisine_preferences ?? "未設定"}`);

  if (ctx.goals.nutrition_goal) {
    lines.push(`- 栄養目標: ${ctx.goals.nutrition_goal}${ctx.goals.weight_change_rate ? `（ペース: ${ctx.goals.weight_change_rate}）` : ""}`);
  }

  const activityParts: string[] = [];
  if (ctx.lifestyle.work_style) activityParts.push(`仕事スタイル: ${ctx.lifestyle.work_style}`);
  if ((ctx.lifestyle.exercise_types ?? []).length) activityParts.push(`運動種別: ${ctx.lifestyle.exercise_types.join(", ")}`);
  if (ctx.lifestyle.exercise_frequency_per_week != null) activityParts.push(`運動頻度: 週${ctx.lifestyle.exercise_frequency_per_week}回`);
  if (ctx.lifestyle.exercise_intensity) activityParts.push(`運動強度: ${ctx.lifestyle.exercise_intensity}`);
  if (ctx.lifestyle.exercise_duration_minutes_per_session != null) activityParts.push(`運動時間: ${ctx.lifestyle.exercise_duration_minutes_per_session}分/回`);
  if (activityParts.length) lines.push(`- 活動量: ${activityParts.join(" / ")}`);

  if (ctx.feasibility.family_size != null) lines.push(`- 家族人数: ${ctx.feasibility.family_size}人分`);
  if (ctx.feasibility.cooking_experience) lines.push(`- 料理経験: ${ctx.feasibility.cooking_experience}`);
  if (ctx.feasibility.weekday_cooking_minutes != null || ctx.feasibility.weekend_cooking_minutes != null) {
    lines.push(
      `- 調理時間目安: 平日${ctx.feasibility.weekday_cooking_minutes ?? "未設定"}分 / 休日${ctx.feasibility.weekend_cooking_minutes ?? "未設定"}分`,
    );
  }

  if (ctx.goals.nutrition_targets) {
    const g = ctx.goals.nutrition_targets;
    const goalLines: string[] = [];
    if (g.daily_calories != null) goalLines.push(`- 目標（1日）カロリー: ${g.daily_calories}kcal`);
    if (g.protein_g != null) goalLines.push(`- 目標（1日）タンパク質: ${g.protein_g}g`);
    if (g.sodium_g != null) goalLines.push(`- 目標（1日）塩分（食塩相当量）: ${g.sodium_g}g`);
    if (goalLines.length) lines.push(`- 栄養目標（目安）:\n  ${goalLines.join("\n  ")}`);
  }

  return lines.join("\n");
}

export function deriveSearchKeywords(input: { profile: any; nutritionTargets?: any | null; note?: string | null }): string[] {
  const ctx = buildUserContextForPrompt(input);

  const kws: string[] = [];

  // goal
  if (ctx.goals.nutrition_goal) {
    if (String(ctx.goals.nutrition_goal).includes("減量")) kws.push("減量", "ダイエット", "低カロリー");
    else if (String(ctx.goals.nutrition_goal).includes("筋肉")) kws.push("筋肉", "増量", "高タンパク");
    else if (String(ctx.goals.nutrition_goal).includes("競技")) kws.push("パフォーマンス", "高エネルギー", "高タンパク");
    else kws.push("健康", "バランス");
  } else {
    kws.push("健康", "バランス");
  }

  // health
  for (const hc of ctx.medical.health_conditions ?? []) {
    kws.push(hc);
    if (hc === "高血圧") kws.push("減塩");
    if (hc === "糖尿病") kws.push("低糖質");
    if (hc === "脂質異常症") kws.push("脂質控えめ");
    if (hc === "貧血") kws.push("鉄分");
    if (hc === "腎臓病") kws.push("塩分控えめ");
  }

  // meds (light)
  for (const m of ctx.medical.medications ?? []) {
    kws.push(m);
    if (m.includes("ワーファリン")) kws.push("ビタミンK", "偏りを避ける");
  }

  // feasibility
  if (ctx.feasibility.cooking_experience) {
    kws.push(ctx.feasibility.cooking_experience);
    if (ctx.feasibility.cooking_experience === "初心者") kws.push("簡単", "時短");
  }
  const weekday = ctx.feasibility.weekday_cooking_minutes;
  if (weekday != null) {
    if (weekday <= 15) kws.push("15分", "時短");
    else if (weekday <= 30) kws.push("30分", "時短");
  }

  // preference
  if (ctx.preferences.cuisine_preferences && ctx.preferences.cuisine_preferences !== "未設定") {
    kws.push(ctx.preferences.cuisine_preferences);
  }

  // constraints (allergy/dislikes)
  if ((ctx.hard.allergies ?? []).length) kws.push("アレルギー除外");

  // weekly note
  const note = toOptionalString(input.note);
  if (note) kws.push(note.slice(0, 120));

  // dedupe, keep order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of kws) {
    const s = String(k ?? "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.slice(0, 40);
}

export function buildSearchQueryBase(input: { profile: any; nutritionTargets?: any | null; note?: string | null }): string {
  const keywords = deriveSearchKeywords(input);
  const note = toOptionalString(input.note);
  const lines: string[] = [];
  lines.push(`目的: 健康的で現実的な献立。`);
  if (keywords.length) lines.push(`キーワード: ${keywords.join(" ")}`);
  if (note) lines.push(`要望: ${note.slice(0, 800)}`);
  return lines.join("\n");
}

