import { Link, router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import { supabase } from "../../src/lib/supabase";

type MealListItem = {
  id: string;
  dish_name: string | null;
  meal_type: string;
  calories_kcal: number | null;
  is_completed: boolean | null;
  meal_plan_days: { day_date: string } | null;
};

export default function MealsScreen() {
  const [items, setItems] = useState<MealListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setIsLoading(true);
      setError(null);

      const { data, error: fetchError } = await supabase
        .from("planned_meals")
        .select(
          `
          id,
          dish_name,
          meal_type,
          calories_kcal,
          is_completed,
          meal_plan_days!inner(day_date)
        `
        )
        .order("created_at", { ascending: false })
        .limit(20);

      if (cancelled) return;

      if (fetchError) {
        setError(fetchError.message);
        setItems([]);
      } else {
        setItems((data as any) ?? []);
      }
      setIsLoading(false);
    }

    run();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 20, fontWeight: "800" }}>食事</Text>
        <Link href="/meals/new">写真で記録</Link>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>まだ記録がありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((m) => (
            <Pressable
              key={m.id}
              onPress={() => router.push(`/meals/${m.id}`)}
              style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 4 }}
            >
              <Text style={{ fontWeight: "900" }}>{m.dish_name || "（未設定）"}</Text>
              <Text style={{ color: "#666" }}>
                {m.meal_plan_days?.day_date ?? ""} / {m.meal_type} / {m.calories_kcal ? `${m.calories_kcal}kcal` : "kcal未設定"}
              </Text>
              <Text style={{ color: "#999" }}>{m.is_completed ? "完了" : "未完了"}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}


