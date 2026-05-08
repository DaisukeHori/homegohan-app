import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Animated, ScrollView, Text, View } from "react-native";

import { Card, EmptyState, LoadingState, PageHeader } from "../../src/components/ui";
import { getApi } from "../../src/lib/api";
import { colors, spacing } from "../../src/theme";

type Badge = {
  id: string;
  code: string;
  name: string;
  description: string;
  earned: boolean;
  obtainedAt: string | null;
};

// Highlight border + background animation for tutorial mode (§1.2 Q10)
function HighlightedBadgeCard({ badge, isHighlighted }: { badge: Badge; isHighlighted: boolean }) {
  const borderAnim = useRef(new Animated.Value(0)).current;
  const bgAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!isHighlighted) return;
    // Pulse the highlight on mount
    Animated.loop(
      Animated.sequence([
        Animated.timing(borderAnim, { toValue: 1, duration: 600, useNativeDriver: false }),
        Animated.timing(borderAnim, { toValue: 0.4, duration: 600, useNativeDriver: false }),
      ]),
    ).start();
    Animated.timing(bgAnim, { toValue: 1, duration: 400, useNativeDriver: false }).start();
  }, [isHighlighted, borderAnim, bgAnim]);

  const borderWidth = isHighlighted
    ? borderAnim.interpolate({ inputRange: [0, 1], outputRange: [2, 4] })
    : 1;
  const borderColor = isHighlighted ? colors.accent : colors.border;
  const backgroundColor = isHighlighted
    ? bgAnim.interpolate({ inputRange: [0, 1], outputRange: [colors.card, colors.accentLight] })
    : colors.card;

  return (
    <Animated.View
      testID={`badge-card-${badge.code}`}
      style={{
        borderWidth,
        borderColor,
        borderRadius: 16,
        backgroundColor,
        overflow: "hidden",
      }}
    >
      {/* legacy testID compatibility: inner View with the old testID pattern */}
      <View testID={`badges-badge-${badge.code}`}>
        <Card variant={badge.earned ? "success" : "default"}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                backgroundColor: badge.earned ? colors.successLight : colors.bg,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons
                name={badge.earned ? "checkmark-circle" : "ellipse-outline"}
                size={24}
                color={badge.earned ? colors.success : colors.textMuted}
              />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{badge.name}</Text>
              <Text style={{ fontSize: 13, color: colors.textLight }}>{badge.description}</Text>
              {badge.obtainedAt ? (
                <Text style={{ fontSize: 12, color: colors.textMuted }}>獲得: {badge.obtainedAt}</Text>
              ) : null}
            </View>
            {isHighlighted && (
              <View style={{ alignItems: "center" }}>
                <Ionicons name="star" size={18} color={colors.accent} />
              </View>
            )}
          </View>
        </Card>
      </View>
    </Animated.View>
  );
}

export default function BadgesPage() {
  const params = useLocalSearchParams<{ "tutorial-mode"?: string; highlight?: string }>();
  const tutorialMode = params["tutorial-mode"] === "1";
  const highlightCode = params["highlight"] ?? null;

  const [badges, setBadges] = useState<Badge[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setIsLoading(true);
      setError(null);
      try {
        const api = getApi();
        const res = await api.get<{ badges: Badge[] }>("/api/badges");
        if (!cancelled) setBadges(res.badges ?? []);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "取得に失敗しました。");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  const earnedCount = badges.filter((b) => b.earned).length;

  return (
    <View testID="badges-screen" style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* tutorialMode 時はヘッダー非表示 (Spotlight 連動のため) */}
      {!tutorialMode && (
        <PageHeader
          title="バッジ"
          right={
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
              <Ionicons name="trophy" size={20} color={colors.accent} />
              <Text testID="badges-earned-count" style={{ fontSize: 13, fontWeight: "700", color: colors.textMuted }}>
                {earnedCount}/{badges.length}
              </Text>
            </View>
          }
        />
      )}
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>

      {isLoading ? (
        <LoadingState message="バッジを読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ color: colors.error, fontSize: 14, fontWeight: "600" }}>{error}</Text>
          </View>
        </Card>
      ) : badges.length === 0 ? (
        <EmptyState
          testID="badges-empty"
          icon={<Ionicons name="trophy-outline" size={48} color={colors.textMuted} />}
          message="バッジがありません。"
        />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {badges.map((b) => (
            <HighlightedBadgeCard
              key={b.id}
              badge={b}
              isHighlighted={tutorialMode && highlightCode === b.code}
            />
          ))}
        </View>
      )}
    </ScrollView>
    </View>
  );
}
