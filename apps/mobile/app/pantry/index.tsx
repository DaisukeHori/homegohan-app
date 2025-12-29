import * as ImagePicker from "expo-image-picker";
import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../src/lib/api";

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

  const todayStr = useMemo(() => new Date().toISOString().split("T")[0], []);

  function addDaysToDate(dateStr: string, days: number): string {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().split("T")[0];
  }

  async function analyzeFridge() {
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

  async function addDetectedOne(i: FridgeIngredient) {
    try {
      const api = getApi();
      const exp = typeof i.daysRemaining === "number" && i.daysRemaining > 0 ? addDaysToDate(todayStr, i.daysRemaining) : null;
      await api.post("/api/pantry", {
        name: i.name,
        amount: i.quantity || null,
        category: mapCategoryToCode(i.category),
        expirationDate: exp,
      });
      await load();
    } catch (e: any) {
      Alert.alert("追加失敗", e?.message ?? "追加に失敗しました。");
    }
  }

  async function addDetectedAll() {
    if (!detected.length) return;
    try {
      const api = getApi();
      for (const i of detected) {
        const exp = typeof i.daysRemaining === "number" && i.daysRemaining > 0 ? addDaysToDate(todayStr, i.daysRemaining) : null;
        await api.post("/api/pantry", {
          name: i.name,
          amount: i.quantity || null,
          category: mapCategoryToCode(i.category),
          expirationDate: exp,
        });
      }
      setDetected([]);
      setAnalysisSummary(null);
      await load();
    } catch (e: any) {
      Alert.alert("一括追加失敗", e?.message ?? "追加に失敗しました。");
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

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>冷蔵庫</Text>

      <View style={{ gap: 8 }}>
        <Link href="/menus/weekly/request">献立生成（冷蔵庫写真解析）へ</Link>
        <Link href="/home">ホームへ</Link>
      </View>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>追加</Text>
        <TextInput value={name} onChangeText={setName} placeholder="例: キャベツ" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <TextInput value={amount} onChangeText={setAmount} placeholder="量（任意）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <TextInput value={category} onChangeText={setCategory} placeholder="category（例: vegetable）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <TextInput value={expirationDate} onChangeText={setExpirationDate} placeholder="期限 YYYY-MM-DD（任意）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <Pressable onPress={add} disabled={isSubmitting} style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isSubmitting ? "#999" : "#E07A5F" }}>
          <Text style={{ color: "white", fontWeight: "900" }}>{isSubmitting ? "追加中..." : "追加"}</Text>
        </Pressable>
      </View>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>写真で冷蔵庫を解析 → 追加</Text>
        <Pressable
          onPress={analyzeFridge}
          disabled={isAnalyzing}
          style={{ padding: 12, borderRadius: 12, backgroundColor: isAnalyzing ? "#999" : "#333", alignItems: "center" }}
        >
          <Text style={{ color: "white", fontWeight: "900" }}>{isAnalyzing ? "解析中..." : "写真を選ぶ"}</Text>
        </Pressable>
        {analysisSummary ? <Text style={{ color: "#666" }}>{analysisSummary}</Text> : null}
        {detected.length ? (
          <>
            <Pressable onPress={addDetectedAll} style={{ padding: 12, borderRadius: 12, backgroundColor: "#E07A5F", alignItems: "center" }}>
              <Text style={{ color: "white", fontWeight: "900" }}>検出食材を一括追加（{detected.length}件）</Text>
            </Pressable>
            <View style={{ gap: 8 }}>
              {detected.map((i, idx) => (
                <View key={`${i.name}-${idx}`} style={{ padding: 10, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "#fafafa", gap: 4 }}>
                  <Text style={{ fontWeight: "900" }}>{i.name}</Text>
                  <Text style={{ color: "#666" }}>
                    {i.category} / {i.quantity} / freshness: {i.freshness} / daysRemaining: {i.daysRemaining}
                  </Text>
                  <Pressable onPress={() => addDetectedOne(i)} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#333", alignSelf: "flex-start" }}>
                    <Text style={{ color: "white", fontWeight: "900" }}>追加</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          </>
        ) : (
          <Text style={{ color: "#999" }}>未解析 / 検出結果なし</Text>
        )}
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>冷蔵庫は空です。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((it) => (
            <View key={it.id} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
              <Text style={{ fontWeight: "900" }}>
                {it.name} {it.amount ? `（${it.amount}）` : ""}
              </Text>
              <Text style={{ color: "#666" }}>category: {it.category ?? "-"} / 期限: {it.expirationDate ?? "-"}</Text>

              {editingId === it.id ? (
                <View style={{ gap: 8, marginTop: 6 }}>
                  <TextInput value={editName} onChangeText={setEditName} placeholder="食材名" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
                  <TextInput value={editAmount} onChangeText={setEditAmount} placeholder="量（任意）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
                  <TextInput value={editCategory} onChangeText={setEditCategory} placeholder="category（例: vegetable）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
                  <TextInput value={editExpirationDate} onChangeText={setEditExpirationDate} placeholder="期限 YYYY-MM-DD（任意）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
                  <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
                    <Pressable onPress={saveEdit} disabled={isSavingEdit} style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: isSavingEdit ? "#999" : "#333" }}>
                      <Text style={{ color: "white", fontWeight: "900" }}>{isSavingEdit ? "保存中..." : "保存"}</Text>
                    </Pressable>
                    <Pressable onPress={() => setEditingId(null)} style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: "#eee" }}>
                      <Text style={{ fontWeight: "900" }}>キャンセル</Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
                  <Pressable onPress={() => startEdit(it)} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#333" }}>
                    <Text style={{ color: "white", fontWeight: "900" }}>編集</Text>
                  </Pressable>
                  <Pressable onPress={() => remove(it.id)} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#c00" }}>
                    <Text style={{ color: "white", fontWeight: "900" }}>削除</Text>
                  </Pressable>
                </View>
              )}
            </View>
          ))}
        </View>
      )}

      <Pressable onPress={load} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>更新</Text>
      </Pressable>
    </ScrollView>
  );
}


