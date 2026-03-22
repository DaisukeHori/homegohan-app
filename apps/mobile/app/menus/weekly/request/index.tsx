import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Image, ScrollView, Text, View } from "react-native";

import { Button, Card, ChipSelector, Input, PageHeader, SectionHeader } from "../../../../src/components/ui";
import { getApi } from "../../../../src/lib/api";
import { colors, radius, spacing } from "../../../../src/theme";

const formatLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export default function WeeklyRequestPage() {
  const [startDate, setStartDate] = useState(() => formatLocalDate(getWeekStart(new Date())));
  const [familySize, setFamilySize] = useState("1");
  const [cheatDay, setCheatDay] = useState("");
  const [note, setNote] = useState("");

  const [ingredients, setIngredients] = useState<string[]>([]);
  const [fridgeImageUri, setFridgeImageUri] = useState<string | null>(null);
  const [fridgeSummary, setFridgeSummary] = useState<string | null>(null);
  const [fridgeSuggestions, setFridgeSuggestions] = useState<string[]>([]);

  const [isUploading, setIsUploading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const themes = useMemo(
    () => [
      "冷蔵庫の食材を優先",
      "時短メニュー中心",
      "和食多め",
      "ヘルシーに",
    ],
    []
  );
  const [selectedThemes, setSelectedThemes] = useState<string[]>([]);

  function toggleTheme(t: string) {
    setSelectedThemes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  async function uploadFridgePhotoAndAnalyze() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("権限が必要です", "写真ライブラリへのアクセスを許可してください。");
      return;
    }

    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"] as any,
      base64: true,
      quality: 0.8,
    });
    if (picked.canceled) return;

    const asset = picked.assets?.[0];
    if (!asset?.base64) {
      Alert.alert("失敗", "画像の取得に失敗しました。");
      return;
    }

    setIsUploading(true);
    setFridgeSummary(null);
    setFridgeSuggestions([]);
    try {
      setFridgeImageUri(asset.uri ?? null);
      const api = getApi();
      const analyzed = await api.post<{
        ingredients: string[];
        detailedIngredients: any[];
        summary: string;
        suggestions: string[];
      }>("/api/ai/analyze-fridge", {
        imageBase64: asset.base64,
        mimeType: (asset as any).mimeType ?? "image/jpeg",
      });

      const detected: string[] = Array.isArray((analyzed as any)?.ingredients) ? (analyzed as any).ingredients : [];
      setIngredients((prev) => Array.from(new Set([...(prev ?? []), ...detected])));
      setFridgeSummary((analyzed as any)?.summary ?? null);
      setFridgeSuggestions(Array.isArray((analyzed as any)?.suggestions) ? (analyzed as any).suggestions : []);
    } catch (e: any) {
      Alert.alert("冷蔵庫解析失敗", e?.message ?? "解析に失敗しました。");
    } finally {
      setIsUploading(false);
    }
  }

  async function submit() {
    if (isSubmitting) return;
    setIsSubmitting(true);

    try {
      const parsedDate = new Date(startDate + "T00:00:00");
      if (isNaN(parsedDate.getTime())) {
        Alert.alert("入力エラー", "日付の形式が正しくありません。YYYY-MM-DD形式で入力してください。");
        setIsSubmitting(false);
        return;
      }
      const ws = getWeekStart(parsedDate);
      const weekStartStr = formatLocalDate(ws);

      const useFridgeFirst = selectedThemes.includes("冷蔵庫の食材を優先");
      const quickMeals = selectedThemes.includes("時短メニュー中心");
      const japaneseStyle = selectedThemes.includes("和食多め");
      const healthy = selectedThemes.includes("ヘルシーに");

      const extraLines: string[] = [];
      if (selectedThemes.length) extraLines.push(`テーマ: ${selectedThemes.join("、")}`);
      if (ingredients.length) extraLines.push(`使いたい食材: ${ingredients.join("、")}`);
      if (cheatDay.trim()) extraLines.push(`チートデイ: ${cheatDay.trim()}`);
      const noteForApi = [note.trim(), ...extraLines].filter(Boolean).join("\n");

      const api = getApi();
      await api.post("/api/ai/menu/weekly/request", {
        startDate: weekStartStr,
        note: noteForApi,
        familySize: Math.max(1, Math.min(10, parseInt(familySize || "1") || 1)),
        cheatDay: cheatDay.trim() || null,
        preferences: { useFridgeFirst, quickMeals, japaneseStyle, healthy, ingredients },
      });

      Alert.alert("生成開始", "週間献立の生成を開始しました。生成中は「生成中...」と表示されます。");
      router.replace("/menus/weekly");
    } catch (e: any) {
      Alert.alert("生成失敗", e?.message ?? "生成に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  const themeOptions = themes.map((t) => ({ value: t, label: t }));

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader
        title="AIで週間献立を作成"
        subtitle="食材や好みに合わせた1週間の献立を自動生成"
      />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>

      <Card>
        <SectionHeader
          title="開始日"
          right={<Ionicons name="calendar-outline" size={18} color={colors.accent} />}
        />
        <View style={{ marginTop: spacing.sm }}>
          <Input
            label="週の月曜日推奨"
            value={startDate}
            onChangeText={setStartDate}
            placeholder="YYYY-MM-DD"
          />
        </View>
      </Card>

      <Card>
        <SectionHeader
          title="冷蔵庫（任意）"
          right={<Ionicons name="cube-outline" size={18} color={colors.accent} />}
        />
        <View style={{ gap: spacing.md, marginTop: spacing.sm }}>
          <Button
            onPress={uploadFridgePhotoAndAnalyze}
            disabled={isUploading || isSubmitting}
            loading={isUploading}
            variant="secondary"
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <Ionicons name="camera-outline" size={18} color={isUploading ? "#FFFFFF" : colors.text} />
              <Text style={{ color: isUploading ? "#FFFFFF" : colors.text, fontWeight: "700", fontSize: 14 }}>
                {isUploading ? "解析中..." : "写真を選んで食材を自動追加"}
              </Text>
            </View>
          </Button>
          {fridgeImageUri ? (
            <Image source={{ uri: fridgeImageUri }} style={{ width: "100%", height: 160, borderRadius: radius.md }} />
          ) : null}
          {fridgeSummary ? (
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.sm }}>
              <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} style={{ marginTop: 2 }} />
              <Text style={{ fontSize: 13, color: colors.textLight, flex: 1 }}>{fridgeSummary}</Text>
            </View>
          ) : null}
          {fridgeSuggestions.length ? (
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.sm }}>
              <Ionicons name="bulb-outline" size={16} color={colors.warning} style={{ marginTop: 2 }} />
              <Text style={{ fontSize: 13, color: colors.textMuted, flex: 1 }}>提案: {fridgeSuggestions.join("、")}</Text>
            </View>
          ) : null}
          {ingredients.length ? (
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.sm }}>
              <Ionicons name="leaf-outline" size={16} color={colors.success} style={{ marginTop: 2 }} />
              <Text style={{ fontSize: 13, color: colors.textLight, flex: 1 }}>検出/指定食材: {ingredients.join("、")}</Text>
            </View>
          ) : (
            <Text style={{ fontSize: 13, color: colors.textMuted }}>食材指定なし（AIにお任せ）</Text>
          )}
        </View>
      </Card>

      <Card>
        <SectionHeader
          title="条件"
          right={<Ionicons name="options-outline" size={18} color={colors.accent} />}
        />
        <View style={{ gap: spacing.md, marginTop: spacing.sm }}>
          <Input
            label="家族人数"
            value={familySize}
            onChangeText={setFamilySize}
            keyboardType="number-pad"
          />
          <Input
            label="チートデイ（任意）"
            value={cheatDay}
            onChangeText={setCheatDay}
            placeholder="例: 土曜"
          />

          <View style={{ gap: spacing.sm }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>テーマ</Text>
            <ChipSelector
              options={themeOptions}
              selected={selectedThemes}
              onSelect={toggleTheme}
              multiple
            />
          </View>
        </View>
      </Card>

      <Card>
        <SectionHeader
          title="メモ（任意）"
          right={<Ionicons name="create-outline" size={18} color={colors.accent} />}
        />
        <View style={{ marginTop: spacing.sm }}>
          <Input
            value={note}
            onChangeText={setNote}
            placeholder="例: 野菜多め、魚を増やしたい"
            multiline
            style={{ minHeight: 80, textAlignVertical: "top" }}
          />
        </View>
      </Card>

      <Button onPress={submit} disabled={isSubmitting || isUploading} loading={isSubmitting} size="lg">
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Ionicons name="sparkles" size={18} color="#FFFFFF" />
          <Text style={{ color: "#FFFFFF", fontWeight: "700", fontSize: 16 }}>
            {isSubmitting ? "生成中..." : "生成する"}
          </Text>
        </View>
      </Button>

      <Button onPress={() => router.back()} variant="ghost" size="sm">
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
          <Ionicons name="arrow-back" size={16} color={colors.textLight} />
          <Text style={{ color: colors.textLight, fontWeight: "600", fontSize: 14 }}>戻る</Text>
        </View>
      </Button>
    </ScrollView>
    </View>
  );
}
