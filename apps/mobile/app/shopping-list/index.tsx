import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Button } from "../../src/components/ui/Button";
import { Card } from "../../src/components/ui/Card";
import { EmptyState } from "../../src/components/ui/EmptyState";
import { Input } from "../../src/components/ui/Input";
import { LoadingState } from "../../src/components/ui/LoadingState";
import { PageHeader } from "../../src/components/ui/PageHeader";
import { SectionHeader } from "../../src/components/ui/SectionHeader";
import { StatusBadge } from "../../src/components/ui/StatusBadge";
import { getApi } from "../../src/lib/api";
import { getActiveShoppingListId } from "../../src/lib/mealPlan";
import { supabase } from "../../src/lib/supabase";
import { colors, radius, spacing } from "../../src/theme";

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
  const [shoppingListId, setShoppingListId] = useState<string | null>(null);
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
      // Get active shopping list
      const listId = shoppingListId ?? (await getActiveShoppingListId());
      setShoppingListId(listId);

      if (!listId) {
        // No shopping list exists yet
        setItems([]);
        return;
      }

      const { data, error: fetchError } = await supabase
        .from("shopping_list_items")
        .select("id,item_name,quantity,category,is_checked,source,quantity_variants,selected_variant_index")
        .eq("shopping_list_id", listId)
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

    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.post("/api/shopping-list", {
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
      const response = await api.patch<{ item?: any }>(`/api/shopping-list/${item.id}`, { selectedVariantIndex: nextIndex });
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
    if (isRegenerating) return;
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
              const response = await api.post<{ requestId?: string }>("/api/shopping-list/regenerate", {});

              // 非同期処理：requestIdが返ってくるのでポーリング
              if (response.requestId) {
                // ポーリングで完了を待つ
                let attempts = 0;
                const maxAttempts = 60; // 最大2分
                const poll = async () => {
                  try {
                    const statusRes = await api.get<{ status: string; result?: any }>(`/api/shopping-list/regenerate/status?requestId=${response.requestId}`);
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

                // ポーリング中は return して finally に行かせない
                // (setIsRegenerating(false) はポーリング内で処理)
                return;
              }

              await load();
              setIsRegenerating(false);
            } catch (e: any) {
              setIsRegenerating(false);
              Alert.alert("再生成失敗", e?.message ?? "再生成に失敗しました。");
            }
          },
        },
      ]
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader
        title="買い物リスト"
        right={
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            {totalServings !== null && totalServings > 0 && (
              <View style={{ backgroundColor: colors.accentLight, paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm }}>
                <Text style={{ fontSize: 12, fontWeight: "700", color: colors.accent }}>{totalServings}食分</Text>
              </View>
            )}
            <Button
              onPress={regenerate}
              disabled={isRegenerating}
              loading={isRegenerating}
              size="sm"
              variant="secondary"
            >
              {isRegenerating ? (
                <Text style={{ color: colors.text, fontWeight: "700", fontSize: 13 }}>整理中...</Text>
              ) : (
                <>
                  <Ionicons name="sparkles" size={14} color={colors.accent} />
                  <Text style={{ color: colors.text, fontWeight: "700", fontSize: 13 }}>再生成</Text>
                </>
              )}
            </Button>
          </View>
        }
      />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>

      <View style={{ flexDirection: "row", gap: spacing.md }}>
        <Link href="/menus/weekly" asChild>
          <Pressable style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
            <Ionicons name="restaurant-outline" size={16} color={colors.accent} />
            <Text style={{ color: colors.accent, fontWeight: "600", fontSize: 14 }}>献立へ</Text>
          </Pressable>
        </Link>
        <Link href="/home" asChild>
          <Pressable style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
            <Ionicons name="home-outline" size={16} color={colors.accent} />
            <Text style={{ color: colors.accent, fontWeight: "600", fontSize: 14 }}>ホームへ</Text>
          </Pressable>
        </Link>
      </View>

      {/* Add item form */}
      <Card>
        <View style={{ gap: spacing.sm }}>
          <SectionHeader title="追加" />
          <Input
            value={newName}
            onChangeText={setNewName}
            placeholder="例: 牛乳"
          />
          <Input
            value={newCategory}
            onChangeText={setNewCategory}
            placeholder="カテゴリ（例: 野菜）"
          />
          <Input
            value={newQuantity}
            onChangeText={setNewQuantity}
            placeholder="数量（任意: 2本、200g など）"
          />
          <Button
            onPress={addItem}
            disabled={isSubmitting}
            loading={isSubmitting}
          >
            {isSubmitting ? "追加中..." : "追加"}
          </Button>
        </View>
      </Card>

      {/* Shopping list items */}
      {isLoading ? (
        <LoadingState message="買い物リストを読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ color: colors.error, flex: 1 }}>{error}</Text>
          </View>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Ionicons name="cart-outline" size={48} color={colors.textMuted} />}
          message="買い物リストは空です。"
          actionLabel="献立から生成"
          onAction={regenerate}
        />
      ) : (
        <View style={{ gap: spacing.md }}>
          {grouped.map(([category, arr]) => (
            <View key={category} style={{ gap: spacing.sm }}>
              <SectionHeader title={category} />
              {arr.map((it) => (
                <Card
                  key={it.id}
                  style={{
                    backgroundColor: it.is_checked ? colors.successLight : colors.card,
                  }}
                >
                  <View style={{ gap: spacing.sm }}>
                    {/* Item header row */}
                    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                      <Pressable
                        onPress={() => toggleChecked(it.id, !it.is_checked)}
                        hitSlop={8}
                      >
                        <Ionicons
                          name={it.is_checked ? "checkmark-circle" : "ellipse-outline"}
                          size={24}
                          color={it.is_checked ? colors.success : colors.textMuted}
                        />
                      </Pressable>
                      <Text
                        style={{
                          fontWeight: "700",
                          fontSize: 15,
                          flex: 1,
                          color: it.is_checked ? colors.textMuted : colors.text,
                          textDecorationLine: it.is_checked ? "line-through" : "none",
                        }}
                      >
                        {it.item_name}
                      </Text>
                      <StatusBadge variant={it.source === 'generated' ? 'ai' : 'manual'} />
                    </View>

                    {/* Quantity (tap to toggle variant) */}
                    {it.quantity && (
                      <Pressable
                        onPress={() => toggleVariant(it)}
                        disabled={!it.quantity_variants || it.quantity_variants.length <= 1}
                        style={{
                          alignSelf: "flex-start",
                          paddingHorizontal: spacing.sm,
                          paddingVertical: spacing.xs,
                          borderRadius: radius.sm,
                          backgroundColor: it.quantity_variants && it.quantity_variants.length > 1 ? colors.bg : "transparent",
                          flexDirection: "row",
                          alignItems: "center",
                          gap: spacing.xs,
                        }}
                      >
                        <Text style={{ color: colors.textLight, fontSize: 14 }}>
                          {it.quantity}
                        </Text>
                        {it.quantity_variants && it.quantity_variants.length > 1 && (
                          <Ionicons name="sync-outline" size={14} color={colors.textMuted} />
                        )}
                      </Pressable>
                    )}

                    {/* Action buttons */}
                    <View style={{ flexDirection: "row", gap: spacing.sm }}>
                      <Button
                        onPress={() => toggleChecked(it.id, !it.is_checked)}
                        variant={it.is_checked ? "outline" : "secondary"}
                        size="sm"
                      >
                        <Ionicons
                          name={it.is_checked ? "arrow-undo-outline" : "checkmark-outline"}
                          size={16}
                          color={it.is_checked ? colors.accent : colors.text}
                        />
                        <Text style={{
                          fontWeight: "700",
                          fontSize: 13,
                          color: it.is_checked ? colors.accent : colors.text,
                        }}>
                          {it.is_checked ? "戻す" : "チェック"}
                        </Text>
                      </Button>
                      <Button
                        onPress={() => deleteItem(it.id)}
                        variant="destructive"
                        size="sm"
                      >
                        <Ionicons name="trash-outline" size={16} color="#FFFFFF" />
                        <Text style={{ color: "#FFFFFF", fontWeight: "700", fontSize: 13 }}>削除</Text>
                      </Button>
                    </View>
                  </View>
                </Card>
              ))}
            </View>
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
