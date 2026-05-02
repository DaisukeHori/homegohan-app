import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { getApi } from "../../src/lib/api";
import { colors, radius, shadows, spacing } from "../../src/theme";

type FavoriteItem = {
  id: string;
  recipeName: string;
  recipeUuid: string | null;
  likedAt: string;
};

type SortOption = "newest" | "oldest" | "name";

const PAGE_SIZE = 50;

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "newest", label: "新しい順" },
  { value: "oldest", label: "古い順" },
  { value: "name", label: "名前順" },
];

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

export default function FavoritesScreen() {
  const insets = useSafeAreaInsets();
  const api = getApi();

  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sort, setSort] = useState<SortOption>("newest");
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const searchInputRef = useRef<TextInput>(null);

  const fetchFavorites = useCallback(
    async (nextOffset: number, currentQuery: string, currentSort: SortOption) => {
      if (nextOffset === 0) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      try {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(nextOffset),
          sort: currentSort,
        });
        if (currentQuery) params.set("q", currentQuery);

        const res = await api.get<{ favorites: FavoriteItem[]; total: number }>(
          `/api/favorites?${params.toString()}`,
        );
        const fetched = res.favorites ?? [];

        if (nextOffset === 0) {
          setFavorites(fetched);
        } else {
          setFavorites((prev) => [...prev, ...fetched]);
        }
        setTotal(res.total ?? 0);
        setOffset(nextOffset + fetched.length);
        setHasMore(fetched.length === PAGE_SIZE);
      } catch (err) {
        console.error("fetchFavorites error:", err);
        Alert.alert("エラー", "お気に入りの読み込みに失敗しました");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [api],
  );

  // searchQuery / sort 変更時はリセットして再取得
  useEffect(() => {
    setOffset(0);
    fetchFavorites(0, searchQuery, sort);
  }, [searchQuery, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRemove = async (item: FavoriteItem) => {
    if (removingId) return;
    setRemovingId(item.id);
    try {
      const encodedName = encodeURIComponent(item.recipeName);
      await api.del(`/api/recipes/${encodedName}/like`);
      setFavorites((prev) => prev.filter((f) => f.id !== item.id));
      setTotal((prev) => Math.max(0, prev - 1));
    } catch (err) {
      console.error("handleRemove error:", err);
      Alert.alert("エラー", "お気に入りの解除に失敗しました");
    } finally {
      setRemovingId(null);
    }
  };

  const renderItem = ({ item }: { item: FavoriteItem }) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.md,
        backgroundColor: colors.card,
        borderRadius: radius.xl,
        padding: spacing.md,
        borderWidth: 1,
        borderColor: colors.border,
        marginBottom: spacing.sm,
        ...shadows.sm,
      }}
    >
      {/* アイコン */}
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: radius.lg,
          backgroundColor: "#FFF0F0",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Ionicons name="restaurant" size={20} color="#FF6B6B" />
      </View>

      {/* レシピ情報 */}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={{
            fontWeight: "600",
            fontSize: 15,
            color: colors.text,
            marginBottom: 2,
          }}
          numberOfLines={1}
        >
          {item.recipeName}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Ionicons name="time-outline" size={11} color={colors.textMuted} />
          <Text style={{ fontSize: 12, color: colors.textMuted }}>
            {formatDate(item.likedAt)} に追加
          </Text>
        </View>
      </View>

      {/* ハートボタン */}
      <Pressable
        onPress={() => handleRemove(item)}
        disabled={removingId === item.id}
        accessibilityLabel="お気に入りから削除"
        style={({ pressed }) => ({
          width: 36,
          height: 36,
          borderRadius: 18,
          backgroundColor: removingId === item.id ? colors.bg : "#FFF0F0",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          opacity: removingId === item.id ? 0.5 : pressed ? 0.7 : 1,
        })}
      >
        <Ionicons
          name={removingId === item.id ? "heart-outline" : "heart"}
          size={18}
          color="#FF6B6B"
        />
      </Pressable>
    </View>
  );

  const renderEmpty = () => {
    if (loading) return null;
    return (
      <View
        style={{
          alignItems: "center",
          justifyContent: "center",
          paddingTop: 80,
          gap: spacing.lg,
        }}
      >
        <Ionicons name="heart-outline" size={56} color={colors.border} />
        <Text
          style={{
            color: colors.textMuted,
            fontSize: 15,
            textAlign: "center",
            lineHeight: 22,
          }}
        >
          {searchQuery
            ? `「${searchQuery}」に一致するレシピが\n見つかりませんでした`
            : "お気に入りレシピはまだありません\n週間献立のレシピからハートを押して追加できます"}
        </Text>
      </View>
    );
  };

  const renderFooter = () => {
    if (loadingMore) {
      return (
        <View style={{ paddingVertical: spacing.lg, alignItems: "center" }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      );
    }
    if (hasMore) {
      return (
        <Pressable
          onPress={() => fetchFavorites(offset, searchQuery, sort)}
          style={({ pressed }) => ({
            margin: spacing.sm,
            padding: spacing.md,
            borderRadius: radius.xl,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.card,
            alignItems: "center",
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text style={{ fontSize: 14, fontWeight: "600", color: colors.textLight }}>
            次の50件を表示
          </Text>
        </Pressable>
      );
    }
    return null;
  };

  return (
    <View testID="favorites-screen" style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <View
        style={{
          backgroundColor: colors.card,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          paddingTop: insets.top + 8,
          paddingBottom: 12,
          paddingHorizontal: spacing.lg,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="heart" size={22} color="#FF6B6B" />
            <Text style={{ fontSize: 18, fontWeight: "700", color: colors.text }}>
              お気に入りレシピ
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            {!loading && (
              <Text style={{ fontSize: 12, color: colors.textMuted }}>{total} 件</Text>
            )}
            <Pressable
              onPress={() => fetchFavorites(0, searchQuery, sort)}
              hitSlop={8}
              accessibilityLabel="再読み込み"
            >
              <Ionicons name="refresh" size={20} color={colors.textLight} />
            </Pressable>
          </View>
        </View>
      </View>

      {/* 検索 + ソート */}
      <View
        style={{
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.sm,
          gap: spacing.sm,
          backgroundColor: colors.card,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        {/* 検索ボックス */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.sm,
            backgroundColor: colors.bg,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radius.lg,
            paddingHorizontal: spacing.md,
            paddingVertical: 8,
          }}
        >
          <Ionicons name="search" size={16} color={colors.textMuted} />
          <TextInput
            ref={searchInputRef}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="レシピ名で検索..."
            placeholderTextColor={colors.textMuted}
            style={{ flex: 1, fontSize: 14, color: colors.text }}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={() => setSearchQuery("")} hitSlop={8}>
              <Ionicons name="close-circle" size={16} color={colors.textMuted} />
            </Pressable>
          )}
        </View>

        {/* ソートピッカー */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: spacing.sm }}
        >
          {SORT_OPTIONS.map((opt) => (
            <Pressable
              key={opt.value}
              onPress={() => setSort(opt.value)}
              style={{
                paddingHorizontal: spacing.md,
                paddingVertical: 6,
                borderRadius: radius.xl,
                backgroundColor: sort === opt.value ? colors.accent : colors.bg,
                borderWidth: 1,
                borderColor: sort === opt.value ? colors.accent : colors.border,
              }}
            >
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: "600",
                  color: sort === opt.value ? "#fff" : colors.textLight,
                }}
              >
                {opt.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {/* コンテンツ */}
      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={{ marginTop: spacing.md, color: colors.textMuted, fontSize: 14 }}>
            読み込み中...
          </Text>
        </View>
      ) : (
        <FlatList
          data={favorites}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ListEmptyComponent={renderEmpty}
          ListFooterComponent={renderFooter}
          contentContainerStyle={{
            padding: spacing.lg,
            paddingBottom: insets.bottom + spacing.lg,
          }}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}
