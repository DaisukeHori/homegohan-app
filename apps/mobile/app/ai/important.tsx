import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";

import { Button, Card, EmptyState, LoadingState, PageHeader } from "../../src/components/ui";
import { getApi } from "../../src/lib/api";
import { colors, spacing } from "../../src/theme";

type ImportantMessage = {
  id: string;
  role: string;
  content: string;
  reason: string | null;
  createdAt: string;
  session: { id: string; title: string };
};

export default function AiImportantMessagesPage() {
  const [items, setItems] = useState<ImportantMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ importantMessages: ImportantMessage[] }>("/api/ai/consultation/important-messages?limit=50");
      setItems(res.importantMessages ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <View testID="ai-important-screen" style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader
        title="重要メッセージ"
        right={
          <Button onPress={() => router.back()} variant="ghost" size="sm">
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
              <Ionicons name="arrow-back" size={16} color={colors.textLight} />
              <Text style={{ color: colors.textLight, fontWeight: "600", fontSize: 13 }}>戻る</Text>
            </View>
          </Button>
        }
      />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>

      {isLoading ? (
        <LoadingState message="メッセージを読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ color: colors.error, fontSize: 14, fontWeight: "600" }}>{error}</Text>
          </View>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          testID="ai-important-empty"
          icon={<Ionicons name="star-outline" size={48} color={colors.textMuted} />}
          message="重要メッセージがありません。"
        />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {items.map((m) => (
            <Card key={m.id} testID={`ai-important-item-${m.id}`} onPress={() => router.push(`/ai/${m.session.id}`)}>
              <View style={{ gap: spacing.sm }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <View
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 16,
                      backgroundColor: colors.warningLight,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Ionicons name="star" size={16} color={colors.warning} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>{m.session.title}</Text>
                    <Text style={{ fontSize: 12, color: colors.textMuted }}>
                      {new Date(m.createdAt).toLocaleString("ja-JP")}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                </View>
                <Text style={{ fontSize: 14, color: colors.textLight, lineHeight: 20 }}>{m.content}</Text>
                {m.reason ? (
                  <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.xs }}>
                    <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} style={{ marginTop: 1 }} />
                    <Text style={{ fontSize: 12, color: colors.textMuted, flex: 1 }}>理由: {m.reason}</Text>
                  </View>
                ) : null}
              </View>
            </Card>
          ))}
        </View>
      )}

      <Button onPress={load} variant="ghost" size="sm">
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
          <Ionicons name="reload-outline" size={16} color={colors.textLight} />
          <Text style={{ color: colors.textLight, fontWeight: "600", fontSize: 14 }}>更新</Text>
        </View>
      </Button>
    </ScrollView>
    </View>
  );
}
