import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../../src/lib/api";

type Mode = "cook" | "out" | "buy" | "skip";

export default function MealEditPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [dishName, setDishName] = useState("");
  const [mode, setMode] = useState<Mode>("cook");
  const [description, setDescription] = useState("");
  const [caloriesKcal, setCaloriesKcal] = useState("");
  const [proteinG, setProteinG] = useState("");
  const [fatG, setFatG] = useState("");
  const [carbsG, setCarbsG] = useState("");
  const [cookingTimeMinutes, setCookingTimeMinutes] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!id) return;
      setIsLoading(true);
      setError(null);
      try {
        const api = getApi();
        const data: any = await api.get(`/api/meals/${id}`);
        if (cancelled) return;
        setDishName(data?.dish_name ?? "");
        setMode((data?.mode ?? "cook") as Mode);
        setDescription(data?.description ?? "");
        setCaloriesKcal(data?.calories_kcal != null ? String(data.calories_kcal) : "");
        setProteinG(data?.protein_g != null ? String(data.protein_g) : "");
        setFatG(data?.fat_g != null ? String(data.fat_g) : "");
        setCarbsG(data?.carbs_g != null ? String(data.carbs_g) : "");
        setCookingTimeMinutes(data?.cooking_time_minutes != null ? String(data.cooking_time_minutes) : "");
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "取得に失敗しました。");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  function toNumberOrNull(s: string): number | null {
    const v = s.trim();
    if (!v) return null;
    const n = Number(v);
    if (Number.isNaN(n)) return null;
    return n;
  }

  async function save() {
    if (!id || isSaving) return;
    const name = dishName.trim();
    if (!name) {
      Alert.alert("入力エラー", "料理名を入力してください。");
      return;
    }
    setIsSaving(true);
    try {
      const api = getApi();
      await api.patch(`/api/meals/${id}`, {
        dish_name: name,
        mode,
        description: description.trim() || null,
        calories_kcal: toNumberOrNull(caloriesKcal),
        protein_g: toNumberOrNull(proteinG),
        fat_g: toNumberOrNull(fatG),
        carbs_g: toNumberOrNull(carbsG),
        cooking_time_minutes: toNumberOrNull(cookingTimeMinutes),
      });
      router.replace(`/meals/${id}`);
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally {
      setIsSaving(false);
    }
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

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>食事を編集</Text>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>料理名</Text>
        <TextInput value={dishName} onChangeText={setDishName} placeholder="例: 鮭の塩焼き定食" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
      </View>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>モード</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {(
            [
              { value: "cook", label: "自炊" },
              { value: "out", label: "外食" },
              { value: "buy", label: "中食" },
              { value: "skip", label: "スキップ" },
            ] as const
          ).map((opt) => {
            const selected = mode === opt.value;
            return (
              <Pressable
                key={opt.value}
                onPress={() => setMode(opt.value)}
                style={{
                  paddingVertical: 8,
                  paddingHorizontal: 10,
                  borderRadius: 999,
                  backgroundColor: selected ? "#E07A5F" : "#eee",
                }}
              >
                <Text style={{ color: selected ? "white" : "#333", fontWeight: "900" }}>{opt.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>メモ（任意）</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="例: 野菜を増やしたい"
          multiline
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10, minHeight: 80 }}
        />
      </View>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>栄養（任意）</Text>
        <TextInput value={caloriesKcal} onChangeText={setCaloriesKcal} placeholder="カロリー(kcal)" keyboardType="numeric" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <TextInput value={proteinG} onChangeText={setProteinG} placeholder="タンパク質(g)" keyboardType="numeric" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <TextInput value={fatG} onChangeText={setFatG} placeholder="脂質(g)" keyboardType="numeric" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <TextInput value={carbsG} onChangeText={setCarbsG} placeholder="炭水化物(g)" keyboardType="numeric" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <TextInput value={cookingTimeMinutes} onChangeText={setCookingTimeMinutes} placeholder="調理時間(分)" keyboardType="numeric" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
      </View>

      <Pressable
        onPress={save}
        disabled={isSaving}
        style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isSaving ? "#999" : "#333" }}
      >
        <Text style={{ color: "white", fontWeight: "900" }}>{isSaving ? "保存中..." : "保存"}</Text>
      </Pressable>

      <Pressable onPress={() => router.back()} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>戻る</Text>
      </Pressable>
    </ScrollView>
  );
}


