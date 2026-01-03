import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { supabase } from "../../src/lib/supabase";

type MealType = "breakfast" | "lunch" | "dinner" | "snack" | "midnight_snack";
type DishDetail = { name: string; role: string; cal?: number; protein?: number; carbs?: number; fat?: number; ingredient?: string };

type AnalyzeResult = {
  dishes: DishDetail[];
  totalCalories: number;
  totalProtein: number;
  totalCarbs: number;
  totalFat: number;
  nutrition: Record<string, number>;
  overallScore: number;
  vegScore: number;
  praiseComment: string;
  nutritionTip: string;
  nutritionalAdvice: string;
  imageUrl?: string | null;
};

const formatLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export default function MealNewPage() {
  const [mealType, setMealType] = useState<MealType>(() => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 11) return "breakfast";
    if (hour >= 11 && hour < 16) return "lunch";
    if (hour >= 16 && hour < 19) return "snack";
    if (hour >= 19 && hour < 22) return "dinner";
    return "midnight_snack";
  });
  const [dayDate, setDayDate] = useState(() => formatLocalDate(new Date()));

  const [photos, setPhotos] = useState<{ uri: string; base64: string; mimeType: string }[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const canAnalyze = photos.length > 0 && !isAnalyzing && !isSaving;
  const canSave = !!result && !isAnalyzing && !isSaving;

  const mealTypeLabel = useMemo(() => {
    const map: Record<string, string> = {
      breakfast: "朝食",
      lunch: "昼食",
      dinner: "夕食",
      snack: "おやつ",
      midnight_snack: "夜食",
    };
    return map[mealType] ?? mealType;
  }, [mealType]);

  async function pickFromLibrary() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("権限が必要です", "写真ライブラリへのアクセスを許可してください。");
      return;
    }

    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      base64: true,
      quality: 0.8,
      selectionLimit: 4,
    });

    if (res.canceled) return;

    const items = (res.assets || [])
      .filter((a) => !!a.base64)
      .map((a) => ({
        uri: a.uri,
        base64: a.base64 as string,
        mimeType: (a as any).mimeType ?? "image/jpeg",
      }));

    setPhotos((prev) => [...prev, ...items]);
  }

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("権限が必要です", "カメラへのアクセスを許可してください。");
      return;
    }

    const res = await ImagePicker.launchCameraAsync({
      base64: true,
      quality: 0.8,
    });

    if (res.canceled) return;

    const a = res.assets?.[0];
    if (!a?.base64) {
      Alert.alert("失敗", "画像の取得に失敗しました。");
      return;
    }
    setPhotos((prev) => [
      ...prev,
      { uri: a.uri, base64: a.base64 as string, mimeType: (a as any).mimeType ?? "image/jpeg" },
    ]);
  }

  function removePhoto(index: number) {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  }

  async function analyze() {
    if (!canAnalyze) return;
    setIsAnalyzing(true);
    setResult(null);

    try {
      const images = photos.map((p) => ({ base64: p.base64, mimeType: p.mimeType }));
      const { data, error } = await supabase.functions.invoke("analyze-meal-photo", {
        body: { images, mealType },
      });
      if (error) throw error;
      setResult(data as AnalyzeResult);
    } catch (e: any) {
      Alert.alert("解析失敗", e?.message ?? "解析に失敗しました。");
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function saveToMealPlan() {
    if (!result) return;
    setIsSaving(true);

    try {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) throw new Error("Unauthorized");

      // 1) meal_plan を取得/作成（週単位）
      const targetDate = new Date(dayDate);
      const weekStart = getWeekStart(targetDate);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);

      const weekStartStr = weekStart.toISOString().split("T")[0];
      const weekEndStr = weekEnd.toISOString().split("T")[0];

      let mealPlanId: string;

      const { data: existingPlan, error: planFindError } = await supabase
        .from("meal_plans")
        .select("id,start_date")
        .eq("user_id", auth.user.id)
        .gte("start_date", weekStartStr)
        .lte("start_date", weekEndStr)
        .maybeSingle();

      if (planFindError) throw planFindError;

      if (existingPlan?.id) {
        mealPlanId = existingPlan.id;
      } else {
        const { data: newPlan, error: planError } = await supabase
          .from("meal_plans")
          .insert({
            user_id: auth.user.id,
            title: `${weekStart.getMonth() + 1}月${weekStart.getDate()}日〜の献立`,
            start_date: weekStartStr,
            end_date: weekEndStr,
            status: "active",
            is_active: true,
          })
          .select("id")
          .single();

        if (planError || !newPlan) throw planError ?? new Error("Failed to create meal plan");
        mealPlanId = newPlan.id;
      }

      // 2) meal_plan_day を取得/作成
      let dayId: string;
      const { data: existingDay, error: dayFindError } = await supabase
        .from("meal_plan_days")
        .select("id")
        .eq("meal_plan_id", mealPlanId)
        .eq("day_date", dayDate)
        .maybeSingle();

      if (dayFindError) throw dayFindError;

      if (existingDay?.id) {
        dayId = existingDay.id;
      } else {
        const dayOfWeek = new Date(dayDate).toLocaleDateString("en-US", { weekday: "long" });
        const { data: newDay, error: dayError } = await supabase
          .from("meal_plan_days")
          .insert({
            meal_plan_id: mealPlanId,
            day_date: dayDate,
            day_of_week: dayOfWeek,
            is_cheat_day: false,
          })
          .select("id")
          .single();

        if (dayError || !newDay) throw dayError ?? new Error("Failed to create meal plan day");
        dayId = newDay.id;
      }

      // 3) 既存の同じ meal_type を削除（上書き）
      await supabase.from("planned_meals").delete().eq("meal_plan_day_id", dayId).eq("meal_type", mealType);

      // 4) planned_meal を作成
      const dishesArray = result.dishes || [];
      const allDishNames = dishesArray.map((d) => d.name).join("、") || "写真から入力";
      const dishesJson = dishesArray.map((d) => ({
        name: d.name,
        cal: d.cal || 0,
        role: d.role || "side",
        ingredient: d.ingredient || "",
        protein: d.protein ?? null,
        carbs: d.carbs ?? null,
        fat: d.fat ?? null,
      }));

      const n = result.nutrition || {};

      const { data: newMeal, error: mealError } = await supabase
        .from("planned_meals")
        .insert({
          meal_plan_day_id: dayId,
          meal_type: mealType,
          mode: "cook",
          dish_name: allDishNames,
          description: result.nutritionalAdvice || null,
          calories_kcal: result.totalCalories || null,
          protein_g: result.totalProtein || null,
          carbs_g: result.totalCarbs || null,
          fat_g: result.totalFat || null,
          // 拡張栄養素（存在する場合）
          sodium_g: n.sodiumG ?? null,
          amino_acid_g: n.aminoAcidG ?? null,
          sugar_g: n.sugarG ?? null,
          fiber_g: n.fiberG ?? null,
          fiber_soluble_g: n.fiberSolubleG ?? null,
          fiber_insoluble_g: n.fiberInsolubleG ?? null,
          potassium_mg: n.potassiumMg ?? null,
          calcium_mg: n.calciumMg ?? null,
          phosphorus_mg: n.phosphorusMg ?? null,
          iron_mg: n.ironMg ?? null,
          zinc_mg: n.zincMg ?? null,
          iodine_ug: n.iodineUg ?? null,
          cholesterol_mg: n.cholesterolMg ?? null,
          vitamin_b1_mg: n.vitaminB1Mg ?? null,
          vitamin_b2_mg: n.vitaminB2Mg ?? null,
          vitamin_c_mg: n.vitaminCMg ?? null,
          vitamin_b6_mg: n.vitaminB6Mg ?? null,
          vitamin_b12_ug: n.vitaminB12Ug ?? null,
          folic_acid_ug: n.folicAcidUg ?? null,
          vitamin_a_ug: n.vitaminAUg ?? null,
          vitamin_d_ug: n.vitaminDUg ?? null,
          vitamin_k_ug: n.vitaminKUg ?? null,
          vitamin_e_mg: n.vitaminEMg ?? null,
          saturated_fat_g: n.saturatedFatG ?? null,
          monounsaturated_fat_g: n.monounsaturatedFatG ?? null,
          polyunsaturated_fat_g: n.polyunsaturatedFatG ?? null,
          veg_score: result.vegScore ?? null,
          image_url: result.imageUrl ?? null,
          is_completed: false,
          dishes: dishesJson.length ? dishesJson : null,
          is_simple: dishesJson.length <= 1,
        })
        .select("id")
        .single();

      if (mealError || !newMeal) throw mealError ?? new Error("Failed to create planned meal");

      // 詳細へ
      router.replace(`/meals/${newMeal.id}`);
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: "800" }}>写真で食事を記録</Text>

      <View style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white" }}>
        <Text style={{ fontWeight: "800" }}>食事タイプ</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {(
            [
              { value: "breakfast", label: "朝食" },
              { value: "lunch", label: "昼食" },
              { value: "dinner", label: "夕食" },
              { value: "snack", label: "おやつ" },
              { value: "midnight_snack", label: "夜食" },
            ] as const
          ).map((opt) => {
            const selected = mealType === opt.value;
            return (
              <Pressable
                key={opt.value}
                onPress={() => setMealType(opt.value)}
                style={{
                  paddingVertical: 8,
                  paddingHorizontal: 10,
                  borderRadius: 999,
                  backgroundColor: selected ? "#E07A5F" : "#eee",
                }}
              >
                <Text style={{ color: selected ? "white" : "#333", fontWeight: "800" }}>{opt.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={{ flexDirection: "row", gap: 10 }}>
        <Pressable
          onPress={takePhoto}
          style={{ flex: 1, padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: "#333" }}
        >
          <Text style={{ color: "white", fontWeight: "800" }}>カメラ</Text>
        </Pressable>
        <Pressable
          onPress={pickFromLibrary}
          style={{ flex: 1, padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: "#333" }}
        >
          <Text style={{ color: "white", fontWeight: "800" }}>ライブラリ</Text>
        </Pressable>
      </View>

      {photos.length ? (
        <View style={{ gap: 8 }}>
          <Text style={{ fontWeight: "800" }}>選択済み（{photos.length}枚）</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {photos.map((p, i) => (
              <Pressable key={`${p.uri}-${i}`} onPress={() => removePhoto(i)} style={{ position: "relative" }}>
                <Image source={{ uri: p.uri }} style={{ width: 90, height: 90, borderRadius: 12 }} />
                <View style={{ position: "absolute", top: 6, right: 6, backgroundColor: "rgba(0,0,0,0.6)", borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4 }}>
                  <Text style={{ color: "white", fontWeight: "800" }}>×</Text>
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      ) : (
        <Text style={{ color: "#666" }}>写真を選択してください（複数枚OK）</Text>
      )}

      <Pressable
        onPress={analyze}
        disabled={!canAnalyze}
        style={{
          padding: 14,
          borderRadius: 12,
          alignItems: "center",
          backgroundColor: canAnalyze ? "#E07A5F" : "#999",
        }}
      >
        <Text style={{ color: "white", fontWeight: "800" }}>{isAnalyzing ? "解析中..." : `${mealTypeLabel}を解析`}</Text>
      </Pressable>

      {result ? (
        <View style={{ gap: 10, padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white" }}>
          <Text style={{ fontWeight: "900" }}>解析結果</Text>
          <Text style={{ color: "#666" }}>
            {result.totalCalories} kcal（P {result.totalProtein} / F {result.totalFat} / C {result.totalCarbs}）
          </Text>
          <Text style={{ color: "#333" }}>{result.praiseComment}</Text>
          {result.nutritionTip ? <Text style={{ color: "#666" }}>{result.nutritionTip}</Text> : null}

          <View style={{ gap: 6 }}>
            {result.dishes?.map((d, idx) => (
              <Text key={`${d.name}-${idx}`} style={{ color: "#666" }}>
                - {d.name}（{d.role} / {d.calories_kcal ?? 0}kcal）
              </Text>
            ))}
          </View>

          <View style={{ gap: 6, marginTop: 6 }}>
            <Text style={{ fontWeight: "800" }}>保存先の日付</Text>
            <TextInput
              value={dayDate}
              onChangeText={setDayDate}
              placeholder="YYYY-MM-DD"
              style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
            />
            <Text style={{ color: "#999" }}>例: {formatLocalDate(new Date())}</Text>
          </View>

          <Pressable
            onPress={saveToMealPlan}
            disabled={!canSave}
            style={{
              padding: 14,
              borderRadius: 12,
              alignItems: "center",
              backgroundColor: canSave ? "#333" : "#999",
              marginTop: 6,
            }}
          >
            <Text style={{ color: "white", fontWeight: "900" }}>{isSaving ? "保存中..." : "献立に保存"}</Text>
          </Pressable>
        </View>
      ) : null}

      <Pressable onPress={() => router.back()} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>戻る</Text>
      </Pressable>
    </ScrollView>
  );
}



