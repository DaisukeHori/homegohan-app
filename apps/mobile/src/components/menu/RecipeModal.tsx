import { NUTRIENT_DEFINITIONS } from "@homegohan/shared";
import { Ionicons } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  Alert,
  Image,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { getApi } from "../../lib/api";
import { colors, radius, spacing } from "../../theme";
import { RoleBadge } from "./RoleBadge";

// ============================================================
// Types
// ============================================================

export interface RecipeModalDishNutrients {
  caloriesKcal?: number | null;
  proteinG?: number | null;
  fatG?: number | null;
  carbsG?: number | null;
  fiberG?: number | null;
  sugarG?: number | null;
  sodiumG?: number | null;
  potassiumMg?: number | null;
  calciumMg?: number | null;
  magnesiumMg?: number | null;
  phosphorusMg?: number | null;
  ironMg?: number | null;
  zincMg?: number | null;
  iodineUg?: number | null;
  vitaminAUg?: number | null;
  vitaminB1Mg?: number | null;
  vitaminB2Mg?: number | null;
  vitaminB6Mg?: number | null;
  vitaminB12Ug?: number | null;
  vitaminCMg?: number | null;
  vitaminDUg?: number | null;
  vitaminEMg?: number | null;
  vitaminKUg?: number | null;
  folicAcidUg?: number | null;
  saturatedFatG?: number | null;
  cholesterolMg?: number | null;
}

export interface RecipeModalDish {
  /** meal の DB id (like/shopping API 用) */
  mealId: string;
  name: string;
  role?: string | null;
  kcal?: number | null;
  imageUrl?: string | null;
  imageStatus?: string | null;
  ingredientsMd?: string | null;
  recipeStepsMd?: string | null;
  ingredients?: string[] | null;
  recipeSteps?: string[] | null;
  nutrients?: RecipeModalDishNutrients | null;
}

interface Props {
  visible: boolean;
  dish: RecipeModalDish | null;
  onClose: () => void;
}

// ============================================================
// Markdown パーサー
// ============================================================

/**
 * Markdown テーブル形式の材料データをパースする
 * 例:
 * | 材料 | 分量 |
 * |------|------|
 * | 卵 | 2個 |
 */
const parseIngredientsTable = (md: string): { name: string; amount: string }[] => {
  if (!md) return [];
  const lines = md.split("\n").filter((l) => {
    const trimmed = l.trim();
    return trimmed && !trimmed.startsWith("|--") && !trimmed.startsWith("|:-");
  });
  const results: { name: string; amount: string }[] = [];
  for (const line of lines) {
    const cells = line.split("|").map((c) => c.trim()).filter((c) => c);
    if (cells.length < 2) continue;
    // ヘッダー行スキップ (材料 / 分量)
    if (cells[0] === "材料" || cells[0] === "食材") continue;
    results.push({ name: cells[0], amount: cells[1] });
  }
  return results;
};

/**
 * 番号付きリスト形式の作り方ステップをパースする
 * 例: "1. 野菜を切る。"
 * ingredients 配列もフォールバックとして使用する
 */
const parseRecipeSteps = (md: string): string[] => {
  if (!md) return [];
  return md
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+\./.test(l));
};

/**
 * ingredients 配列から材料リストを生成する (ingredientsMd がない場合のフォールバック)
 */
const buildIngredientsFromArray = (arr: string[]): { name: string; amount: string }[] => {
  return arr.filter((s) => s).map((s) => ({ name: s, amount: "" }));
};

/**
 * recipeSteps 配列をパースする (recipeStepsMd がない場合のフォールバック)
 */
const buildStepsFromArray = (arr: string[]): string[] => {
  return arr
    .filter((s) => s)
    .map((s, i) => `${i + 1}. ${s.replace(/^\d+\.\s*/, "")}`);
};

// ============================================================
// サブコンポーネント
// ============================================================

const SectionHeader: React.FC<{ icon: string; title: string }> = ({ icon, title }) => (
  <View style={styles.sectionHeader}>
    <Text style={styles.sectionIcon}>{icon}</Text>
    <Text style={styles.sectionTitle}>{title}</Text>
  </View>
);

// ============================================================
// Component
// ============================================================

export const RecipeModal: React.FC<Props> = ({ visible, dish, onClose }) => {
  const [favorited, setFavorited] = useState(false);
  const [isAddingToShopping, setIsAddingToShopping] = useState(false);

  React.useEffect(() => {
    if (dish) {
      setFavorited(false);
      const fetchLikeStatus = async () => {
        try {
          const api = getApi();
          const res = await api.get<{ liked: boolean }>(`/api/recipes/${dish.mealId}/like`);
          setFavorited(res.liked);
        } catch {
          // ignore
        }
      };
      fetchLikeStatus();
    }
  }, [dish?.mealId]);

  const toggleFavorite = async () => {
    if (!dish) return;
    const prev = favorited;
    setFavorited(!prev);
    try {
      const api = getApi();
      if (!prev) {
        await api.post(`/api/recipes/${dish.mealId}/like`, {});
      } else {
        await api.del(`/api/recipes/${dish.mealId}/like`);
      }
    } catch {
      setFavorited(prev);
    }
  };

  const addToShopping = async () => {
    if (!dish) return;
    setIsAddingToShopping(true);
    try {
      // ingredientsMd or ingredients からリストを収集
      let ingredientNames: string[] = [];
      const parsedFromMd = dish.ingredientsMd
        ? parseIngredientsTable(dish.ingredientsMd)
        : [];
      if (parsedFromMd.length > 0) {
        ingredientNames = parsedFromMd.map((i) => i.name);
      } else if (dish.ingredients && dish.ingredients.length > 0) {
        ingredientNames = dish.ingredients;
      }

      if (ingredientNames.length === 0) {
        Alert.alert("材料情報なし", "この料理には材料情報がありません。");
        return;
      }
      const api = getApi();
      await api.post("/api/shopping-list/add-recipe", {
        ingredients: ingredientNames.map((name) => ({ name })),
      });
      Alert.alert("追加しました", "材料を買い物リストに追加しました。");
    } catch {
      Alert.alert("エラー", "買い物リストへの追加に失敗しました。");
    } finally {
      setIsAddingToShopping(false);
    }
  };

  if (!dish) return null;

  // 材料データ解決
  const ingredientRows: { name: string; amount: string }[] = dish.ingredientsMd
    ? parseIngredientsTable(dish.ingredientsMd)
    : dish.ingredients && dish.ingredients.length > 0
    ? buildIngredientsFromArray(dish.ingredients)
    : [];

  // 作り方データ解決
  const stepLines: string[] = dish.recipeStepsMd
    ? parseRecipeSteps(dish.recipeStepsMd)
    : dish.recipeSteps && dish.recipeSteps.length > 0
    ? buildStepsFromArray(dish.recipeSteps)
    : [];

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.card }}>
        <View testID="recipe-modal" style={styles.sheet}>
          {/* ヘッダー */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Ionicons name="book-outline" size={18} color={colors.accent} />
              <Text style={styles.title} numberOfLines={2}>
                {dish.name}
              </Text>
            </View>
            <Pressable onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </Pressable>
          </View>

          {/* バッジ行: 役割 + kcal */}
          <View style={styles.badgeRow}>
            {dish.role ? <RoleBadge role={dish.role} /> : null}
            {dish.kcal != null && (
              <View style={styles.kcalBadge}>
                <Ionicons name="flame-outline" size={12} color={colors.textMuted} />
                <Text style={styles.kcalText}>{dish.kcal} kcal</Text>
              </View>
            )}
          </View>

          <ScrollView
            style={styles.scrollArea}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {/* AI 料理画像 */}
            {(dish.imageUrl || dish.imageStatus) && (
              <View style={styles.imageSection}>
                {dish.imageUrl ? (
                  <Image source={{ uri: dish.imageUrl }} style={styles.dishImage} resizeMode="cover" />
                ) : (
                  <View style={styles.imagePlaceholder}>
                    <Ionicons name="image-outline" size={32} color={colors.textMuted} />
                    <Text style={styles.placeholderText}>料理画像を生成中です</Text>
                    <Text style={styles.placeholderSubtext}>AIが料理画像を生成しています。</Text>
                  </View>
                )}
              </View>
            )}

            {/* この料理の栄養素 */}
            {dish.nutrients && (
              <View style={styles.section}>
                <SectionHeader icon="📊" title="この料理の栄養素" />
                <View style={styles.nutrientsGrid}>
                  {NUTRIENT_DEFINITIONS.map((def) => {
                    const raw = (dish.nutrients as Record<string, number | null | undefined>)?.[def.key];
                    const value = raw ?? 0;
                    const displayValue =
                      value === 0
                        ? "-"
                        : def.decimals === 0
                        ? String(Math.round(value))
                        : value.toFixed(def.decimals).replace(/\.?0+$/, "");
                    return (
                      <View key={def.key} style={styles.nutrientItem}>
                        <Text style={styles.nutrientLabel} numberOfLines={1}>
                          {def.label}
                        </Text>
                        <Text style={styles.nutrientValue}>
                          {displayValue}
                          {value !== 0 ? def.unit : ""}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            )}

            {/* 材料 */}
            <View style={styles.section}>
              <SectionHeader icon="🥕" title="材料" />
              {ingredientRows.length > 0 ? (
                <View style={styles.ingredientsTable}>
                  <View style={styles.tableHeaderRow}>
                    <Text style={[styles.tableHeaderCell, { flex: 2 }]}>材料</Text>
                    <Text style={[styles.tableHeaderCell, { flex: 1 }]}>分量</Text>
                  </View>
                  {ingredientRows.map((ing, i) => (
                    <View
                      key={i}
                      style={[
                        styles.tableRow,
                        i % 2 === 0 ? styles.tableRowEven : styles.tableRowOdd,
                      ]}
                    >
                      <Text style={[styles.tableCell, { flex: 2 }]}>{ing.name}</Text>
                      <Text style={[styles.tableCell, { flex: 1 }]}>{ing.amount}</Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={styles.emptyText}>材料情報なし</Text>
              )}
            </View>

            {/* 作り方 */}
            <View style={styles.section}>
              <SectionHeader icon="👨‍🍳" title="作り方" />
              {stepLines.length > 0 ? (
                <View style={styles.stepList}>
                  {stepLines.map((step, i) => (
                    <View key={i} style={styles.stepRow}>
                      <View style={styles.stepNum}>
                        <Text style={styles.stepNumText}>{i + 1}</Text>
                      </View>
                      <Text style={styles.stepText}>
                        {step.replace(/^\d+\.\s*/, "")}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={styles.emptyText}>
                  レシピはAI献立を生成すると自動で作成されます。
                </Text>
              )}
            </View>
          </ScrollView>

          {/* フッター固定 */}
          <View style={styles.footer}>
            <Pressable
              testID="recipe-favorite-btn"
              onPress={toggleFavorite}
              style={[styles.favoriteBtn, favorited && styles.favoriteBtnActive]}
              accessibilityLabel={favorited ? "お気に入りから削除" : "お気に入りに追加"}
            >
              <Ionicons
                name={favorited ? "heart" : "heart-outline"}
                size={22}
                color={favorited ? "#FF6B6B" : colors.textMuted}
              />
            </Pressable>
            <Pressable
              testID="recipe-add-to-shopping-btn"
              onPress={addToShopping}
              disabled={isAddingToShopping}
              style={({ pressed }) => [
                styles.shoppingBtn,
                (pressed || isAddingToShopping) && styles.shoppingBtnPressed,
              ]}
            >
              <Ionicons name="cart-outline" size={18} color="#fff" />
              <Text style={styles.shoppingBtnText}>
                {isAddingToShopping ? "追加中..." : "材料を買い物リストに追加"}
              </Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
};

// ============================================================
// Styles
// ============================================================

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  headerLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  kcalBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  kcalText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  scrollArea: {
    flexShrink: 1,
  },
  scrollContent: {
    padding: spacing.lg,
    gap: spacing.lg,
    paddingBottom: spacing.xl,
  },
  // 画像
  imageSection: {
    borderRadius: radius.lg,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
  },
  dishImage: {
    width: "100%",
    height: 192,
  },
  imagePlaceholder: {
    height: 192,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
  },
  placeholderText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textMuted,
  },
  placeholderSubtext: {
    fontSize: 12,
    color: colors.textMuted,
  },
  // セクション共通
  section: {
    gap: spacing.sm,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  sectionIcon: {
    fontSize: 14,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.text,
  },
  // 栄養素グリッド
  nutrientsGrid: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: spacing.md,
    flexDirection: "row",
    flexWrap: "wrap",
  },
  nutrientItem: {
    width: "33.33%",
    paddingVertical: 4,
    paddingHorizontal: spacing.xs,
  },
  nutrientLabel: {
    fontSize: 10,
    color: colors.textMuted,
  },
  nutrientValue: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.text,
  },
  // 材料テーブル
  ingredientsTable: {
    borderRadius: radius.md,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
  },
  tableHeaderRow: {
    flexDirection: "row",
    backgroundColor: colors.bg,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  tableHeaderCell: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.text,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  tableRowEven: {
    backgroundColor: colors.card,
  },
  tableRowOdd: {
    backgroundColor: colors.bg,
  },
  tableCell: {
    fontSize: 13,
    color: colors.text,
  },
  emptyText: {
    fontSize: 13,
    color: colors.textMuted,
    fontStyle: "italic",
  },
  // 作り方
  stepList: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  stepNum: {
    width: 22,
    height: 22,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginTop: 1,
  },
  stepNumText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#fff",
  },
  stepText: {
    flex: 1,
    fontSize: 13,
    color: colors.text,
    lineHeight: 20,
  },
  // フッター
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  favoriteBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  favoriteBtnActive: {
    backgroundColor: "#FFF0F0",
  },
  shoppingBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  shoppingBtnPressed: {
    opacity: 0.8,
  },
  shoppingBtnText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#fff",
  },
});
