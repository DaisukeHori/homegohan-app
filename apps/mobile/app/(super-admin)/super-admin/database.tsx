import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import { getApi } from "../../../src/lib/api";

type DbStats = {
  tableCounts: Record<string, number>;
  todayStats: { newUsers: number; newMeals: number; aiSessions: number };
  aiUsage: { totalMessages: number; totalTokens: number; estimatedCost: number };
};

export default function SuperAdminDatabasePage() {
  const [data, setData] = useState<DbStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<DbStats>("/api/super-admin/db-stats");
      setData(res);
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
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 20, fontWeight: "900" }}>データベース</Text>
        <Pressable onPress={load}>
          <Text style={{ color: "#666" }}>更新</Text>
        </Pressable>
      </View>
      <Link href="/super-admin">Super Admin Home</Link>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : !data ? (
        <Text style={{ color: "#666" }}>データがありません。</Text>
      ) : (
        <>
          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
            <Text style={{ fontWeight: "900" }}>今日</Text>
            <Text>new users: {data.todayStats.newUsers}</Text>
            <Text>new meals: {data.todayStats.newMeals}</Text>
            <Text>ai sessions: {data.todayStats.aiSessions}</Text>
          </View>

          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
            <Text style={{ fontWeight: "900" }}>AI</Text>
            <Text>messages: {data.aiUsage.totalMessages}</Text>
            <Text>tokens: {data.aiUsage.totalTokens}</Text>
            <Text>estimatedCost: ${data.aiUsage.estimatedCost.toFixed(4)}</Text>
          </View>

          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
            <Text style={{ fontWeight: "900" }}>テーブル件数</Text>
            {Object.entries(data.tableCounts).map(([k, v]) => (
              <Text key={k}>
                - {k}: {v}
              </Text>
            ))}
          </View>
        </>
      )}
    </ScrollView>
  );
}


