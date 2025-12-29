import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../src/lib/api";
import { ensureActiveMealPlanId } from "../../src/lib/mealPlan";
import { supabase } from "../../src/lib/supabase";

type Item = {
  id: string;
  item_name: string;
  quantity: string | null;
  category: string | null;
  is_checked: boolean;
};

export default function ShoppingListPage() {
  const [mealPlanId, setMealPlanId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState("その他");
  const [newQuantity, setNewQuantity] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const planId = mealPlanId ?? (await ensureActiveMealPlanId());
      setMealPlanId(planId);

      const { data, error: fetchError } = await supabase
        .from("shopping_list_items")
        .select("id,item_name,quantity,category,is_checked")
        .eq("meal_plan_id", planId)
        .order("category", { ascending: true })
        .order("created_at", { ascending: true });

      if (fetchError) throw fetchError;
      setItems((data as any) ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const it of items) {
      const key = it.category || "その他";
      const arr = map.get(key) ?? [];
      arr.push(it);
      map.set(key, arr);
    }
    return Array.from(map.entries());
  }, [items]);

  async function addItem() {
    const name = newName.trim();
    if (!name) return;
    if (!mealPlanId) {
      await load();
    }
    if (!mealPlanId) return;

    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.post("/api/shopping-list", {
        mealPlanId,
        itemName: name,
        category: newCategory || "その他",
        quantity: newQuantity.trim() || null,
      });
      setNewName("");
      setNewQuantity("");
      await load();
    } catch (e: any) {
      Alert.alert("追加失敗", e?.message ?? "追加に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function toggleChecked(id: string, next: boolean) {
    try {
      const api = getApi();
      await api.patch(`/api/shopping-list/${id}`, { isChecked: next });
      setItems((prev) => prev.map((x) => (x.id === id ? { ...x, is_checked: next } : x)));
    } catch (e: any) {
      Alert.alert("更新失敗", e?.message ?? "更新に失敗しました。");
    }
  }

  async function deleteItem(id: string) {
    Alert.alert("削除", "この項目を削除しますか？", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: async () => {
          try {
            const api = getApi();
            await api.del(`/api/shopping-list/${id}`);
            setItems((prev) => prev.filter((x) => x.id !== id));
          } catch (e: any) {
            Alert.alert("削除失敗", e?.message ?? "削除に失敗しました。");
          }
        },
      },
    ]);
  }

  async function regenerate() {
    if (!mealPlanId) return;
    Alert.alert("再生成", "献立の材料から買い物リストを再生成します。現在のリストは置き換えられます。", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "再生成",
        onPress: async () => {
          try {
            const api = getApi();
            await api.post("/api/shopping-list/regenerate", { mealPlanId });
            await load();
          } catch (e: any) {
            Alert.alert("再生成失敗", e?.message ?? "再生成に失敗しました。");
          }
        },
      },
    ]);
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 20, fontWeight: "900" }}>買い物リスト</Text>
        <Pressable onPress={regenerate} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#333" }}>
          <Text style={{ color: "white", fontWeight: "900" }}>再生成</Text>
        </Pressable>
      </View>

      <View style={{ gap: 8 }}>
        <Link href="/menus/weekly">献立へ</Link>
        <Link href="/home">ホームへ</Link>
      </View>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>追加</Text>
        <TextInput
          value={newName}
          onChangeText={setNewName}
          placeholder="例: 牛乳"
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
        />
        <TextInput
          value={newCategory}
          onChangeText={setNewCategory}
          placeholder="カテゴリ（例: 野菜）"
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
        />
        <TextInput
          value={newQuantity}
          onChangeText={setNewQuantity}
          placeholder="数量（任意: 2本、200g など）"
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
        />
        <Pressable
          onPress={addItem}
          disabled={isSubmitting}
          style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isSubmitting ? "#999" : "#E07A5F" }}
        >
          <Text style={{ color: "white", fontWeight: "900" }}>{isSubmitting ? "追加中..." : "追加"}</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>買い物リストは空です。</Text>
      ) : (
        <View style={{ gap: 12 }}>
          {grouped.map(([category, arr]) => (
            <View key={category} style={{ gap: 8 }}>
              <Text style={{ fontWeight: "900" }}>{category}</Text>
              {arr.map((it) => (
                <View
                  key={it.id}
                  style={{
                    padding: 12,
                    borderWidth: 1,
                    borderColor: "#eee",
                    borderRadius: 12,
                    backgroundColor: it.is_checked ? "#E8F5E9" : "white",
                    gap: 6,
                  }}
                >
                  <Text style={{ fontWeight: "900" }}>
                    {it.is_checked ? "✅ " : "⬜️ "}
                    {it.item_name}
                    {it.quantity ? `（${it.quantity}）` : ""}
                  </Text>
                  <View style={{ flexDirection: "row", gap: 10 }}>
                    <Pressable
                      onPress={() => toggleChecked(it.id, !it.is_checked)}
                      style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#333" }}
                    >
                      <Text style={{ color: "white", fontWeight: "900" }}>{it.is_checked ? "戻す" : "チェック"}</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => deleteItem(it.id)}
                      style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#c00" }}
                    >
                      <Text style={{ color: "white", fontWeight: "900" }}>削除</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
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



