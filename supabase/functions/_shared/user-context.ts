type AnyRecord = Record<string, any>;

function isPlainObject(value: unknown): value is AnyRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeConstraints(value: unknown): AnyRecord {
  return isPlainObject(value) ? value : {};
}

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

// Performance OS v3 ラベル
const TRAINING_PHASE_LABELS: Record<string, string> = {
  training: "トレーニング期",
  competition: "試合期",
  cut: "減量期（計量）",
  recovery: "リカバリー期",
};

const EXPERIENCE_LABELS: Record<string, string> = {
  beginner: "初級",
  intermediate: "中級",
  advanced: "上級",
};

const PRIORITY_LABELS: Record<string, string> = {
  high: "高",
  moderate: "中",
  low: "低",
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

// 健康診断データの型
export type HealthCheckupForContext = {
  checkup_date: string;
  blood_pressure_systolic?: number | null;
  blood_pressure_diastolic?: number | null;
  hba1c?: number | null;
  fasting_glucose?: number | null;
  ldl_cholesterol?: number | null;
  hdl_cholesterol?: number | null;
  triglycerides?: number | null;
  uric_acid?: number | null;
  gamma_gtp?: number | null;
  individual_review?: {
    summary?: string;
    concerns?: string[];
    recommendations?: string[];
  } | null;
};

export type HealthCheckupGuidance = {
  generalDirection?: string;
  avoidanceHints?: string[];
  emphasisHints?: string[];
  specialNotes?: string;
};

export function buildUserContextForPrompt(input: {
  profile: any;
  nutritionTargets?: any | null;
  note?: string | null;
  constraints?: unknown;
  healthCheckups?: HealthCheckupForContext[] | null;
  healthGuidance?: HealthCheckupGuidance | null;
}) {
  const p = input.profile ?? {};
  const t = input.nutritionTargets ?? null;
  const c = normalizeConstraints(input.constraints);

  const allergies = toStringArray(p?.diet_flags?.allergies);
  const dislikes = toStringArray(p?.diet_flags?.dislikes);
  const healthConditions = toStringArray(p?.health_conditions);
  const medicationsRaw = toStringArray(p?.medications);
  const medications = mapCodesToLabels(medicationsRaw, MEDICATION_LABELS);

  // request-level (weekly/action) constraints
  const weeklyIngredients = toStringArray(c?.ingredients);
  const weeklyThemes = toStringArray(c?.themes);
  const weeklyCheatDay = toOptionalString(c?.cheatDay ?? c?.cheat_day);
  const weeklyFamilySize = toOptionalNumber(c?.familySize ?? c?.family_size);
  const cookingTimeObj = normalizeConstraints(c?.cookingTime ?? c?.cooking_time);
  const weeklyWeekdayCookingMinutes = toOptionalNumber(
    cookingTimeObj?.weekday ?? c?.weekdayCookingMinutes ?? c?.weekday_cooking_minutes,
  );
  const weeklyWeekendCookingMinutes = toOptionalNumber(
    cookingTimeObj?.weekend ?? c?.weekendCookingMinutes ?? c?.weekend_cooking_minutes,
  );

  const weeklyFlags = {
    useFridgeFirst: Boolean(c?.useFridgeFirst ?? c?.use_fridge_first),
    quickMeals: Boolean(c?.quickMeals ?? c?.quick_meals),
    japaneseStyle: Boolean(c?.japaneseStyle ?? c?.japanese_style),
    healthy: Boolean(c?.healthy),
  };

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
  const profileWeekdayCookingMinutes = toOptionalNumber(p?.weekday_cooking_minutes);
  const profileWeekendCookingMinutes = toOptionalNumber(p?.weekend_cooking_minutes);
  const profileFamilySize = toOptionalNumber(p?.family_size);

  // request constraints override profile where relevant
  const effectiveFamilySize = weeklyFamilySize ?? profileFamilySize;
  const effectiveWeekdayCookingMinutes = weeklyWeekdayCookingMinutes ?? profileWeekdayCookingMinutes;
  const effectiveWeekendCookingMinutes = weeklyWeekendCookingMinutes ?? profileWeekendCookingMinutes;

  // Performance OS v3 情報を抽出
  const perfProfile = p?.performance_profile ?? null;
  const sportInfo = perfProfile?.sport ?? null;
  const growthInfo = perfProfile?.growth ?? null;
  const cutInfo = perfProfile?.cut ?? null;
  const priorities = perfProfile?.priorities ?? null;

  const performance = sportInfo ? {
    sport_name: sportInfo?.name ?? sportInfo?.id ?? null,
    sport_role: sportInfo?.role ?? null,
    experience: sportInfo?.experience ? (EXPERIENCE_LABELS[sportInfo.experience] ?? sportInfo.experience) : null,
    phase: sportInfo?.phase ? (TRAINING_PHASE_LABELS[sportInfo.phase] ?? sportInfo.phase) : null,
    demand_vector: sportInfo?.demandVector ?? null,
    is_growth_protection: Boolean(growthInfo?.growthProtectionEnabled),
    is_cutting: Boolean(cutInfo?.enabled),
    cut_target_weight: cutInfo?.targetWeight ?? null,
    cut_target_date: cutInfo?.targetDate ?? null,
    priorities: priorities ? {
      protein: priorities.protein ? (PRIORITY_LABELS[priorities.protein] ?? priorities.protein) : null,
      carbs: priorities.carbs ? (PRIORITY_LABELS[priorities.carbs] ?? priorities.carbs) : null,
      fat: priorities.fat ? (PRIORITY_LABELS[priorities.fat] ?? priorities.fat) : null,
      hydration: priorities.hydration ? (PRIORITY_LABELS[priorities.hydration] ?? priorities.hydration) : null,
    } : null,
  } : null;

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
    performance, // Performance OS v3
    feasibility: {
      cooking_experience: cookingExperience,
      weekday_cooking_minutes: effectiveWeekdayCookingMinutes,
      weekend_cooking_minutes: effectiveWeekendCookingMinutes,
      family_size: effectiveFamilySize,
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
      constraints: {
        ...weeklyFlags,
        ingredients: weeklyIngredients,
        themes: weeklyThemes,
        cookingTime: {
          weekday: weeklyWeekdayCookingMinutes,
          weekend: weeklyWeekendCookingMinutes,
        },
        familySize: weeklyFamilySize,
        cheatDay: weeklyCheatDay,
      },
    },
    health: {
      recentCheckups: input.healthCheckups ?? null,
      guidance: input.healthGuidance ?? null,
    },
  };

  return ctx;
}

export function buildUserSummary(
  profile: any,
  nutritionTargets?: any | null,
  note?: string | null,
  constraints?: unknown,
  healthCheckups?: HealthCheckupForContext[] | null,
  healthGuidance?: HealthCheckupGuidance | null,
): string {
  const ctx = buildUserContextForPrompt({ profile, nutritionTargets, note, constraints, healthCheckups, healthGuidance });

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

  // Performance OS v3 情報
  const perf = ctx.performance;
  if (perf) {
    const perfParts: string[] = [];
    if (perf.sport_name) perfParts.push(`競技: ${perf.sport_name}`);
    if (perf.sport_role) perfParts.push(`ポジション/役割: ${perf.sport_role}`);
    if (perf.experience) perfParts.push(`経験: ${perf.experience}`);
    if (perf.phase) perfParts.push(`フェーズ: ${perf.phase}`);
    if (perfParts.length) {
      lines.push(`- 競技情報: ${perfParts.join(" / ")}`);
    }

    // 優先栄養素
    if (perf.priorities) {
      const prioLines: string[] = [];
      if (perf.priorities.protein) prioLines.push(`タンパク質: ${perf.priorities.protein}`);
      if (perf.priorities.carbs) prioLines.push(`炭水化物: ${perf.priorities.carbs}`);
      if (perf.priorities.fat) prioLines.push(`脂質: ${perf.priorities.fat}`);
      if (perf.priorities.hydration) prioLines.push(`水分: ${perf.priorities.hydration}`);
      if (prioLines.length) {
        lines.push(`- 優先栄養素: ${prioLines.join(" / ")}`);
      }
    }

    // 減量期（計量）情報
    if (perf.is_cutting && perf.cut_target_weight) {
      const cutInfo = `目標${perf.cut_target_weight}kg`;
      const dateInfo = perf.cut_target_date ? `（${perf.cut_target_date}まで）` : "";
      lines.push(`- 減量計画: ${cutInfo}${dateInfo}`);
    }

    // 成長期保護
    if (perf.is_growth_protection) {
      lines.push(`- 注意: 成長期のため過度な減量は推奨しません`);
    }
  }

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

  const w = ctx.weekly?.constraints ?? null;
  if (w) {
    const wLines: string[] = [];
    if (w.useFridgeFirst) wLines.push("冷蔵庫の食材を優先");
    if (w.quickMeals) wLines.push("時短メニュー中心");
    if (w.japaneseStyle) wLines.push("和食多め");
    if (w.healthy) wLines.push("ヘルシーに");
    if ((w.themes ?? []).length) wLines.push(`テーマ: ${(w.themes ?? []).join("、")}`);
    if ((w.ingredients ?? []).length) wLines.push(`使いたい食材: ${(w.ingredients ?? []).slice(0, 20).join("、")}`);
    if (w.cookingTime?.weekday != null || w.cookingTime?.weekend != null) {
      wLines.push(`調理時間（今回）: 平日${w.cookingTime?.weekday ?? "未設定"}分 / 休日${w.cookingTime?.weekend ?? "未設定"}分`);
    }
    if (w.familySize != null) wLines.push(`家族人数（今回）: ${w.familySize}人分`);
    if (w.cheatDay) wLines.push(`チートデイ: ${w.cheatDay}`);
    if (wLines.length) lines.push(`- 今回の条件:\n  ${wLines.map((x) => `- ${x}`).join("\n  ")}`);
  }

  // 健康診断に基づく食事方針
  const guidance = ctx.health?.guidance;
  if (guidance && guidance.generalDirection) {
    lines.push("");
    lines.push(`【健康診断に基づく食事方針】`);
    lines.push(`方針: ${guidance.generalDirection}`);
    if (guidance.avoidanceHints?.length) {
      lines.push(`控える: ${guidance.avoidanceHints.join("、")}`);
    }
    if (guidance.emphasisHints?.length) {
      lines.push(`意識する: ${guidance.emphasisHints.join("、")}`);
    }
    if (guidance.specialNotes) {
      lines.push(`注記: ${guidance.specialNotes}`);
    }
  }

  // 直近の健康診断サマリー（最新1件のみ）
  const recentCheckups = ctx.health?.recentCheckups;
  if (recentCheckups && recentCheckups.length > 0) {
    const latest = recentCheckups[0];
    const reviewSummary = latest.individual_review?.summary;
    if (reviewSummary) {
      lines.push("");
      lines.push(`【直近の健康診断（${latest.checkup_date}）】`);
      lines.push(`概要: ${reviewSummary}`);
      const concerns = latest.individual_review?.concerns ?? [];
      if (concerns.length > 0) {
        lines.push(`気になる点: ${concerns.slice(0, 3).join("、")}`);
      }
    }
  }

  return lines.join("\n");
}

export function deriveSearchKeywords(input: {
  profile: any;
  nutritionTargets?: any | null;
  note?: string | null;
  constraints?: unknown;
}): string[] {
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

  // weekly/action constraints (explicit)
  const w = ctx.weekly?.constraints ?? null;
  if (w) {
    if (w.quickMeals) kws.push("時短");
    if (w.japaneseStyle) kws.push("和食");
    if (w.healthy) kws.push("ヘルシー");
    if (w.useFridgeFirst) kws.push("冷蔵庫", "食材活用");
    for (const th of (w.themes ?? []).slice(0, 6)) kws.push(th);
    for (const ing of (w.ingredients ?? []).slice(0, 12)) kws.push(ing);
  }

  // constraints (allergy/dislikes)
  if ((ctx.hard.allergies ?? []).length) kws.push("アレルギー除外");

  // Performance OS v3
  const perf = ctx.performance;
  if (perf) {
    // 競技名
    if (perf.sport_name) kws.push(perf.sport_name);

    // フェーズに応じたキーワード
    if (perf.phase) {
      if (perf.phase.includes("試合")) kws.push("高炭水化物", "エネルギー", "パフォーマンス");
      else if (perf.phase.includes("減量") || perf.is_cutting) kws.push("低カロリー", "高タンパク", "減量");
      else if (perf.phase.includes("リカバリー")) kws.push("回復", "抗酸化", "タンパク質");
      else kws.push("バランス", "トレーニング");
    }

    // 優先栄養素
    if (perf.priorities?.protein === "高") kws.push("高タンパク");
    if (perf.priorities?.carbs === "高") kws.push("高炭水化物");
    if (perf.priorities?.hydration === "高") kws.push("水分補給", "電解質");

    // 需要ベクトルに基づくキーワード
    const dv = perf.demand_vector;
    if (dv) {
      if (dv.endurance > 0.7) kws.push("持久力", "複合炭水化物");
      if (dv.power > 0.7 || dv.strength > 0.7) kws.push("筋力", "高タンパク");
      if (dv.heat > 0.7) kws.push("暑熱対策", "電解質");
    }
  }

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

export function buildSearchQueryBase(input: {
  profile: any;
  nutritionTargets?: any | null;
  note?: string | null;
  constraints?: unknown;
}): string {
  const keywords = deriveSearchKeywords(input);
  const note = toOptionalString(input.note);
  const lines: string[] = [];
  lines.push(`目的: 健康的で現実的な献立。`);
  if (keywords.length) lines.push(`キーワード: ${keywords.join(" ")}`);
  if (note) lines.push(`要望: ${note.slice(0, 800)}`);
  return lines.join("\n");
}

