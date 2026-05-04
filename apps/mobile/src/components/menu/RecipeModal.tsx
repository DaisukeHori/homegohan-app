import { Ionicons } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { getApi } from "../../lib/api";
import { colors, radius, shadows, spacing } from "../../theme";

// ============================================================
// Types
// ============================================================

interface DishDetail {
  name: string;
  role?: string;
  ingredients?: string[];
  ingredientsMd?: string;
  recipeSteps?: string[];
  recipeStepsMd?: string;
}

export interface RecipeModalMeal {
  id: string;
  dish_name: string;
  calories_kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  ingredients?: string[];
  recipe_steps?: string[] | null;
  dishes?: DishDetail[] | null;
  role?: string | null;
}

interface Props {
  visible: boolean;
  meal: RecipeModalMeal | null;
  onClose: () => void;
}

// ============================================================
// Helpers
// ============================================================

function renderIngredients(dish: DishDetail, fallback?: string[]): string[] | null {
  if (dish.ingredientsMd) return null; // handled separately
  if (dish.ingredients && dish.ingredients.length > 0) return dish.ingredients;
  if (fallback && fallback.length > 0) return fallback;
  return null;
}

function renderSteps(dish: DishDetail, fallback?: string[] | null): string[] | null {
  if (dish.recipeStepsMd) return null; // handled separately
  if (dish.recipeSteps && dish.recipeSteps.length > 0) return dish.recipeSteps;
  if (fallback && fallback.length > 0) return fallback;
  return null;
}

function collectIngredients(meal: RecipeModalMeal): Array<{ name: string }> {
  const all: string[] = [];

  if (meal.dishes && meal.dishes.length > 0) {
    meal.dishes.forEach((dish) => {
      if (dish.ingredients) all.push(...dish.ingredients);
    });
  }

  if (all.length === 0 && meal.ingredients) {
    all.push(...meal.ingredients);
  }

  return all.map((name) => ({ name }));
}

// ============================================================
// Component
// ============================================================

export const RecipeModal: React.FC<Props> = ({ visible, meal, onClose }) => {
  const [favorited, setFavorited] = useState(false);
  const [isAddingToShopping, setIsAddingToShopping] = useState(false);

  // Reset favorited state when meal changes
  React.useEffect(() => {
    if (meal) {
      setFavorited(false);
      // Fetch current like status
      const fetchLikeStatus = async () => {
        try {
          const api = getApi();
          const res = await api.get<{ liked: boolean }>(`/api/recipes/${meal.id}/like`);
          setFavorited(res.liked);
        } catch {
          // ignore
        }
      };
      fetchLikeStatus();
    }
  }, [meal?.id]);

  const toggleFavorite = async () => {
    if (!meal) return;
    const prev = favorited;
    setFavorited(!prev); // 楽観的更新
    try {
      const api = getApi();
      if (!prev) {
        await api.post(`/api/recipes/${meal.id}/like`, {});
      } else {
        await api.del(`/api/recipes/${meal.id}/like`);
      }
    } catch {
      setFavorited(prev); // revert
    }
  };

  const addToShopping = async () => {
    if (!meal) return;
    setIsAddingToShopping(true);
    try {
      const ingredients = collectIngredients(meal);
      if (ingredients.length === 0) {
        Alert.alert("材料情報なし", "この料理には材料情報がありません。");
        return;
      }
      const api = getApi();
      await api.post("/api/shopping-list/add-recipe", { ingredients });
      Alert.alert("追加しました", "材料を買い物リストに追加しました。");
    } catch {
      Alert.alert("エラー", "買い物リストへの追加に失敗しました。");
    } finally {
      setIsAddingToShopping(false);
    }
  };

  if (!meal) return null;

  const dishes: DishDetail[] =
    meal.dishes && meal.dishes.length > 0
      ? meal.dishes
      : [
          {
            name: meal.dish_name,
            role: meal.role ?? undefined,
            ingredients: meal.ingredients,
            recipeSteps: meal.recipe_steps ?? undefined,
          },
        ];

  const hasNutrition =
    meal.protein_g != null || meal.fat_g != null || meal.carbs_g != null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View testID="recipe-modal" style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={styles.sheet}>
          {/* ヘッダー */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Text style={styles.title} numberOfLines={2}>
                {meal.dish_name}
              </Text>
              {meal.calories_kcal != null && (
                <View style={styles.calorieRow}>
                  <Ionicons name="flame-outline" size={13} color={colors.textMuted} />
                  <Text style={styles.calorieText}>{meal.calories_kcal} kcal</Text>
                </View>
              )}
            </View>
            <View style={styles.headerRight}>
              {/* お気に入りボタン */}
              <Pressable
                testID="recipe-favorite-btn"
                onPress={toggleFavorite}
                style={[styles.iconBtn, favorited && styles.iconBtnActive]}
                accessibilityLabel={favorited ? "お気に入りから削除" : "お気に入りに追加"}
              >
                <Ionicons
                  name={favorited ? "heart" : "heart-outline"}
                  size={20}
                  color={favorited ? "#FF6B6B" : colors.textMuted}
                />
              </Pressable>
              {/* 閉じるボタン */}
              <Pressable onPress={onClose} style={styles.iconBtn}>
                <Ionicons name="close" size={20} color={colors.textMuted} />
              </Pressable>
            </View>
          </View>

          <ScrollView
            style={styles.scrollArea}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {/* dishes 一覧 */}
            {dishes.map((dish, index) => (
              <View key={index} testID={`recipe-dish-${index}`} style={styles.dishBlock}>
                {/* 料理名 */}
                <Text style={styles.dishName}>
                  {dish.name || meal.dish_name}
                </Text>

                {/* 材料 */}
                <Text style={styles.sectionLabel}>🥕 材料</Text>
                {dish.ingredientsMd ? (
                  <View style={styles.mdBlock}>
                    <Text style={styles.mdText}>{dish.ingredientsMd}</Text>
                  </View>
                ) : (
                  (() => {
                    const ings = renderIngredients(dish, meal.ingredients);
                    return ings ? (
                      <View style={styles.ingredientList}>
                        {ings.map((ing, i) => (
                          <Text key={i} style={styles.ingredientItem}>
                            ・{ing}
                          </Text>
                        ))}
                      </View>
                    ) : (
                      <Text style={styles.emptyText}>材料情報なし</Text>
                    );
                  })()
                )}

                {/* 作り方 */}
                <Text style={[styles.sectionLabel, { marginTop: spacing.md }]}>
                  👨‍🍳 作り方
                </Text>
                {dish.recipeStepsMd ? (
                  <View style={styles.mdBlock}>
                    <Text style={styles.mdText}>{dish.recipeStepsMd}</Text>
                  </View>
                ) : (
                  (() => {
                    const steps = renderSteps(
                      dish,
                      meal.recipe_steps ?? undefined
                    );
                    return steps ? (
                      <View style={styles.stepList}>
                        {steps.map((step, i) => (
                          <View key={i} style={styles.stepRow}>
                            <View style={styles.stepNum}>
                              <Text style={styles.stepNumText}>{i + 1}</Text>
                            </View>
                            <Text style={styles.stepText}>{step}</Text>
                          </View>
                        ))}
                      </View>
                    ) : (
                      <Text style={styles.emptyText}>
                        レシピはAI献立を生成すると自動で作成されます。
                      </Text>
                    );
                  })()
                )}
              </View>
            ))}

            {/* 栄養サマリー */}
            {hasNutrition && (
              <View style={styles.nutritionBlock}>
                <Text style={styles.sectionLabel}>📊 栄養</Text>
                <View style={styles.nutritionRow}>
                  {meal.protein_g != null && (
                    <View style={styles.nutritionItem}>
                      <Text style={styles.nutritionValue}>{meal.protein_g.toFixed(1)}g</Text>
                      <Text style={styles.nutritionLabel}>タンパク質</Text>
                    </View>
                  )}
                  {meal.fat_g != null && (
                    <View style={styles.nutritionItem}>
                      <Text style={styles.nutritionValue}>{meal.fat_g.toFixed(1)}g</Text>
                      <Text style={styles.nutritionLabel}>脂質</Text>
                    </View>
                  )}
                  {meal.carbs_g != null && (
                    <View style={styles.nutritionItem}>
                      <Text style={styles.nutritionValue}>{meal.carbs_g.toFixed(1)}g</Text>
                      <Text style={styles.nutritionLabel}>炭水化物</Text>
                    </View>
                  )}
                </View>
              </View>
            )}
          </ScrollView>

          {/* 買い物リストに追加 */}
          <View style={styles.footer}>
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
      </View>
    </Modal>
  );
};

// ============================================================
// Styles
// ============================================================

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    maxHeight: "85%",
    ...shadows.lg,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerLeft: {
    flex: 1,
    gap: 4,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginLeft: spacing.sm,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.text,
  },
  calorieRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  calorieText: {
    fontSize: 13,
    color: colors.textMuted,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  iconBtnActive: {
    backgroundColor: "#FFF0F0",
  },
  scrollArea: {
    flexShrink: 1,
  },
  scrollContent: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  dishBlock: {
    gap: spacing.sm,
  },
  dishName: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.text,
    marginBottom: 2,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
  },
  mdBlock: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  mdText: {
    fontSize: 13,
    color: colors.text,
    lineHeight: 20,
  },
  ingredientList: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 4,
  },
  ingredientItem: {
    fontSize: 13,
    color: colors.text,
  },
  emptyText: {
    fontSize: 13,
    color: colors.textMuted,
    fontStyle: "italic",
  },
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
  nutritionBlock: {
    gap: spacing.sm,
  },
  nutritionRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  nutritionItem: {
    flex: 1,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: "center",
    gap: 2,
  },
  nutritionValue: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
  },
  nutritionLabel: {
    fontSize: 11,
    color: colors.textMuted,
  },
  footer: {
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  shoppingBtn: {
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
    fontSize: 15,
    fontWeight: "700",
    color: "#fff",
  },
});
