import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";

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

type RangeType = 'today' | 'tomorrow' | 'dayAfterTomorrow' | 'days' | 'week';
type MealType = 'breakfast' | 'lunch' | 'dinner';
type RangeStep = 'range' | 'servings';

type ShoppingRange = {
  type: RangeType;
  todayMeals: MealType[];
  daysCount: number;
};

function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

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

  // Range selection modal state
  const [showRangeModal, setShowRangeModal] = useState(false);
  const [rangeStep, setRangeStep] = useState<RangeStep>('range');
  const [shoppingRange, setShoppingRange] = useState<ShoppingRange>({
    type: 'week',
    todayMeals: ['breakfast', 'lunch', 'dinner'],
    daysCount: 3,
  });
  const [servings, setServings] = useState(2);
  const [isTodayExpanded, setIsTodayExpanded] = useState(false);
  const [daysCountInput, setDaysCountInput] = useState('3');

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

  // スーパーの動線に合わせたカテゴリ順序
  const CATEGORY_ORDER = [
    '青果（野菜・果物）',
    '精肉',
    '鮮魚',
    '乳製品・卵',
    '豆腐・練り物',
    '米・パン・麺',
    '調味料',
    '油・香辛料',
    '乾物・缶詰',
    '冷凍食品',
    '飲料',
    // 旧カテゴリとの互換性
    '野菜',
    '肉',
    '魚',
    '乳製品',
    '卵',
    '豆腐・大豆',
    '麺・米',
    '乾物',
    '食材',
    'その他',
  ];

  const grouped = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const it of items) {
      const key = it.category || "その他";
      const arr = map.get(key) ?? [];
      arr.push(it);
      map.set(key, arr);
    }
    // カテゴリ順序でソート
    return Array.from(map.entries()).sort((a, b) => {
      const indexA = CATEGORY_ORDER.indexOf(a[0]);
      const indexB = CATEGORY_ORDER.indexOf(b[0]);
      const orderA = indexA === -1 ? 999 : indexA;
      const orderB = indexB === -1 ? 999 : indexB;
      return orderA - orderB;
    });
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

  function calculateDateRange() {
    const today = new Date();
    const todayStr = formatLocalDate(today);

    switch (shoppingRange.type) {
      case 'today':
        return {
          startDate: todayStr,
          endDate: todayStr,
          mealTypes: shoppingRange.todayMeals,
        };
      case 'tomorrow': {
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        return {
          startDate: formatLocalDate(tomorrow),
          endDate: formatLocalDate(tomorrow),
          mealTypes: ['breakfast', 'lunch', 'dinner'] as MealType[],
        };
      }
      case 'dayAfterTomorrow': {
        const dayAfter = new Date(today);
        dayAfter.setDate(dayAfter.getDate() + 2);
        return {
          startDate: formatLocalDate(dayAfter),
          endDate: formatLocalDate(dayAfter),
          mealTypes: ['breakfast', 'lunch', 'dinner'] as MealType[],
        };
      }
      case 'week': {
        const weekEnd = new Date(today);
        weekEnd.setDate(weekEnd.getDate() + 6);
        return {
          startDate: todayStr,
          endDate: formatLocalDate(weekEnd),
          mealTypes: ['breakfast', 'lunch', 'dinner'] as MealType[],
        };
      }
      case 'days': {
        const count = Math.max(1, Math.min(14, shoppingRange.daysCount));
        const endDay = new Date(today);
        endDay.setDate(endDay.getDate() + count - 1);
        return {
          startDate: todayStr,
          endDate: formatLocalDate(endDay),
          mealTypes: ['breakfast', 'lunch', 'dinner'] as MealType[],
        };
      }
      default:
        return {
          startDate: todayStr,
          endDate: todayStr,
          mealTypes: ['breakfast', 'lunch', 'dinner'] as MealType[],
        };
    }
  }

  async function executeRegenerate() {
    if (isRegenerating) return;
    setShowRangeModal(false);
    setIsRegenerating(true);

    const dateRange = calculateDateRange();

    try {
      const api = getApi();
      const body: Record<string, any> = {
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        mealTypes: dateRange.mealTypes,
      };

      // 人数設定を送信（デフォルト以外の場合）
      if (servings !== 2) {
        body.servingsConfig = { default: servings };
      }

      const response = await api.post<{ requestId?: string }>("/api/shopping-list/regenerate", body);

      // 非同期処理：requestIdが返ってくるのでポーリング
      if (response.requestId) {
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

        return;
      }

      await load();
      setIsRegenerating(false);
    } catch (e: any) {
      setIsRegenerating(false);
      Alert.alert("再生成失敗", e?.message ?? "再生成に失敗しました。");
    }
  }

  function openRangeModal() {
    if (isRegenerating) return;
    setRangeStep('range');
    setIsTodayExpanded(false);
    setShowRangeModal(true);
  }

  const rangeLabel = (type: RangeType) => {
    switch (type) {
      case 'today': return '今日の分';
      case 'tomorrow': return '明日の分';
      case 'dayAfterTomorrow': return '明後日の分';
      case 'days': return `${shoppingRange.daysCount}日分`;
      case 'week': return '1週間分';
    }
  };

  const mealLabel = (meal: MealType) =>
    meal === 'breakfast' ? '朝食' : meal === 'lunch' ? '昼食' : '夕食';

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
              onPress={openRangeModal}
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

      {/* Range Selection Modal */}
      <Modal
        visible={showRangeModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowRangeModal(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }}
          onPress={() => setShowRangeModal(false)}
        >
          <Pressable
            style={{
              backgroundColor: colors.card,
              borderTopLeftRadius: radius['2xl'],
              borderTopRightRadius: radius['2xl'],
              padding: spacing.lg,
              paddingBottom: spacing['3xl'],
              maxHeight: '80%',
            }}
            onPress={(e) => e.stopPropagation()}
          >
            <ScrollView showsVerticalScrollIndicator={false}>

              {/* Step 1: 範囲選択 */}
              {rangeStep === 'range' && (
                <>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.lg }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                      <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>買い物の範囲を選択</Text>
                      <View style={{ backgroundColor: colors.bg, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 }}>
                        <Text style={{ fontSize: 11, color: colors.textMuted }}>ステップ 1/2</Text>
                      </View>
                    </View>
                    <Pressable
                      onPress={() => setShowRangeModal(false)}
                      hitSlop={8}
                      style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Ionicons name="close" size={14} color={colors.textLight} />
                    </Pressable>
                  </View>

                  <View style={{ gap: spacing.sm }}>
                    {/* 今日の分 */}
                    <View>
                      <Pressable
                        onPress={() => {
                          if (shoppingRange.type === 'today') {
                            setIsTodayExpanded(!isTodayExpanded);
                          } else {
                            setShoppingRange({ ...shoppingRange, type: 'today' });
                            setIsTodayExpanded(true);
                          }
                        }}
                        style={{
                          padding: spacing.md,
                          borderRadius: radius.md,
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          backgroundColor: shoppingRange.type === 'today' ? colors.accent : colors.bg,
                          borderWidth: 1,
                          borderColor: shoppingRange.type === 'today' ? colors.accent : colors.border,
                        }}
                      >
                        <Text style={{ fontSize: 14, fontWeight: '500', color: shoppingRange.type === 'today' ? '#fff' : colors.text }}>
                          今日の分
                        </Text>
                        {shoppingRange.type === 'today' && (
                          <Ionicons
                            name={isTodayExpanded ? "chevron-up" : "chevron-down"}
                            size={16}
                            color="#fff"
                          />
                        )}
                      </Pressable>

                      {/* 食事タイプ選択（今日のみ） */}
                      {shoppingRange.type === 'today' && isTodayExpanded && (
                        <View style={{ paddingLeft: spacing.lg, paddingTop: spacing.sm, gap: spacing.xs }}>
                          {(['breakfast', 'lunch', 'dinner'] as MealType[]).map((mealType) => {
                            const isSelected = shoppingRange.todayMeals.includes(mealType);
                            return (
                              <Pressable
                                key={mealType}
                                onPress={() => {
                                  const newMeals = isSelected
                                    ? shoppingRange.todayMeals.filter(m => m !== mealType)
                                    : [...shoppingRange.todayMeals, mealType];
                                  setShoppingRange({ ...shoppingRange, todayMeals: newMeals });
                                }}
                                style={{
                                  padding: spacing.sm,
                                  borderRadius: radius.sm,
                                  flexDirection: 'row',
                                  alignItems: 'center',
                                  gap: spacing.sm,
                                  backgroundColor: isSelected ? `${colors.accent}18` : 'transparent',
                                }}
                              >
                                <View
                                  style={{
                                    width: 20,
                                    height: 20,
                                    borderRadius: 4,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    backgroundColor: isSelected ? colors.accent : 'transparent',
                                    borderWidth: 2,
                                    borderColor: isSelected ? colors.accent : colors.border,
                                  }}
                                >
                                  {isSelected && <Ionicons name="checkmark" size={12} color="#fff" />}
                                </View>
                                <Text style={{ fontSize: 13, color: colors.text }}>{mealLabel(mealType)}</Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      )}
                    </View>

                    {/* 明日の分 */}
                    <Pressable
                      onPress={() => setShoppingRange({ ...shoppingRange, type: 'tomorrow' })}
                      style={{
                        padding: spacing.md,
                        borderRadius: radius.md,
                        backgroundColor: shoppingRange.type === 'tomorrow' ? colors.accent : colors.bg,
                        borderWidth: 1,
                        borderColor: shoppingRange.type === 'tomorrow' ? colors.accent : colors.border,
                      }}
                    >
                      <Text style={{ fontSize: 14, fontWeight: '500', color: shoppingRange.type === 'tomorrow' ? '#fff' : colors.text }}>
                        明日の分
                      </Text>
                    </Pressable>

                    {/* 明後日の分 */}
                    <Pressable
                      onPress={() => setShoppingRange({ ...shoppingRange, type: 'dayAfterTomorrow' })}
                      style={{
                        padding: spacing.md,
                        borderRadius: radius.md,
                        backgroundColor: shoppingRange.type === 'dayAfterTomorrow' ? colors.accent : colors.bg,
                        borderWidth: 1,
                        borderColor: shoppingRange.type === 'dayAfterTomorrow' ? colors.accent : colors.border,
                      }}
                    >
                      <Text style={{ fontSize: 14, fontWeight: '500', color: shoppingRange.type === 'dayAfterTomorrow' ? '#fff' : colors.text }}>
                        明後日の分
                      </Text>
                    </Pressable>

                    {/* ○○日分 */}
                    <View>
                      <Pressable
                        onPress={() => setShoppingRange({ ...shoppingRange, type: 'days' })}
                        style={{
                          padding: spacing.md,
                          borderRadius: radius.md,
                          backgroundColor: shoppingRange.type === 'days' ? colors.accent : colors.bg,
                          borderWidth: 1,
                          borderColor: shoppingRange.type === 'days' ? colors.accent : colors.border,
                        }}
                      >
                        <Text style={{ fontSize: 14, fontWeight: '500', color: shoppingRange.type === 'days' ? '#fff' : colors.text }}>
                          {shoppingRange.daysCount}日分
                        </Text>
                      </Pressable>

                      {shoppingRange.type === 'days' && (
                        <View style={{ paddingLeft: spacing.lg, paddingTop: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                          <TextInput
                            value={daysCountInput}
                            onChangeText={(v) => {
                              setDaysCountInput(v);
                              const n = parseInt(v);
                              if (!isNaN(n) && n >= 1 && n <= 14) {
                                setShoppingRange({ ...shoppingRange, daysCount: n });
                              }
                            }}
                            keyboardType="number-pad"
                            style={{
                              width: 64,
                              padding: spacing.sm,
                              borderRadius: radius.sm,
                              backgroundColor: colors.bg,
                              borderWidth: 1,
                              borderColor: colors.border,
                              textAlign: 'center',
                              fontSize: 14,
                              color: colors.text,
                            }}
                          />
                          <Text style={{ fontSize: 13, color: colors.textMuted }}>日分（今日から・最大14日）</Text>
                        </View>
                      )}
                    </View>

                    {/* 1週間分 */}
                    <Pressable
                      onPress={() => setShoppingRange({ ...shoppingRange, type: 'week' })}
                      style={{
                        padding: spacing.md,
                        borderRadius: radius.md,
                        backgroundColor: shoppingRange.type === 'week' ? colors.accent : colors.bg,
                        borderWidth: 1,
                        borderColor: shoppingRange.type === 'week' ? colors.accent : colors.border,
                      }}
                    >
                      <Text style={{ fontSize: 14, fontWeight: '500', color: shoppingRange.type === 'week' ? '#fff' : colors.text }}>
                        1週間分
                      </Text>
                    </Pressable>
                  </View>

                  {/* 次へボタン */}
                  <Pressable
                    onPress={() => setRangeStep('servings')}
                    disabled={shoppingRange.type === 'today' && shoppingRange.todayMeals.length === 0}
                    style={({ pressed }) => ({
                      marginTop: spacing.lg,
                      padding: spacing.md,
                      borderRadius: radius.md,
                      backgroundColor: (shoppingRange.type === 'today' && shoppingRange.todayMeals.length === 0)
                        ? colors.textMuted
                        : pressed ? colors.accentDark : colors.accent,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: spacing.sm,
                    })}
                  >
                    <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>次へ（人数確認）</Text>
                    <Ionicons name="chevron-forward" size={18} color="#fff" />
                  </Pressable>
                </>
              )}

              {/* Step 2: 人数設定 */}
              {rangeStep === 'servings' && (
                <>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.lg }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                      <Pressable
                        onPress={() => setRangeStep('range')}
                        hitSlop={8}
                        style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}
                      >
                        <Ionicons name="chevron-back" size={14} color={colors.textLight} />
                      </Pressable>
                      <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>人数を確認</Text>
                      <View style={{ backgroundColor: colors.bg, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 }}>
                        <Text style={{ fontSize: 11, color: colors.textMuted }}>ステップ 2/2</Text>
                      </View>
                    </View>
                    <Pressable
                      onPress={() => setShowRangeModal(false)}
                      hitSlop={8}
                      style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Ionicons name="close" size={14} color={colors.textLight} />
                    </Pressable>
                  </View>

                  {/* 選択した範囲の表示 */}
                  <View style={{
                    backgroundColor: colors.accentLight,
                    padding: spacing.md,
                    borderRadius: radius.md,
                    marginBottom: spacing.lg,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.sm,
                  }}>
                    <Ionicons name="calendar-outline" size={16} color={colors.accent} />
                    <Text style={{ fontSize: 13, color: colors.accent, fontWeight: '600' }}>
                      {rangeLabel(shoppingRange.type)}
                      {shoppingRange.type === 'today' && shoppingRange.todayMeals.length < 3
                        ? ` (${shoppingRange.todayMeals.map(mealLabel).join('・')})`
                        : ''}
                    </Text>
                  </View>

                  <Text style={{ fontSize: 13, color: colors.textLight, marginBottom: spacing.md }}>
                    何人分の材料を計算しますか？
                  </Text>

                  {/* 人数セレクター */}
                  <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: spacing.xl,
                    backgroundColor: colors.bg,
                    padding: spacing.lg,
                    borderRadius: radius.md,
                    marginBottom: spacing.lg,
                  }}>
                    <Pressable
                      onPress={() => setServings(Math.max(1, servings - 1))}
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 22,
                        backgroundColor: colors.card,
                        borderWidth: 1,
                        borderColor: colors.border,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Text style={{ fontSize: 20, fontWeight: '700', color: colors.text }}>−</Text>
                    </Pressable>
                    <View style={{ alignItems: 'center' }}>
                      <Text style={{ fontSize: 36, fontWeight: '700', color: colors.text }}>{servings}</Text>
                      <Text style={{ fontSize: 12, color: colors.textMuted }}>人分</Text>
                    </View>
                    <Pressable
                      onPress={() => setServings(Math.min(10, servings + 1))}
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 22,
                        backgroundColor: colors.card,
                        borderWidth: 1,
                        borderColor: colors.border,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Text style={{ fontSize: 20, fontWeight: '700', color: colors.text }}>+</Text>
                    </Pressable>
                  </View>

                  {/* 生成ボタン */}
                  <Pressable
                    onPress={executeRegenerate}
                    style={({ pressed }) => ({
                      padding: spacing.md,
                      borderRadius: radius.md,
                      backgroundColor: pressed ? colors.accentDark : colors.accent,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: spacing.sm,
                    })}
                  >
                    <Ionicons name="sparkles" size={18} color="#fff" />
                    <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>この設定で買い物リストを生成</Text>
                  </Pressable>
                </>
              )}

            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

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
          onAction={openRangeModal}
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
