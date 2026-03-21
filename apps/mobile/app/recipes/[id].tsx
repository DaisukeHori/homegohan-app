import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, EmptyState, LoadingState, PageHeader, SectionHeader } from "../../src/components/ui";
import { Input } from "../../src/components/ui/Input";
import { getApi } from "../../src/lib/api";
import { colors, radius, shadows, spacing } from "../../src/theme";
import { typography } from "../../src/theme/typography";

type RecipeDetail = {
  id: string;
  userId: string;
  authorName: string;
  name: string;
  description: string | null;
  caloriesKcal: number | null;
  cookingTimeMinutes: number | null;
  servings: number | null;
  imageUrl: string | null;
  ingredients: any;
  steps: any;
  isPublic: boolean;
  category: string | null;
  cuisineType: string | null;
  difficulty: string | null;
  tags: string[];
  nutrition: any;
  tips: string | null;
  videoUrl: string | null;
  sourceUrl: string | null;
  viewCount: number;
  likeCount: number;
  isLiked: boolean;
  isOwner: boolean;
  comments: Array<{ id: string; content: string; rating: number | null; authorName: string; createdAt: string }>;
};

export default function RecipeDetailPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [recipe, setRecipe] = useState<RecipeDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [comment, setComment] = useState("");
  const [isPosting, setIsPosting] = useState(false);

  const apiPath = useMemo(() => `/api/recipes/${id}`, [id]);

  async function load() {
    if (!id) return;
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ recipe: RecipeDetail }>(apiPath);
      setRecipe(res.recipe);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  async function toggleLike() {
    if (!recipe) return;
    const api = getApi();
    if (recipe.isLiked) {
      await api.del(`${apiPath}/like`);
    } else {
      await api.post(`${apiPath}/like`, {});
    }
    await load();
  }

  function normalizeIngredients(raw: any): Array<{ name: string; amount?: string }> {
    if (!raw) return [];
    if (Array.isArray(raw)) {
      return raw
        .map((x) => {
          if (typeof x === "string") return { name: x };
          if (x && typeof x === "object" && typeof x.name === "string") return { name: x.name, amount: x.amount };
          return null;
        })
        .filter(Boolean) as any;
    }
    return [];
  }

  async function addToShoppingList() {
    if (!recipe) return;
    const ingredients = normalizeIngredients(recipe.ingredients);
    if (ingredients.length === 0) {
      Alert.alert("追加できません", "材料が空です。");
      return;
    }
    const api = getApi();
    await api.post("/api/shopping-list/add-recipe", { ingredients });
    Alert.alert("追加しました", "買い物リストに追加しました。");
  }

  async function postComment() {
    const content = comment.trim();
    if (!content || !id) return;
    setIsPosting(true);
    try {
      const api = getApi();
      await api.post(`/api/recipes/${id}/comments`, { content });
      setComment("");
      await load();
    } catch (e: any) {
      Alert.alert("投稿失敗", e?.message ?? "投稿に失敗しました。");
    } finally {
      setIsPosting(false);
    }
  }

  async function removeRecipe() {
    if (!id) return;
    Alert.alert("削除", "このレシピを削除しますか？", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: async () => {
          try {
            const api = getApi();
            await api.del(apiPath);
            router.back();
          } catch (e: any) {
            Alert.alert("削除失敗", e?.message ?? "削除に失敗しました。");
          }
        },
      },
    ]);
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="レシピ詳細" />
      <ScrollView style={styles.screen} contentContainerStyle={styles.container}>

      {isLoading ? (
        <LoadingState message="読み込み中..." />
      ) : error ? (
        <EmptyState
          icon={<Ionicons name="alert-circle-outline" size={40} color={colors.error} />}
          message={error}
          actionLabel="再読み込み"
          onAction={load}
        />
      ) : !recipe ? (
        <EmptyState
          icon={<Ionicons name="search-outline" size={40} color={colors.textMuted} />}
          message="見つかりませんでした。"
        />
      ) : (
        <>
          {/* Recipe header card */}
          <Card style={{ gap: spacing.sm }}>
            <Text style={typography.h3}>{recipe.name}</Text>
            <View style={styles.metaRow}>
              <Ionicons name="person-outline" size={14} color={colors.textMuted} />
              <Text style={typography.bodySmall}>{recipe.authorName}</Text>
              <Ionicons name="heart" size={14} color={colors.error} />
              <Text style={typography.bodySmall}>{recipe.likeCount}</Text>
              <Ionicons name="time-outline" size={14} color={colors.textMuted} />
              <Text style={typography.bodySmall}>
                {recipe.cookingTimeMinutes ? `${recipe.cookingTimeMinutes}分` : "時間不明"}
              </Text>
            </View>
            {recipe.description ? <Text style={typography.body}>{recipe.description}</Text> : null}

            <View style={styles.actionRow}>
              <Button onPress={toggleLike} variant={recipe.isLiked ? "destructive" : "secondary"} size="sm">
                <Ionicons name={recipe.isLiked ? "heart" : "heart-outline"} size={16} color={recipe.isLiked ? "#FFF" : colors.text} />
                <Text style={{ color: recipe.isLiked ? "#FFF" : colors.text, fontWeight: "700", fontSize: 13 }}>
                  {recipe.isLiked ? "解除" : "いいね"}
                </Text>
              </Button>
              <Button onPress={addToShoppingList} variant="primary" size="sm">
                <Ionicons name="cart-outline" size={16} color="#FFF" />
                <Text style={{ color: "#FFF", fontWeight: "700", fontSize: 13 }}>買い物に追加</Text>
              </Button>
              <Button onPress={() => router.push(`/recipes/collections/select?recipeId=${recipe.id}`)} variant="secondary" size="sm">
                <Ionicons name="folder-outline" size={16} color={colors.text} />
                <Text style={{ color: colors.text, fontWeight: "700", fontSize: 13 }}>コレクション</Text>
              </Button>
            </View>
            {recipe.isOwner ? (
              <View style={styles.actionRow}>
                <Button onPress={() => router.push(`/recipes/${recipe.id}/edit`)} variant="outline" size="sm">
                  <Ionicons name="create-outline" size={16} color={colors.accent} />
                  <Text style={{ color: colors.accent, fontWeight: "700", fontSize: 13 }}>編集</Text>
                </Button>
                <Button onPress={removeRecipe} variant="destructive" size="sm">
                  <Ionicons name="trash-outline" size={16} color="#FFF" />
                  <Text style={{ color: "#FFF", fontWeight: "700", fontSize: 13 }}>削除</Text>
                </Button>
              </View>
            ) : null}
          </Card>

          {/* Ingredients card */}
          <Card style={{ gap: spacing.sm }}>
            <SectionHeader title="材料" right={<Ionicons name="leaf-outline" size={18} color={colors.accent} />} />
            {normalizeIngredients(recipe.ingredients).map((ing, idx) => (
              <View key={`${ing.name}-${idx}`} style={styles.ingredientRow}>
                <Ionicons name="ellipse" size={6} color={colors.accent} style={{ marginTop: 6 }} />
                <Text style={typography.body}>
                  {ing.name}
                  {ing.amount ? <Text style={{ color: colors.textMuted }}>{` (${ing.amount})`}</Text> : ""}
                </Text>
              </View>
            ))}
          </Card>

          {/* Steps card */}
          <Card style={{ gap: spacing.sm }}>
            <SectionHeader title="手順" right={<Ionicons name="list-outline" size={18} color={colors.accent} />} />
            {Array.isArray(recipe.steps) ? (
              recipe.steps.map((s: any, idx: number) => (
                <View key={idx} style={styles.stepRow}>
                  <View style={styles.stepNumber}>
                    <Text style={styles.stepNumberText}>{idx + 1}</Text>
                  </View>
                  <Text style={[typography.body, { flex: 1 }]}>
                    {typeof s === "string" ? s : JSON.stringify(s)}
                  </Text>
                </View>
              ))
            ) : (
              <Text style={typography.body}>{recipe.steps ? JSON.stringify(recipe.steps) : "-"}</Text>
            )}
          </Card>

          {/* Comments card */}
          <Card style={{ gap: spacing.md }}>
            <SectionHeader title="コメント" right={<Ionicons name="chatbubble-outline" size={18} color={colors.accent} />} />
            <Input
              value={comment}
              onChangeText={setComment}
              placeholder="コメントを書く…"
            />
            <Button onPress={postComment} loading={isPosting} variant="primary">
              {isPosting ? "投稿中..." : "投稿"}
            </Button>
            {recipe.comments?.length ? (
              <View style={{ gap: spacing.sm }}>
                {recipe.comments.map((c) => (
                  <View key={c.id} style={styles.commentItem}>
                    <View style={styles.commentHeader}>
                      <Ionicons name="person-circle-outline" size={18} color={colors.textMuted} />
                      <Text style={typography.label}>{c.authorName}</Text>
                    </View>
                    <Text style={typography.body}>{c.content}</Text>
                    <Text style={typography.caption}>{new Date(c.createdAt).toLocaleString("ja-JP")}</Text>
                  </View>
                ))}
              </View>
            ) : (
              <EmptyState
                icon={<Ionicons name="chatbubble-ellipses-outline" size={32} color={colors.textMuted} />}
                message="コメントはまだありません。"
              />
            )}
          </Card>
        </>
      )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing["4xl"],
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  backText: {
    color: colors.textLight,
    fontSize: 14,
    fontWeight: "600",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  ingredientRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
  },
  stepNumber: {
    width: 28,
    height: 28,
    borderRadius: radius.full,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
  },
  stepNumberText: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.accent,
  },
  commentItem: {
    padding: spacing.md,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    gap: spacing.xs,
  },
  commentHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
});
