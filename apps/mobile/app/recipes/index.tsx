import { Ionicons } from "@expo/vector-icons";
import { Link, router } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";

import { Button, Card, EmptyState, Input, ListItem, LoadingState, PageHeader } from "../../src/components/ui";
import { getApi } from "../../src/lib/api";
import { colors, spacing } from "../../src/theme";

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
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader
        title="レシピ"
        right={
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <Button onPress={() => router.push("/recipes/collections")} variant="ghost" size="sm">
              <Ionicons name="folder-outline" size={18} color={colors.textLight} />
            </Button>
            <Button onPress={() => router.push("/recipes/new")} variant="primary" size="sm">
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                <Ionicons name="add" size={16} color="#FFFFFF" />
                <Text style={{ color: "#FFFFFF", fontWeight: "700", fontSize: 13 }}>新規</Text>
              </View>
            </Button>
          </View>
        }
      />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>

      <Card>
        <View style={{ gap: spacing.sm }}>
          <Input
            value={q}
            onChangeText={setQ}
            placeholder="検索（例: からあげ）"
          />
          <Button onPress={load} variant="secondary" size="sm">
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
              <Ionicons name="search" size={16} color={colors.text} />
              <Text style={{ color: colors.text, fontWeight: "700", fontSize: 13 }}>検索</Text>
            </View>
          </Button>
        </View>
      </Card>

      <View style={{ flexDirection: "row", gap: spacing.md }}>
        <Link href="/home" style={{ color: colors.accent, fontSize: 14, fontWeight: "600" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
            <Ionicons name="home-outline" size={16} color={colors.accent} />
            <Text style={{ color: colors.accent, fontSize: 14, fontWeight: "600" }}>ホームへ</Text>
          </View>
        </Link>
        <Link href="/shopping-list" style={{ color: colors.accent, fontSize: 14, fontWeight: "600" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
            <Ionicons name="cart-outline" size={16} color={colors.accent} />
            <Text style={{ color: colors.accent, fontSize: 14, fontWeight: "600" }}>買い物リストへ</Text>
          </View>
        </Link>
      </View>

      {isLoading ? (
        <LoadingState message="レシピを読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ color: colors.error, fontSize: 14, fontWeight: "600" }}>{error}</Text>
          </View>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Ionicons name="restaurant-outline" size={48} color={colors.textMuted} />}
          message="レシピがありません。"
        />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {items.map((r) => (
            <Card key={r.id} onPress={() => router.push(`/recipes/${r.id}`)}>
              <View style={{ gap: spacing.sm }}>
                <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{r.name}</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                    <Ionicons name="person-outline" size={14} color={colors.textMuted} />
                    <Text style={{ fontSize: 13, color: colors.textMuted }}>{r.authorName}</Text>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                    <Ionicons name="time-outline" size={14} color={colors.textMuted} />
                    <Text style={{ fontSize: 13, color: colors.textMuted }}>
                      {r.cookingTimeMinutes ? `${r.cookingTimeMinutes}分` : "時間不明"}
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                    <Ionicons name="heart" size={14} color={colors.error} />
                    <Text style={{ fontSize: 13, color: colors.textMuted }}>{r.likeCount}</Text>
                  </View>
                </View>
                {r.description ? <Text style={{ fontSize: 13, color: colors.textMuted }}>{r.description}</Text> : null}

                <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs }}>
                  <Button
                    onPress={() => {
                      toggleLike(r.id, !r.isLiked).catch(() => {});
                    }}
                    variant={r.isLiked ? "destructive" : "outline"}
                    size="sm"
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                      <Ionicons
                        name={r.isLiked ? "heart" : "heart-outline"}
                        size={16}
                        color={r.isLiked ? "#FFFFFF" : colors.accent}
                      />
                      <Text style={{ color: r.isLiked ? "#FFFFFF" : colors.accent, fontWeight: "700", fontSize: 13 }}>
                        {r.isLiked ? "いいね解除" : "いいね"}
                      </Text>
                    </View>
                  </Button>
                </View>
              </View>
            </Card>
          ))}
        </View>
      )}
    </ScrollView>
    </View>
  );
}
