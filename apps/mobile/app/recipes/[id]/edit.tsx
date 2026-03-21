import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, EmptyState, LoadingState, PageHeader, SectionHeader } from "../../../src/components/ui";
import { Input } from "../../../src/components/ui/Input";
import { getApi } from "../../../src/lib/api";
import { colors, radius, spacing } from "../../../src/theme";
import { typography } from "../../../src/theme/typography";

type RecipeDetail = {
  id: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  ingredients: any;
  steps: any;
  isOwner: boolean;
};

export default function RecipeEditPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const apiPath = useMemo(() => `/api/recipes/${id}`, [id]);

  const [recipe, setRecipe] = useState<RecipeDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [ingredientsText, setIngredientsText] = useState("");
  const [stepsText, setStepsText] = useState("");
  const [isPublic, setIsPublic] = useState(false);

  function parseLines(s: string): string[] {
    return s
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
  }

  function ingredientsToText(raw: any): string {
    if (!raw) return "";
    if (Array.isArray(raw)) {
      return raw
        .map((x) => {
          if (typeof x === "string") return x;
          if (x && typeof x === "object" && typeof x.name === "string") return x.amount ? `${x.name} ${x.amount}` : x.name;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  async function load() {
    if (!id) return;
    setIsLoading(true);
    try {
      const api = getApi();
      const res = await api.get<{ recipe: any }>(apiPath);
      const r = res.recipe;
      if (!r?.isOwner) {
        Alert.alert("権限がありません", "このレシピは編集できません。");
        router.back();
        return;
      }
      setRecipe({ id: r.id, name: r.name, description: r.description, isPublic: r.isPublic, ingredients: r.ingredients, steps: r.steps, isOwner: true });
      setName(r.name ?? "");
      setDescription(r.description ?? "");
      setIsPublic(!!r.isPublic);
      setIngredientsText(ingredientsToText(r.ingredients));
      setStepsText(Array.isArray(r.steps) ? r.steps.map((s: any) => (typeof s === "string" ? s : JSON.stringify(s))).join("\n") : "");
    } catch (e: any) {
      Alert.alert("取得失敗", e?.message ?? "取得に失敗しました。");
      router.back();
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  async function submit() {
    const n = name.trim();
    if (!n) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      const ingredients = parseLines(ingredientsText).map((line) => ({ name: line }));
      const steps = parseLines(stepsText);
      await api.put(apiPath, {
        name: n,
        description: description.trim() || null,
        ingredients,
        steps,
        isPublic,
      });
      router.replace(`/recipes/${id}`);
    } catch (e: any) {
      Alert.alert("更新失敗", e?.message ?? "更新に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <LoadingState message="読み込み中..." />
      </View>
    );
  }

  if (!recipe) {
    return (
      <View style={styles.centered}>
        <EmptyState
          icon={<Ionicons name="alert-circle-outline" size={40} color={colors.error} />}
          message="読み込みに失敗しました。"
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="レシピ編集" />
      <ScrollView style={styles.screen} contentContainerStyle={styles.container}>

      <Card style={{ gap: spacing.md }}>
        <SectionHeader title="基本" right={<Ionicons name="document-text-outline" size={18} color={colors.accent} />} />
        <Input label="レシピ名" value={name} onChangeText={setName} placeholder="レシピ名" />
        <Input
          label="説明（任意）"
          value={description}
          onChangeText={setDescription}
          placeholder="説明（任意）"
          multiline
          style={{ minHeight: 80 }}
        />
        <Button
          onPress={() => setIsPublic((v) => !v)}
          variant={isPublic ? "primary" : "secondary"}
        >
          <Ionicons name={isPublic ? "eye-outline" : "eye-off-outline"} size={18} color={isPublic ? "#FFF" : colors.text} />
          <Text style={{ color: isPublic ? "#FFF" : colors.text, fontWeight: "700", fontSize: 15 }}>
            {isPublic ? "公開: ON" : "公開: OFF"}
          </Text>
        </Button>
      </Card>

      <Card style={{ gap: spacing.md }}>
        <SectionHeader title="材料（1行=1材料）" right={<Ionicons name="leaf-outline" size={18} color={colors.accent} />} />
        <Input
          value={ingredientsText}
          onChangeText={setIngredientsText}
          multiline
          style={{ minHeight: 140 }}
        />
      </Card>

      <Card style={{ gap: spacing.md }}>
        <SectionHeader title="手順（1行=1手順）" right={<Ionicons name="list-outline" size={18} color={colors.accent} />} />
        <Input
          value={stepsText}
          onChangeText={setStepsText}
          multiline
          style={{ minHeight: 140 }}
        />
      </Card>

      <Button onPress={submit} loading={isSubmitting} variant="primary" size="lg">
        {isSubmitting ? "更新中..." : "更新"}
      </Button>

      <Pressable onPress={() => router.back()} style={styles.cancelButton}>
        <Ionicons name="close-outline" size={18} color={colors.textMuted} />
        <Text style={styles.cancelText}>キャンセル</Text>
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
  centered: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
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
  cancelButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingVertical: spacing.sm,
  },
  cancelText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: "600",
  },
});
