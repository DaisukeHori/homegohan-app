import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../../src/lib/api";

type RecipeDetail = {
  id: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  ingredients: any;
  steps: any;
  isOwner: boolean;
};

export default function RecipeEditPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const apiPath = useMemo(() => `/api/recipes/${id}`, [id]);

  const [recipe, setRecipe] = useState<RecipeDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [ingredientsText, setIngredientsText] = useState("");
  const [stepsText, setStepsText] = useState("");
  const [isPublic, setIsPublic] = useState(false);

  function parseLines(s: string): string[] {
    return s
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
  }

  function ingredientsToText(raw: any): string {
    if (!raw) return "";
    if (Array.isArray(raw)) {
      return raw
        .map((x) => {
          if (typeof x === "string") return x;
          if (x && typeof x === "object" && typeof x.name === "string") return x.amount ? `${x.name} ${x.amount}` : x.name;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  async function load() {
    if (!id) return;
    setIsLoading(true);
    try {
      const api = getApi();
      const res = await api.get<{ recipe: any }>(apiPath);
      const r = res.recipe;
      if (!r?.isOwner) {
        Alert.alert("権限がありません", "このレシピは編集できません。");
        router.back();
        return;
      }
      setRecipe({ id: r.id, name: r.name, description: r.description, isPublic: r.isPublic, ingredients: r.ingredients, steps: r.steps, isOwner: true });
      setName(r.name ?? "");
      setDescription(r.description ?? "");
      setIsPublic(!!r.isPublic);
      setIngredientsText(ingredientsToText(r.ingredients));
      setStepsText(Array.isArray(r.steps) ? r.steps.map((s: any) => (typeof s === "string" ? s : JSON.stringify(s))).join("\n") : "");
    } catch (e: any) {
      Alert.alert("取得失敗", e?.message ?? "取得に失敗しました。");
      router.back();
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  async function submit() {
    const n = name.trim();
    if (!n) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      const ingredients = parseLines(ingredientsText).map((line) => ({ name: line }));
      const steps = parseLines(stepsText);
      await api.put(apiPath, {
        name: n,
        description: description.trim() || null,
        ingredients,
        steps,
        isPublic,
      });
      router.replace(`/recipes/${id}`);
    } catch (e: any) {
      Alert.alert("更新失敗", e?.message ?? "更新に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!recipe) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Text>読み込みに失敗しました。</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>レシピ編集</Text>

      <View style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white" }}>
        <Text style={{ fontWeight: "900" }}>基本</Text>
        <TextInput value={name} onChangeText={setName} placeholder="レシピ名" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="説明（任意）"
          multiline
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10, minHeight: 80 }}
        />
        <Pressable
          onPress={() => setIsPublic((v) => !v)}
          style={{ padding: 12, borderRadius: 12, backgroundColor: isPublic ? "#E07A5F" : "#333", alignItems: "center" }}
        >
          <Text style={{ color: "white", fontWeight: "900" }}>{isPublic ? "公開: ON" : "公開: OFF"}</Text>
        </Pressable>
      </View>

      <View style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white" }}>
        <Text style={{ fontWeight: "900" }}>材料（1行=1材料）</Text>
        <TextInput value={ingredientsText} onChangeText={setIngredientsText} multiline style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10, minHeight: 140 }} />
      </View>

      <View style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white" }}>
        <Text style={{ fontWeight: "900" }}>手順（1行=1手順）</Text>
        <TextInput value={stepsText} onChangeText={setStepsText} multiline style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10, minHeight: 140 }} />
      </View>

      <Pressable onPress={submit} disabled={isSubmitting} style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isSubmitting ? "#999" : "#333" }}>
        <Text style={{ color: "white", fontWeight: "900" }}>{isSubmitting ? "更新中..." : "更新"}</Text>
      </Pressable>

      <Pressable onPress={() => router.back()} style={{ alignItems: "center" }}>
        <Text style={{ color: "#666" }}>戻る</Text>
      </Pressable>
    </ScrollView>
  );
}



