import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../src/lib/api";
import { ensureActiveMealPlanId } from "../../src/lib/mealPlan";

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
    const mealPlanId = await ensureActiveMealPlanId();
    const api = getApi();
    await api.post("/api/shopping-list/add-recipe", { mealPlanId, ingredients });
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
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 20, fontWeight: "900" }}>レシピ詳細</Text>
        <Pressable onPress={() => router.back()}>
          <Text style={{ color: "#666" }}>戻る</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : !recipe ? (
        <Text style={{ color: "#666" }}>見つかりませんでした。</Text>
      ) : (
        <>
          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
            <Text style={{ fontWeight: "900", fontSize: 18 }}>{recipe.name}</Text>
            <Text style={{ color: "#666" }}>
              {recipe.authorName} / ❤ {recipe.likeCount} / {recipe.cookingTimeMinutes ? `${recipe.cookingTimeMinutes}分` : "時間不明"}
            </Text>
            {recipe.description ? <Text style={{ color: "#333" }}>{recipe.description}</Text> : null}

            <View style={{ flexDirection: "row", gap: 10, marginTop: 6 }}>
              <Pressable onPress={toggleLike} style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: recipe.isLiked ? "#c00" : "#333" }}>
                <Text style={{ color: "white", fontWeight: "900" }}>{recipe.isLiked ? "いいね解除" : "いいね"}</Text>
              </Pressable>
              <Pressable onPress={addToShoppingList} style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: "#E07A5F" }}>
                <Text style={{ color: "white", fontWeight: "900" }}>買い物に追加</Text>
              </Pressable>
              <Pressable
                onPress={() => router.push(`/recipes/collections/select?recipeId=${recipe.id}`)}
                style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: "#333" }}
              >
                <Text style={{ color: "white", fontWeight: "900" }}>コレクション</Text>
              </Pressable>
              {recipe.isOwner ? (
                <Pressable onPress={() => router.push(`/recipes/${recipe.id}/edit`)} style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: "#333" }}>
                  <Text style={{ color: "white", fontWeight: "900" }}>編集</Text>
                </Pressable>
              ) : null}
              {recipe.isOwner ? (
                <Pressable onPress={removeRecipe} style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: "#c00" }}>
                  <Text style={{ color: "white", fontWeight: "900" }}>削除</Text>
                </Pressable>
              ) : null}
            </View>
          </View>

          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
            <Text style={{ fontWeight: "900" }}>材料</Text>
            {normalizeIngredients(recipe.ingredients).map((ing, idx) => (
              <Text key={`${ing.name}-${idx}`} style={{ color: "#333" }}>
                - {ing.name}
                {ing.amount ? `（${ing.amount}）` : ""}
              </Text>
            ))}
          </View>

          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
            <Text style={{ fontWeight: "900" }}>手順</Text>
            {Array.isArray(recipe.steps) ? (
              recipe.steps.map((s: any, idx: number) => (
                <Text key={idx} style={{ color: "#333" }}>
                  {idx + 1}. {typeof s === "string" ? s : JSON.stringify(s)}
                </Text>
              ))
            ) : (
              <Text style={{ color: "#333" }}>{recipe.steps ? JSON.stringify(recipe.steps) : "-"}</Text>
            )}
          </View>

          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
            <Text style={{ fontWeight: "900" }}>コメント</Text>
            <TextInput
              value={comment}
              onChangeText={setComment}
              placeholder="コメントを書く…"
              style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
            />
            <Pressable
              onPress={postComment}
              disabled={isPosting}
              style={{ padding: 12, borderRadius: 12, backgroundColor: isPosting ? "#999" : "#333", alignItems: "center" }}
            >
              <Text style={{ color: "white", fontWeight: "900" }}>{isPosting ? "投稿中..." : "投稿"}</Text>
            </Pressable>
            {recipe.comments?.length ? (
              <View style={{ gap: 8 }}>
                {recipe.comments.map((c) => (
                  <View key={c.id} style={{ padding: 10, borderWidth: 1, borderColor: "#eee", borderRadius: 10 }}>
                    <Text style={{ fontWeight: "900" }}>{c.authorName}</Text>
                    <Text style={{ color: "#333" }}>{c.content}</Text>
                    <Text style={{ color: "#999" }}>{new Date(c.createdAt).toLocaleString("ja-JP")}</Text>
                  </View>
                ))}
              </View>
            ) : (
              <Text style={{ color: "#666" }}>コメントはまだありません。</Text>
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}


