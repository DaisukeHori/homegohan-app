import { router } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../src/lib/api";

export default function RecipeNewPage() {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [ingredientsText, setIngredientsText] = useState("");
  const [stepsText, setStepsText] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function parseLines(s: string): string[] {
    return s
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
  }

  async function submit() {
    const n = name.trim();
    if (!n) {
      Alert.alert("必須", "レシピ名を入力してください。");
      return;
    }
    setIsSubmitting(true);
    try {
      const api = getApi();
      const ingredients = parseLines(ingredientsText).map((line) => ({ name: line }));
      const steps = parseLines(stepsText);
      const res = await api.post<{ success: boolean; recipe: { id: string } }>("/api/recipes", {
        name: n,
        description: description.trim() || null,
        ingredients,
        steps,
        isPublic,
      });
      router.replace(`/recipes/${res.recipe.id}`);
    } catch (e: any) {
      Alert.alert("作成失敗", e?.message ?? "作成に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>レシピ作成</Text>

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
        <TextInput
          value={ingredientsText}
          onChangeText={setIngredientsText}
          placeholder={"例:\n鶏もも肉 300g\nしょうゆ 大さじ2\nみりん 大さじ1"}
          multiline
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10, minHeight: 120 }}
        />
      </View>

      <View style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white" }}>
        <Text style={{ fontWeight: "900" }}>手順（1行=1手順）</Text>
        <TextInput
          value={stepsText}
          onChangeText={setStepsText}
          placeholder={"例:\n肉を切る\n調味料を混ぜる\n焼く"}
          multiline
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10, minHeight: 120 }}
        />
      </View>

      <Pressable onPress={submit} disabled={isSubmitting} style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isSubmitting ? "#999" : "#333" }}>
        <Text style={{ color: "white", fontWeight: "900" }}>{isSubmitting ? "作成中..." : "作成"}</Text>
      </Pressable>

      <Pressable onPress={() => router.back()} style={{ alignItems: "center" }}>
        <Text style={{ color: "#666" }}>戻る</Text>
      </Pressable>
    </ScrollView>
  );
}



