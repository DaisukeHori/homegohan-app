import { Link, router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { createRecipeCollection, listMyRecipeCollections, type RecipeCollection } from "../../../src/lib/recipeCollections";

export default function RecipeCollectionsPage() {
  const [items, setItems] = useState<RecipeCollection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const cols = await listMyRecipeCollections();
      setItems(cols);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create() {
    const n = name.trim();
    if (!n || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await createRecipeCollection(n);
      setName("");
      await load();
    } catch (e: any) {
      Alert.alert("作成失敗", e?.message ?? "作成に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 20, fontWeight: "900" }}>コレクション</Text>
        <Link href="/recipes">レシピへ</Link>
      </View>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>新規作成</Text>
        <TextInput value={name} onChangeText={setName} placeholder="コレクション名" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <Pressable onPress={create} disabled={isSubmitting} style={{ padding: 12, borderRadius: 12, backgroundColor: isSubmitting ? "#999" : "#333", alignItems: "center" }}>
          <Text style={{ color: "white", fontWeight: "900" }}>{isSubmitting ? "作成中..." : "作成"}</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>コレクションがありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((c) => (
            <Pressable
              key={c.id}
              onPress={() => router.push(`/recipes/collections/${c.id}`)}
              style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 4 }}
            >
              <Text style={{ fontWeight: "900" }}>{c.name}</Text>
              <Text style={{ color: "#666" }}>件数: {(c.recipe_ids ?? []).length}</Text>
              {c.description ? <Text style={{ color: "#999" }}>{c.description}</Text> : null}
            </Pressable>
          ))}
        </View>
      )}

      <Pressable onPress={load} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>更新</Text>
      </Pressable>
    </ScrollView>
  );
}



