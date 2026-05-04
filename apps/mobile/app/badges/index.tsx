import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";

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

export default function BadgesPage() {
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
            <Card
              testID={`badges-badge-${b.code}`}
              key={b.id}
              variant={b.earned ? "success" : "default"}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    backgroundColor: b.earned ? colors.successLight : colors.bg,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Ionicons
                    name={b.earned ? "checkmark-circle" : "ellipse-outline"}
                    size={24}
                    color={b.earned ? colors.success : colors.textMuted}
                  />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{b.name}</Text>
                  <Text style={{ fontSize: 13, color: colors.textLight }}>{b.description}</Text>
                  {b.obtainedAt ? (
                    <Text style={{ fontSize: 12, color: colors.textMuted }}>獲得: {b.obtainedAt}</Text>
                  ) : null}
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
