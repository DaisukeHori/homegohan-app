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

import type { MealType } from "@homegohan/shared";
import { getApi } from "../../lib/api";
import { colors, radius, shadows, spacing } from "../../theme";

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

type Mode = "cook" | "buy" | "out" | "quick";

interface Props {
  visible: boolean;
  onClose: () => void;
  /** user_daily_meals.id */
  dayId: string;
  /** 対応する日付文字列 YYYY-MM-DD (POST に必要) */
  dayDate: string;
  mealType: MealType;
  onSuccess?: () => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MODE_CONFIG: Record<Mode, { label: string; icon: keyof typeof Ionicons.glyphMap; bg: string; color: string }> = {
  cook:  { label: "自炊",   icon: "restaurant-outline",  bg: colors.successLight, color: colors.success },
  quick: { label: "時短",   icon: "flash-outline",       bg: colors.blueLight,    color: colors.blue },
  buy:   { label: "買う",   icon: "bag-handle-outline",  bg: colors.purpleLight,  color: colors.purple },
  out:   { label: "外食",   icon: "fork-outline" as any, bg: colors.warningLight, color: colors.warning },
};

const MODES: Mode[] = ["cook", "quick", "buy", "out"];

// ─── Component ────────────────────────────────────────────────────────────────

export function AddMealModal({ visible, onClose, dayId: _dayId, dayDate, mealType, onSuccess }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogProduct[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<CatalogProduct | null>(null);
  const [selectedMode, setSelectedMode] = useState<Mode>("cook");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const cancelledRef = useRef(false);

  // Reset state when modal opens
  useEffect(() => {
    if (visible) {
      setQuery("");
      setResults([]);
      setIsSearching(false);
      setSearchError("");
      setSelectedProduct(null);
      setSelectedMode("cook");
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

  async function handleSubmit() {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.post("/api/meal-plans/meals/simple", {
        dayDate,
        mealType,
        mode: selectedMode,
        dishName: (selectedProduct?.name ?? query.trim()) || "未設定",
        isSimple: true,
        catalogProductId: selectedProduct?.id ?? undefined,
        caloriesKcal: selectedProduct?.caloriesKcal ?? undefined,
      });
      onSuccess?.();
      onClose();
    } catch (e: any) {
      Alert.alert("追加失敗", e?.message ?? "食事の追加に失敗しました");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal
      testID="add-meal-modal"
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
            maxHeight: "85%",
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
            <Text style={{ fontSize: 17, fontWeight: "700", color: colors.text }}>
              食事を追加
            </Text>
            <Pressable onPress={onClose} hitSlop={8} style={{ padding: 4 }}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </Pressable>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}
            keyboardShouldPersistTaps="handled"
          >
            {/* 検索 */}
            <Text style={{ fontSize: 12, color: colors.textMuted, marginBottom: 4 }}>
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
              <Ionicons name="search" size={16} color={colors.textMuted} />
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
                        backgroundColor: isSelected ? colors.accentLight : colors.card,
                        borderWidth: 1,
                        borderColor: isSelected ? colors.accent : colors.border,
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
                  backgroundColor: colors.accentLight,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: colors.accent,
                }}
              >
                <Ionicons name="checkmark-circle" size={16} color={colors.accent} />
                <Text style={{ flex: 1, fontSize: 13, color: colors.text, fontWeight: "600" }}>
                  {selectedProduct.name}
                </Text>
                <Pressable onPress={() => setSelectedProduct(null)} hitSlop={8}>
                  <Ionicons name="close-circle" size={16} color={colors.textMuted} />
                </Pressable>
              </View>
            )}

            {/* モード選択 */}
            <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text, marginTop: spacing.sm }}>
              追加方法
            </Text>
            <View style={{ gap: spacing.sm }}>
              {MODES.map((mode) => {
                const cfg = MODE_CONFIG[mode];
                const isActive = selectedMode === mode;
                return (
                  <Pressable
                    key={mode}
                    testID={`add-meal-mode-${mode}`}
                    onPress={() => setSelectedMode(mode)}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: spacing.md,
                      padding: spacing.md,
                      borderRadius: radius.lg,
                      backgroundColor: isActive ? cfg.bg : colors.card,
                      borderWidth: 1,
                      borderColor: isActive ? cfg.color : colors.border,
                    }}
                  >
                    <Ionicons name={cfg.icon} size={20} color={cfg.color} />
                    <Text style={{ fontSize: 14, fontWeight: isActive ? "700" : "500", color: colors.text }}>
                      {cfg.label}で追加
                    </Text>
                    {isActive && (
                      <View style={{ marginLeft: "auto" }}>
                        <Ionicons name="checkmark-circle" size={18} color={cfg.color} />
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>

          {/* 追加ボタン */}
          <View
            style={{
              paddingHorizontal: spacing.lg,
              paddingTop: spacing.md,
              borderTopWidth: 1,
              borderTopColor: colors.border,
            }}
          >
            <Pressable
              testID="add-meal-submit-btn"
              onPress={handleSubmit}
              disabled={isSubmitting}
              style={({ pressed }) => ({
                alignItems: "center",
                justifyContent: "center",
                paddingVertical: spacing.md,
                borderRadius: radius.lg,
                backgroundColor: isSubmitting ? colors.textMuted : colors.accent,
                opacity: pressed || isSubmitting ? 0.8 : 1,
                flexDirection: "row",
                gap: spacing.sm,
              })}
            >
              {isSubmitting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="add-circle-outline" size={18} color="#fff" />
              )}
              <Text style={{ fontSize: 15, fontWeight: "700", color: "#fff" }}>
                {isSubmitting ? "追加中..." : "追加"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
