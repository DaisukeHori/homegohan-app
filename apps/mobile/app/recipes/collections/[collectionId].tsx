import { Link, router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";

import { removeRecipeFromCollection, type RecipeCollection } from "../../../src/lib/recipeCollections";
import { supabase } from "../../../src/lib/supabase";

type RecipeLite = {
  id: string;
  name: string;
  description: string | null;
  like_count: number | null;
};

export default function RecipeCollectionDetailPage() {
  const { collectionId } = useLocalSearchParams<{ collectionId: string }>();
  const [collection, setCollection] = useState<RecipeCollection | null>(null);
  const [recipes, setRecipes] = useState<RecipeLite[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const id = useMemo(() => collectionId, [collectionId]);

  async function load() {
    if (!id) return;
    setIsLoading(true);
    setError(null);
    try {
      const { data: col, error: colErr } = await supabase
        .from("recipe_collections")
        .select("id,user_id,name,description,is_public,recipe_ids")
        .eq("id", id)
        .single();
      if (colErr || !col) throw colErr ?? new Error("Not found");
      setCollection(col as any);

      const recipeIds = ((col as any).recipe_ids as string[]) ?? [];
      if (recipeIds.length === 0) {
        setRecipes([]);
        return;
      }

      const { data: rs, error: rErr } = await supabase
        .from("recipes")
        .select("id,name,description,like_count")
        .in("id", recipeIds);
      if (rErr) throw rErr;
      setRecipes((rs ?? []) as any);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  async function remove(collectionId: string, recipeId: string) {
    Alert.alert("削除", "このレシピをコレクションから外しますか？", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "外す",
        style: "destructive",
        onPress: async () => {
          try {
            await removeRecipeFromCollection(collectionId, recipeId);
            await load();
          } catch (e: any) {
            Alert.alert("失敗", e?.message ?? "失敗しました。");
          }
        },
      },
    ]);
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 20, fontWeight: "900" }}>コレクション</Text>
        <Pressable onPress={() => router.back()}>
          <Text style={{ color: "#666" }}>戻る</Text>
        </Pressable>
      </View>

      <View style={{ gap: 8 }}>
        <Link href="/recipes/collections">一覧へ</Link>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : !collection ? (
        <Text style={{ color: "#666" }}>見つかりませんでした。</Text>
      ) : (
        <>
          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 4 }}>
            <Text style={{ fontWeight: "900" }}>{collection.name}</Text>
            <Text style={{ color: "#666" }}>件数: {(collection.recipe_ids ?? []).length}</Text>
            {collection.description ? <Text style={{ color: "#999" }}>{collection.description}</Text> : null}
          </View>

          {recipes.length === 0 ? (
            <Text style={{ color: "#666" }}>レシピがありません。</Text>
          ) : (
            <View style={{ gap: 10 }}>
              {recipes.map((r) => (
                <View key={r.id} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
                  <Text style={{ fontWeight: "900" }}>{r.name}</Text>
                  {r.description ? <Text style={{ color: "#999" }}>{r.description}</Text> : null}
                  <View style={{ flexDirection: "row", gap: 10 }}>
                    <Pressable onPress={() => router.push(`/recipes/${r.id}`)} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#333" }}>
                      <Text style={{ color: "white", fontWeight: "900" }}>開く</Text>
                    </Pressable>
                    <Pressable onPress={() => remove(collection.id, r.id)} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#c00" }}>
                      <Text style={{ color: "white", fontWeight: "900" }}>外す</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          )}
        </>
      )}

      <Pressable onPress={load} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>更新</Text>
      </Pressable>
    </ScrollView>
  );
}



