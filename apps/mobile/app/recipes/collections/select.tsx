import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, EmptyState, LoadingState, PageHeader, SectionHeader } from "../../../src/components/ui";
import { Input } from "../../../src/components/ui/Input";
import { addRecipeToCollection, createRecipeCollection, listMyRecipeCollections, type RecipeCollection } from "../../../src/lib/recipeCollections";
import { colors, spacing } from "../../../src/theme";
import { typography } from "../../../src/theme/typography";

export default function RecipeCollectionSelectPage() {
  const { recipeId } = useLocalSearchParams<{ recipeId: string }>();

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

  async function addTo(colId: string) {
    if (!recipeId) return;
    try {
      await addRecipeToCollection(colId, recipeId);
      Alert.alert("追加しました", "コレクションに追加しました。");
      router.back();
    } catch (e: any) {
      Alert.alert("失敗", e?.message ?? "追加に失敗しました。");
    }
  }

  async function createAndAdd() {
    const n = name.trim();
    if (!n || !recipeId || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const col = await createRecipeCollection(n);
      await addRecipeToCollection(col.id, recipeId);
      Alert.alert("追加しました", "新しいコレクションに追加しました。");
      router.back();
    } catch (e: any) {
      Alert.alert("失敗", e?.message ?? "失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="コレクション選択" />
      <ScrollView style={styles.screen} contentContainerStyle={styles.container}>

      <Card style={{ gap: spacing.md }}>
        <SectionHeader title="新規作成して追加" right={<Ionicons name="add-circle-outline" size={18} color={colors.accent} />} />
        <Input value={name} onChangeText={setName} placeholder="コレクション名" />
        <Button onPress={createAndAdd} loading={isSubmitting} variant="primary">
          {isSubmitting ? "作成中..." : "作成して追加"}
        </Button>
      </Card>

      {isLoading ? (
        <LoadingState message="読み込み中..." />
      ) : error ? (
        <EmptyState
          icon={<Ionicons name="alert-circle-outline" size={40} color={colors.error} />}
          message={error}
          actionLabel="再読み込み"
          onAction={load}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Ionicons name="folder-open-outline" size={40} color={colors.textMuted} />}
          message="コレクションがありません。"
        />
      ) : (
        <View style={{ gap: spacing.sm }}>
          <SectionHeader title="既存のコレクション" />
          {items.map((c) => (
            <Card
              key={c.id}
              onPress={() => addTo(c.id)}
              style={{ gap: spacing.xs }}
            >
              <View style={styles.collectionRow}>
                <Ionicons name="folder-outline" size={20} color={colors.accent} />
                <Text style={typography.label}>{c.name}</Text>
              </View>
              <Text style={typography.bodySmall}>件数: {(c.recipe_ids ?? []).length}</Text>
            </Card>
          ))}
        </View>
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
  collectionRow: {
    flexDirection: "row",
    alignItems: "center",
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
