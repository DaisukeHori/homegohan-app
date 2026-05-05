import {
  CheckCircle,
  ChefHat,
  FastForward,
  Search,
  Sparkles,
  Store,
  UtensilsCrossed,
  X,
  XCircle,
  Zap,
} from "lucide-react-native";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";

import type { MealType } from "@homegohan/shared";
import { MEAL_LABELS } from "@homegohan/shared";
import { getApi } from "../../lib/api";
import { colors, radius, spacing } from "../../theme";

// ─── Types ────────────────────────────────────────────────────────────────────

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

type ActionMode = "cook" | "quick" | "buy" | "out" | "ai_creative";

interface ActionConfig {
  mode: ActionMode;
  label: string;
  Icon: React.ComponentType<any>;
  bgColor: string;
  textColor: string;
  outline?: boolean;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** user_daily_meals.id (plan 未作成時は null — API 側で自動作成) */
  dayId: string | null;
  /** 対応する日付文字列 YYYY-MM-DD (POST に必要) */
  dayDate: string;
  mealType: MealType;
  onSuccess?: () => void;
  /** 「AIに提案してもらう」タップ時のコールバック (未指定時は何もしない) */
  onRequestAiSuggest?: () => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ACTIONS: ActionConfig[] = [
  {
    mode: "cook",
    label: "自炊で追加",
    Icon: ChefHat,
    bgColor: colors.successLight,
    textColor: colors.success,
  },
  {
    mode: "quick",
    label: "時短で追加",
    Icon: Zap,
    bgColor: colors.blueLight,
    textColor: colors.blue,
  },
  {
    mode: "buy",
    label: "買うで追加",
    Icon: Store,
    bgColor: colors.purpleLight,
    textColor: colors.purple,
  },
  {
    mode: "out",
    label: "外食で追加",
    Icon: UtensilsCrossed,
    bgColor: colors.warningLight,
    textColor: colors.warning,
  },
  {
    mode: "ai_creative",
    label: "AI献立で追加",
    Icon: Sparkles,
    bgColor: colors.accentLight,
    textColor: colors.accent,
  },
];

const DEFAULT_DISH_NAMES: Record<ActionMode, string> = {
  cook: "自炊メニュー",
  quick: "時短メニュー",
  buy: "コンビニ・惣菜",
  out: "外食",
  ai_creative: "AI献立",
};

// ─── Component ────────────────────────────────────────────────────────────────

export function AddMealModal({
  visible,
  onClose,
  dayId: _dayId,
  dayDate,
  mealType,
  onSuccess,
  onRequestAiSuggest,
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogProduct[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<CatalogProduct | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const cancelledRef = useRef(false);

  const mealLabel = MEAL_LABELS[mealType] ?? "食事";

  // Reset state when modal opens
  useEffect(() => {
    if (visible) {
      setQuery("");
      setResults([]);
      setIsSearching(false);
      setSearchError("");
      setSelectedProduct(null);
      setIsSubmitting(false);
    }
  }, [visible]);

  // 250ms debounce catalog search
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearchError("");
      setIsSearching(false);
      return;
    }
    cancelledRef.current = false;
    const timer = setTimeout(async () => {
      setIsSearching(true);
      setSearchError("");
      try {
        const api = getApi();
        const data = await api.get<{ products: CatalogProduct[] }>(
          `/api/catalog/products?q=${encodeURIComponent(q)}&limit=8`
        );
        if (!cancelledRef.current) {
          setResults(Array.isArray(data.products) ? data.products : []);
        }
      } catch (e: any) {
        if (!cancelledRef.current) {
          setResults([]);
          setSearchError(e?.message ?? "商品検索に失敗しました");
        }
      } finally {
        if (!cancelledRef.current) setIsSearching(false);
      }
    }, 250);
    return () => {
      cancelledRef.current = true;
      clearTimeout(timer);
    };
  }, [query]);

  const submitAction = async (mode: ActionMode) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      const catalogProduct =
        (mode === "buy" || mode === "out") ? selectedProduct : null;
      await api.post("/api/meal-plans/meals", {
        dayDate,
        mealType,
        mode,
        dishName: catalogProduct?.name ?? DEFAULT_DISH_NAMES[mode],
        isSimple: true,
        catalogProductId: catalogProduct?.id ?? null,
        sourceType: catalogProduct ? "catalog_product" : "manual",
      });
      onSuccess?.();
      onClose();
    } catch (e: any) {
      Alert.alert("追加失敗", e?.message ?? "食事の追加に失敗しました");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAiSuggest = () => {
    onClose();
    onRequestAiSuggest?.();
  };

  return (
    <Modal
      testID="add-meal-modal"
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
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
              backgroundColor: colors.bg,
            }}
          >
            <Text style={{ fontSize: 17, fontWeight: "700", color: colors.text }}>
              {mealLabel}を追加
            </Text>
            <Pressable onPress={onClose} hitSlop={8} style={{ padding: 4 }}>
              <X size={22} color={colors.textMuted} />
            </Pressable>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}
            keyboardShouldPersistTaps="handled"
          >
            {/* 検索セクションヘッダー */}
            <Text style={{ fontSize: 12, color: colors.textMuted, marginBottom: 4 }}>
              市販品・外食メニューから選ぶ
            </Text>

            {/* 検索 input */}
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
              <Search size={16} color={colors.textMuted} />
              <TextInput
                testID="add-meal-search-input"
                value={query}
                onChangeText={(text) => {
                  setQuery(text);
                  if (selectedProduct) setSelectedProduct(null);
                }}
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
              {isSearching && <ActivityIndicator size="small" color={colors.accent} />}
            </View>

            {/* ヒント文 */}
            <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>
              選んだ商品は「買う」か「外食」で追加すると公開栄養値ごと保存されます。
            </Text>

            {/* 検索状態メッセージ */}
            {isSearching && (
              <Text style={{ fontSize: 12, color: colors.textMuted }}>検索中...</Text>
            )}
            {searchError ? (
              <Text style={{ fontSize: 12, color: colors.error }}>{searchError}</Text>
            ) : null}

            {/* 検索結果リスト */}
            {results.length > 0 && (
              <View style={{ gap: spacing.sm }}>
                {results.map((product, index) => {
                  const isSelected = selectedProduct?.id === product.id;
                  return (
                    <Pressable
                      key={product.id}
                      testID={`add-meal-result-${index}`}
                      onPress={() => setSelectedProduct(isSelected ? null : product)}
                      style={{
                        padding: spacing.md,
                        borderRadius: radius.lg,
                        backgroundColor: isSelected ? colors.purpleLight : colors.card,
                        borderWidth: 1,
                        borderColor: isSelected ? colors.purple : colors.border,
                        flexDirection: "row",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: spacing.md,
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        {product.brandName ? (
                          <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 2 }}>
                            {product.brandName}
                          </Text>
                        ) : null}
                        <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text }}>
                          {product.name}
                        </Text>
                        {product.categoryCode ? (
                          <Text style={{ fontSize: 11, color: colors.textLight, marginTop: 2 }}>
                            {product.categoryCode}
                            {product.priceYen ? ` / ${product.priceYen}円` : ""}
                          </Text>
                        ) : null}
                      </View>
                      <View style={{ alignItems: "flex-end" }}>
                        <Text style={{ fontSize: 11, color: colors.textMuted }}>
                          {product.caloriesKcal ?? "-"} kcal
                        </Text>
                        <Text style={{ fontSize: 10, color: colors.textLight }}>
                          P {product.proteinG != null ? product.proteinG.toFixed(1) : "-"}g
                        </Text>
                        <Text style={{ fontSize: 10, color: colors.textLight }}>
                          F {product.fatG != null ? product.fatG.toFixed(1) : "-"}g
                        </Text>
                        <Text style={{ fontSize: 10, color: colors.textLight }}>
                          C {product.carbsG != null ? product.carbsG.toFixed(1) : "-"}g
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}

            {/* 選択済み商品 */}
            {selectedProduct && (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: spacing.sm,
                  paddingVertical: spacing.sm,
                  paddingHorizontal: spacing.md,
                  backgroundColor: colors.purpleLight,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: colors.purple,
                }}
              >
                <CheckCircle size={16} color={colors.purple} />
                <Text style={{ flex: 1, fontSize: 13, color: colors.text, fontWeight: "600" }}>
                  {selectedProduct.name}
                </Text>
                <Pressable
                  onPress={() => {
                    setSelectedProduct(null);
                    setQuery("");
                    setResults([]);
                  }}
                  hitSlop={8}
                >
                  <XCircle size={16} color={colors.textMuted} />
                </Pressable>
              </View>
            )}

            {/* 6 アクションボタン */}
            <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
              {ACTIONS.map((action) => (
                <Pressable
                  key={action.mode}
                  testID={`add-meal-action-${action.mode}`}
                  onPress={() => submitAction(action.mode)}
                  disabled={isSubmitting}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: spacing.sm,
                    padding: spacing.md,
                    borderRadius: radius.lg,
                    backgroundColor: action.bgColor,
                    opacity: pressed || isSubmitting ? 0.7 : 1,
                  })}
                >
                  {isSubmitting ? (
                    <ActivityIndicator size="small" color={action.textColor} />
                  ) : (
                    <action.Icon size={20} color={action.textColor} />
                  )}
                  <Text style={{ fontSize: 14, fontWeight: "500", color: action.textColor }}>
                    {action.label}
                  </Text>
                </Pressable>
              ))}

              {/* AIに提案してもらう (outline ボタン) */}
              <Pressable
                testID="add-meal-action-ai_suggest"
                onPress={handleAiSuggest}
                disabled={isSubmitting}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: spacing.sm,
                  padding: spacing.md,
                  borderRadius: radius.lg,
                  backgroundColor: colors.accentLight,
                  borderWidth: 1.5,
                  borderColor: colors.accent,
                  opacity: pressed || isSubmitting ? 0.7 : 1,
                })}
              >
                <Sparkles size={20} color={colors.accent} />
                <Text style={{ fontSize: 14, fontWeight: "500", color: colors.accent }}>
                  AIに提案してもらう
                </Text>
              </Pressable>
            </View>

            {/* bottom padding for safe area */}
            <View style={{ height: spacing.xl }} />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
