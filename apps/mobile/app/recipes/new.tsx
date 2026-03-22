import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, PageHeader, SectionHeader } from "../../src/components/ui";
import { Input } from "../../src/components/ui/Input";
import { getApi } from "../../src/lib/api";
import { colors, spacing } from "../../src/theme";

export default function RecipeNewPage() {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [ingredientsText, setIngredientsText] = useState("");
  const [stepsText, setStepsText] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function parseLines(s: string): string[] {
    return s
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
  }

  async function submit() {
    const n = name.trim();
    if (!n) {
      Alert.alert("必須", "レシピ名を入力してください。");
      return;
    }
    setIsSubmitting(true);
    try {
      const api = getApi();
      const ingredients = parseLines(ingredientsText).map((line) => ({ name: line }));
      const steps = parseLines(stepsText);
      const res = await api.post<{ success: boolean; recipe: { id: string } }>("/api/recipes", {
        name: n,
        description: description.trim() || null,
        ingredients,
        steps,
        isPublic,
      });
      router.replace(`/recipes/${res.recipe.id}`);
    } catch (e: any) {
      Alert.alert("作成失敗", e?.message ?? "作成に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="レシピ作成" />
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
          placeholder={"例:\n鶏もも肉 300g\nしょうゆ 大さじ2\nみりん 大さじ1"}
          multiline
          style={{ minHeight: 120 }}
        />
      </Card>

      <Card style={{ gap: spacing.md }}>
        <SectionHeader title="手順（1行=1手順）" right={<Ionicons name="list-outline" size={18} color={colors.accent} />} />
        <Input
          value={stepsText}
          onChangeText={setStepsText}
          placeholder={"例:\n肉を切る\n調味料を混ぜる\n焼く"}
          multiline
          style={{ minHeight: 120 }}
        />
      </Card>

      <Button onPress={submit} loading={isSubmitting} variant="primary" size="lg">
        {isSubmitting ? "作成中..." : "作成"}
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
