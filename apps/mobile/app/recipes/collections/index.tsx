import { Ionicons } from "@expo/vector-icons";
import { Link, router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, EmptyState, LoadingState, PageHeader, SectionHeader } from "../../../src/components/ui";
import { Input } from "../../../src/components/ui/Input";
import { createRecipeCollection, listMyRecipeCollections, type RecipeCollection } from "../../../src/lib/recipeCollections";
import { colors, spacing } from "../../../src/theme";
import { typography } from "../../../src/theme/typography";

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
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader
        title="コレクション"
        right={
          <Link href="/recipes" style={styles.linkText}>
            <View style={styles.linkRow}>
              <Ionicons name="restaurant-outline" size={16} color={colors.accent} />
              <Text style={styles.linkText}>レシピへ</Text>
            </View>
          </Link>
        }
      />
      <ScrollView style={styles.screen} contentContainerStyle={styles.container}>

      <Card style={{ gap: spacing.md }}>
        <SectionHeader title="新規作成" right={<Ionicons name="add-circle-outline" size={18} color={colors.accent} />} />
        <Input value={name} onChangeText={setName} placeholder="コレクション名" />
        <Button onPress={create} loading={isSubmitting} variant="primary">
          {isSubmitting ? "作成中..." : "作成"}
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
          {items.map((c) => (
            <Card
              key={c.id}
              onPress={() => router.push(`/recipes/collections/${c.id}`)}
              style={{ gap: spacing.xs }}
            >
              <View style={styles.collectionRow}>
                <Ionicons name="folder-outline" size={20} color={colors.accent} />
                <Text style={typography.label}>{c.name}</Text>
              </View>
              <Text style={typography.bodySmall}>件数: {(c.recipe_ids ?? []).length}</Text>
              {c.description ? <Text style={typography.caption}>{c.description}</Text> : null}
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
