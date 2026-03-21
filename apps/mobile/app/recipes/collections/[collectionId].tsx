import { Ionicons } from "@expo/vector-icons";
import { Link, router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, EmptyState, LoadingState, PageHeader, SectionHeader } from "../../../src/components/ui";
import { removeRecipeFromCollection, type RecipeCollection } from "../../../src/lib/recipeCollections";
import { supabase } from "../../../src/lib/supabase";
import { colors, spacing } from "../../../src/theme";
import { typography } from "../../../src/theme/typography";

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
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="コレクション詳細" />
      <ScrollView style={styles.screen} contentContainerStyle={styles.container}>

      <Link href="/recipes/collections" style={styles.linkText}>
        <View style={styles.linkRow}>
          <Ionicons name="list-outline" size={16} color={colors.accent} />
          <Text style={styles.linkText}>一覧へ</Text>
        </View>
      </Link>

      {isLoading ? (
        <LoadingState message="読み込み中..." />
      ) : error ? (
        <EmptyState
          icon={<Ionicons name="alert-circle-outline" size={40} color={colors.error} />}
          message={error}
          actionLabel="再読み込み"
          onAction={load}
        />
      ) : !collection ? (
        <EmptyState
          icon={<Ionicons name="search-outline" size={40} color={colors.textMuted} />}
          message="見つかりませんでした。"
        />
      ) : (
        <>
          <Card style={{ gap: spacing.xs }}>
            <View style={styles.collectionTitleRow}>
              <Ionicons name="folder-outline" size={22} color={colors.accent} />
              <Text style={typography.h3}>{collection.name}</Text>
            </View>
            <Text style={typography.bodySmall}>件数: {(collection.recipe_ids ?? []).length}</Text>
            {collection.description ? <Text style={typography.caption}>{collection.description}</Text> : null}
          </Card>

          {recipes.length === 0 ? (
            <EmptyState
              icon={<Ionicons name="restaurant-outline" size={40} color={colors.textMuted} />}
              message="レシピがありません。"
            />
          ) : (
            <View style={{ gap: spacing.sm }}>
              {recipes.map((r) => (
                <Card key={r.id} style={{ gap: spacing.sm }}>
                  <Text style={typography.label}>{r.name}</Text>
                  {r.description ? <Text style={typography.caption}>{r.description}</Text> : null}
                  <View style={styles.recipeActions}>
                    <Button onPress={() => router.push(`/recipes/${r.id}`)} variant="secondary" size="sm">
                      <Ionicons name="open-outline" size={14} color={colors.text} />
                      <Text style={{ color: colors.text, fontWeight: "700", fontSize: 13 }}>開く</Text>
                    </Button>
                    <Button onPress={() => remove(collection.id, r.id)} variant="destructive" size="sm">
                      <Ionicons name="close-circle-outline" size={14} color="#FFF" />
                      <Text style={{ color: "#FFF", fontWeight: "700", fontSize: 13 }}>外す</Text>
                    </Button>
                  </View>
                </Card>
              ))}
            </View>
          )}
        </>
      )}

      <Pressable onPress={load} style={styles.refreshButton}>
        <Ionicons name="refresh-outline" size={16} color={colors.textMuted} />
        <Text style={styles.refreshText}>更新</Text>
      </Pressable>
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
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  linkText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
  },
  collectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  recipeActions: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  refreshButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingVertical: spacing.sm,
  },
  refreshText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: "600",
  },
});
