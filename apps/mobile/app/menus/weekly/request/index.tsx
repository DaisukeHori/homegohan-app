import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../../../src/lib/api";

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

  const [isUploading, setIsUploading] = useState(false); // UI互換（ボタン無効化用）
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
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
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
      const ws = getWeekStart(new Date(startDate));
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
        familySize: parseInt(familySize || "1"),
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

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>AIで週間献立を作成</Text>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>開始日（週の月曜日推奨）</Text>
        <TextInput
          value={startDate}
          onChangeText={setStartDate}
          placeholder="YYYY-MM-DD"
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
        />
      </View>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>冷蔵庫（任意）</Text>
        <Pressable
          onPress={uploadFridgePhotoAndAnalyze}
          disabled={isUploading || isSubmitting}
          style={{ padding: 12, borderRadius: 10, alignItems: "center", backgroundColor: isUploading ? "#999" : "#333" }}
        >
          <Text style={{ color: "white", fontWeight: "900" }}>{isUploading ? "解析中..." : "写真を選んで食材を自動追加"}</Text>
        </Pressable>
        {fridgeImageUri ? <Image source={{ uri: fridgeImageUri }} style={{ width: "100%", height: 160, borderRadius: 12 }} /> : null}
        {fridgeSummary ? <Text style={{ color: "#666" }}>{fridgeSummary}</Text> : null}
        {fridgeSuggestions.length ? <Text style={{ color: "#999" }}>提案: {fridgeSuggestions.join("、")}</Text> : null}
        {ingredients.length ? (
          <Text style={{ color: "#666" }}>検出/指定食材: {ingredients.join("、")}</Text>
        ) : (
          <Text style={{ color: "#999" }}>食材指定なし（AIにお任せ）</Text>
        )}
      </View>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>条件</Text>
        <Text style={{ color: "#666" }}>家族人数</Text>
        <TextInput
          value={familySize}
          onChangeText={setFamilySize}
          keyboardType="number-pad"
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
        />
        <Text style={{ color: "#666" }}>チートデイ（任意）</Text>
        <TextInput
          value={cheatDay}
          onChangeText={setCheatDay}
          placeholder="例: 土曜"
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
        />

        <Text style={{ fontWeight: "900", marginTop: 6 }}>テーマ</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {themes.map((t) => {
            const selected = selectedThemes.includes(t);
            return (
              <Pressable
                key={t}
                onPress={() => toggleTheme(t)}
                style={{
                  paddingVertical: 8,
                  paddingHorizontal: 10,
                  borderRadius: 999,
                  backgroundColor: selected ? "#E07A5F" : "#eee",
                }}
              >
                <Text style={{ color: selected ? "white" : "#333", fontWeight: "900" }}>{t}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>メモ（任意）</Text>
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder="例: 野菜多め、魚を増やしたい"
          multiline
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10, minHeight: 80 }}
        />
      </View>

      <Pressable
        onPress={submit}
        disabled={isSubmitting || isUploading}
        style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isSubmitting ? "#999" : "#333" }}
      >
        <Text style={{ color: "white", fontWeight: "900" }}>{isSubmitting ? "生成中..." : "生成する"}</Text>
      </Pressable>

      <Pressable onPress={() => router.back()} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>戻る</Text>
      </Pressable>
    </ScrollView>
  );
}



