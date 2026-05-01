import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Image, Pressable, ScrollView, Text, View } from "react-native";

import { Button } from "../../src/components/ui/Button";
import { Card } from "../../src/components/ui/Card";
import { EmptyState } from "../../src/components/ui/EmptyState";
import { Input } from "../../src/components/ui/Input";
import { LoadingState } from "../../src/components/ui/LoadingState";
import { PageHeader } from "../../src/components/ui/PageHeader";
import { SectionHeader } from "../../src/components/ui/SectionHeader";

import { getApi } from "../../src/lib/api";
import { colors, radius, spacing } from "../../src/theme";

type PantryItem = {
  id: string;
  name: string;
  amount: string | null;
  category: string | null;
  expirationDate: string | null;
  addedAt: string | null;
};

type FridgeIngredient = {
  name: string;
  category: string;
  quantity: string;
  freshness: string;
  daysRemaining: number;
};

function isExpiringSoon(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const diff = (new Date(dateStr).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  return diff >= 0 && diff <= 3;
}

function isExpired(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const diff = (new Date(dateStr).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  return diff < 0;
}

export default function PantryPage() {
  const [items, setItems] = useState<PantryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("other");
  const [expirationDate, setExpirationDate] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editCategory, setEditCategory] = useState("other");
  const [editExpirationDate, setEditExpirationDate] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisSummary, setAnalysisSummary] = useState<string | null>(null);
  const [detected, setDetected] = useState<FridgeIngredient[]>([]);
  const [saveMode, setSaveMode] = useState<"append" | "replace">("append");
  const [isSavingDetected, setIsSavingDetected] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ items: PantryItem[] }>("/api/pantry");
      setItems(res.items ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function add() {
    const n = name.trim();
    if (!n) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.post("/api/pantry", {
        name: n,
        amount: amount.trim() || null,
        category: category || "other",
        expirationDate: expirationDate.trim() || null,
      });
      setName("");
      setAmount("");
      setExpirationDate("");
      await load();
    } catch (e: any) {
      Alert.alert("追加失敗", e?.message ?? "追加に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  function startEdit(it: PantryItem) {
    setEditingId(it.id);
    setEditName(it.name ?? "");
    setEditAmount(it.amount ?? "");
    setEditCategory(it.category ?? "other");
    setEditExpirationDate(it.expirationDate ?? "");
  }

  async function saveEdit() {
    if (!editingId || isSavingEdit) return;
    const n = editName.trim();
    if (!n) return;
    setIsSavingEdit(true);
    try {
      const api = getApi();
      await api.patch(`/api/pantry/${editingId}`, {
        name: n,
        amount: editAmount.trim() || null,
        category: editCategory || "other",
        expirationDate: editExpirationDate.trim() || null,
      });
      setEditingId(null);
      await load();
    } catch (e: any) {
      Alert.alert("更新失敗", e?.message ?? "更新に失敗しました。");
    } finally {
      setIsSavingEdit(false);
    }
  }

  function mapCategoryToCode(raw: string): string {
    const s = (raw || "").toLowerCase();
    if (s.includes("野菜") || s.includes("vegetable")) return "vegetable";
    if (s.includes("肉") || s.includes("meat")) return "meat";
    if (s.includes("魚") || s.includes("fish") || s.includes("seafood")) return "fish";
    if (s.includes("乳") || s.includes("dairy")) return "dairy";
    if (s.includes("卵") || s.includes("egg")) return "egg";
    if (s.includes("調味料") || s.includes("seasoning")) return "seasoning";
    if (s.includes("飲料") || s.includes("drink") || s.includes("beverage")) return "drink";
    return "other";
  }

  const todayStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);

  function addDaysToDate(dateStr: string, days: number): string {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  async function analyzeFridge() {
    // ユーザーに入力元を選択させる
    const source = await new Promise<"camera" | "library" | null>((resolve) => {
      Alert.alert(
        "写真の選択",
        "冷蔵庫の写真をどこから取得しますか？",
        [
          { text: "カメラで撮影", onPress: () => resolve("camera") },
          { text: "ライブラリから選択", onPress: () => resolve("library") },
          { text: "キャンセル", style: "cancel", onPress: () => resolve(null) },
        ],
      );
    });
    if (!source) return;

    let picked: ImagePicker.ImagePickerResult;

    if (source === "camera") {
      const camPerm = await ImagePicker.requestCameraPermissionsAsync();
      if (!camPerm.granted) {
        Alert.alert("権限が必要です", "カメラへのアクセスを許可してください。");
        return;
      }
      picked = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        base64: true,
        quality: 0.8,
      });
    } else {
      const libPerm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!libPerm.granted) {
        Alert.alert("権限が必要です", "写真ライブラリへのアクセスを許可してください。");
        return;
      }
      picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        base64: true,
        quality: 0.8,
      });
    }

    if (picked.canceled) return;
    const asset = picked.assets?.[0];
    if (!asset?.base64) {
      Alert.alert("失敗", "画像の取得に失敗しました。");
      return;
    }

    setPreviewUri(asset.uri ?? null);
    setIsAnalyzing(true);
    setAnalysisSummary(null);
    setDetected([]);
    try {
      const api = getApi();
      const res = await api.post<{
        ingredients: string[];
        detailedIngredients: FridgeIngredient[];
        summary: string;
        suggestions: string[];
      }>("/api/ai/analyze-fridge", {
        imageBase64: asset.base64,
        mimeType: (asset as any).mimeType ?? "image/jpeg",
      });
      setAnalysisSummary(res.summary || null);
      setDetected((res.detailedIngredients ?? []) as any);
    } catch (e: any) {
      Alert.alert("解析失敗", e?.message ?? "解析に失敗しました。");
    } finally {
      setIsAnalyzing(false);
    }
  }

  function toIngredientInput(i: FridgeIngredient) {
    const exp = typeof i.daysRemaining === "number" && i.daysRemaining > 0 ? addDaysToDate(todayStr, i.daysRemaining) : undefined;
    return {
      name: i.name,
      amount: i.quantity || undefined,
      category: mapCategoryToCode(i.category),
      expirationDate: exp,
      daysRemaining: i.daysRemaining,
    };
  }

  async function addDetectedOne(i: FridgeIngredient) {
    setIsSavingDetected(true);
    try {
      const api = getApi();
      await api.post("/api/pantry/from-photo", {
        ingredients: [toIngredientInput(i)],
        mode: saveMode,
      });
      setDetected((prev) => prev.filter((d) => d !== i));
      if (detected.length <= 1) {
        setAnalysisSummary(null);
        setPreviewUri(null);
      }
      await load();
    } catch (e: any) {
      Alert.alert("追加失敗", e?.message ?? "追加に失敗しました。");
    } finally {
      setIsSavingDetected(false);
    }
  }

  async function addDetectedAll() {
    if (!detected.length) return;
    setIsSavingDetected(true);
    try {
      const api = getApi();
      await api.post("/api/pantry/from-photo", {
        ingredients: detected.map(toIngredientInput),
        mode: saveMode,
      });
      setDetected([]);
      setAnalysisSummary(null);
      setPreviewUri(null);
      await load();
    } catch (e: any) {
      Alert.alert("一括追加失敗", e?.message ?? "追加に失敗しました。");
    } finally {
      setIsSavingDetected(false);
    }
  }

  async function remove(id: string) {
    Alert.alert("削除", "この食材を削除しますか？", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: async () => {
          try {
            const api = getApi();
            await api.del(`/api/pantry/${id}`);
            setItems((prev) => prev.filter((x) => x.id !== id));
          } catch (e: any) {
            Alert.alert("削除失敗", e?.message ?? "削除に失敗しました。");
          }
        },
      },
    ]);
  }

  function getFreshnessColor(freshness: string): string {
    switch (freshness.toLowerCase()) {
      case "fresh": return colors.success;
      case "good": return colors.success;
      case "ok": return colors.warning;
      case "old": return colors.error;
      default: return colors.textMuted;
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="冷蔵庫" subtitle="食材を管理しましょう" />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>

      <View style={{ flexDirection: "row", gap: spacing.md }}>
        <Link href="/menus/weekly/request" asChild>
          <Pressable style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
            <Ionicons name="sparkles-outline" size={16} color={colors.accent} />
            <Text style={{ color: colors.accent, fontWeight: "600", fontSize: 14 }}>献立生成へ</Text>
          </Pressable>
        </Link>
        <Link href="/home" asChild>
          <Pressable style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
            <Ionicons name="home-outline" size={16} color={colors.accent} />
            <Text style={{ color: colors.accent, fontWeight: "600", fontSize: 14 }}>ホームへ</Text>
          </Pressable>
        </Link>
      </View>

      {/* Manual add form */}
      <Card>
        <View style={{ gap: spacing.sm }}>
          <SectionHeader title="追加" />
          <Input value={name} onChangeText={setName} placeholder="例: キャベツ" />
          <Input value={amount} onChangeText={setAmount} placeholder="量（任意）" />
          <Input value={category} onChangeText={setCategory} placeholder="category（例: vegetable）" />
          <Input value={expirationDate} onChangeText={setExpirationDate} placeholder="期限 YYYY-MM-DD（任意）" />
          <Button onPress={add} disabled={isSubmitting} loading={isSubmitting}>
            {isSubmitting ? "追加中..." : "追加"}
          </Button>
        </View>
      </Card>

      {/* Photo analysis */}
      <Card>
        <View style={{ gap: spacing.sm }}>
          <SectionHeader
            title="写真で冷蔵庫を解析"
            right={<Ionicons name="camera-outline" size={20} color={colors.accent} />}
          />
          <Button
            onPress={analyzeFridge}
            disabled={isAnalyzing}
            loading={isAnalyzing}
            variant="secondary"
          >
            <Ionicons name="image-outline" size={18} color={isAnalyzing ? "#FFFFFF" : colors.text} />
            <Text style={{ color: isAnalyzing ? "#FFFFFF" : colors.text, fontWeight: "700", fontSize: 15 }}>
              {isAnalyzing ? "解析中..." : "写真を選ぶ"}
            </Text>
          </Button>

          {previewUri ? (
            <Image
              source={{ uri: previewUri }}
              style={{ width: "100%", height: 200, borderRadius: radius.md, resizeMode: "cover" }}
              accessibilityLabel="選択した冷蔵庫の写真"
            />
          ) : null}

          {analysisSummary ? (
            <View style={{ backgroundColor: colors.bg, padding: spacing.md, borderRadius: radius.md }}>
              <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" }}>
                <Ionicons name="information-circle-outline" size={18} color={colors.accent} style={{ marginTop: 2 }} />
                <Text style={{ color: colors.textLight, flex: 1, fontSize: 14, lineHeight: 20 }}>{analysisSummary}</Text>
              </View>
            </View>
          ) : null}

          {detected.length > 0 ? (
            <View style={{ gap: spacing.sm }}>
              {/* append / replace 選択 */}
              <View style={{ flexDirection: "row", gap: spacing.sm }}>
                <Pressable
                  onPress={() => setSaveMode("append")}
                  style={{
                    flex: 1,
                    padding: spacing.sm,
                    borderRadius: radius.md,
                    borderWidth: 2,
                    borderColor: saveMode === "append" ? colors.accent : colors.textMuted,
                    alignItems: "center",
                  }}
                >
                  <Text style={{ color: saveMode === "append" ? colors.accent : colors.textMuted, fontWeight: "700", fontSize: 13 }}>
                    追加（append）
                  </Text>
                  <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>既存を保持して追加</Text>
                </Pressable>
                <Pressable
                  onPress={() => setSaveMode("replace")}
                  style={{
                    flex: 1,
                    padding: spacing.sm,
                    borderRadius: radius.md,
                    borderWidth: 2,
                    borderColor: saveMode === "replace" ? colors.accent : colors.textMuted,
                    alignItems: "center",
                  }}
                >
                  <Text style={{ color: saveMode === "replace" ? colors.accent : colors.textMuted, fontWeight: "700", fontSize: 13 }}>
                    置換（replace）
                  </Text>
                  <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>既存を全削除して置換</Text>
                </Pressable>
              </View>
              <Button onPress={addDetectedAll} variant="primary" disabled={isSavingDetected} loading={isSavingDetected}>
                <Ionicons name="add-circle-outline" size={18} color="#FFFFFF" />
                <Text style={{ color: "#FFFFFF", fontWeight: "700", fontSize: 15 }}>
                  {isSavingDetected ? "保存中..." : `検出食材を一括${saveMode === "replace" ? "置換" : "追加"}（${detected.length}件）`}
                </Text>
              </Button>
              {detected.map((i, idx) => (
                <Card key={`${i.name}-${idx}`} style={{ backgroundColor: colors.bg }}>
                  <View style={{ gap: spacing.sm }}>
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                      <Text style={{ fontWeight: "700", fontSize: 15, color: colors.text }}>{i.name}</Text>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                        <View style={{
                          width: 8,
                          height: 8,
                          borderRadius: 4,
                          backgroundColor: getFreshnessColor(i.freshness),
                        }} />
                        <Text style={{ fontSize: 12, color: colors.textMuted }}>{i.freshness}</Text>
                      </View>
                    </View>
                    <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                        <Ionicons name="pricetag-outline" size={14} color={colors.textMuted} />
                        <Text style={{ fontSize: 13, color: colors.textMuted }}>{i.category}</Text>
                      </View>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                        <Ionicons name="cube-outline" size={14} color={colors.textMuted} />
                        <Text style={{ fontSize: 13, color: colors.textMuted }}>{i.quantity}</Text>
                      </View>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                        <Ionicons name="time-outline" size={14} color={colors.textMuted} />
                        <Text style={{ fontSize: 13, color: colors.textMuted }}>残り{i.daysRemaining}日</Text>
                      </View>
                    </View>
                    <Button
                      onPress={() => addDetectedOne(i)}
                      variant="secondary"
                      size="sm"
                      style={{ alignSelf: "flex-start" }}
                      disabled={isSavingDetected}
                    >
                      <Ionicons name="add-outline" size={16} color={colors.text} />
                      <Text style={{ color: colors.text, fontWeight: "700", fontSize: 13 }}>追加</Text>
                    </Button>
                  </View>
                </Card>
              ))}
            </View>
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm }}>
              <Ionicons name="scan-outline" size={18} color={colors.textMuted} />
              <Text style={{ color: colors.textMuted, fontSize: 14 }}>未解析 / 検出結果なし</Text>
            </View>
          )}
        </View>
      </Card>

      {/* Pantry items list */}
      {isLoading ? (
        <LoadingState message="冷蔵庫の中身を読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ color: colors.error, flex: 1 }}>{error}</Text>
          </View>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Ionicons name="nutrition-outline" size={48} color={colors.textMuted} />}
          message="冷蔵庫は空です。"
          actionLabel="写真で追加"
          onAction={analyzeFridge}
        />
      ) : (
        <View style={{ gap: spacing.sm }}>
          <SectionHeader title={`食材一覧（${items.length}件）`} />
          {items.map((it) => (
            <Card key={it.id}>
              <View style={{ gap: spacing.sm }}>
                {/* Item header */}
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <Ionicons name="nutrition-outline" size={20} color={colors.accent} />
                  <Text style={{ fontWeight: "700", fontSize: 15, color: colors.text, flex: 1 }}>
                    {it.name}
                    {it.amount ? (
                      <Text style={{ fontWeight: "400", color: colors.textLight }}>{`  ${it.amount}`}</Text>
                    ) : null}
                  </Text>
                  {isExpired(it.expirationDate) && (
                    <View style={{ backgroundColor: "#EF9A9A", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 }}>
                      <Text style={{ fontSize: 11, color: "#B71C1C", fontWeight: "600" }}>期限切れ</Text>
                    </View>
                  )}
                  {!isExpired(it.expirationDate) && isExpiringSoon(it.expirationDate) && (
                    <View style={{ backgroundColor: "#FFEBEE", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 }}>
                      <Text style={{ fontSize: 11, color: colors.error, fontWeight: "600" }}>期限間近</Text>
                    </View>
                  )}
                </View>

                {/* Meta info */}
                <View style={{ flexDirection: "row", gap: spacing.md, flexWrap: "wrap" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                    <Ionicons name="pricetag-outline" size={14} color={colors.textMuted} />
                    <Text style={{ fontSize: 13, color: colors.textMuted }}>{it.category ?? "-"}</Text>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                    <Ionicons name="calendar-outline" size={14} color={(isExpired(it.expirationDate) || isExpiringSoon(it.expirationDate)) ? colors.error : colors.textMuted} />
                    <Text style={{ fontSize: 13, color: (isExpired(it.expirationDate) || isExpiringSoon(it.expirationDate)) ? colors.error : colors.textMuted }}>期限: {it.expirationDate ?? "-"}</Text>
                  </View>
                </View>

                {/* Edit form (inline) */}
                {editingId === it.id ? (
                  <View style={{ gap: spacing.sm, marginTop: spacing.xs }}>
                    <Input value={editName} onChangeText={setEditName} placeholder="食材名" />
                    <Input value={editAmount} onChangeText={setEditAmount} placeholder="量（任意）" />
                    <Input value={editCategory} onChangeText={setEditCategory} placeholder="category（例: vegetable）" />
                    <Input value={editExpirationDate} onChangeText={setEditExpirationDate} placeholder="期限 YYYY-MM-DD（任意）" />
                    <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
                      <Button onPress={saveEdit} disabled={isSavingEdit} loading={isSavingEdit} size="sm">
                        <Ionicons name="checkmark-outline" size={16} color="#FFFFFF" />
                        <Text style={{ color: "#FFFFFF", fontWeight: "700", fontSize: 13 }}>
                          {isSavingEdit ? "保存中..." : "保存"}
                        </Text>
                      </Button>
                      <Button onPress={() => setEditingId(null)} variant="secondary" size="sm">
                        <Text style={{ color: colors.text, fontWeight: "700", fontSize: 13 }}>キャンセル</Text>
                      </Button>
                    </View>
                  </View>
                ) : (
                  <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap", marginTop: spacing.xs }}>
                    <Button onPress={() => startEdit(it)} variant="secondary" size="sm">
                      <Ionicons name="create-outline" size={16} color={colors.text} />
                      <Text style={{ color: colors.text, fontWeight: "700", fontSize: 13 }}>編集</Text>
                    </Button>
                    <Button onPress={() => remove(it.id)} variant="destructive" size="sm">
                      <Ionicons name="trash-outline" size={16} color="#FFFFFF" />
                      <Text style={{ color: "#FFFFFF", fontWeight: "700", fontSize: 13 }}>削除</Text>
                    </Button>
                  </View>
                )}
              </View>
            </Card>
          ))}
        </View>
      )}

      {/* Refresh button */}
      <Button onPress={load} variant="ghost" size="sm" style={{ alignSelf: "center", marginTop: spacing.sm }}>
        <Ionicons name="refresh-outline" size={16} color={colors.textMuted} />
        <Text style={{ color: colors.textMuted, fontSize: 14 }}>更新</Text>
      </Button>
    </ScrollView>
    </View>
  );
}
