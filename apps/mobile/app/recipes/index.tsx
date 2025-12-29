import { Link, router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../src/lib/api";

type RecipeListItem = {
  id: string;
  name: string;
  authorName: string;
  description: string | null;
  cookingTimeMinutes: number | null;
  likeCount: number;
  isLiked: boolean;
  isPublic: boolean;
};

export default function RecipesPage() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<RecipeListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ recipes: RecipeListItem[] }>(`/api/recipes?limit=30&q=${encodeURIComponent(q)}`);
      setItems(res.recipes ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleLike(recipeId: string, next: boolean) {
    const api = getApi();
    if (next) {
      await api.post(`/api/recipes/${recipeId}/like`, {});
    } else {
      await api.del(`/api/recipes/${recipeId}/like`);
    }
    await load();
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 20, fontWeight: "900" }}>レシピ</Text>
        <View style={{ flexDirection: "row", gap: 12 }}>
          <Link href="/recipes/collections">コレクション</Link>
          <Link href="/recipes/new">新規</Link>
        </View>
      </View>

      <View style={{ gap: 8 }}>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="検索（例: からあげ）"
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 12 }}
        />
        <Pressable onPress={load} style={{ padding: 12, borderRadius: 12, backgroundColor: "#333", alignItems: "center" }}>
          <Text style={{ color: "white", fontWeight: "900" }}>検索</Text>
        </Pressable>
      </View>

      <View style={{ gap: 8 }}>
        <Link href="/home">ホームへ</Link>
        <Link href="/shopping-list">買い物リストへ</Link>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>レシピがありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((r) => (
            <Pressable
              key={r.id}
              onPress={() => router.push(`/recipes/${r.id}`)}
              style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}
            >
              <Text style={{ fontWeight: "900" }}>{r.name}</Text>
              <Text style={{ color: "#666" }}>
                {r.authorName} / {r.cookingTimeMinutes ? `${r.cookingTimeMinutes}分` : "時間不明"} / ❤ {r.likeCount}
              </Text>
              {r.description ? <Text style={{ color: "#999" }}>{r.description}</Text> : null}

              <View style={{ flexDirection: "row", gap: 10, marginTop: 6 }}>
                <Pressable
                  onPress={(e) => {
                    e.stopPropagation();
                    toggleLike(r.id, !r.isLiked).catch(() => {});
                  }}
                  style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: r.isLiked ? "#c00" : "#333" }}
                >
                  <Text style={{ color: "white", fontWeight: "900" }}>{r.isLiked ? "いいね解除" : "いいね"}</Text>
                </Pressable>
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}


