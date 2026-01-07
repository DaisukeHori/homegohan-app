import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../src/lib/api";
import { ensureActiveMealPlanId } from "../../src/lib/mealPlan";
import { supabase } from "../../src/lib/supabase";

type QuantityVariant = {
  display: string;
  unit: string;
  value: number | null;
};

type Item = {
  id: string;
  item_name: string;
  quantity: string | null;
  category: string | null;
  is_checked: boolean;
  source?: 'manual' | 'generated';
  quantity_variants?: QuantityVariant[];
  selected_variant_index?: number;
};

export default function ShoppingListPage() {
  const [mealPlanId, setMealPlanId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);

  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState("その他");
  const [newQuantity, setNewQuantity] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [totalServings, setTotalServings] = useState<number | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const planId = mealPlanId ?? (await ensureActiveMealPlanId());
      setMealPlanId(planId);

      const { data, error: fetchError } = await supabase
        .from("shopping_list_items")
        .select("id,item_name,quantity,category,is_checked,source,quantity_variants,selected_variant_index")
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

  async function toggleVariant(item: Item) {
    if (!item.quantity_variants || item.quantity_variants.length <= 1) return;
    
    const nextIndex = ((item.selected_variant_index ?? 0) + 1) % item.quantity_variants.length;
    try {
      const api = getApi();
      const response = await api.patch(`/api/shopping-list/${item.id}`, { selectedVariantIndex: nextIndex });
      if (response.item) {
        setItems((prev) => prev.map((x) => (x.id === item.id ? {
          ...x,
          quantity: response.item.quantity,
          selected_variant_index: nextIndex
        } : x)));
      }
    } catch (e: any) {
      console.error("Failed to toggle variant:", e);
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
    if (!mealPlanId || isRegenerating) return;
    Alert.alert(
      "献立から再生成", 
      "AIが材料を整理します。手動追加した項目は残ります。", 
      [
        { text: "キャンセル", style: "cancel" },
        {
          text: "再生成",
          onPress: async () => {
            setIsRegenerating(true);
            try {
              const api = getApi();
              const response = await api.post("/api/shopping-list/regenerate", { mealPlanId });
              
              // 非同期処理：requestIdが返ってくるのでポーリング
              if (response.requestId) {
                // ポーリングで完了を待つ
                let attempts = 0;
                const maxAttempts = 60; // 最大2分
                const poll = async () => {
                  try {
                    const statusRes = await api.get(`/api/shopping-list/regenerate/status?requestId=${response.requestId}`);
                    if (statusRes.status === 'completed') {
                      if (statusRes.result?.stats?.totalServings) {
                        setTotalServings(statusRes.result.stats.totalServings);
                      }
                      await load();
                      const stats = statusRes.result?.stats;
                      const servingsText = stats?.totalServings ? ` (${stats.totalServings}食分)` : '';
                      Alert.alert("完了", `${stats?.outputCount ?? 0}件の材料を整理しました${servingsText}`);
                      return true;
                    } else if (statusRes.status === 'failed') {
                      throw new Error(statusRes.result?.error || '再生成に失敗しました');
                    }
                    return false;
                  } catch (e) {
                    throw e;
                  }
                };
                
                const pollInterval = setInterval(async () => {
                  attempts++;
                  if (attempts > maxAttempts) {
                    clearInterval(pollInterval);
                    setIsRegenerating(false);
                    Alert.alert("タイムアウト", "処理に時間がかかっています。後で確認してください。");
                    return;
                  }
                  try {
                    const done = await poll();
                    if (done) {
                      clearInterval(pollInterval);
                      setIsRegenerating(false);
                    }
                  } catch (e: any) {
                    clearInterval(pollInterval);
                    setIsRegenerating(false);
                    Alert.alert("再生成失敗", e?.message ?? "再生成に失敗しました。");
                  }
                }, 2000);
                
                return; // 非同期処理中なので即座にreturn
              }
              
              await load();
            } catch (e: any) {
              Alert.alert("再生成失敗", e?.message ?? "再生成に失敗しました。");
            } finally {
              setIsRegenerating(false);
            }
          },
        },
      ]
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 20, fontWeight: "900" }}>買い物リスト</Text>
          {totalServings !== null && totalServings > 0 && (
            <View style={{ backgroundColor: "#FDF0ED", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 }}>
              <Text style={{ fontSize: 12, fontWeight: "700", color: "#E07A5F" }}>{totalServings}食分</Text>
            </View>
          )}
        </View>
        <Pressable 
          onPress={regenerate} 
          disabled={isRegenerating}
          style={{ 
            paddingVertical: 8, 
            paddingHorizontal: 10, 
            borderRadius: 10, 
            backgroundColor: isRegenerating ? "#666" : "#333",
            flexDirection: "row",
            alignItems: "center",
            gap: 6
          }}
        >
          {isRegenerating ? (
            <>
              <ActivityIndicator size="small" color="white" />
              <Text style={{ color: "white", fontWeight: "900" }}>整理中...</Text>
            </>
          ) : (
            <Text style={{ color: "white", fontWeight: "900" }}>再生成</Text>
          )}
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
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ fontWeight: "900", flex: 1 }}>
                      {it.is_checked ? "✅ " : "⬜️ "}
                      {it.item_name}
                    </Text>
                    {/* AI/手動バッジ */}
                    <View 
                      style={{ 
                        paddingHorizontal: 6, 
                        paddingVertical: 2, 
                        borderRadius: 4,
                        backgroundColor: it.source === 'generated' ? '#E8F5E9' : '#FFF3E0'
                      }}
                    >
                      <Text style={{ 
                        fontSize: 10, 
                        fontWeight: "700",
                        color: it.source === 'generated' ? '#2E7D32' : '#E65100'
                      }}>
                        {it.source === 'generated' ? 'AI' : '手動'}
                      </Text>
                    </View>
                  </View>
                  
                  {/* 数量（タップで切り替え） */}
                  {it.quantity && (
                    <Pressable 
                      onPress={() => toggleVariant(it)}
                      disabled={!it.quantity_variants || it.quantity_variants.length <= 1}
                      style={{ 
                        alignSelf: "flex-start",
                        paddingHorizontal: 8,
                        paddingVertical: 4,
                        borderRadius: 6,
                        backgroundColor: it.quantity_variants && it.quantity_variants.length > 1 ? "#f0f0f0" : "transparent"
                      }}
                    >
                      <Text style={{ color: "#666" }}>
                        {it.quantity}
                        {it.quantity_variants && it.quantity_variants.length > 1 && " ⟳"}
                      </Text>
                    </Pressable>
                  )}
                  
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
