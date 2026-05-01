import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Card, LoadingState } from "../../src/components/ui";
import { getApi } from "../../src/lib/api";
import { supabase } from "../../src/lib/supabase";
import { useProfile } from "../../src/providers/ProfileProvider";
import { colors, radius, shadows, spacing } from "../../src/theme";

type Question =
  | {
      id: string;
      text: string;
      type: "text";
      placeholder?: string;
      required?: boolean;
      showIf?: (answers: Record<string, any>) => boolean;
    }
  | {
      id: string;
      text: string;
      type: "choice";
      options: { label: string; value: string; description?: string }[];
      allowSkip?: boolean;
      showIf?: (answers: Record<string, any>) => boolean;
    }
  | {
      id: string;
      text: string;
      type: "number";
      placeholder?: string;
      min?: number;
      max?: number;
      showIf?: (answers: Record<string, any>) => boolean;
    }
  | {
      id: string;
      text: string;
      type: "multi_choice";
      options: { label: string; value: string }[];
      allowSkip?: boolean;
      showIf?: (answers: Record<string, any>) => boolean;
    }
  | {
      id: string;
      text: string;
      type: "tags";
      placeholder?: string;
      suggestions?: string[];
      allowSkip?: boolean;
      showIf?: (answers: Record<string, any>) => boolean;
    }
  | {
      id: string;
      text: string;
      type: "custom_stats";
      showIf?: (answers: Record<string, any>) => boolean;
    }
  | {
      id: string;
      text: string;
      type: "servings_grid";
      showIf?: (answers: Record<string, any>) => boolean;
    }
  | {
      id: string;
      text: string;
      type: "date";
      allowSkip?: boolean;
      showIf?: (answers: Record<string, any>) => boolean;
    };

// 曜日別人数設定のデフォルト値
const DAYS_OF_WEEK = [
  { key: "monday", label: "月" },
  { key: "tuesday", label: "火" },
  { key: "wednesday", label: "水" },
  { key: "thursday", label: "木" },
  { key: "friday", label: "金" },
  { key: "saturday", label: "土" },
  { key: "sunday", label: "日" },
] as const;

const MEAL_TYPES = [
  { key: "breakfast", label: "朝" },
  { key: "lunch", label: "昼" },
  { key: "dinner", label: "夜" },
] as const;

type ServingsConfig = {
  default: number;
  byDayMeal: {
    [day: string]: {
      breakfast?: number;
      lunch?: number;
      dinner?: number;
    };
  };
};

function createDefaultServingsConfig(familySize: number): ServingsConfig {
  const config: ServingsConfig = {
    default: familySize,
    byDayMeal: {},
  };
  for (const day of DAYS_OF_WEEK) {
    config.byDayMeal[day.key] = {
      breakfast: familySize,
      lunch: 0, // 昼は外食想定でデフォルト0
      dinner: familySize,
    };
  }
  return config;
}

const QUESTIONS: Question[] = [
  {
    id: "nickname",
    text: "はじめまして！\n私はあなたの食生活をサポートするAI栄養士です。\n\nお名前（ニックネーム）を教えてください",
    type: "text",
    placeholder: "例: たろう",
    required: true,
  },
  {
    id: "gender",
    text: "{nickname}さん、よろしくお願いします！\n\n正確な栄養計算のために、性別を教えてください",
    type: "choice",
    options: [
      { label: "男性", value: "male" },
      { label: "女性", value: "female" },
      { label: "回答しない", value: "unspecified" },
    ],
  },
  {
    id: "body_stats",
    text: "基礎代謝を計算するために、\n身体情報を教えてください",
    type: "custom_stats",
  },
  {
    id: "nutrition_goal",
    text: "一番の目標は何ですか？",
    type: "choice",
    options: [
      { label: "減量・ダイエット", value: "lose_weight", description: "体重を落としたい" },
      { label: "筋肉増量・バルクアップ", value: "gain_muscle", description: "筋肉をつけたい" },
      { label: "現状維持・健康管理", value: "maintain", description: "今の体型を維持したい" },
      { label: "競技パフォーマンス", value: "athlete_performance", description: "大会・試合に向けて" },
    ],
  },
  // Performance OS v3: アスリート向け追加質問
  {
    id: "sport_type",
    text: "主に取り組んでいる競技は？",
    type: "choice",
    showIf: (answers) => answers.nutrition_goal === "athlete_performance",
    options: [
      { label: "サッカー", value: "soccer" },
      { label: "バスケットボール", value: "basketball" },
      { label: "バレーボール", value: "volleyball" },
      { label: "野球", value: "baseball" },
      { label: "テニス", value: "tennis" },
      { label: "水泳", value: "swimming" },
      { label: "陸上競技", value: "track_and_field" },
      { label: "自転車", value: "road_cycling" },
      { label: "格闘技", value: "martial_arts_general" },
      { label: "ウェイトリフティング", value: "weightlifting" },
      { label: "その他", value: "custom" },
    ],
  },
  {
    id: "sport_custom_name",
    text: "競技名を入力してください",
    type: "text",
    placeholder: "例: トライアスロン",
    showIf: (answers) =>
      answers.nutrition_goal === "athlete_performance" && answers.sport_type === "custom",
  },
  {
    id: "sport_experience",
    text: "競技経験はどのくらいですか？",
    type: "choice",
    showIf: (answers) => answers.nutrition_goal === "athlete_performance",
    options: [
      { label: "初心者（1年未満）", value: "beginner", description: "始めたばかり" },
      { label: "中級者（1〜3年）", value: "intermediate", description: "基礎は身についている" },
      { label: "上級者（3年以上）", value: "advanced", description: "競技会・大会出場レベル" },
    ],
  },
  {
    id: "training_phase",
    text: "現在のトレーニング期は？",
    type: "choice",
    showIf: (answers) => answers.nutrition_goal === "athlete_performance",
    options: [
      { label: "トレーニング期", value: "training", description: "体力・技術向上中" },
      { label: "試合期", value: "competition", description: "大会・試合シーズン" },
      { label: "減量期", value: "cut", description: "体重調整中（階級制など）" },
      { label: "回復期", value: "recovery", description: "オフシーズン・ケガからの復帰" },
    ],
  },
  {
    id: "competition_date",
    text: "次の大会・試合はいつですか？",
    type: "date",
    allowSkip: true,
    showIf: (answers) =>
      answers.nutrition_goal === "athlete_performance" &&
      (answers.training_phase === "competition" || answers.training_phase === "cut"),
  },
  {
    id: "weight_change_rate",
    text: "どのくらいのペースで変えたいですか？",
    type: "choice",
    showIf: (answers) => answers.nutrition_goal === "lose_weight" || answers.nutrition_goal === "gain_muscle",
    options: [
      { label: "ゆっくり（月1-2kg）", value: "slow" },
      { label: "普通（月2-3kg）", value: "moderate" },
      { label: "積極的（月3kg以上）", value: "aggressive" },
    ],
  },
  {
    id: "exercise_types",
    text: "普段どんな運動をしていますか？（複数選択可）",
    type: "multi_choice",
    options: [
      { label: "筋トレ", value: "weight_training" },
      { label: "ランニング", value: "running" },
      { label: "サイクリング", value: "cycling" },
      { label: "水泳", value: "swimming" },
      { label: "ヨガ", value: "yoga" },
      { label: "球技", value: "team_sports" },
      { label: "格闘技", value: "martial_arts" },
      { label: "ウォーキング", value: "walking" },
      { label: "運動していない", value: "none" },
    ],
  },
  {
    id: "exercise_frequency",
    text: "週に何日運動していますか？",
    type: "choice",
    showIf: (answers) => !answers.exercise_types?.includes("none"),
    options: [
      { label: "1日", value: "1" },
      { label: "2日", value: "2" },
      { label: "3日", value: "3" },
      { label: "4日", value: "4" },
      { label: "5日", value: "5" },
      { label: "6日以上", value: "6" },
    ],
  },
  {
    id: "exercise_intensity",
    text: "運動の強度はどのくらいですか？",
    type: "choice",
    showIf: (answers) => !answers.exercise_types?.includes("none"),
    options: [
      { label: "軽い", value: "light" },
      { label: "普通", value: "moderate" },
      { label: "激しい", value: "intense" },
      { label: "アスリート", value: "athlete" },
    ],
  },
  {
    id: "exercise_duration",
    text: "1回の運動時間は？",
    type: "choice",
    showIf: (answers) => !answers.exercise_types?.includes("none"),
    options: [
      { label: "30分未満", value: "30" },
      { label: "30分〜1時間", value: "60" },
      { label: "1〜2時間", value: "90" },
      { label: "2時間以上", value: "120" },
    ],
  },
  {
    id: "work_style",
    text: "普段の仕事・活動スタイルは？",
    type: "choice",
    options: [
      { label: "デスクワーク", value: "sedentary" },
      { label: "オフィス（立ち座り半々）", value: "light_active" },
      { label: "立ち仕事・移動多め", value: "moderately_active" },
      { label: "肉体労働", value: "very_active" },
      { label: "学生", value: "student" },
      { label: "主婦/主夫", value: "homemaker" },
    ],
  },
  {
    id: "health_conditions",
    text: "気になる健康状態はありますか？（複数選択可、なければスキップ）",
    type: "multi_choice",
    allowSkip: true,
    options: [
      { label: "高血圧", value: "高血圧" },
      { label: "糖尿病", value: "糖尿病" },
      { label: "脂質異常症", value: "脂質異常症" },
      { label: "心臓病", value: "心臓病" },
      { label: "腎臓病", value: "腎臓病" },
      { label: "骨粗しょう症", value: "骨粗しょう症" },
      { label: "貧血", value: "貧血" },
      { label: "痛風", value: "痛風" },
    ],
  },
  {
    id: "medications",
    text: "服用中の薬はありますか？（なければスキップ）",
    type: "multi_choice",
    allowSkip: true,
    options: [
      { label: "ワーファリン", value: "warfarin" },
      { label: "降圧剤", value: "antihypertensive" },
      { label: "糖尿病薬", value: "diabetes_medication" },
      { label: "利尿剤", value: "diuretic" },
      { label: "抗生物質", value: "antibiotics" },
      { label: "ステロイド", value: "steroid" },
    ],
  },
  {
    id: "allergies",
    text: "食物アレルギーや苦手な食材は？（なければスキップ）",
    type: "tags",
    placeholder: "例: 卵、エビ、ピーマン",
    suggestions: ["卵", "エビ", "カニ", "小麦", "乳製品", "そば", "落花生", "ナッツ類", "貝類", "魚卵", "大豆"],
    allowSkip: true,
  },
  {
    id: "cooking_experience",
    text: "料理の経験は？",
    type: "choice",
    options: [
      { label: "初心者", value: "beginner" },
      { label: "中級者", value: "intermediate" },
      { label: "上級者", value: "advanced" },
    ],
  },
  {
    id: "cooking_time",
    text: "平日の夕食にかけられる調理時間は？",
    type: "choice",
    options: [
      { label: "15分以内", value: "15" },
      { label: "30分以内", value: "30" },
      { label: "45分以内", value: "45" },
      { label: "1時間以上OK", value: "60" },
    ],
  },
  {
    id: "cuisine_preference",
    text: "好きな料理ジャンルは？（複数選択可）",
    type: "multi_choice",
    options: [
      { label: "和食", value: "japanese" },
      { label: "洋食", value: "western" },
      { label: "中華", value: "chinese" },
      { label: "イタリアン", value: "italian" },
      { label: "エスニック", value: "ethnic" },
      { label: "韓国料理", value: "korean" },
    ],
  },
  {
    id: "family_size",
    text: "何人分の食事を作りますか？（1〜10人）",
    type: "number",
    placeholder: "例: 4",
    min: 1,
    max: 10,
  },
  {
    id: "servings_config",
    text: "曜日ごとの食事人数を設定してください\n（0人＝作らない/外食）",
    type: "servings_grid",
  },
  {
    id: "shopping_frequency",
    text: "普段の買い物の頻度は？",
    type: "choice",
    options: [
      { label: "毎日買い物に行く", value: "daily" },
      { label: "週2〜3回", value: "2-3_weekly" },
      { label: "週1回まとめ買い", value: "weekly" },
      { label: "2週間に1回程度", value: "biweekly" },
    ],
  },
  {
    id: "weekly_food_budget",
    text: "週の食費予算は？（任意）",
    type: "choice",
    allowSkip: true,
    options: [
      { label: "〜5,000円", value: "5000" },
      { label: "5,000〜10,000円", value: "10000" },
      { label: "10,000〜15,000円", value: "15000" },
      { label: "15,000〜20,000円", value: "20000" },
      { label: "20,000円以上", value: "25000" },
      { label: "特に決めていない", value: "none" },
    ],
  },
  {
    id: "kitchen_appliances",
    text: "お持ちの調理器具は？（複数選択可）",
    type: "multi_choice",
    allowSkip: true,
    options: [
      { label: "オーブン/オーブンレンジ", value: "oven" },
      { label: "魚焼きグリル", value: "grill" },
      { label: "圧力鍋", value: "pressure_cooker" },
      { label: "ホットクック/電気圧力鍋", value: "slow_cooker" },
      { label: "エアフライヤー", value: "air_fryer" },
      { label: "フードプロセッサー/ミキサー", value: "food_processor" },
    ],
  },
  {
    id: "stove_type",
    text: "お使いのコンロは？",
    type: "choice",
    options: [
      { label: "ガスコンロ", value: "stove:gas" },
      { label: "IHコンロ", value: "stove:ih" },
    ],
  },
];

function getNextQuestion(fromStep: number, ans: Record<string, any>) {
  for (let i = fromStep + 1; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    if (!q.showIf || q.showIf(ans)) return i;
  }
  return -1;
}

function calculateTotalQuestions(ans: Record<string, any>) {
  let total = 0;
  for (const q of QUESTIONS) {
    if (!q.showIf || q.showIf(ans)) total++;
  }
  return total;
}

function transformAnswersToProfile(ans: Record<string, any>) {
  const profile: Record<string, any> = {
    nickname: ans.nickname,
    gender: ans.gender,
    age: ans.age ? parseInt(ans.age) : null,
    occupation: ans.occupation,
    height: ans.height ? parseFloat(ans.height) : null,
    weight: ans.weight ? parseFloat(ans.weight) : null,
  };

  if (ans.nutrition_goal) profile.nutritionGoal = ans.nutrition_goal;
  if (ans.weight_change_rate) profile.weightChangeRate = ans.weight_change_rate;
  if (ans.exercise_types?.length && !ans.exercise_types.includes("none")) profile.exerciseTypes = ans.exercise_types;
  if (ans.exercise_frequency) profile.exerciseFrequency = parseInt(ans.exercise_frequency);
  if (ans.exercise_intensity) profile.exerciseIntensity = ans.exercise_intensity;
  if (ans.exercise_duration) profile.exerciseDurationPerSession = parseInt(ans.exercise_duration);
  if (ans.work_style) profile.workStyle = ans.work_style;
  if (ans.health_conditions?.length && !ans.health_conditions.includes("none")) profile.healthConditions = ans.health_conditions;
  if (ans.medications?.length && !ans.medications.includes("none")) profile.medications = ans.medications;
  if (ans.allergies?.length) profile.dietFlags = { allergies: ans.allergies, dislikes: [] };
  if (ans.cooking_experience) profile.cookingExperience = ans.cooking_experience;
  if (ans.cooking_time) profile.weekdayCookingMinutes = parseInt(ans.cooking_time);
  if (ans.cuisine_preference?.length) {
    const prefs: Record<string, number> = {};
    ans.cuisine_preference.forEach((c: string) => { prefs[c] = 5; });
    profile.cuisinePreferences = prefs;
  }
  if (ans.family_size) profile.familySize = parseInt(ans.family_size);
  if (ans.servings_config) profile.servingsConfig = ans.servings_config;
  if (ans.shopping_frequency) profile.shoppingFrequency = ans.shopping_frequency;
  if (ans.weekly_food_budget && ans.weekly_food_budget !== "none") profile.weeklyFoodBudget = parseInt(ans.weekly_food_budget);
  const appliances: string[] = [];
  if (ans.kitchen_appliances?.length) appliances.push(...ans.kitchen_appliances);
  if (ans.stove_type) appliances.push(ans.stove_type);
  if (appliances.length > 0) profile.kitchenAppliances = appliances;

  // Performance OS v3: performance_profile 構築
  if (ans.nutrition_goal === "athlete_performance") {
    const sportId = ans.sport_type === "custom" ? "custom" : ans.sport_type;
    const sportName = ans.sport_type === "custom" ? ans.sport_custom_name : null;
    profile.performanceProfile = {
      sport: {
        id: sportId || null,
        name: sportName || null,
        role: null,
        experience: ans.sport_experience || "intermediate",
        phase: ans.training_phase || "training",
        demandVector: null,
      },
      growth: {
        isUnder18: ans.age ? parseInt(ans.age) < 18 : false,
        heightChangeRecent: null,
        growthProtectionEnabled: ans.age ? parseInt(ans.age) < 18 : false,
      },
      cut: {
        enabled: ans.training_phase === "cut",
        targetWeight: ans.target_weight ? parseFloat(ans.target_weight) : null,
        targetDate: ans.competition_date || ans.target_date || null,
        strategy: "gradual",
      },
      priorities: {
        protein: "high",
        carbs: ans.training_phase === "competition" ? "high" : "moderate",
        fat: "moderate",
        hydration: "high",
      },
    };
  }

  return profile;
}

function toDbProfileUpdates(body: any, userId: string) {
  const updates: any = { id: userId, updated_at: new Date().toISOString() };

  if (body.nickname) updates.nickname = body.nickname;
  if (body.gender) updates.gender = body.gender;
  if (body.age !== undefined && body.age !== null) updates.age = body.age;
  if (body.age !== undefined && body.age !== null) updates.age_group = `${Math.floor(body.age / 10) * 10}s`;
  if (body.occupation) updates.occupation = body.occupation;
  if (body.height !== undefined && body.height !== null) updates.height = body.height;
  if (body.weight !== undefined && body.weight !== null) updates.weight = body.weight;
  if (body.nutritionGoal) updates.nutrition_goal = body.nutritionGoal;
  if (body.weightChangeRate) updates.weight_change_rate = body.weightChangeRate;
  if (body.exerciseTypes) updates.exercise_types = body.exerciseTypes;
  if (body.exerciseFrequency !== undefined) updates.exercise_frequency = body.exerciseFrequency;
  if (body.exerciseIntensity) updates.exercise_intensity = body.exerciseIntensity;
  if (body.exerciseDurationPerSession !== undefined) updates.exercise_duration_per_session = body.exerciseDurationPerSession;
  if (body.workStyle) updates.work_style = body.workStyle;
  if (body.healthConditions) updates.health_conditions = body.healthConditions;
  if (body.medications) updates.medications = body.medications;
  if (body.dietFlags) updates.diet_flags = body.dietFlags;
  if (body.cookingExperience) updates.cooking_experience = body.cookingExperience;
  if (body.weekdayCookingMinutes !== undefined) updates.weekday_cooking_minutes = body.weekdayCookingMinutes;
  if (body.cuisinePreferences) updates.cuisine_preferences = body.cuisinePreferences;
  if (body.familySize !== undefined) updates.family_size = body.familySize;
  if (body.servingsConfig !== undefined) updates.servings_config = body.servingsConfig;
  if (body.shoppingFrequency) updates.shopping_frequency = body.shoppingFrequency;
  if (body.weeklyFoodBudget !== undefined) updates.weekly_food_budget = body.weeklyFoodBudget;
  if (body.kitchenAppliances) updates.kitchen_appliances = body.kitchenAppliances;
  if (body.performanceProfile) updates.performance_profile = body.performanceProfile;

  if (!updates.nickname) updates.nickname = "Guest";
  if (!updates.age_group && !updates.age) updates.age_group = "unspecified";
  if (!updates.gender) updates.gender = "unspecified";

  return updates;
}

// モバイル版: 質問フロー (OB-UI-05)
export default function OnboardingQuestions() {
  const { refresh: refreshProfile, profile } = useProfile();
  const params = useLocalSearchParams();
  const isResume = params.resume === "true";
  const insets = useSafeAreaInsets();

  const [currentStep, setCurrentStep] = useState(0);
  const [stepHistory, setStepHistory] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [inputValue, setInputValue] = useState("");
  const [selectedMulti, setSelectedMulti] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(isResume);
  const [isCalculating, setIsCalculating] = useState(false);

  // 再開時は進捗を復元
  useEffect(() => {
    if (isResume && profile?.onboardingProgress) {
      setCurrentStep(profile.onboardingProgress.currentStep || 0);
      setAnswers(profile.onboardingProgress.answers || {});
      setIsLoading(false);
    } else if (isResume) {
      setIsLoading(false);
    }
  }, [isResume, profile?.onboardingProgress]);

  const currentQuestion = QUESTIONS[currentStep];
  const isNumberQuestion = currentQuestion?.type === "number";
  const numberMin = isNumberQuestion && typeof (currentQuestion as any).min === "number" ? (currentQuestion as any).min : 1;
  const numberMax = isNumberQuestion && typeof (currentQuestion as any).max === "number" ? (currentQuestion as any).max : 10;
  const numberValue = isNumberQuestion ? Number.parseInt(inputValue, 10) : NaN;
  const isNumberValid = isNumberQuestion && Number.isFinite(numberValue) && numberValue >= numberMin && numberValue <= numberMax;
  const isMultiReady = selectedMulti.length > 0;
  const hasTags = tags.length > 0;

  const progress = useMemo(() => {
    let total = 0;
    let current = 0;
    for (let i = 0; i < QUESTIONS.length; i++) {
      const q = QUESTIONS[i];
      if (!q.showIf || q.showIf(answers)) {
        total++;
        if (i <= currentStep) current++;
      }
    }
    return { current, total };
  }, [answers, currentStep]);

  function getQuestionText() {
    if (!currentQuestion) return "";
    let text = currentQuestion.text;
    Object.keys(answers).forEach((key) => {
      text = text.replace(`{${key}}`, String(answers[key] ?? ""));
    });
    return text;
  }

  function handleBack() {
    if (stepHistory.length === 0) return;
    const prevStep = stepHistory[stepHistory.length - 1];
    setStepHistory((prev) => prev.slice(0, -1));
    setCurrentStep(prevStep);
    setInputValue("");
    setSelectedMulti([]);
    setTags([]);
    setTagInput("");
  }

  function handleMultiSelect(value: string) {
    if (value === "none") {
      setSelectedMulti(["none"]);
      return;
    }
    setSelectedMulti((prev) => {
      const filtered = prev.filter((v) => v !== "none");
      if (filtered.includes(value)) return filtered.filter((v) => v !== value);
      return [...filtered, value];
    });
  }

  function addTag(t: string) {
    const trimmed = t.trim();
    if (!trimmed) return;
    if (!tags.includes(trimmed)) setTags((prev) => [...prev, trimmed]);
    setTagInput("");
  }

  function removeTag(t: string) {
    setTags((prev) => prev.filter((x) => x !== t));
  }

  // リアルタイム保存
  async function saveProgress(step: number, ans: Record<string, any>) {
    try {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) return;

      const totalQuestions = calculateTotalQuestions(ans);
      const progressData = {
        currentStep: step,
        answers: ans,
        totalQuestions,
        lastUpdatedAt: new Date().toISOString(),
      };

      // 現在のプロファイルを取得
      const { data: existing } = await supabase
        .from("user_profiles")
        .select("onboarding_started_at")
        .eq("id", auth.user.id)
        .single();

      const updates: any = {
        id: auth.user.id,
        onboarding_progress: progressData,
        updated_at: new Date().toISOString(),
      };

      if (!existing?.onboarding_started_at) {
        updates.onboarding_started_at = new Date().toISOString();
      }

      // 回答内容も同時に保存
      if (ans.nickname) updates.nickname = ans.nickname;
      if (ans.gender) updates.gender = ans.gender;
      if (ans.age) {
        updates.age = parseInt(ans.age);
        updates.age_group = `${Math.floor(parseInt(ans.age) / 10) * 10}s`;
      }
      if (!updates.nickname) updates.nickname = "Guest";
      if (!updates.age_group && !updates.age) updates.age_group = "unspecified";
      if (!updates.gender) updates.gender = "unspecified";

      await supabase.from("user_profiles").upsert(updates);
    } catch (error) {
      console.error("Failed to save progress:", error);
    }
  }

  async function handleAnswer(value: any) {
    const newAnswers = { ...answers, [currentQuestion.id]: value };
    setAnswers(newAnswers);
    setInputValue("");
    setSelectedMulti([]);
    setTags([]);
    setTagInput("");

    const next = getNextQuestion(currentStep, newAnswers);
    if (next !== -1) {
      setStepHistory((prev) => [...prev, currentStep]);
      saveProgress(next, newAnswers);
      setCurrentStep(next);
      return;
    }

    // 完了: プロファイルをDBに保存してからサーバーサイドで栄養目標を計算
    setIsCalculating(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) throw new Error("Unauthorized");

      const profileBody = transformAnswersToProfile(newAnswers);
      const updates = toDbProfileUpdates(profileBody, auth.user.id);

      const { error: profileError } = await supabase
        .from("user_profiles")
        .upsert(updates);
      if (profileError) throw profileError;

      // サーバーサイドで performance_profile 構築・fitness_goals/goal_text/
      // weekly_exercise_minutes 計算・nutrition_targets 保存を一括実行
      const api = getApi();
      await api.post("/api/onboarding/complete");

      await refreshProfile();
      router.replace("/onboarding/complete");
    } catch (e: any) {
      setIsCalculating(false);
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  const canSkip = (currentQuestion as any)?.allowSkip;

  if (isLoading) {
    return <LoadingState message="前回の進捗を読み込み中..." style={{ backgroundColor: "#FFF7ED" }} />;
  }

  if (isCalculating) {
    return (
      <View style={[styles.calculatingContainer, { paddingTop: insets.top }]}>
        <View style={styles.calculatingIcon}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
        <Text style={styles.calculatingTitle}>栄養設計を計算中...</Text>
        <Text style={styles.calculatingSubtitle}>
          入力いただいた情報をもとに{"\n"}最適な栄養目標を計算しています
        </Text>
        <Text style={styles.calculatingHint}>このまましばらくお待ちください</Text>
      </View>
    );
  }

  if (!currentQuestion) {
    return null;
  }

  return (
    <View style={[styles.screenContainer, { paddingTop: insets.top }]}>
      {/* ── Header: back + progress ── */}
      <View style={styles.headerSection}>
        <View style={styles.headerRow}>
          <View style={styles.headerLeft}>
            {stepHistory.length > 0 && (
              <Pressable onPress={handleBack} style={styles.backButton} hitSlop={12}>
                <Ionicons name="chevron-back" size={18} color="#666" />
              </Pressable>
            )}
            <Text style={styles.headerLabel}>
              Setup Profile
            </Text>
          </View>
          <Text style={styles.headerCounter}>{progress.current} / {progress.total}</Text>
        </View>
        {/* Progress bar */}
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${(progress.current / progress.total) * 100}%` }]} />
        </View>
      </View>

      {/* ── Main: avatar + question ── */}
      <ScrollView contentContainerStyle={styles.mainSection} keyboardShouldPersistTaps="handled">
        {/* AI Avatar */}
        <View style={styles.avatarWrap}>
          <View style={styles.avatarPulse} />
          <View style={styles.avatar}>
            <Text style={{ fontSize: 28 }}>🍳</Text>
          </View>
        </View>

        {/* Question text */}
        <View style={styles.questionSection}>
          {getQuestionText()
            .split("\n")
            .map((line, i) => (
              <Text key={i} style={styles.questionText}>
                {line}
              </Text>
            ))}
        </View>
      </ScrollView>

      {/* ── Input area (bottom) ── */}
      <ScrollView style={styles.inputScroll} contentContainerStyle={styles.inputSection} keyboardShouldPersistTaps="handled">

        {/* Text input */}
        {currentQuestion.type === "text" && (
          <View style={styles.inputRow}>
            <TextInput
              autoFocus
              placeholder={currentQuestion.placeholder}
              placeholderTextColor={colors.textMuted}
              value={inputValue}
              onChangeText={setInputValue}
              onSubmitEditing={() => { if (inputValue.trim()) handleAnswer(inputValue.trim()); }}
              style={[styles.textInput, { flex: 1 }]}
            />
            <Pressable
              onPress={() => { if (inputValue.trim()) handleAnswer(inputValue.trim()); }}
              disabled={!inputValue.trim()}
              style={[styles.arrowButton, !inputValue.trim() && styles.arrowButtonDisabled]}
            >
              <Ionicons name="arrow-forward" size={20} color="#fff" />
            </Pressable>
          </View>
        )}

        {/* Number input */}
        {currentQuestion.type === "number" && (
          <View style={styles.inputRow}>
            <TextInput
              autoFocus
              keyboardType="number-pad"
              placeholder={currentQuestion.placeholder}
              placeholderTextColor={colors.textMuted}
              value={inputValue}
              onChangeText={(v) => setInputValue(v.replace(/[^0-9]/g, ""))}
              onSubmitEditing={() => { if (isNumberValid) handleAnswer(numberValue); }}
              style={[styles.textInput, { flex: 1 }]}
            />
            <Pressable
              onPress={() => { if (isNumberValid) handleAnswer(numberValue); }}
              disabled={!isNumberValid}
              style={[styles.arrowButton, !isNumberValid && styles.arrowButtonDisabled]}
            >
              <Ionicons name="arrow-forward" size={20} color="#fff" />
            </Pressable>
          </View>
        )}

        {/* Choice — outline buttons (matching web) */}
        {currentQuestion.type === "choice" && (
          <View style={styles.choiceGroup}>
            {(currentQuestion.options || []).map((opt) => (
              <Pressable
                key={opt.value}
                onPress={() => handleAnswer(opt.value)}
                style={({ pressed }) => [styles.choiceButton, pressed && { backgroundColor: colors.accent, borderColor: colors.accent }]}
              >
                {({ pressed }) => (
                  <View style={{ gap: 2 }}>
                    <Text style={[styles.choiceLabel, pressed && { color: "#fff" }]}>{opt.label}</Text>
                    {opt.description ? (
                      <Text style={[styles.choiceDescription, pressed && { color: "rgba(255,255,255,0.7)" }]}>{opt.description}</Text>
                    ) : null}
                  </View>
                )}
              </Pressable>
            ))}
          </View>
        )}

        {/* Multi choice — grid buttons (matching web) */}
        {currentQuestion.type === "multi_choice" && (
          <View style={{ gap: spacing.md }}>
            <View style={styles.multiGrid}>
              {(currentQuestion.options || []).map((opt) => {
                const selected = selectedMulti.includes(opt.value);
                return (
                  <Pressable
                    key={opt.value}
                    onPress={() => handleMultiSelect(opt.value)}
                    style={[styles.multiButton, selected && styles.multiButtonSelected]}
                  >
                    <Text style={[styles.multiButtonText, selected && { color: "#fff" }]}>
                      {opt.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.actionRow}>
              {canSkip && (
                <Pressable onPress={() => handleAnswer(null)} style={styles.skipButton}>
                  <Text style={styles.skipButtonText}>スキップ</Text>
                </Pressable>
              )}
              <Pressable
                onPress={() => { if (isMultiReady) handleAnswer(selectedMulti); }}
                disabled={!isMultiReady}
                style={[styles.nextButton, !isMultiReady && styles.nextButtonDisabled]}
              >
                <Text style={styles.nextButtonText}>次へ</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Tags */}
        {currentQuestion.type === "tags" && (
          <View style={{ gap: spacing.md }}>
            {tags.length > 0 && (
              <View style={styles.tagWrap}>
                {tags.map((t) => (
                  <Pressable key={t} onPress={() => removeTag(t)} style={styles.tagBadge}>
                    <Text style={styles.tagBadgeText}>{t}</Text>
                    <Text style={{ color: colors.accent, fontWeight: "800" }}>×</Text>
                  </Pressable>
                ))}
              </View>
            )}

            {currentQuestion.suggestions?.length ? (
              <View style={styles.tagWrap}>
                {currentQuestion.suggestions.filter((s) => !tags.includes(s)).map((s) => (
                  <Pressable key={s} onPress={() => addTag(s)} style={styles.suggestionChip}>
                    <Text style={styles.suggestionChipText}>+ {s}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            <View style={styles.inputRow}>
              <TextInput
                placeholder={currentQuestion.placeholder}
                placeholderTextColor={colors.textMuted}
                value={tagInput}
                onChangeText={setTagInput}
                onSubmitEditing={() => addTag(tagInput)}
                style={[styles.textInput, { flex: 1 }]}
              />
              <Pressable onPress={() => addTag(tagInput)} style={styles.addTagButton}>
                <Text style={{ color: colors.text, fontWeight: "700", fontSize: 14 }}>追加</Text>
              </Pressable>
            </View>

            <View style={styles.actionRow}>
              {canSkip && (
                <Pressable onPress={() => handleAnswer(null)} style={styles.skipButton}>
                  <Text style={styles.skipButtonText}>スキップ</Text>
                </Pressable>
              )}
              <Pressable
                onPress={() => { if (hasTags) handleAnswer(tags); }}
                disabled={!hasTags}
                style={[styles.nextButton, !hasTags && styles.nextButtonDisabled]}
              >
                <Text style={styles.nextButtonText}>次へ</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Custom stats */}
        {currentQuestion.type === "custom_stats" && (
          <View style={{ gap: spacing.md }}>
            <View style={styles.statsRow}>
              <View style={styles.statsField}>
                <Text style={styles.statsLabel}>年齢</Text>
                <TextInput keyboardType="number-pad" placeholder="25" placeholderTextColor={colors.textMuted}
                  value={answers.age || ""} onChangeText={(v) => setAnswers((prev) => ({ ...prev, age: v }))}
                  style={[styles.textInput, { textAlign: "center" }]} />
              </View>
              <View style={styles.statsField}>
                <Text style={styles.statsLabel}>職業</Text>
                <TextInput placeholder="会社員" placeholderTextColor={colors.textMuted}
                  value={answers.occupation || ""} onChangeText={(v) => setAnswers((prev) => ({ ...prev, occupation: v }))}
                  style={[styles.textInput, { textAlign: "center" }]} />
              </View>
            </View>
            <View style={styles.statsRow}>
              <View style={styles.statsField}>
                <Text style={styles.statsLabel}>身長 (cm)</Text>
                <TextInput keyboardType="decimal-pad" placeholder="170" placeholderTextColor={colors.textMuted}
                  value={answers.height || ""} onChangeText={(v) => setAnswers((prev) => ({ ...prev, height: v }))}
                  style={[styles.textInput, { textAlign: "center" }]} />
              </View>
              <View style={styles.statsField}>
                <Text style={styles.statsLabel}>体重 (kg)</Text>
                <TextInput keyboardType="decimal-pad" placeholder="60" placeholderTextColor={colors.textMuted}
                  value={answers.weight || ""} onChangeText={(v) => setAnswers((prev) => ({ ...prev, weight: v }))}
                  style={[styles.textInput, { textAlign: "center" }]} />
              </View>
            </View>
            <Pressable
              onPress={() => handleAnswer("completed")}
              disabled={!answers.age || !answers.height || !answers.weight}
              style={[styles.nextButton, (!answers.age || !answers.height || !answers.weight) && styles.nextButtonDisabled]}
            >
              <Text style={styles.nextButtonText}>次へ</Text>
            </Pressable>
          </View>
        )}

      {/* Date input */}
      {currentQuestion.type === "date" && (
        <View style={{ gap: spacing.md }}>
          <Text style={{ color: colors.textMuted, fontSize: 13, textAlign: "center" }}>
            YYYY-MM-DD 形式で入力してください（例: 2025-08-15）
          </Text>
          <View style={styles.inputRow}>
            <TextInput
              autoFocus
              keyboardType="numbers-and-punctuation"
              placeholder="例: 2025-08-15"
              placeholderTextColor={colors.textMuted}
              value={inputValue}
              onChangeText={setInputValue}
              onSubmitEditing={() => {
                if (inputValue.trim()) handleAnswer(inputValue.trim());
              }}
              style={[styles.textInput, { flex: 1 }]}
            />
            <Pressable
              onPress={() => {
                if (inputValue.trim()) handleAnswer(inputValue.trim());
              }}
              disabled={!inputValue.trim()}
              style={[styles.arrowButton, !inputValue.trim() && styles.arrowButtonDisabled]}
            >
              <Ionicons name="arrow-forward" size={20} color="#fff" />
            </Pressable>
          </View>
          {canSkip && (
            <Pressable onPress={() => handleAnswer(null)} style={styles.skipButton}>
              <Text style={styles.skipButtonText}>スキップ</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Servings grid */}
      {currentQuestion.type === "servings_grid" ? (
        <View style={{ gap: spacing.md }}>
          <Text style={styles.gridHint}>
            各セルをタップして人数を変更できます
          </Text>

          {/* Header row */}
          <Card style={styles.gridCard}>
            <View style={styles.gridHeaderRow}>
              <View style={{ width: 36 }} />
              {MEAL_TYPES.map((meal) => (
                <View key={meal.key} style={styles.gridHeaderCell}>
                  <Text style={styles.gridHeaderText}>{meal.label}</Text>
                </View>
              ))}
            </View>

            {/* Day rows */}
            {DAYS_OF_WEEK.map((day) => (
              <View key={day.key} style={styles.gridRow}>
                <View style={{ width: 36, alignItems: "center" }}>
                  <Text
                    style={[
                      styles.gridDayLabel,
                      (day.key === "saturday" || day.key === "sunday") && { color: colors.error },
                    ]}
                  >
                    {day.label}
                  </Text>
                </View>
                {MEAL_TYPES.map((meal) => {
                  const familySize = parseInt(answers.family_size) || 2;
                  const currentConfig = answers.servings_config || createDefaultServingsConfig(familySize);
                  const value = currentConfig.byDayMeal?.[day.key]?.[meal.key] ?? familySize;

                  const updateValue = (newValue: number) => {
                    const clampedValue = Math.max(0, Math.min(10, newValue));
                    const updatedConfig = {
                      ...currentConfig,
                      byDayMeal: {
                        ...currentConfig.byDayMeal,
                        [day.key]: {
                          ...(currentConfig.byDayMeal?.[day.key] || {}),
                          [meal.key]: clampedValue,
                        },
                      },
                    };
                    setAnswers((prev) => ({ ...prev, servings_config: updatedConfig }));
                  };

                  return (
                    <View
                      key={meal.key}
                      style={[
                        styles.gridCell,
                        value === 0 ? styles.gridCellInactive : styles.gridCellActive,
                      ]}
                    >
                      <Pressable onPress={() => updateValue(value - 1)} style={styles.gridButton}>
                        <Ionicons
                          name="remove"
                          size={16}
                          color={value === 0 ? colors.textMuted : colors.success}
                        />
                      </Pressable>
                      <Text
                        style={[
                          styles.gridValue,
                          value === 0 && { color: colors.textMuted },
                        ]}
                      >
                        {value === 0 ? "-" : value}
                      </Text>
                      <Pressable onPress={() => updateValue(value + 1)} style={styles.gridButton}>
                        <Ionicons
                          name="add"
                          size={16}
                          color={value === 0 ? colors.textMuted : colors.success}
                        />
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            ))}
          </Card>

          {/* Legend */}
          <View style={styles.legendRow}>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: colors.successLight, borderColor: colors.success }]} />
              <Text style={styles.legendText}>作る</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: colors.bg, borderColor: colors.border }]} />
              <Text style={styles.legendText}>作らない</Text>
            </View>
          </View>

          <Pressable
            onPress={() => {
              const familySize = parseInt(answers.family_size) || 2;
              const config = answers.servings_config || createDefaultServingsConfig(familySize);
              handleAnswer(config);
            }}
            style={styles.nextButton}
          >
            <Text style={styles.nextButtonText}>次へ</Text>
            <Ionicons name="arrow-forward" size={18} color="#FFFFFF" />
          </Pressable>
        </View>
      ) : null}

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  /* ── Layout ── */
  screenContainer: {
    flex: 1,
    backgroundColor: "#FFF7ED",
  },
  headerSection: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  headerLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: "#9CA3AF",
    textTransform: "uppercase",
    letterSpacing: 2,
  },
  headerCounter: {
    fontSize: 11,
    fontWeight: "800",
    color: "#9CA3AF",
    letterSpacing: 1,
  },
  backButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  progressTrack: {
    width: "100%",
    height: 8,
    backgroundColor: "#E5E7EB",
    borderRadius: 4,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  mainSection: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing["2xl"],
    gap: spacing.xl,
  },
  avatarWrap: {
    width: 80,
    height: 80,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarPulse: {
    position: "absolute",
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "rgba(251,146,60,0.15)",
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: "#fff",
    ...shadows.lg,
  },
  questionSection: {
    gap: spacing.sm,
    alignItems: "center",
  },
  questionText: {
    fontSize: 20,
    fontWeight: "800",
    color: "#1F2937",
    textAlign: "center",
    lineHeight: 30,
  },
  /* ── Input area ── */
  inputScroll: {
    maxHeight: "55%",
  },
  inputSection: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing["2xl"],
    gap: spacing.md,
  },
  inputRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  textInput: {
    borderWidth: 1,
    borderColor: "#E5E7EB",
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: "#fff",
    fontSize: 16,
    color: colors.text,
  },
  arrowButton: {
    width: 48,
    height: 48,
    borderRadius: radius.lg,
    backgroundColor: "#1F2937",
    alignItems: "center",
    justifyContent: "center",
  },
  arrowButtonDisabled: {
    backgroundColor: "#D1D5DB",
  },
  /* ── Choice ── */
  choiceGroup: {
    gap: spacing.sm,
  },
  choiceButton: {
    paddingVertical: 16,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    backgroundColor: "#fff",
  },
  choiceLabel: {
    fontWeight: "700",
    fontSize: 15,
    color: "#4B5563",
  },
  choiceDescription: {
    color: "#9CA3AF",
    fontSize: 12,
    marginTop: 2,
  },
  /* ── Multi choice ── */
  multiGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  multiButton: {
    width: "48%",
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: "#E5E7EB",
    backgroundColor: "#fff",
    alignItems: "center",
  },
  multiButtonSelected: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  multiButtonText: {
    fontWeight: "700",
    fontSize: 13,
    color: "#4B5563",
  },
  actionRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  skipButton: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: radius.xl,
    alignItems: "center",
  },
  skipButtonText: {
    fontWeight: "700",
    color: "#9CA3AF",
    fontSize: 15,
  },
  nextButton: {
    flex: 1,
    backgroundColor: "#1F2937",
    paddingVertical: 16,
    borderRadius: radius.xl,
    alignItems: "center",
    justifyContent: "center",
  },
  nextButtonDisabled: {
    backgroundColor: "#D1D5DB",
  },
  nextButtonText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 15,
  },
  /* ── Tags ── */
  tagWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  tagBadge: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.full,
    backgroundColor: "#FFF7ED",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  tagBadgeText: {
    fontWeight: "700",
    color: colors.accent,
    fontSize: 13,
  },
  addTagButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    backgroundColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
  },
  suggestionChip: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.full,
    backgroundColor: "#F3F4F6",
  },
  suggestionChipText: {
    fontWeight: "700",
    color: "#4B5563",
    fontSize: 12,
  },
  /* ── Stats ── */
  statsRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  statsField: {
    flex: 1,
    gap: spacing.xs,
  },
  statsLabel: {
    color: "#6B7280",
    fontWeight: "700",
    fontSize: 12,
  },
  /* ── Grid ── */
  gridHint: {
    color: "#6B7280",
    fontSize: 13,
    textAlign: "center",
  },
  gridCard: {
    padding: spacing.md,
  },
  gridHeaderRow: {
    flexDirection: "row",
    marginBottom: spacing.xs,
  },
  gridHeaderCell: {
    flex: 1,
    alignItems: "center",
  },
  gridHeaderText: {
    fontWeight: "700",
    color: "#374151",
    fontSize: 14,
  },
  gridRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 2,
  },
  gridDayLabel: {
    fontWeight: "700",
    color: "#374151",
    fontSize: 14,
  },
  gridCell: {
    flex: 1,
    margin: 2,
    borderRadius: radius.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    borderWidth: 1,
  },
  gridCellActive: {
    backgroundColor: colors.successLight,
    borderColor: colors.success,
  },
  gridCellInactive: {
    backgroundColor: "#F9FAFB",
    borderColor: "#E5E7EB",
  },
  gridButton: {
    padding: 8,
  },
  gridValue: {
    fontWeight: "700",
    fontSize: 14,
    color: colors.success,
    minWidth: 16,
    textAlign: "center",
  },
  legendRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: spacing.lg,
    marginTop: spacing.sm,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  legendDot: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1,
  },
  legendText: {
    fontSize: 12,
    color: "#6B7280",
  },
  /* ── Calculating ── */
  calculatingContainer: {
    flex: 1,
    backgroundColor: "#FFF7ED",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing["2xl"],
    gap: spacing.lg,
  },
  calculatingIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: "#FFF7ED",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#FED7AA",
    marginBottom: spacing.sm,
  },
  calculatingTitle: {
    fontSize: 22,
    fontWeight: "800",
    color: "#1F2937",
  },
  calculatingSubtitle: {
    fontSize: 14,
    color: "#6B7280",
    textAlign: "center",
    lineHeight: 22,
  },
  calculatingHint: {
    fontSize: 12,
    color: "#9CA3AF",
    marginTop: spacing.md,
  },
});
