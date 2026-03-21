import { Ionicons } from "@expo/vector-icons";
import { Link, router } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";

import { Button, Card, EmptyState, ListItem, LoadingState, PageHeader } from "../../src/components/ui";
import { getApi } from "../../src/lib/api";
import { colors, spacing } from "../../src/theme";

type Session = {
  id: string;
  title: string;
  status: string;
  summary?: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

export default function AiSessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ sessions: Session[] }>("/api/ai/consultation/sessions?status=active");
      setSessions(res.sessions ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createSession() {
    if (isCreating) return;
    setIsCreating(true);
    try {
      const api = getApi();
      const res = await api.post<{ success: boolean; session: { id: string } }>("/api/ai/consultation/sessions", {
        title: "AI相談",
      });
      const sessionId = res.session.id;
      router.push(`/ai/${sessionId}`);
    } catch (e: any) {
      setError(e?.message ?? "作成に失敗しました。");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader
        title="AI相談"
        right={
          <Button onPress={createSession} loading={isCreating} size="sm">
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
              <Ionicons name="add" size={16} color="#FFFFFF" />
              <Text style={{ color: "#FFFFFF", fontWeight: "700", fontSize: 13 }}>
                {isCreating ? "作成中..." : "新規"}
              </Text>
            </View>
          </Button>
        }
      />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>

      <View style={{ flexDirection: "row", gap: spacing.md }}>
        <Link href="/ai/important" style={{ color: colors.accent, fontSize: 14, fontWeight: "600" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
            <Ionicons name="star-outline" size={16} color={colors.accent} />
            <Text style={{ color: colors.accent, fontSize: 14, fontWeight: "600" }}>重要メッセージ一覧</Text>
          </View>
        </Link>
        <Link href="/home" style={{ color: colors.accent, fontSize: 14, fontWeight: "600" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
            <Ionicons name="home-outline" size={16} color={colors.accent} />
            <Text style={{ color: colors.accent, fontSize: 14, fontWeight: "600" }}>ホームへ</Text>
          </View>
        </Link>
      </View>

      {isLoading ? (
        <LoadingState message="セッションを読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ color: colors.error, fontSize: 14, fontWeight: "600" }}>{error}</Text>
          </View>
        </Card>
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={<Ionicons name="chatbubbles-outline" size={48} color={colors.textMuted} />}
          message="アクティブなセッションがありません。"
          actionLabel="新しい相談を始める"
          onAction={createSession}
        />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {sessions.map((s) => (
            <ListItem
              key={s.id}
              title={s.title}
              subtitle={`${s.messageCount} messages / ${new Date(s.updatedAt).toLocaleString("ja-JP")}`}
              onPress={() => router.push(`/ai/${s.id}`)}
              left={
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    backgroundColor: colors.successLight,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Ionicons name="chatbubble-ellipses-outline" size={20} color={colors.success} />
                </View>
              }
              right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
            />
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
