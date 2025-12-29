import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, Text, View } from "react-native";

import { supabase } from "../../src/lib/supabase";

type PlannedMealDetail = {
  id: string;
  meal_type: string;
  mode: string | null;
  dish_name: string | null;
  description: string | null;
  image_url: string | null;
  calories_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  is_completed: boolean | null;
  completed_at: string | null;
  dishes: any[] | null;
  is_simple: boolean | null;
  cooking_time_minutes: number | null;
  meal_plan_day_id: string;
  day_date: string | null;
};

export default function MealDetailPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [meal, setMeal] = useState<PlannedMealDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!id) return;
      setIsLoading(true);
      setError(null);

      const { data, error: fetchError } = await supabase
        .from("planned_meals")
        .select(
          `
          *,
          meal_plan_days!inner(day_date)
        `
        )
        .eq("id", id)
        .maybeSingle();

      if (cancelled) return;

      if (fetchError || !data) {
        setError(fetchError?.message ?? "食事データが見つかりませんでした。");
        setMeal(null);
      } else {
        setMeal({
          ...(data as any),
          day_date: (data as any).meal_plan_days?.day_date ?? null,
        });
      }
      setIsLoading(false);
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function toggleCompletion() {
    if (!meal) return;
    const next = !meal.is_completed;
    setMeal((prev) => (prev ? { ...prev, is_completed: next, completed_at: next ? new Date().toISOString() : null } : prev));

    await supabase
      .from("planned_meals")
      .update({ is_completed: next, completed_at: next ? new Date().toISOString() : null })
      .eq("id", meal.id);
  }

  async function deleteMeal() {
    if (!meal) return;
    Alert.alert("削除", "この食事を削除しますか？", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: async () => {
          const { error: delError } = await supabase.from("planned_meals").delete().eq("id", meal.id);
          if (delError) {
            Alert.alert("削除失敗", delError.message);
            return;
          }
          router.replace("/menus");
        },
      },
    ]);
  }

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (error) {
    return (
      <View style={{ flex: 1, padding: 16, gap: 12, justifyContent: "center" }}>
        <Text style={{ color: "#c00" }}>{error}</Text>
        <Pressable onPress={() => router.back()} style={{ alignItems: "center" }}>
          <Text style={{ color: "#666" }}>戻る</Text>
        </Pressable>
      </View>
    );
  }

  if (!meal) return null;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: "900" }}>{meal.dish_name || "食事"}</Text>
      <Text style={{ color: "#666" }}>
        {meal.day_date ? `${meal.day_date} / ` : ""}
        {meal.meal_type} / {meal.mode || "cook"}
      </Text>

      {meal.image_url ? (
        <Image source={{ uri: meal.image_url }} style={{ width: "100%", height: 220, borderRadius: 12 }} />
      ) : null}

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 4 }}>
        <Text style={{ fontWeight: "900" }}>栄養（推定）</Text>
        <Text style={{ color: "#666" }}>
          {meal.calories_kcal ?? "-"} kcal / P {meal.protein_g ?? "-"} / F {meal.fat_g ?? "-"} / C {meal.carbs_g ?? "-"}
        </Text>
      </View>

      {meal.description ? (
        <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white" }}>
          <Text style={{ fontWeight: "900" }}>コメント</Text>
          <Text style={{ color: "#333", marginTop: 6 }}>{meal.description}</Text>
        </View>
      ) : null}

      {Array.isArray(meal.dishes) && meal.dishes.length ? (
        <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
          <Text style={{ fontWeight: "900" }}>料理内訳</Text>
          {meal.dishes.map((d: any, idx: number) => (
            <Text key={`${d?.name ?? idx}-${idx}`} style={{ color: "#666" }}>
              - {d?.name ?? "?"}（{d?.role ?? "?"} / {d?.cal ?? 0}kcal）
            </Text>
          ))}
        </View>
      ) : null}

      <Pressable
        onPress={() => router.push(`/meals/${meal.id}/edit`)}
        style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: "#eee" }}
      >
        <Text style={{ fontWeight: "900" }}>編集</Text>
      </Pressable>

      <View style={{ flexDirection: "row", gap: 10 }}>
        <Pressable
          onPress={toggleCompletion}
          style={{ flex: 1, padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: meal.is_completed ? "#999" : "#333" }}
        >
          <Text style={{ color: "white", fontWeight: "900" }}>{meal.is_completed ? "未完了に戻す" : "完了にする"}</Text>
        </Pressable>
        <Pressable
          onPress={deleteMeal}
          style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: "#c00" }}
        >
          <Text style={{ color: "white", fontWeight: "900" }}>削除</Text>
        </Pressable>
      </View>

      <Pressable onPress={() => router.back()} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>戻る</Text>
      </Pressable>
    </ScrollView>
  );
}



