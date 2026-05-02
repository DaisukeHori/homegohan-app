import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";

import { Button, Card, EmptyState, Input, LoadingState, PageHeader } from "../../src/components/ui";
import { getApi } from "../../src/lib/api";
import { colors, spacing, radius } from "../../src/theme";

type RecipeListItem = {
  id: string;
  name: string;
  authorName: string;
  description: string | null;
  cookingTimeMinutes: number | null;
  caloriesKcal: number | null;
  category: string | null;
  cuisineType: string | null;
  difficulty: string | null;
  likeCount: number;
  isLiked: boolean;
  isPublic: boolean;
};

const CATEGORY_OPTIONS = [
  { value: "", label: "すべて" },
  { value: "main", label: "主菜" },
  { value: "side", label: "副菜" },
  { value: "soup", label: "汁物" },
  { value: "salad", label: "サラダ" },
  { value: "rice", label: "ご飯" },
  { value: "noodle", label: "麺類" },
  { value: "bread", label: "パン" },
  { value: "dessert", label: "デザート" },
  { value: "snack", label: "おやつ" },
  { value: "drink", label: "飲み物" },
  { value: "other", label: "その他" },
];

const CUISINE_OPTIONS = [
  { value: "", label: "すべて" },
  { value: "japanese", label: "和食" },
  { value: "western", label: "洋食" },
  { value: "chinese", label: "中華" },
  { value: "italian", label: "イタリアン" },
  { value: "french", label: "フレンチ" },
  { value: "korean", label: "韓国料理" },
  { value: "asian", label: "アジア料理" },
  { value: "other", label: "その他" },
];

const DIFFICULTY_OPTIONS = [
  { value: "", label: "すべて" },
  { value: "easy", label: "簡単" },
  { value: "medium", label: "普通" },
  { value: "hard", label: "難しい" },
];

const MAX_TIME_OPTIONS = [
  { value: "", label: "指定なし" },
  { value: "15", label: "15分以内" },
  { value: "30", label: "30分以内" },
  { value: "45", label: "45分以内" },
  { value: "60", label: "60分以内" },
  { value: "90", label: "90分以内" },
];

type FilterChipProps = {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
};

function FilterChip({ label, selected, onPress, testID }: FilterChipProps) {
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      style={{
        paddingHorizontal: spacing.md,
        paddingVertical: 6,
        borderRadius: radius.xl,
        backgroundColor: selected ? colors.accent : colors.card,
        borderWidth: 1,
        borderColor: selected ? colors.accent : colors.border,
      }}
    >
      <Text style={{ fontSize: 12, fontWeight: "700", color: selected ? "#FFFFFF" : colors.textLight }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

export default function RecipesPage() {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [cuisineType, setCuisineType] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [maxTime, setMaxTime] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [items, setItems] = useState<RecipeListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const params = new URLSearchParams({ limit: "30" });
      if (q) params.set("q", q);
      if (category) params.set("category", category);
      if (cuisineType) params.set("cuisine_type", cuisineType);
      if (difficulty) params.set("difficulty", difficulty);
      if (maxTime) params.set("max_time", maxTime);
      const res = await api.get<{ recipes: RecipeListItem[] }>(`/api/recipes?${params.toString()}`);
      setItems(res.recipes ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleLike(recipeId: string, next: boolean) {
    const api = getApi();
    if (next) {
      await api.post(`/api/recipes/${recipeId}/like`, {});
    } else {
      await api.del(`/api/recipes/${recipeId}/like`);
    }
    await load();
  }

  const hasActiveFilters = !!(category || cuisineType || difficulty || maxTime);

  return (
    <View testID="recipes-screen" style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader
        title="レシピ"
        right={
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <Button onPress={() => router.push("/recipes/collections")} variant="ghost" size="sm">
              <Ionicons name="folder-outline" size={18} color={colors.textLight} />
            </Button>
            <Button onPress={() => router.push("/recipes/new")} variant="primary" size="sm">
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                <Ionicons name="add" size={16} color="#FFFFFF" />
                <Text style={{ color: "#FFFFFF", fontWeight: "700", fontSize: 13 }}>新規</Text>
              </View>
            </Button>
          </View>
        }
      />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>

        {/* 検索バー */}
        <Card>
          <View style={{ gap: spacing.sm }}>
            <View style={{ flexDirection: "row", gap: spacing.sm }}>
              <View style={{ flex: 1 }}>
                <Input
                  testID="recipes-search-input"
                  value={q}
                  onChangeText={setQ}
                  placeholder="検索（例: からあげ）"
                />
              </View>
              <Button onPress={() => setShowFilters(!showFilters)} variant={hasActiveFilters ? "secondary" : "ghost"} size="sm">
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <Ionicons name="options-outline" size={16} color={hasActiveFilters ? colors.accent : colors.textLight} />
                </View>
              </Button>
            </View>
            <Button onPress={load} variant="secondary" size="sm">
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                <Ionicons name="search" size={16} color={colors.text} />
                <Text style={{ color: colors.text, fontWeight: "700", fontSize: 13 }}>検索</Text>
              </View>
            </Button>
          </View>
        </Card>

        {/* フィルターパネル */}
        {showFilters && (
          <Card>
            <View style={{ gap: spacing.md }}>
              {/* カテゴリ */}
              <View style={{ gap: spacing.xs }}>
                <Text style={{ fontSize: 12, fontWeight: "700", color: colors.textLight }}>カテゴリ</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={{ flexDirection: "row", gap: spacing.xs }}>
                    {CATEGORY_OPTIONS.map((opt) => (
                      <FilterChip
                        key={opt.value}
                        testID={`recipes-category-filter-${opt.value === "" ? "all" : opt.value}`}
                        label={opt.label}
                        selected={category === opt.value}
                        onPress={() => setCategory(opt.value)}
                      />
                    ))}
                  </View>
                </ScrollView>
              </View>

              {/* 料理の種類 */}
              <View style={{ gap: spacing.xs }}>
                <Text style={{ fontSize: 12, fontWeight: "700", color: colors.textLight }}>料理の種類</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={{ flexDirection: "row", gap: spacing.xs }}>
                    {CUISINE_OPTIONS.map((opt) => (
                      <FilterChip
                        key={opt.value}
                        label={opt.label}
                        selected={cuisineType === opt.value}
                        onPress={() => setCuisineType(opt.value)}
                      />
                    ))}
                  </View>
                </ScrollView>
              </View>

              {/* 難易度 */}
              <View style={{ gap: spacing.xs }}>
                <Text style={{ fontSize: 12, fontWeight: "700", color: colors.textLight }}>難易度</Text>
                <View style={{ flexDirection: "row", gap: spacing.xs }}>
                  {DIFFICULTY_OPTIONS.map((opt) => (
                    <FilterChip
                      key={opt.value}
                      testID={`recipes-difficulty-filter-${opt.value === "" ? "all" : opt.value}`}
                      label={opt.label}
                      selected={difficulty === opt.value}
                      onPress={() => setDifficulty(opt.value)}
                    />
                  ))}
                </View>
              </View>

              {/* 調理時間 */}
              <View testID="recipes-time-filter" style={{ gap: spacing.xs }}>
                <Text style={{ fontSize: 12, fontWeight: "700", color: colors.textLight }}>調理時間</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={{ flexDirection: "row", gap: spacing.xs }}>
                    {MAX_TIME_OPTIONS.map((opt) => (
                      <FilterChip
                        key={opt.value}
                        label={opt.label}
                        selected={maxTime === opt.value}
                        onPress={() => setMaxTime(opt.value)}
                      />
                    ))}
                  </View>
                </ScrollView>
              </View>

              {hasActiveFilters && (
                <Button
                  onPress={() => {
                    setCategory("");
                    setCuisineType("");
                    setDifficulty("");
                    setMaxTime("");
                  }}
                  variant="ghost"
                  size="sm"
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                    <Ionicons name="close-circle-outline" size={14} color={colors.textMuted} />
                    <Text style={{ color: colors.textMuted, fontSize: 12 }}>フィルターをリセット</Text>
                  </View>
                </Button>
              )}
            </View>
          </Card>
        )}

        {isLoading ? (
          <LoadingState message="レシピを読み込み中..." />
        ) : error ? (
          <Card variant="error">
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <Ionicons name="alert-circle" size={20} color={colors.error} />
              <Text style={{ color: colors.error, fontSize: 14, fontWeight: "600" }}>{error}</Text>
            </View>
          </Card>
        ) : items.length === 0 ? (
          <EmptyState
            testID="recipes-empty"
            icon={<Ionicons name="restaurant-outline" size={48} color={colors.textMuted} />}
            message="レシピがありません。"
          />
        ) : (
          <View style={{ gap: spacing.sm }}>
            <Text style={{ fontSize: 12, color: colors.textMuted }}>{items.length}件</Text>
            {items.map((r) => (
              <Card testID={`recipes-item-${r.id}`} key={r.id} onPress={() => router.push(`/recipes/${r.id}`)}>
                <View style={{ gap: spacing.sm }}>
                  <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{r.name}</Text>

                  {/* タグ行 */}
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
                    {r.category && (
                      <View style={{ backgroundColor: colors.accentLight, paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm }}>
                        <Text style={{ fontSize: 10, fontWeight: "700", color: colors.accent }}>
                          {CATEGORY_OPTIONS.find((c) => c.value === r.category)?.label ?? r.category}
                        </Text>
                      </View>
                    )}
                    {r.difficulty && (
                      <View style={{ backgroundColor: colors.bg, paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border }}>
                        <Text style={{ fontSize: 10, fontWeight: "700", color: colors.textLight }}>
                          {DIFFICULTY_OPTIONS.find((d) => d.value === r.difficulty)?.label ?? r.difficulty}
                        </Text>
                      </View>
                    )}
                    {r.cuisineType && (
                      <View style={{ backgroundColor: colors.bg, paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border }}>
                        <Text style={{ fontSize: 10, fontWeight: "700", color: colors.textLight }}>
                          {CUISINE_OPTIONS.find((c) => c.value === r.cuisineType)?.label ?? r.cuisineType}
                        </Text>
                      </View>
                    )}
                  </View>

                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                      <Ionicons name="person-outline" size={14} color={colors.textMuted} />
                      <Text style={{ fontSize: 13, color: colors.textMuted }}>{r.authorName}</Text>
                    </View>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                      <Ionicons name="time-outline" size={14} color={colors.textMuted} />
                      <Text style={{ fontSize: 13, color: colors.textMuted }}>
                        {r.cookingTimeMinutes ? `${r.cookingTimeMinutes}分` : "時間不明"}
                      </Text>
                    </View>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                      <Ionicons name="heart" size={14} color={colors.error} />
                      <Text style={{ fontSize: 13, color: colors.textMuted }}>{r.likeCount}</Text>
                    </View>
                    {r.caloriesKcal ? (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                        <Ionicons name="flame-outline" size={14} color={colors.textMuted} />
                        <Text style={{ fontSize: 13, color: colors.textMuted }}>{r.caloriesKcal}kcal</Text>
                      </View>
                    ) : null}
                  </View>

                  {r.description ? (
                    <Text style={{ fontSize: 13, color: colors.textMuted }} numberOfLines={2}>{r.description}</Text>
                  ) : null}

                  <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs }}>
                    <Button
                      testID={`recipes-like-${r.id}`}
                      onPress={() => {
                        toggleLike(r.id, !r.isLiked).catch(() => {});
                      }}
                      variant={r.isLiked ? "destructive" : "outline"}
                      size="sm"
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                        <Ionicons
                          name={r.isLiked ? "heart" : "heart-outline"}
                          size={16}
                          color={r.isLiked ? "#FFFFFF" : colors.accent}
                        />
                        <Text style={{ color: r.isLiked ? "#FFFFFF" : colors.accent, fontWeight: "700", fontSize: 13 }}>
                          {r.isLiked ? "いいね解除" : "いいね"}
                        </Text>
                      </View>
                    </Button>
                  </View>
                </View>
              </Card>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
