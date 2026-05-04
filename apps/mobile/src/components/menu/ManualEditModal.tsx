import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";

import { getApi } from "../../lib/api";
import { colors, radius, shadows, spacing } from "../../theme";
import { DishEditor, type DishItem } from "./DishEditor";
import { PhotoEditModal, type MealAnalysis } from "./PhotoEditModal";

// ─── Types ───────────────────────────────────────────────────────────────────

interface CatalogProduct {
  id: string;
  name: string;
  brandName: string;
  categoryCode: string | null;
  caloriesKcal: number | null;
  proteinG: number | null;
  fatG: number | null;
  carbsG: number | null;
  priceYen: number | null;
}

/** weekly index.tsx の PlannedMealRow の最小サブセット */
export interface ManualEditMeal {
  id: string;
  dish_name: string;
  mode: string | null;
  calories_kcal: number | null;
  dishes: Array<{
    name?: string | null;
    role?: string | null;
    calories_kcal?: number | null;
    [key: string]: unknown;
  }> | null;
}

interface Props {
  visible: boolean;
  meal: ManualEditMeal | null;
  onClose: () => void;
  onSave: (updated: ManualEditMeal) => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MODE_OPTIONS = [
  {
    mode: "cook",
    label: "自炊",
    icon: "restaurant" as const,
    bg: colors.successLight,
    fg: colors.success,
  },
  {
    mode: "quick",
    label: "時短",
    icon: "flash" as const,
    bg: colors.blueLight,
    fg: colors.blue,
  },
  {
    mode: "buy",
    label: "買う",
    icon: "bag" as const,
    bg: colors.purpleLight,
    fg: colors.purple,
  },
  {
    mode: "out",
    label: "外食",
    icon: "restaurant-outline" as const,
    bg: colors.warningLight,
    fg: colors.warning,
  },
  {
    mode: "skip",
    label: "なし",
    icon: "remove-circle" as const,
    bg: "#F5F5F5",
    fg: colors.textMuted,
  },
  {
    mode: "ai_creative",
    label: "AI献立",
    icon: "sparkles" as const,
    bg: colors.accentLight,
    fg: colors.accent,
  },
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mealToDishes(meal: ManualEditMeal | null): DishItem[] {
  if (!meal) return [];
  if (Array.isArray(meal.dishes) && meal.dishes.length > 0) {
    return meal.dishes.map((d) => ({
      name: d.name ?? "",
      role: d.role ?? "main",
      kcal: d.calories_kcal ?? null,
    }));
  }
  // dishes が空なら dish_name から初期 1 件を生成
  return [
    {
      name: meal.dish_name ?? "",
      role: "main",
      kcal: meal.calories_kcal ?? null,
    },
  ];
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ManualEditModal({ visible, meal, onClose, onSave }: Props) {
  const [manualMode, setManualMode] = useState<string>("cook");
  const [dishes, setDishes] = useState<DishItem[]>([]);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogResults, setCatalogResults] = useState<CatalogProduct[]>([]);
  const [isCatalogSearching, setIsCatalogSearching] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  /** カタログ検索パネルを表示する dish index (null = 非表示) */
  const [showCatalog, setShowCatalog] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [showPhotoEdit, setShowPhotoEdit] = useState(false);

  const cancelledRef = useRef(false);

  // モーダルが開いたとき state 初期化
  useEffect(() => {
    if (visible && meal) {
      setManualMode(meal.mode ?? "cook");
      setDishes(mealToDishes(meal));
      setShowCatalog(null);
      setCatalogQuery("");
      setCatalogResults([]);
      setCatalogError("");
      setIsSaving(false);
      setShowPhotoEdit(false);
    }
  }, [visible, meal]);

  // カタログ debounce 検索 (250ms)
  useEffect(() => {
    if (showCatalog === null) {
      setCatalogResults([]);
      setCatalogError("");
      setIsCatalogSearching(false);
      return;
    }
    const q = catalogQuery.trim();
    if (q.length < 2) {
      setCatalogResults([]);
      setCatalogError("");
      setIsCatalogSearching(false);
      return;
    }
    cancelledRef.current = false;
    const timer = setTimeout(async () => {
      setIsCatalogSearching(true);
      setCatalogError("");
      try {
        const api = getApi();
        const data = await api.get<{ products: CatalogProduct[] }>(
          `/api/catalog/products?q=${encodeURIComponent(q)}&limit=8`
        );
        if (!cancelledRef.current) {
          setCatalogResults(Array.isArray(data.products) ? data.products : []);
        }
      } catch (e: any) {
        if (!cancelledRef.current) {
          setCatalogResults([]);
          setCatalogError(e?.message ?? "商品検索に失敗しました");
        }
      } finally {
        if (!cancelledRef.current) setIsCatalogSearching(false);
      }
    }, 250);
    return () => {
      cancelledRef.current = true;
      clearTimeout(timer);
    };
  }, [catalogQuery, showCatalog]);

  // ─── Dish operations ─────────────────────────────────────────────────────

  function updateDish(index: number, d: DishItem) {
    setDishes((prev: DishItem[]) =>
      prev.map((item: DishItem, i: number) => (i === index ? d : item))
    );
  }

  function removeDish(index: number) {
    setDishes((prev: DishItem[]) =>
      prev.filter((_: DishItem, i: number) => i !== index)
    );
  }

  function addDish() {
    setDishes((prev: DishItem[]) => [
      ...prev,
      { name: "", role: "main", kcal: null },
    ]);
  }

  function selectCatalogProduct(product: CatalogProduct) {
    if (showCatalog === null) return;
    updateDish(showCatalog, {
      name: product.name,
      role: dishes[showCatalog]?.role ?? "main",
      kcal: product.caloriesKcal ?? null,
    });
    setShowCatalog(null);
    setCatalogQuery("");
    setCatalogResults([]);
  }

  // ─── Save ─────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!meal || isSaving) return;
    setIsSaving(true);
    try {
      const api = getApi();
      const totalKcal = dishes.reduce((sum, d) => sum + (d.kcal ?? 0), 0);
      const dishesPayload = dishes.map((d) => ({
        name: d.name,
        role: d.role,
        calories_kcal: d.kcal ?? 0,
      }));
      await api.patch(`/api/meal-plans/meals/${meal.id}`, {
        dishes: dishesPayload,
        dishName: dishes[0]?.name ?? meal.dish_name,
        caloriesKcal: totalKcal || null,
        mode: manualMode,
      });
      const updated: ManualEditMeal = {
        ...meal,
        dish_name: dishes[0]?.name ?? meal.dish_name,
        calories_kcal: totalKcal || null,
        mode: manualMode,
        dishes: dishesPayload.map((d) => ({
          name: d.name,
          role: d.role,
          calories_kcal: d.calories_kcal,
        })),
      };
      onSave(updated);
      onClose();
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました");
    } finally {
      setIsSaving(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  function handlePhotoResult(analysis: MealAnalysis) {
    const newDishes: DishItem[] = analysis.dishes.map((d) => ({
      name: d.name,
      role: d.role ?? "main",
      kcal: d.kcal ?? null,
    }));
    setDishes((prev) => [...prev, ...newDishes]);
  }

  return (
    <>
      <Modal
        testID="manual-edit-modal"
        visible={visible}
        animationType="slide"
        transparent
        onRequestClose={onClose}
      >
        <View
          style={{
            flex: 1,
            justifyContent: "flex-end",
            backgroundColor: "rgba(0,0,0,0.4)",
          }}
        >
          <View
            style={{
              backgroundColor: colors.bg,
              borderTopLeftRadius: radius["2xl"],
              borderTopRightRadius: radius["2xl"],
              maxHeight: "92%",
              paddingBottom: spacing["2xl"],
              ...shadows.lg,
            }}
          >
            {/* ヘッダー */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                padding: spacing.lg,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
              }}
            >
              <Text
                style={{ fontSize: 17, fontWeight: "700", color: colors.text }}
              >
                手動で変更
              </Text>
              <Pressable onPress={onClose} hitSlop={8} style={{ padding: 4 }}>
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </Pressable>
            </View>

            {/* カタログ検索パネル */}
            {showCatalog !== null ? (
              <View style={{ flex: 1 }}>
                {/* カタログヘッダー */}
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: spacing.sm,
                    padding: spacing.lg,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.border,
                  }}
                >
                  <Pressable onPress={() => setShowCatalog(null)} hitSlop={8}>
                    <Ionicons
                      name="arrow-back"
                      size={20}
                      color={colors.accent}
                    />
                  </Pressable>
                  <Text
                    style={{
                      fontSize: 15,
                      fontWeight: "600",
                      color: colors.text,
                    }}
                  >
                    カタログ検索
                  </Text>
                </View>

                {/* 検索入力 */}
                <View style={{ padding: spacing.lg, gap: spacing.sm }}>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      backgroundColor: colors.card,
                      borderRadius: radius.lg,
                      borderWidth: 1,
                      borderColor: colors.border,
                      paddingHorizontal: spacing.md,
                      gap: spacing.sm,
                    }}
                  >
                    <Ionicons
                      name="search"
                      size={16}
                      color={colors.textMuted}
                    />
                    <TextInput
                      testID="manual-edit-catalog-search-input"
                      value={catalogQuery}
                      onChangeText={setCatalogQuery}
                      placeholder="商品名で検索"
                      placeholderTextColor={colors.textMuted}
                      style={{
                        flex: 1,
                        paddingVertical: spacing.md,
                        fontSize: 14,
                        color: colors.text,
                      }}
                      autoFocus
                      autoCorrect={false}
                      autoCapitalize="none"
                    />
                    {isCatalogSearching && (
                      <ActivityIndicator size="small" color={colors.accent} />
                    )}
                  </View>

                  {catalogError ? (
                    <Text style={{ fontSize: 12, color: colors.error }}>
                      {catalogError}
                    </Text>
                  ) : null}
                </View>

                {/* 検索結果 */}
                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={{
                    paddingHorizontal: spacing.lg,
                    gap: spacing.sm,
                    paddingBottom: spacing.lg,
                  }}
                  keyboardShouldPersistTaps="handled"
                >
                  {catalogResults.map((product, idx) => (
                    <Pressable
                      key={product.id}
                      testID={`manual-edit-catalog-result-${idx}`}
                      onPress={() => selectCatalogProduct(product)}
                      style={{
                        padding: spacing.md,
                        borderRadius: radius.lg,
                        backgroundColor: colors.card,
                        borderWidth: 1,
                        borderColor: colors.border,
                        flexDirection: "row",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: spacing.md,
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        {product.brandName ? (
                          <Text
                            style={{
                              fontSize: 11,
                              color: colors.textMuted,
                              marginBottom: 2,
                            }}
                          >
                            {product.brandName}
                          </Text>
                        ) : null}
                        <Text
                          style={{
                            fontSize: 13,
                            fontWeight: "600",
                            color: colors.text,
                          }}
                        >
                          {product.name}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 11, color: colors.textMuted }}>
                        {product.caloriesKcal ?? "-"} kcal
                      </Text>
                    </Pressable>
                  ))}

                  {!isCatalogSearching &&
                    catalogQuery.trim().length >= 2 &&
                    catalogResults.length === 0 &&
                    !catalogError && (
                      <Text
                        style={{
                          fontSize: 13,
                          color: colors.textMuted,
                          textAlign: "center",
                          marginTop: spacing.xl,
                        }}
                      >
                        検索結果がありません
                      </Text>
                    )}
                </ScrollView>
              </View>
            ) : (
              /* メイン編集パネル */
              <>
                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={{
                    padding: spacing.lg,
                    gap: spacing.md,
                  }}
                  keyboardShouldPersistTaps="handled"
                >
                  {/* ─── タイプ ─── */}
                  <View>
                    <Text
                      style={{
                        fontSize: 12,
                        color: colors.textMuted,
                        marginBottom: spacing.sm,
                      }}
                    >
                      タイプ
                    </Text>
                    <View
                      style={{
                        flexDirection: "row",
                        flexWrap: "wrap",
                        gap: spacing.sm,
                      }}
                    >
                      {MODE_OPTIONS.map((opt) => {
                        const isSelected = manualMode === opt.mode;
                        return (
                          <Pressable
                            key={opt.mode}
                            testID={`manual-edit-mode-${opt.mode}`}
                            onPress={() => setManualMode(opt.mode)}
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              gap: spacing.xs,
                              paddingHorizontal: spacing.md,
                              paddingVertical: spacing.sm,
                              borderRadius: radius.lg,
                              backgroundColor: isSelected ? opt.bg : colors.card,
                              borderWidth: 1.5,
                              borderColor: isSelected ? opt.fg : colors.border,
                            }}
                          >
                            <Ionicons
                              name={opt.icon}
                              size={14}
                              color={isSelected ? opt.fg : colors.textMuted}
                            />
                            <Text
                              style={{
                                fontSize: 12,
                                fontWeight: isSelected ? "700" : "500",
                                color: isSelected ? opt.fg : colors.textMuted,
                              }}
                            >
                              {opt.label}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>

                  {/* ─── 市販品・外食メニューから選ぶ ─── */}
                  <View>
                    <Text
                      style={{
                        fontSize: 12,
                        color: colors.textMuted,
                        marginBottom: spacing.sm,
                      }}
                    >
                      市販品・外食メニューから選ぶ
                    </Text>
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        backgroundColor: colors.card,
                        borderRadius: radius.lg,
                        borderWidth: 1,
                        borderColor: colors.border,
                        paddingHorizontal: spacing.md,
                        gap: spacing.sm,
                      }}
                    >
                      <Ionicons
                        name="search-outline"
                        size={16}
                        color={colors.textMuted}
                      />
                      <TextInput
                        testID="manual-edit-search-input"
                        value={catalogQuery}
                        onChangeText={setCatalogQuery}
                        placeholder="商品名で検索"
                        placeholderTextColor={colors.textMuted}
                        style={{
                          flex: 1,
                          paddingVertical: spacing.md,
                          fontSize: 14,
                          color: colors.text,
                        }}
                        autoCorrect={false}
                        autoCapitalize="none"
                      />
                      {isCatalogSearching && (
                        <ActivityIndicator size="small" color={colors.accent} />
                      )}
                    </View>
                    <Text
                      style={{
                        fontSize: 11,
                        color: colors.textMuted,
                        marginTop: spacing.xs,
                      }}
                    >
                      コンビニだけでなく、今後はスーパーや外食メニューも同じ catalog で追加します。
                    </Text>
                    {catalogError ? (
                      <Text
                        style={{
                          fontSize: 12,
                          color: colors.error,
                          marginTop: spacing.xs,
                        }}
                      >
                        {catalogError}
                      </Text>
                    ) : null}
                  </View>

                  {/* ─── 料理（複数可） ─── */}
                  <View>
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: spacing.sm,
                      }}
                    >
                      <Text style={{ fontSize: 12, color: colors.textMuted }}>
                        料理（複数可）
                      </Text>
                      <Pressable
                        testID="manual-edit-add-dish"
                        onPress={addDish}
                        hitSlop={8}
                        style={{ flexDirection: "row", alignItems: "center", gap: 2 }}
                      >
                        <Ionicons
                          name="add"
                          size={14}
                          color={colors.accent}
                        />
                        <Text
                          style={{
                            fontSize: 12,
                            fontWeight: "600",
                            color: colors.accent,
                          }}
                        >
                          追加
                        </Text>
                      </Pressable>
                    </View>

                    {/* Dishes リスト */}
                    <View style={{ gap: spacing.sm }}>
                      {dishes.map((dish, i) => (
                        <DishEditor
                          key={i}
                          dish={dish}
                          index={i}
                          onChange={(d) => updateDish(i, d)}
                          onDelete={() => removeDish(i)}
                          onOpenCatalog={() => {
                            setShowCatalog(i);
                            setCatalogQuery(dish.name);
                            setCatalogResults([]);
                          }}
                        />
                      ))}
                    </View>
                  </View>
                </ScrollView>

                {/* フッター */}
                <View
                  style={{
                    paddingHorizontal: spacing.lg,
                    paddingTop: spacing.md,
                    borderTopWidth: 1,
                    borderTopColor: colors.border,
                    gap: spacing.sm,
                  }}
                >
                  {/* 写真から入力 / AI画像生成 */}
                  <View style={{ flexDirection: "row", gap: spacing.sm }}>
                    <Pressable
                      testID="manual-edit-photo-btn"
                      onPress={() => setShowPhotoEdit(true)}
                      style={({ pressed }) => ({
                        flex: 1,
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: spacing.xs,
                        paddingVertical: spacing.sm,
                        borderRadius: radius.lg,
                        backgroundColor: colors.blueLight,
                        borderWidth: 1,
                        borderColor: colors.blue,
                        opacity: pressed ? 0.7 : 1,
                      })}
                    >
                      <Ionicons
                        name="camera-outline"
                        size={16}
                        color={colors.blue}
                      />
                      <Text
                        style={{
                          fontSize: 12,
                          fontWeight: "600",
                          color: colors.blue,
                        }}
                      >
                        写真から入力
                      </Text>
                    </Pressable>

                    <Pressable
                      testID="manual-edit-image-gen-btn"
                      disabled
                      style={{
                        flex: 1,
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: spacing.xs,
                        paddingVertical: spacing.sm,
                        borderRadius: radius.lg,
                        backgroundColor: colors.accentLight,
                        borderWidth: 1,
                        borderColor: colors.accent,
                        opacity: 0.5,
                      }}
                    >
                      <Ionicons
                        name="color-palette-outline"
                        size={16}
                        color={colors.accent}
                      />
                      <Text
                        style={{
                          fontSize: 12,
                          fontWeight: "600",
                          color: colors.accent,
                        }}
                      >
                        AIで画像生成
                      </Text>
                    </Pressable>
                  </View>

                  {/* 保存ボタン */}
                  <Pressable
                    testID="manual-edit-save-btn"
                    onPress={handleSave}
                    disabled={isSaving}
                    style={({ pressed }) => ({
                      alignItems: "center",
                      justifyContent: "center",
                      paddingVertical: spacing.md,
                      borderRadius: radius.lg,
                      backgroundColor: isSaving
                        ? colors.textMuted
                        : colors.accent,
                      opacity: pressed || isSaving ? 0.8 : 1,
                      flexDirection: "row",
                      gap: spacing.sm,
                    })}
                  >
                    {isSaving ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Ionicons
                        name="checkmark-circle-outline"
                        size={18}
                        color="#fff"
                      />
                    )}
                    <Text
                      style={{
                        fontSize: 15,
                        fontWeight: "700",
                        color: "#fff",
                      }}
                    >
                      {isSaving ? "保存中..." : "保存する"}
                    </Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
      <PhotoEditModal
        visible={showPhotoEdit}
        onClose={() => setShowPhotoEdit(false)}
        onResult={handlePhotoResult}
      />
    </>
  );
}
