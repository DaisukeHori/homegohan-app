import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button, Card, SectionHeader } from "../../src/components/ui";
import { colors, spacing, radius, shadows } from "../../src/theme";
import { buildPhotoDishList } from "../../../../lib/meal-image";
import { cancelPendingMealImageJobs } from "../../../../lib/meal-image-jobs";
import { supabase } from "../../src/lib/supabase";
import { getApi } from "../../src/lib/api";

// ─── Types ───────────────────────────────────────────
type Step = "mode-select" | "capture" | "analyzing" | "result" | "select-date"
          | "fridge-result" | "health-result" | "weight-result" | "classify-failed";
type PhotoMode = "auto" | "meal" | "fridge" | "health_checkup" | "weight_scale";
type MealType = "breakfast" | "lunch" | "dinner" | "snack" | "midnight_snack";
type DishDetail = { name: string; role: string; cal?: number; calories_kcal?: number; protein?: number; carbs?: number; fat?: number; ingredient?: string };

interface FridgeIngredient {
  name: string;
  category: string;
  quantity: string;
  freshness: "fresh" | "good" | "expiring_soon" | "expired";
  daysRemaining: number;
}

interface HealthCheckupData {
  checkupDate?: string; facilityName?: string;
  height?: number; weight?: number; bmi?: number;
  bloodPressureSystolic?: number; bloodPressureDiastolic?: number;
  hemoglobin?: number; hba1c?: number; fastingGlucose?: number;
  totalCholesterol?: number; ldlCholesterol?: number; hdlCholesterol?: number; triglycerides?: number;
  ast?: number; alt?: number; gammaGtp?: number;
  creatinine?: number; egfr?: number; uricAcid?: number;
}

interface WeightScaleData {
  weight: number;
  bodyFat?: number;
  muscleMass?: number;
  confidence: number;
}

interface ClassificationCandidate {
  type: string;
  confidence: number;
}

// ─── Constants ───────────────────────────────────────
const PHOTO_MODES: Record<PhotoMode, { icon: keyof typeof Ionicons.glyphMap; label: string; description: string; color: string; bg: string }> = {
  auto:           { icon: "color-wand",    label: "オート",  description: "AIが写真の種類を自動判別",   color: colors.purple,  bg: colors.purpleLight },
  meal:           { icon: "restaurant",    label: "食事",    description: "食事の写真を記録",           color: colors.accent,  bg: colors.accentLight },
  fridge:         { icon: "snow",          label: "冷蔵庫",  description: "冷蔵庫の中身を登録",         color: colors.blue,    bg: colors.blueLight },
  health_checkup: { icon: "document-text", label: "健診",    description: "健康診断結果を読み取り",     color: colors.success, bg: colors.successLight },
  weight_scale:   { icon: "scale",         label: "体重計",  description: "体重計の写真を読み取り",     color: colors.warning, bg: colors.warningLight },
};

const PHOTO_MODE_COPY: Record<PhotoMode, { captureDescription: string; cameraLabel: string; galleryLabel: string; hint: string; analyzingTitle: string; analyzingDescription: string }> = {
  auto: {
    captureDescription: "AIが写真の種類を自動判別します。食事・冷蔵庫・健診結果・体重計のいずれかがはっきり写る写真を選んでください。",
    cameraLabel: "撮影する", galleryLabel: "写真を選ぶ",
    hint: "対象が1つに絞られた写真だと、オート判定が安定します。",
    analyzingTitle: "AIが写真の種類を確認中...", analyzingDescription: "画像の内容を見て、最適な解析モードを選んでいます",
  },
  meal: {
    captureDescription: "食事の写真を撮影してください。AIが料理を認識して栄養を推定します。",
    cameraLabel: "食事を撮影", galleryLabel: "食事写真を選ぶ",
    hint: "複数の料理がある場合は、それぞれ別の写真で撮影するとより正確に解析できます。",
    analyzingTitle: "AIが食事を解析中...", analyzingDescription: "料理を認識して栄養素を推定しています",
  },
  fridge: {
    captureDescription: "冷蔵庫の中や買ってきた食材を撮影してください。AIが食材と鮮度の目安を読み取ります。",
    cameraLabel: "冷蔵庫を撮影", galleryLabel: "冷蔵庫写真を選ぶ",
    hint: "棚全体と食材名が見えるように撮ると、食材の抽出精度が上がります。",
    analyzingTitle: "AIが冷蔵庫を解析中...", analyzingDescription: "写っている食材や鮮度の目安を読み取っています",
  },
  health_checkup: {
    captureDescription: "健康診断結果や検査票を撮影してください。AIが検査項目と数値を読み取ります。",
    cameraLabel: "健診結果を撮影", galleryLabel: "健診結果を選ぶ",
    hint: "紙全体が入り、文字や数値がぼやけていない写真を使うと読み取りが安定します。",
    analyzingTitle: "AIが健診結果を解析中...", analyzingDescription: "検査項目と数値を読み取っています",
  },
  weight_scale: {
    captureDescription: "体重計や体組成計のディスプレイを撮影してください。AIが表示値を読み取ります。",
    cameraLabel: "体重計を撮影", galleryLabel: "体重計写真を選ぶ",
    hint: "数字だけでなく単位や体脂肪率の表示も写るように撮ると、読み取り精度が安定します。",
    analyzingTitle: "AIが体重計を解析中...", analyzingDescription: "体重や体組成の表示値を読み取っています",
  },
};

const MEAL_CONFIG: Record<MealType, { icon: keyof typeof Ionicons.glyphMap; label: string; color: string; bg: string }> = {
  breakfast:      { icon: "sunny",        label: "朝食",   color: "#FF9800", bg: colors.warningLight },
  lunch:          { icon: "partly-sunny", label: "昼食",   color: colors.accent, bg: colors.accentLight },
  dinner:         { icon: "moon",         label: "夕食",   color: colors.purple, bg: colors.purpleLight },
  snack:          { icon: "cafe",         label: "おやつ", color: "#E91E63", bg: "#FCE4EC" },
  midnight_snack: { icon: "cloudy-night", label: "夜食",   color: colors.blue, bg: colors.blueLight },
};

const formatLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const getWeekStart = (date: Date): Date => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

const getWeekDates = (startDate: Date) => {
  const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    return { date: d, dayOfWeek: dayNames[d.getDay()], dateStr: formatLocalDate(d) };
  });
};

const getAutoMealType = (): MealType => {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return "breakfast";
  if (h >= 11 && h < 16) return "lunch";
  if (h >= 16 && h < 19) return "snack";
  if (h >= 19 && h < 22) return "dinner";
  return "midnight_snack";
};

const FRESHNESS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  fresh:         { label: "新鮮",   color: colors.success, bg: colors.successLight },
  good:          { label: "良好",   color: colors.blue,    bg: colors.blueLight },
  expiring_soon: { label: "早めに", color: colors.warning, bg: colors.warningLight },
  expired:       { label: "要確認", color: colors.accent,  bg: colors.accentLight },
};

const CATEGORY_EMOJI: Record<string, string> = {
  "野菜": "🥬", "肉類": "🥩", "魚介類": "🐟", "乳製品": "🧀", "果物": "🍎", "調味料": "🧂",
};

// ─── Component ───────────────────────────────────────
export default function MealNewPage() {
  const insets = useSafeAreaInsets();

  // Step & mode
  const [step, setStep] = useState<Step>("mode-select");
  const [photoMode, setPhotoMode] = useState<PhotoMode>("auto");
  const modeCopy = PHOTO_MODE_COPY[photoMode];

  // Photos
  const [photos, setPhotos] = useState<{ uri: string; base64: string; mimeType: string }[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // Meal result
  const [analyzedDishes, setAnalyzedDishes] = useState<DishDetail[]>([]);
  const [totalCalories, setTotalCalories] = useState(0);
  const [totalProtein, setTotalProtein] = useState(0);
  const [totalCarbs, setTotalCarbs] = useState(0);
  const [totalFat, setTotalFat] = useState(0);
  const [overallScore, setOverallScore] = useState(0);
  const [vegScore, setVegScore] = useState(0);
  const [praiseComment, setPraiseComment] = useState("");
  const [nutritionTip, setNutritionTip] = useState("");
  const [nutritionalAdvice, setNutritionalAdvice] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [nutrition, setNutrition] = useState<Record<string, number>>({});
  const [isSaving, setIsSaving] = useState(false);

  // Fridge result
  const [fridgeIngredients, setFridgeIngredients] = useState<FridgeIngredient[]>([]);
  const [fridgeSummary, setFridgeSummary] = useState("");
  const [fridgeSuggestions, setFridgeSuggestions] = useState<string[]>([]);
  const [isSavingFridge, setIsSavingFridge] = useState(false);

  // Health checkup result
  const [healthData, setHealthData] = useState<HealthCheckupData>({});
  const [healthConfidence, setHealthConfidence] = useState(0);
  const [healthNotes, setHealthNotes] = useState("");
  const [healthModelUsed, setHealthModelUsed] = useState("");
  const [isSavingHealth, setIsSavingHealth] = useState(false);

  // Weight result
  const [weightData, setWeightData] = useState<WeightScaleData | null>(null);
  const [previousWeight, setPreviousWeight] = useState<number | null>(null);
  const [isSavingWeight, setIsSavingWeight] = useState(false);

  // Classify failed
  const [detectedType, setDetectedType] = useState<string | null>(null);
  const [detectedConfidence, setDetectedConfidence] = useState(0);
  const [classificationCandidates, setClassificationCandidates] = useState<ClassificationCandidate[]>([]);

  // Date selection
  const [selectedDate, setSelectedDate] = useState(formatLocalDate(new Date()));
  const [selectedMealType, setSelectedMealType] = useState<MealType>(getAutoMealType());
  const [weekStart, setWeekStart] = useState(getWeekStart(new Date()));
  const weekDates = useMemo(() => getWeekDates(weekStart), [weekStart]);
  const todayStr = formatLocalDate(new Date());

  // ─── Photo helpers ─────────────────────────────────
  async function pickFromLibrary() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert("権限が必要です", "写真ライブラリへのアクセスを許可してください。"); return; }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsMultipleSelection: true, base64: true, quality: 0.8, selectionLimit: 4 });
    if (res.canceled) return;
    const items = (res.assets || []).filter((a) => !!a.base64).map((a) => ({ uri: a.uri, base64: a.base64 as string, mimeType: (a as any).mimeType ?? "image/jpeg" }));
    setPhotos((prev) => [...prev, ...items]);
  }

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { Alert.alert("権限が必要です", "カメラへのアクセスを許可してください。"); return; }
    try {
      const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.8 });
      if (res.canceled) return;
      const a = res.assets?.[0];
      if (!a?.base64) { Alert.alert("失敗", "画像の取得に失敗しました。"); return; }
      setPhotos((prev) => [...prev, { uri: a.uri, base64: a.base64 as string, mimeType: (a as any).mimeType ?? "image/jpeg" }]);
    } catch {
      Alert.alert("カメラが使用できません", "このデバイスではカメラが利用できません。「写真を選ぶ」をお試しください。");
    }
  }

  function removePhoto(index: number) { setPhotos((prev) => prev.filter((_, i) => i !== index)); }

  function resetAll() {
    setPhotos([]);
    setAnalyzedDishes([]); setTotalCalories(0); setTotalProtein(0); setTotalCarbs(0); setTotalFat(0);
    setOverallScore(0); setVegScore(0); setPraiseComment(""); setNutritionTip(""); setNutritionalAdvice("");
    setImageUrl(null); setNutrition({});
    setFridgeIngredients([]); setFridgeSummary(""); setFridgeSuggestions([]);
    setHealthData({}); setHealthConfidence(0); setHealthNotes(""); setHealthModelUsed("");
    setWeightData(null); setPreviousWeight(null);
    setDetectedType(null); setDetectedConfidence(0); setClassificationCandidates([]);
  }

  // ─── API calls ─────────────────────────────────────
  const images = () => photos.map((p) => ({ base64: p.base64, mimeType: p.mimeType }));

  async function analyzeMealPhoto(mealAnalysis?: any) {
    setStep("analyzing"); setIsAnalyzing(true);
    try {
      const api = getApi();
      const data = await api.post<any>("/api/ai/analyze-meal-photo", { images: images(), mealType: selectedMealType, prefetchedGeminiResult: mealAnalysis });
      setAnalyzedDishes(data.dishes || []);
      setTotalCalories(data.totalCalories || 0); setTotalProtein(data.totalProtein || 0);
      setTotalCarbs(data.totalCarbs || 0); setTotalFat(data.totalFat || 0);
      setOverallScore(data.overallScore || 75); setVegScore(data.vegScore || 50);
      setPraiseComment(data.praiseComment || ""); setNutritionTip(data.nutritionTip || "");
      setNutritionalAdvice(data.nutritionalAdvice || ""); setImageUrl(data.imageUrl ?? null);
      setNutrition(data.nutrition || {});
      setStep("result");
    } catch (e: any) {
      Alert.alert("解析失敗", e?.message ?? "解析に失敗しました。"); setStep("capture");
    } finally { setIsAnalyzing(false); }
  }

  async function analyzeFridge() {
    setStep("analyzing"); setIsAnalyzing(true);
    try {
      const api = getApi();
      const data = await api.post<any>("/api/ai/analyze-fridge", { images: images() });
      setFridgeIngredients(data.detailedIngredients || []);
      setFridgeSummary(data.summary || ""); setFridgeSuggestions(data.suggestions || []);
      setStep("fridge-result");
    } catch (e: any) {
      Alert.alert("解析失敗", e?.message ?? "冷蔵庫の解析に失敗しました。"); setStep("capture");
    } finally { setIsAnalyzing(false); }
  }

  async function analyzeHealthCheckup() {
    setStep("analyzing"); setIsAnalyzing(true);
    try {
      const api = getApi();
      const data = await api.post<any>("/api/ai/analyze-health-checkup", { imageBase64: photos[0].base64, mimeType: photos[0].mimeType });
      setHealthData(data.extractedData || {}); setHealthConfidence(data.confidence || 0);
      setHealthNotes(data.notes || ""); setHealthModelUsed(data.modelUsed || "");
      setStep("health-result");
    } catch (e: any) {
      Alert.alert("解析失敗", e?.message ?? "健康診断結果の解析に失敗しました。"); setStep("capture");
    } finally { setIsAnalyzing(false); }
  }

  async function analyzeWeightScale() {
    setStep("analyzing"); setIsAnalyzing(true);
    try {
      const api = getApi();
      const data = await api.post<any>("/api/ai/analyze-weight-scale", { image: photos[0].base64, mimeType: photos[0].mimeType });
      setWeightData(data);
      // Fetch history for comparison
      try {
        const history = await api.get<any[]>("/api/health/records/history?days=7");
        if (history && history.length > 0) setPreviousWeight(history[history.length - 1].weight);
      } catch { /* ignore */ }
      setStep("weight-result");
    } catch (e: any) {
      Alert.alert("解析失敗", e?.message ?? "体重計の読み取りに失敗しました。"); setStep("capture");
    } finally { setIsAnalyzing(false); }
  }

  async function analyzeResolvedMode(mode: string, mealAnalysis?: any) {
    switch (mode) {
      case "fridge": await analyzeFridge(); break;
      case "health_checkup": await analyzeHealthCheckup(); break;
      case "weight_scale": await analyzeWeightScale(); break;
      case "meal": default: await analyzeMealPhoto(mealAnalysis); break;
    }
  }

  async function analyzeByMode() {
    if (photos.length === 0) return;

    if (photoMode === "auto") {
      setStep("analyzing"); setIsAnalyzing(true);
      try {
        const api = getApi();
        const data = await api.post<any>("/api/ai/classify-photo", {
          images: images(), includeMealAnalysis: true, mealType: selectedMealType,
        });
        setIsAnalyzing(false);
        setDetectedType(data.type); setDetectedConfidence(data.confidence);
        setClassificationCandidates(Array.isArray(data.candidates) ? data.candidates : []);

        const validTypes = ["meal", "fridge", "health_checkup", "weight_scale"];
        const resolvedType = validTypes.includes(data.type) && data.confidence >= 0.6 ? data.type : null;
        if (!resolvedType) { setStep("classify-failed"); return; }
        await analyzeResolvedMode(resolvedType, data.mealAnalysis);
      } catch (e: any) {
        setIsAnalyzing(false);
        Alert.alert("判別失敗", e?.message ?? "写真の判別に失敗しました。"); setStep("capture");
      }
    } else {
      await analyzeResolvedMode(photoMode);
    }
  }

  // ─── Save functions ────────────────────────────────
  async function saveFridgeItems(mode: "append" | "replace") {
    setIsSavingFridge(true);
    try {
      const api = getApi();
      const data = await api.post<any>("/api/pantry/from-photo", {
        ingredients: fridgeIngredients.map((i) => ({ name: i.name, amount: i.quantity, category: i.category, daysRemaining: i.daysRemaining })),
        mode,
      });
      Alert.alert("保存完了", `冷蔵庫に${data.results.created + data.results.updated}件の食材を保存しました。`);
      router.push("/menus/weekly");
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally { setIsSavingFridge(false); }
  }

  async function saveHealthCheckup() {
    setIsSavingHealth(true);
    try {
      const api = getApi();
      await api.post("/api/health/checkups", {
        checkup_date: healthData.checkupDate || new Date().toISOString().split("T")[0],
        facility_name: healthData.facilityName, height: healthData.height, weight: healthData.weight, bmi: healthData.bmi,
        blood_pressure_systolic: healthData.bloodPressureSystolic, blood_pressure_diastolic: healthData.bloodPressureDiastolic,
        hemoglobin: healthData.hemoglobin, hba1c: healthData.hba1c, fasting_glucose: healthData.fastingGlucose,
        total_cholesterol: healthData.totalCholesterol, ldl_cholesterol: healthData.ldlCholesterol,
        hdl_cholesterol: healthData.hdlCholesterol, triglycerides: healthData.triglycerides,
        ast: healthData.ast, alt: healthData.alt, gamma_gtp: healthData.gammaGtp,
        creatinine: healthData.creatinine, egfr: healthData.egfr, uric_acid: healthData.uricAcid,
        ocr_extracted_data: healthData, ocr_extraction_timestamp: new Date().toISOString(), ocr_model_used: healthModelUsed,
      });
      Alert.alert("保存完了", "健康診断結果を保存しました。");
      router.push("/health/blood-tests");
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally { setIsSavingHealth(false); }
  }

  async function saveWeightRecord() {
    if (!weightData) return;
    setIsSavingWeight(true);
    try {
      const api = getApi();
      await api.post("/api/health/records/quick", {
        weight: weightData.weight, bodyFat: weightData.bodyFat, muscleMass: weightData.muscleMass,
        recordedAt: new Date().toISOString(), source: "photo",
      });
      Alert.alert("保存完了", "体重を記録しました。");
      setStep("mode-select"); resetAll();
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally { setIsSavingWeight(false); }
  }

  async function saveToMealPlan() {
    setIsSaving(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) throw new Error("Unauthorized");

      let dailyMealId: string;
      const { data: existingDay, error: dayFindError } = await supabase.from("user_daily_meals").select("id").eq("user_id", auth.user.id).eq("day_date", selectedDate).maybeSingle();
      if (dayFindError) throw dayFindError;

      if (existingDay?.id) { dailyMealId = existingDay.id; } else {
        const { data: newDay, error: dayError } = await supabase.from("user_daily_meals").insert({ user_id: auth.user.id, day_date: selectedDate, is_cheat_day: false }).select("id").single();
        if (dayError || !newDay) throw dayError ?? new Error("Failed to create daily meal");
        dailyMealId = newDay.id;
      }

      const { data: existingMeals, error: existingMealsError } = await supabase.from("planned_meals").select("id").eq("daily_meal_id", dailyMealId).eq("meal_type", selectedMealType);
      if (existingMealsError) throw existingMealsError;

      if (Array.isArray(existingMeals) && existingMeals.length > 0) {
        await Promise.all(existingMeals.map((meal) => cancelPendingMealImageJobs({ supabase, plannedMealId: meal.id, reason: "photo overwrite" }).catch(() => {})));
      }
      await supabase.from("planned_meals").delete().eq("daily_meal_id", dailyMealId).eq("meal_type", selectedMealType);

      const baseDishPayloads = (analyzedDishes ?? []).map((d) => ({
        name: d.name, role: d.role ?? "side", ingredient: d.ingredient ?? null,
        calories_kcal: typeof d.cal === "number" ? d.cal : d.calories_kcal ?? null,
        protein_g: d.protein ?? null, carbs_g: d.carbs ?? null, fat_g: d.fat ?? null,
      }));
      const photoDishes = buildPhotoDishList(baseDishPayloads, imageUrl);
      const allDishNames = photoDishes.map((d) => (typeof d.name === "string" ? d.name.trim() : "")).filter(Boolean).join("、") || "写真から入力";

      const n = nutrition || {};
      const { data: newMeal, error: mealError } = await supabase.from("planned_meals").insert({
        daily_meal_id: dailyMealId, meal_type: selectedMealType, mode: "cook", dish_name: allDishNames,
        description: nutritionalAdvice || null, calories_kcal: totalCalories || null,
        protein_g: totalProtein || null, carbs_g: totalCarbs || null, fat_g: totalFat || null,
        sodium_g: n.sodiumG ?? null, sugar_g: n.sugarG ?? null, fiber_g: n.fiberG ?? null,
        potassium_mg: n.potassiumMg ?? null, calcium_mg: n.calciumMg ?? null,
        iron_mg: n.ironMg ?? null, zinc_mg: n.zincMg ?? null,
        vitamin_c_mg: n.vitaminCMg ?? null, vitamin_a_ug: n.vitaminAUg ?? null,
        vitamin_d_ug: n.vitaminDUg ?? null, vitamin_b1_mg: n.vitaminB1Mg ?? null,
        vitamin_b2_mg: n.vitaminB2Mg ?? null, vitamin_b6_mg: n.vitaminB6Mg ?? null,
        vitamin_b12_ug: n.vitaminB12Ug ?? null, folic_acid_ug: n.folicAcidUg ?? null,
        vitamin_k_ug: n.vitaminKUg ?? null, vitamin_e_mg: n.vitaminEMg ?? null,
        cholesterol_mg: n.cholesterolMg ?? null, iodine_ug: n.iodineUg ?? null,
        phosphorus_mg: n.phosphorusMg ?? null,
        veg_score: vegScore ?? null, image_url: imageUrl ?? null,
        is_completed: false, dishes: photoDishes.length ? photoDishes : null, is_simple: photoDishes.length <= 1,
      }).select("id").single();

      if (mealError || !newMeal) throw mealError ?? new Error("Failed to create planned meal");
      router.replace(`/meals/${newMeal.id}`);
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally { setIsSaving(false); }
  }

  // ─── Header title ──────────────────────────────────
  const headerTitle = useMemo(() => {
    switch (step) {
      case "mode-select": return "モード選択";
      case "capture": return photoMode === "meal" ? "食事を撮影" : photoMode === "fridge" ? "冷蔵庫を撮影" : photoMode === "health_checkup" ? "健診結果を撮影" : photoMode === "weight_scale" ? "体重計を撮影" : "写真を撮影";
      case "analyzing": return modeCopy.analyzingTitle;
      case "result": return "解析結果";
      case "select-date": return "日時を選択";
      case "fridge-result": return "冷蔵庫の中身";
      case "health-result": return "健康診断結果";
      case "weight-result": return "体重計読み取り結果";
      case "classify-failed": return "判別できませんでした";
    }
  }, [step, photoMode, modeCopy]);

  const handleBack = () => {
    if (step === "mode-select") { router.back(); }
    else if (step === "capture") { setStep("mode-select"); }
    else if (step === "result") { setStep("capture"); resetAll(); }
    else if (step === "select-date") { setStep("result"); }
    else { setStep("mode-select"); resetAll(); }
  };

  // ─── Render ────────────────────────────────────────
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Header */}
      <View style={{
        flexDirection: "row", alignItems: "center", gap: spacing.md,
        paddingTop: insets.top + 8, paddingBottom: spacing.sm, paddingHorizontal: spacing.lg,
        backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border,
      }}>
        <Pressable onPress={handleBack} hitSlop={12}>
          <Ionicons name="close" size={22} color={colors.textLight} />
        </Pressable>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm, justifyContent: "center" }}>
          <Ionicons name="camera" size={18} color={colors.accent} />
          <Text style={{ fontSize: 16, fontWeight: "600", color: colors.text }}>{headerTitle}</Text>
        </View>
        <View style={{ width: 22 }} />
      </View>

      {/* ─── Step: mode-select ─── */}
      {step === "mode-select" && (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
          <Text style={{ fontSize: 13, color: colors.textMuted, textAlign: "center" }}>撮影するものを選んでください</Text>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
            {(Object.entries(PHOTO_MODES) as [PhotoMode, typeof PHOTO_MODES.auto][]).map(([mode, config]) => {
              const isSelected = photoMode === mode;
              return (
                <Pressable key={mode} onPress={() => setPhotoMode(mode)} style={{
                  width: "47%", padding: spacing.md, borderRadius: radius.lg, alignItems: "center", gap: spacing.sm,
                  backgroundColor: isSelected ? config.bg : colors.card,
                  borderWidth: isSelected ? 2 : 1, borderColor: isSelected ? config.color : colors.border,
                }}>
                  <View style={{ width: 48, height: 48, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: isSelected ? config.color : colors.bg }}>
                    <Ionicons name={config.icon} size={24} color={isSelected ? "#fff" : config.color} />
                  </View>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: isSelected ? config.color : colors.text }}>{config.label}</Text>
                  <Text style={{ fontSize: 10, color: colors.textMuted, textAlign: "center" }}>{config.description}</Text>
                </Pressable>
              );
            })}
          </View>

          <Button onPress={() => setStep("capture")} style={{ backgroundColor: PHOTO_MODES[photoMode].color }}>
            撮影へ進む
          </Button>
        </ScrollView>
      )}

      {/* ─── Step: capture ─── */}
      {step === "capture" && (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
          <Text style={{ fontSize: 13, color: colors.textMuted, textAlign: "center" }}>{modeCopy.captureDescription}</Text>

          {photos.length > 0 ? (
            <View style={{ gap: spacing.md }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text }}>選択した写真 ({photos.length}枚)</Text>
                <Pressable onPress={() => setPhotos([])}><Text style={{ fontSize: 12, color: colors.accent }}>すべて削除</Text></Pressable>
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
                {photos.map((p, i) => (
                  <Pressable key={`${p.uri}-${i}`} onPress={() => removePhoto(i)} style={{ position: "relative" }}>
                    <Image source={{ uri: p.uri }} style={{ width: 100, height: 100, borderRadius: radius.md }} />
                    <View style={{ position: "absolute", top: 4, right: 4, width: 22, height: 22, borderRadius: 11, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center" }}>
                      <Ionicons name="close" size={14} color="#fff" />
                    </View>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : (
            <View style={{ flexDirection: "row", gap: spacing.md }}>
              <Pressable onPress={takePhoto} style={({ pressed }) => ({
                flex: 1, padding: spacing.xl, borderRadius: radius.lg, alignItems: "center", gap: spacing.sm,
                backgroundColor: colors.card, borderWidth: 2, borderStyle: "dashed", borderColor: colors.border, opacity: pressed ? 0.9 : 1,
              })}>
                <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.accentLight, alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="camera" size={28} color={colors.accent} />
                </View>
                <Text style={{ fontSize: 14, fontWeight: "500", color: colors.text }}>{modeCopy.cameraLabel}</Text>
              </Pressable>
              <Pressable onPress={pickFromLibrary} style={({ pressed }) => ({
                flex: 1, padding: spacing.xl, borderRadius: radius.lg, alignItems: "center", gap: spacing.sm,
                backgroundColor: colors.card, borderWidth: 2, borderStyle: "dashed", borderColor: colors.border, opacity: pressed ? 0.9 : 1,
              })}>
                <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.blueLight, alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="images" size={28} color={colors.blue} />
                </View>
                <Text style={{ fontSize: 14, fontWeight: "500", color: colors.text }}>{modeCopy.galleryLabel}</Text>
              </Pressable>
            </View>
          )}

          {photos.length > 0 && (
            <Button onPress={analyzeByMode} style={{ backgroundColor: PHOTO_MODES[photoMode].color }}>
              {photoMode === "auto" ? "AIが判別して解析" : photos.length > 1 ? `${photos.length}枚をAIで解析` : "AIで解析する"}
            </Button>
          )}

          <View style={{ padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.blueLight }}>
            <Text style={{ fontSize: 12, color: colors.blue }}>💡 ヒント: {modeCopy.hint}</Text>
          </View>
        </ScrollView>
      )}

      {/* ─── Step: analyzing ─── */}
      {step === "analyzing" && (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg, gap: spacing.lg }}>
          {photos.length > 0 && (
            <View style={{ position: "relative" }}>
              <Image source={{ uri: photos[0].uri }} style={{ width: 220, height: 220, borderRadius: radius.lg, opacity: 0.8 }} />
              {photos.length > 1 && (
                <View style={{ position: "absolute", bottom: 8, right: 8, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: "rgba(0,0,0,0.6)" }}>
                  <Text style={{ fontSize: 11, color: "#fff" }}>+{photos.length - 1}枚</Text>
                </View>
              )}
            </View>
          )}
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={{ fontSize: 16, fontWeight: "600", color: colors.text }}>{modeCopy.analyzingTitle}</Text>
          <Text style={{ fontSize: 13, color: colors.textMuted }}>{modeCopy.analyzingDescription}</Text>
        </View>
      )}

      {/* ─── Step: result (meal) ─── */}
      {step === "result" && (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
          {/* Score */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.successLight }}>
            <View style={{ width: 56, height: 56, borderRadius: radius.lg, alignItems: "center", justifyContent: "center", backgroundColor: overallScore >= 85 ? colors.success : overallScore >= 70 ? colors.warning : colors.accent }}>
              <Text style={{ fontSize: 22, fontWeight: "800", color: "#fff" }}>{overallScore}</Text>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 16, fontWeight: "700", color: overallScore >= 85 ? colors.success : overallScore >= 70 ? "#B8860B" : colors.accent }}>
                {overallScore >= 90 ? "素晴らしい！🎉" : overallScore >= 80 ? "いいね！👍" : overallScore >= 70 ? "グッド！😊" : "記録しました！"}
              </Text>
              <Text style={{ fontSize: 13, color: colors.textLight }}>
                {analyzedDishes.length > 0 ? analyzedDishes[0].name : "食事"}{analyzedDishes.length > 1 ? ` 他${analyzedDishes.length - 1}品` : ""}
              </Text>
            </View>
          </View>

          {/* Praise comment */}
          {praiseComment ? (
            <View style={{ padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.accentLight }}>
              <Text style={{ fontSize: 12, fontWeight: "600", color: colors.accent, marginBottom: 4 }}>記録コメント</Text>
              <Text style={{ fontSize: 13, color: colors.text, lineHeight: 20 }}>{praiseComment}</Text>
            </View>
          ) : null}

          {/* Nutrition grid */}
          <View style={{ flexDirection: "row", gap: spacing.xs }}>
            {[
              { label: "カロリー", value: totalCalories, unit: "kcal", color: colors.accent },
              { label: "タンパク質", value: totalProtein, unit: "g", color: colors.blue },
              { label: "炭水化物", value: totalCarbs, unit: "g", color: colors.warning },
              { label: "脂質", value: totalFat, unit: "g", color: colors.purple },
              { label: "野菜", value: vegScore, unit: "点", color: colors.success },
            ].map((n, i) => (
              <View key={i} style={{ flex: 1, padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.bg, alignItems: "center" }}>
                <Text style={{ fontSize: 9, color: colors.textMuted }}>{n.label}</Text>
                <Text style={{ fontSize: 14, fontWeight: "700", color: n.color }}>{n.value}</Text>
                <Text style={{ fontSize: 9, color: colors.textMuted }}>{n.unit}</Text>
              </View>
            ))}
          </View>

          {/* Nutrition tip */}
          {nutritionTip ? (
            <View style={{ padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.warningLight, flexDirection: "row", gap: spacing.sm }}>
              <Text style={{ fontSize: 14 }}>💡</Text>
              <Text style={{ fontSize: 11, color: colors.text, flex: 1, lineHeight: 16 }}>
                <Text style={{ fontWeight: "600", color: colors.warning }}>栄養メモ: </Text>{nutritionTip}
              </Text>
            </View>
          ) : null}

          {/* Detected dishes */}
          <View style={{ gap: spacing.sm }}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: colors.textLight }}>検出された料理</Text>
            {analyzedDishes.map((dish, idx) => (
              <View key={idx} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.card }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <View style={{ width: 36, height: 36, borderRadius: 8, backgroundColor: colors.successLight, alignItems: "center", justifyContent: "center" }}>
                    <Ionicons name="restaurant" size={16} color={colors.success} />
                  </View>
                  <View>
                    <Text style={{ fontSize: 14, fontWeight: "500", color: colors.text }}>{dish.name}</Text>
                    <Text style={{ fontSize: 11, color: colors.textMuted }}>{dish.role === "main" ? "主菜" : dish.role === "side" ? "副菜" : dish.role === "soup" ? "汁物" : dish.role === "rice" ? "ご飯" : "おかず"}</Text>
                  </View>
                </View>
                <Text style={{ fontSize: 13, color: colors.textLight }}>{dish.cal ?? dish.calories_kcal ?? 0} kcal</Text>
              </View>
            ))}
          </View>

          <Button onPress={() => setStep("select-date")} style={{ backgroundColor: colors.accent }}>
            日時を選んで保存
          </Button>
          <Pressable onPress={() => { setStep("capture"); resetAll(); }} style={{ padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.bg, alignItems: "center" }}>
            <Text style={{ fontSize: 14, color: colors.textLight }}>撮り直す</Text>
          </Pressable>
        </ScrollView>
      )}

      {/* ─── Step: select-date ─── */}
      {step === "select-date" && (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
          <Text style={{ fontSize: 13, color: colors.textMuted }}>この食事をいつの献立として保存しますか？</Text>

          {/* Week navigation */}
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Pressable onPress={() => { const d = new Date(weekStart); d.setDate(d.getDate() - 7); setWeekStart(d); }} style={{ padding: spacing.sm, borderRadius: 8, backgroundColor: colors.bg }}>
              <Ionicons name="chevron-back" size={20} color={colors.textLight} />
            </Pressable>
            <Text style={{ fontSize: 14, fontWeight: "500", color: colors.text }}>
              {weekDates[0]?.date.getMonth() + 1}/{weekDates[0]?.date.getDate()} - {weekDates[6]?.date.getMonth() + 1}/{weekDates[6]?.date.getDate()}
            </Text>
            <Pressable onPress={() => { const d = new Date(weekStart); d.setDate(d.getDate() + 7); setWeekStart(d); }} style={{ padding: spacing.sm, borderRadius: 8, backgroundColor: colors.bg }}>
              <Ionicons name="chevron-forward" size={20} color={colors.textLight} />
            </Pressable>
          </View>

          {/* Day pills */}
          <View style={{ flexDirection: "row", gap: 4 }}>
            {weekDates.map((day) => {
              const isSelected = day.dateStr === selectedDate;
              const isToday = day.dateStr === todayStr;
              const isWeekend = day.date.getDay() === 0 || day.date.getDay() === 6;
              return (
                <Pressable key={day.dateStr} onPress={() => setSelectedDate(day.dateStr)} style={{
                  flex: 1, alignItems: "center", gap: 2, paddingVertical: spacing.sm, borderRadius: radius.md,
                  backgroundColor: isSelected ? colors.accent : colors.card,
                  borderWidth: isToday && !isSelected ? 2 : 1, borderColor: isToday && !isSelected ? colors.accent : colors.border,
                }}>
                  <Text style={{ fontSize: 10, color: isSelected ? "rgba(255,255,255,0.7)" : colors.textMuted }}>{day.date.getDate()}</Text>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: isSelected ? "#fff" : isWeekend ? colors.accent : colors.text }}>{day.dayOfWeek}</Text>
                </Pressable>
              );
            })}
          </View>

          {/* Meal type selection */}
          <Text style={{ fontSize: 13, fontWeight: "500", color: colors.text }}>食事タイプ</Text>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            {(["breakfast", "lunch", "dinner"] as MealType[]).map((type) => {
              const config = MEAL_CONFIG[type];
              const isSelected = type === selectedMealType;
              return (
                <Pressable key={type} onPress={() => setSelectedMealType(type)} style={{
                  flex: 1, padding: spacing.sm, borderRadius: radius.md, alignItems: "center", gap: 4,
                  backgroundColor: isSelected ? config.bg : colors.card, borderWidth: isSelected ? 2 : 1, borderColor: isSelected ? config.color : colors.border,
                }}>
                  <Ionicons name={config.icon} size={22} color={isSelected ? config.color : colors.textMuted} />
                  <Text style={{ fontSize: 13, fontWeight: "500", color: isSelected ? config.color : colors.textLight }}>{config.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            {(["snack", "midnight_snack"] as MealType[]).map((type) => {
              const config = MEAL_CONFIG[type];
              const isSelected = type === selectedMealType;
              return (
                <Pressable key={type} onPress={() => setSelectedMealType(type)} style={{
                  flex: 1, padding: spacing.sm, borderRadius: radius.md, alignItems: "center", gap: 4,
                  backgroundColor: isSelected ? config.bg : colors.card, borderWidth: isSelected ? 2 : 1, borderColor: isSelected ? config.color : colors.border,
                }}>
                  <Ionicons name={config.icon} size={22} color={isSelected ? config.color : colors.textMuted} />
                  <Text style={{ fontSize: 13, fontWeight: "500", color: isSelected ? config.color : colors.textLight }}>{config.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {/* Summary */}
          <View style={{ padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.card }}>
            <Text style={{ fontSize: 12, color: colors.textMuted, marginBottom: 4 }}>保存先</Text>
            <Text style={{ fontSize: 16, fontWeight: "600", color: colors.text }}>
              {new Date(selectedDate).getMonth() + 1}月{new Date(selectedDate).getDate()}日（{weekDates.find((d) => d.dateStr === selectedDate)?.dayOfWeek}）の{MEAL_CONFIG[selectedMealType].label}
            </Text>
          </View>

          <Button onPress={saveToMealPlan} loading={isSaving} disabled={isSaving} style={{ backgroundColor: colors.success }}>
            {isSaving ? "保存中..." : "献立表に保存"}
          </Button>
          <Pressable onPress={() => setStep("result")} style={{ padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.bg, alignItems: "center" }}>
            <Text style={{ fontSize: 14, color: colors.textLight }}>戻る</Text>
          </Pressable>
        </ScrollView>
      )}

      {/* ─── Step: fridge-result ─── */}
      {step === "fridge-result" && (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
          {photos.length > 0 && <Image source={{ uri: photos[0].uri }} style={{ width: "100%", height: 120, borderRadius: radius.lg }} />}

          {fridgeSummary ? (
            <View style={{ padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.blueLight, flexDirection: "row", gap: spacing.sm }}>
              <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="snow" size={16} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, fontWeight: "600", color: colors.blue, marginBottom: 4 }}>冷蔵庫の中身</Text>
                <Text style={{ fontSize: 13, color: colors.text, lineHeight: 20 }}>{fridgeSummary}</Text>
              </View>
            </View>
          ) : null}

          <Text style={{ fontSize: 13, fontWeight: "600", color: colors.textLight }}>検出された食材 ({fridgeIngredients.length}件)</Text>
          {fridgeIngredients.map((item, idx) => {
            const fc = FRESHNESS_CONFIG[item.freshness] || FRESHNESS_CONFIG.expired;
            return (
              <View key={idx} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.card }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <View style={{ width: 36, height: 36, borderRadius: 8, backgroundColor: fc.bg, alignItems: "center", justifyContent: "center" }}>
                    <Text style={{ fontSize: 18 }}>{CATEGORY_EMOJI[item.category] || "🍴"}</Text>
                  </View>
                  <View>
                    <Text style={{ fontSize: 14, fontWeight: "500", color: colors.text }}>{item.name}</Text>
                    <Text style={{ fontSize: 11, color: colors.textMuted }}>{item.quantity} • {item.category}</Text>
                  </View>
                </View>
                <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: fc.bg }}>
                  <Text style={{ fontSize: 10, color: fc.color }}>{fc.label}</Text>
                </View>
              </View>
            );
          })}

          {fridgeSuggestions.length > 0 && (
            <View style={{ padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.purpleLight }}>
              <Text style={{ fontSize: 12, fontWeight: "600", color: colors.purple, marginBottom: 8 }}>💡 この食材で作れる料理</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
                {fridgeSuggestions.map((s, idx) => (
                  <View key={idx} style={{ backgroundColor: colors.card, padding: 6, borderRadius: 6 }}>
                    <Text style={{ fontSize: 12, color: colors.text }}>{s}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <Button onPress={() => saveFridgeItems("append")} loading={isSavingFridge} disabled={isSavingFridge} style={{ flex: 1, backgroundColor: colors.blue }}>追記する</Button>
            <Button onPress={() => saveFridgeItems("replace")} loading={isSavingFridge} disabled={isSavingFridge} style={{ flex: 1, backgroundColor: colors.accent }}>入れ替える</Button>
          </View>
          <Pressable onPress={() => { setStep("mode-select"); resetAll(); }} style={{ padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.bg, alignItems: "center" }}>
            <Text style={{ fontSize: 14, color: colors.textLight }}>やり直す</Text>
          </Pressable>
        </ScrollView>
      )}

      {/* ─── Step: health-result ─── */}
      {step === "health-result" && (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
          {photos.length > 0 && (
            <View style={{ position: "relative" }}>
              <Image source={{ uri: photos[0].uri }} style={{ width: "100%", height: 120, borderRadius: radius.lg }} />
              {healthConfidence > 0 && (
                <View style={{ position: "absolute", bottom: 8, right: 8, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: "rgba(0,0,0,0.6)" }}>
                  <Text style={{ fontSize: 10, color: "#fff" }}>読み取り精度: {Math.round(healthConfidence * 100)}%</Text>
                </View>
              )}
            </View>
          )}

          {healthNotes ? (
            <View style={{ padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.warningLight, flexDirection: "row", gap: spacing.sm }}>
              <Ionicons name="alert-circle" size={16} color={colors.warning} />
              <Text style={{ fontSize: 11, color: colors.text, flex: 1 }}>{healthNotes}</Text>
            </View>
          ) : null}

          {/* Body measurements */}
          {(healthData.height || healthData.weight || healthData.bmi) && (
            <Card><View style={{ gap: spacing.sm }}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: colors.textMuted }}>身体測定</Text>
              <View style={{ flexDirection: "row", gap: spacing.sm }}>
                {healthData.height && <View style={{ flex: 1, alignItems: "center" }}><Text style={{ fontSize: 16, fontWeight: "700", color: colors.text }}>{healthData.height}</Text><Text style={{ fontSize: 10, color: colors.textMuted }}>身長 cm</Text></View>}
                {healthData.weight && <View style={{ flex: 1, alignItems: "center" }}><Text style={{ fontSize: 16, fontWeight: "700", color: colors.text }}>{healthData.weight}</Text><Text style={{ fontSize: 10, color: colors.textMuted }}>体重 kg</Text></View>}
                {healthData.bmi && <View style={{ flex: 1, alignItems: "center" }}><Text style={{ fontSize: 16, fontWeight: "700", color: colors.text }}>{healthData.bmi}</Text><Text style={{ fontSize: 10, color: colors.textMuted }}>BMI</Text></View>}
              </View>
            </View></Card>
          )}

          {/* Blood pressure */}
          {(healthData.bloodPressureSystolic || healthData.bloodPressureDiastolic) && (
            <Card><View style={{ gap: spacing.sm }}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: colors.textMuted }}>血圧</Text>
              <Text style={{ fontSize: 18, fontWeight: "700", color: colors.text, textAlign: "center" }}>{healthData.bloodPressureSystolic || "-"} / {healthData.bloodPressureDiastolic || "-"} mmHg</Text>
            </View></Card>
          )}

          {/* Blood sugar */}
          {(healthData.hba1c || healthData.fastingGlucose) && (
            <Card><View style={{ gap: spacing.sm }}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: colors.textMuted }}>血糖</Text>
              <View style={{ flexDirection: "row", gap: spacing.sm }}>
                {healthData.hba1c && <View style={{ flex: 1, alignItems: "center" }}><Text style={{ fontSize: 16, fontWeight: "700", color: colors.text }}>{healthData.hba1c}</Text><Text style={{ fontSize: 10, color: colors.textMuted }}>HbA1c %</Text></View>}
                {healthData.fastingGlucose && <View style={{ flex: 1, alignItems: "center" }}><Text style={{ fontSize: 16, fontWeight: "700", color: colors.text }}>{healthData.fastingGlucose}</Text><Text style={{ fontSize: 10, color: colors.textMuted }}>空腹時血糖</Text></View>}
              </View>
            </View></Card>
          )}

          {/* Lipids */}
          {(healthData.ldlCholesterol || healthData.hdlCholesterol || healthData.triglycerides || healthData.totalCholesterol) && (
            <Card><View style={{ gap: spacing.sm }}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: colors.textMuted }}>脂質</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
                {healthData.ldlCholesterol && <View style={{ width: "45%", alignItems: "center" }}><Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>{healthData.ldlCholesterol}</Text><Text style={{ fontSize: 9, color: colors.textMuted }}>LDL</Text></View>}
                {healthData.hdlCholesterol && <View style={{ width: "45%", alignItems: "center" }}><Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>{healthData.hdlCholesterol}</Text><Text style={{ fontSize: 9, color: colors.textMuted }}>HDL</Text></View>}
                {healthData.triglycerides && <View style={{ width: "45%", alignItems: "center" }}><Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>{healthData.triglycerides}</Text><Text style={{ fontSize: 9, color: colors.textMuted }}>中性脂肪</Text></View>}
                {healthData.totalCholesterol && <View style={{ width: "45%", alignItems: "center" }}><Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>{healthData.totalCholesterol}</Text><Text style={{ fontSize: 9, color: colors.textMuted }}>総コレステロール</Text></View>}
              </View>
            </View></Card>
          )}

          {/* Liver */}
          {(healthData.ast || healthData.alt || healthData.gammaGtp) && (
            <Card><View style={{ gap: spacing.sm }}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: colors.textMuted }}>肝機能</Text>
              <View style={{ flexDirection: "row", gap: spacing.sm }}>
                {healthData.ast && <View style={{ flex: 1, alignItems: "center" }}><Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>{healthData.ast}</Text><Text style={{ fontSize: 9, color: colors.textMuted }}>AST</Text></View>}
                {healthData.alt && <View style={{ flex: 1, alignItems: "center" }}><Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>{healthData.alt}</Text><Text style={{ fontSize: 9, color: colors.textMuted }}>ALT</Text></View>}
                {healthData.gammaGtp && <View style={{ flex: 1, alignItems: "center" }}><Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>{healthData.gammaGtp}</Text><Text style={{ fontSize: 9, color: colors.textMuted }}>γ-GTP</Text></View>}
              </View>
            </View></Card>
          )}

          {/* Kidney */}
          {(healthData.creatinine || healthData.egfr || healthData.uricAcid) && (
            <Card><View style={{ gap: spacing.sm }}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: colors.textMuted }}>腎機能</Text>
              <View style={{ flexDirection: "row", gap: spacing.sm }}>
                {healthData.creatinine && <View style={{ flex: 1, alignItems: "center" }}><Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>{healthData.creatinine}</Text><Text style={{ fontSize: 9, color: colors.textMuted }}>クレアチニン</Text></View>}
                {healthData.egfr && <View style={{ flex: 1, alignItems: "center" }}><Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>{healthData.egfr}</Text><Text style={{ fontSize: 9, color: colors.textMuted }}>eGFR</Text></View>}
                {healthData.uricAcid && <View style={{ flex: 1, alignItems: "center" }}><Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>{healthData.uricAcid}</Text><Text style={{ fontSize: 9, color: colors.textMuted }}>尿酸</Text></View>}
              </View>
            </View></Card>
          )}

          <Button onPress={saveHealthCheckup} loading={isSavingHealth} disabled={isSavingHealth} style={{ backgroundColor: colors.success }}>
            {isSavingHealth ? "保存中..." : "健康診断記録を保存"}
          </Button>
          <Pressable onPress={() => { setStep("mode-select"); resetAll(); }} style={{ padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.bg, alignItems: "center" }}>
            <Text style={{ fontSize: 14, color: colors.textLight }}>やり直す</Text>
          </Pressable>
        </ScrollView>
      )}

      {/* ─── Step: weight-result ─── */}
      {step === "weight-result" && weightData && (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
          {/* Confidence badge */}
          <View style={{ alignItems: "center" }}>
            <View style={{ paddingHorizontal: 12, paddingVertical: 4, borderRadius: radius.full, backgroundColor: weightData.confidence >= 0.8 ? colors.successLight : colors.warningLight }}>
              <Text style={{ fontSize: 13, color: weightData.confidence >= 0.8 ? colors.success : colors.warning }}>信頼度: {(weightData.confidence * 100).toFixed(0)}%</Text>
            </View>
          </View>

          {/* Main weight display */}
          <View style={{ padding: spacing.xl, borderRadius: radius.lg, backgroundColor: colors.warningLight, alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="scale" size={32} color={colors.warning} />
            <Text style={{ fontSize: 48, fontWeight: "800", color: colors.text }}>
              {weightData.weight.toFixed(1)}<Text style={{ fontSize: 20 }}> kg</Text>
            </Text>
            {previousWeight && (
              <Text style={{ fontSize: 16, color: weightData.weight <= previousWeight ? colors.success : colors.accent }}>
                {weightData.weight === previousWeight ? "前回と同じ" : weightData.weight < previousWeight ? `${(previousWeight - weightData.weight).toFixed(1)} kg 減` : `+${(weightData.weight - previousWeight).toFixed(1)} kg`}
              </Text>
            )}
          </View>

          {/* Body composition */}
          {(weightData.bodyFat || weightData.muscleMass) && (
            <View style={{ flexDirection: "row", gap: spacing.sm }}>
              {weightData.bodyFat && (
                <View style={{ flex: 1, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, alignItems: "center" }}>
                  <Text style={{ fontSize: 13, color: colors.textMuted, marginBottom: 4 }}>体脂肪率</Text>
                  <Text style={{ fontSize: 22, fontWeight: "700", color: colors.text }}>{weightData.bodyFat.toFixed(1)}%</Text>
                </View>
              )}
              {weightData.muscleMass && (
                <View style={{ flex: 1, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, alignItems: "center" }}>
                  <Text style={{ fontSize: 13, color: colors.textMuted, marginBottom: 4 }}>筋肉量</Text>
                  <Text style={{ fontSize: 22, fontWeight: "700", color: colors.text }}>{weightData.muscleMass.toFixed(1)} kg</Text>
                </View>
              )}
            </View>
          )}

          <Button onPress={saveWeightRecord} loading={isSavingWeight} disabled={isSavingWeight} style={{ backgroundColor: colors.warning }}>
            {isSavingWeight ? "保存中..." : "この体重を記録"}
          </Button>
          <Pressable onPress={() => { setStep("mode-select"); resetAll(); }} style={{ padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.bg, alignItems: "center" }}>
            <Text style={{ fontSize: 14, color: colors.textLight }}>やり直す</Text>
          </Pressable>
        </ScrollView>
      )}

      {/* ─── Step: classify-failed ─── */}
      {step === "classify-failed" && (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, alignItems: "center" }}>
          <Text style={{ fontSize: 48 }}>🤔</Text>
          <Text style={{ fontSize: 20, fontWeight: "700", color: colors.text, textAlign: "center" }}>写真の種類を判別できませんでした</Text>
          <Text style={{ fontSize: 14, color: colors.textLight, textAlign: "center" }}>食事・冷蔵庫・健診結果・体重計の写真を撮影してください</Text>

          {detectedType && (
            <View style={{ width: "100%", padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border }}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text }}>AI判定</Text>
              <Text style={{ fontSize: 13, color: colors.textLight }}>
                {detectedType === "unknown" ? "判別不可" : PHOTO_MODES[detectedType as PhotoMode]?.label} ({Math.round(detectedConfidence * 100)}%)
              </Text>
            </View>
          )}

          {/* Candidate buttons */}
          {classificationCandidates.filter((c) => c.type !== "unknown").length > 0 && (
            <View style={{ width: "100%", gap: spacing.sm }}>
              {classificationCandidates.filter((c) => c.type !== "unknown").map((candidate, i) => (
                <Pressable key={i} onPress={() => { setPhotoMode(candidate.type as PhotoMode); void analyzeResolvedMode(candidate.type); }}
                  style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{PHOTO_MODES[candidate.type as PhotoMode]?.label}として解析</Text>
                  <Text style={{ fontSize: 12, color: colors.textLight }}>{Math.round(candidate.confidence * 100)}%</Text>
                </Pressable>
              ))}
            </View>
          )}

          {/* Manual mode buttons */}
          <View style={{ width: "100%", gap: spacing.sm }}>
            {(["meal", "fridge", "health_checkup", "weight_scale"] as const).map((mode) => (
              <Pressable key={mode} onPress={() => { setPhotoMode(mode); void analyzeResolvedMode(mode); }}
                style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderStyle: "dashed" }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{PHOTO_MODES[mode]?.label}として続ける</Text>
                <Text style={{ fontSize: 12, color: colors.textLight }}>手動</Text>
              </Pressable>
            ))}
          </View>

          <Button onPress={() => { resetAll(); setStep("capture"); }} style={{ backgroundColor: colors.accent, width: "100%" }}>撮り直す</Button>
          <Pressable onPress={() => setStep("mode-select")} style={{ padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, alignItems: "center", width: "100%" }}>
            <Text style={{ fontSize: 14, fontWeight: "500", color: colors.textLight }}>モードを選び直す</Text>
          </Pressable>
        </ScrollView>
      )}
    </View>
  );
}
