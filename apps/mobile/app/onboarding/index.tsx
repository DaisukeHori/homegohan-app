import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { calculateNutritionTargets } from "../../src/lib/nutritionTargets";
import { supabase } from "../../src/lib/supabase";
import { useProfile } from "../../src/providers/ProfileProvider";

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
    };

// Web版のオンボーディング定義をベースに移植（まずは同等の質問フローを実装）
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
      { label: "特になし", value: "none" },
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
      { label: "特になし", value: "none" },
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
    text: "何人分の食事を作りますか？",
    type: "choice",
    options: [
      { label: "1人", value: "1" },
      { label: "2人", value: "2" },
      { label: "3人", value: "3" },
      { label: "4人以上", value: "4" },
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

  if (ans.allergies?.length) {
    profile.dietFlags = {
      allergies: ans.allergies,
      dislikes: [],
    };
  }

  if (ans.cooking_experience) profile.cookingExperience = ans.cooking_experience;
  if (ans.cooking_time) profile.weekdayCookingMinutes = parseInt(ans.cooking_time);

  if (ans.cuisine_preference?.length) {
    const prefs: Record<string, number> = {};
    ans.cuisine_preference.forEach((c: string) => {
      prefs[c] = 5;
    });
    profile.cuisinePreferences = prefs;
  }

  if (ans.family_size) profile.familySize = parseInt(ans.family_size);

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

  // デフォルト補完
  if (!updates.nickname) updates.nickname = "Guest";
  if (!updates.age_group && !updates.age) updates.age_group = "unspecified";
  if (!updates.gender) updates.gender = "unspecified";

  return updates;
}

export default function OnboardingIndex() {
  const { refresh: refreshProfile } = useProfile();

  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [inputValue, setInputValue] = useState("");
  const [selectedMulti, setSelectedMulti] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const currentQuestion = QUESTIONS[currentStep];

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
    let text = currentQuestion.text;
    Object.keys(answers).forEach((key) => {
      text = text.replace(`{${key}}`, String(answers[key] ?? ""));
    });
    return text;
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

  async function handleAnswer(value: any) {
    const newAnswers = { ...answers, [currentQuestion.id]: value };
    setAnswers(newAnswers);
    setInputValue("");
    setSelectedMulti([]);
    setTags([]);
    setTagInput("");

    const next = getNextQuestion(currentStep, newAnswers);
    if (next !== -1) {
      setCurrentStep(next);
      return;
    }

    // 完了: DBに保存
    setIsSubmitting(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) throw new Error("Unauthorized");

      const profileBody = transformAnswersToProfile(newAnswers);
      const updates = toDbProfileUpdates(profileBody, auth.user.id);

      const { data: savedProfile, error: profileError } = await supabase
        .from("user_profiles")
        .upsert(updates)
        .select("*")
        .single();
      if (profileError) throw profileError;

      const { targetData } = calculateNutritionTargets(savedProfile);

      const { data: existing } = await supabase
        .from("nutrition_targets")
        .select("id")
        .eq("user_id", auth.user.id)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase.from("nutrition_targets").update(targetData).eq("user_id", auth.user.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("nutrition_targets").insert(targetData);
        if (error) throw error;
      }

      await refreshProfile();
      router.replace("/onboarding/complete");
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  const canSkip = (currentQuestion as any).allowSkip;

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 16, justifyContent: "center", gap: 16 }}>
      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 12, color: "#888" }}>
          {progress.current} / {progress.total}
        </Text>
        <View style={{ height: 6, backgroundColor: "#eee", borderRadius: 999 }}>
          <View
            style={{
              height: 6,
              width: `${Math.round((progress.current / progress.total) * 100)}%`,
              backgroundColor: "#E07A5F",
              borderRadius: 999,
            }}
          />
        </View>
      </View>

      <View style={{ gap: 10 }}>
        {getQuestionText()
          .split("\n")
          .map((line, i) => (
            <Text key={i} style={{ fontSize: 18, fontWeight: "700" }}>
              {line}
            </Text>
          ))}
      </View>

      {/* 入力UI */}
      {currentQuestion.type === "text" ? (
        <View style={{ gap: 10 }}>
          <TextInput
            autoFocus
            placeholder={currentQuestion.placeholder}
            value={inputValue}
            onChangeText={setInputValue}
            style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
          />
          <Pressable
            onPress={() => {
              if (!inputValue.trim()) return;
              handleAnswer(inputValue.trim());
            }}
            style={{
              backgroundColor: inputValue.trim() ? "#333" : "#999",
              padding: 14,
              borderRadius: 12,
              alignItems: "center",
            }}
          >
            <Text style={{ color: "white", fontWeight: "700" }}>{isSubmitting ? "保存中..." : "次へ"}</Text>
          </Pressable>
        </View>
      ) : null}

      {currentQuestion.type === "choice" ? (
        <View style={{ gap: 10 }}>
          {(currentQuestion.options || []).map((opt) => (
            <Pressable
              key={opt.value}
              onPress={() => handleAnswer(opt.value)}
              style={{
                borderWidth: 1,
                borderColor: "#ddd",
                padding: 14,
                borderRadius: 12,
                backgroundColor: "white",
              }}
            >
              <Text style={{ fontWeight: "700" }}>{opt.label}</Text>
              {opt.description ? <Text style={{ color: "#666" }}>{opt.description}</Text> : null}
            </Pressable>
          ))}
        </View>
      ) : null}

      {currentQuestion.type === "multi_choice" ? (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {(currentQuestion.options || []).map((opt) => {
              const selected = selectedMulti.includes(opt.value);
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => handleMultiSelect(opt.value)}
                  style={{
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: selected ? "#E07A5F" : "#ddd",
                    backgroundColor: selected ? "#E07A5F" : "white",
                  }}
                >
                  <Text style={{ color: selected ? "white" : "#333", fontWeight: "700" }}>{opt.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={{ flexDirection: "row", gap: 10 }}>
            {canSkip ? (
              <Pressable
                onPress={() => handleAnswer(null)}
                style={{
                  flex: 1,
                  padding: 14,
                  borderRadius: 12,
                  alignItems: "center",
                  borderWidth: 1,
                  borderColor: "#ddd",
                  backgroundColor: "white",
                }}
              >
                <Text style={{ fontWeight: "700" }}>スキップ</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => handleAnswer(selectedMulti)}
              style={{
                flex: 1,
                padding: 14,
                borderRadius: 12,
                alignItems: "center",
                backgroundColor: selectedMulti.length ? "#333" : "#999",
              }}
            >
              <Text style={{ color: "white", fontWeight: "700" }}>{isSubmitting ? "保存中..." : "次へ"}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {currentQuestion.type === "tags" ? (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {tags.map((t) => (
              <Pressable
                key={t}
                onPress={() => removeTag(t)}
                style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 999, backgroundColor: "#eee" }}
              >
                <Text style={{ fontWeight: "700" }}>{t} ×</Text>
              </Pressable>
            ))}
          </View>

          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput
              placeholder={currentQuestion.placeholder}
              value={tagInput}
              onChangeText={setTagInput}
              style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
            />
            <Pressable
              onPress={() => addTag(tagInput)}
              style={{ padding: 12, borderRadius: 10, backgroundColor: "#333", justifyContent: "center" }}
            >
              <Text style={{ color: "white", fontWeight: "700" }}>追加</Text>
            </Pressable>
          </View>

          {currentQuestion.suggestions?.length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {currentQuestion.suggestions.slice(0, 8).map((s) => (
                <Pressable
                  key={s}
                  onPress={() => addTag(s)}
                  style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: "#ddd" }}
                >
                  <Text style={{ fontWeight: "700" }}>{s}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          <View style={{ flexDirection: "row", gap: 10 }}>
            {canSkip ? (
              <Pressable
                onPress={() => handleAnswer(null)}
                style={{
                  flex: 1,
                  padding: 14,
                  borderRadius: 12,
                  alignItems: "center",
                  borderWidth: 1,
                  borderColor: "#ddd",
                  backgroundColor: "white",
                }}
              >
                <Text style={{ fontWeight: "700" }}>スキップ</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => handleAnswer(tags)}
              style={{
                flex: 1,
                padding: 14,
                borderRadius: 12,
                alignItems: "center",
                backgroundColor: "#333",
              }}
            >
              <Text style={{ color: "white", fontWeight: "700" }}>{isSubmitting ? "保存中..." : "次へ"}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {currentQuestion.type === "custom_stats" ? (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={{ color: "#666", fontWeight: "700" }}>年齢</Text>
              <TextInput
                keyboardType="number-pad"
                placeholder="25"
                onChangeText={(v) => setAnswers((prev) => ({ ...prev, age: v }))}
                style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
              />
            </View>
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={{ color: "#666", fontWeight: "700" }}>職業</Text>
              <TextInput
                placeholder="会社員"
                onChangeText={(v) => setAnswers((prev) => ({ ...prev, occupation: v }))}
                style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
              />
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={{ color: "#666", fontWeight: "700" }}>身長 (cm)</Text>
              <TextInput
                keyboardType="number-pad"
                placeholder="170"
                onChangeText={(v) => setAnswers((prev) => ({ ...prev, height: v }))}
                style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
              />
            </View>
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={{ color: "#666", fontWeight: "700" }}>体重 (kg)</Text>
              <TextInput
                keyboardType="number-pad"
                placeholder="60"
                onChangeText={(v) => setAnswers((prev) => ({ ...prev, weight: v }))}
                style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
              />
            </View>
          </View>

          <Pressable
            onPress={() => handleAnswer("completed")}
            style={{
              backgroundColor: answers.age && answers.height && answers.weight ? "#333" : "#999",
              padding: 14,
              borderRadius: 12,
              alignItems: "center",
            }}
            disabled={!answers.age || !answers.height || !answers.weight}
          >
            <Text style={{ color: "white", fontWeight: "700" }}>次へ</Text>
          </Pressable>
        </View>
      ) : null}

      <Pressable
        onPress={() => {
          Alert.alert(
            "確認",
            "オンボーディングを中断しますか？（あとで設定から再開できます）",
            [
              { text: "続ける", style: "cancel" },
              { text: "中断", style: "destructive", onPress: () => router.replace("/login") },
            ]
          );
        }}
        style={{ marginTop: 20, alignItems: "center" }}
      >
        <Text style={{ color: "#999" }}>中断</Text>
      </Pressable>
    </ScrollView>
  );
}



