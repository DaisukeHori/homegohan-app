import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import { getApi } from "../../../src/lib/api";

type SupportStats = {
  overview: {
    pendingInquiries: number;
    inProgressInquiries: number;
    resolvedToday: number;
    totalInquiries: number;
    myResolvedThisWeek: number;
  };
  inquiriesByType: Record<string, number>;
  recentInquiries: Array<{ id: string; inquiryType: string; subject: string; status: string; createdAt: string; userName: string }>;
};

export default function SupportHomePage() {
  const [stats, setStats] = useState<SupportStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<SupportStats>("/api/support/stats");
      setStats(res);
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
        <Text style={{ fontSize: 20, fontWeight: "900" }}>Support Center</Text>
        <Pressable onPress={load}>
          <Text style={{ color: "#666" }}>更新</Text>
        </Pressable>
      </View>

      <View style={{ gap: 10 }}>
        <Link href="/support/inquiries">問い合わせ</Link>
        <Link href="/support/users">ユーザー検索</Link>
        <Link href="/home">アプリに戻る</Link>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : !stats ? (
        <Text style={{ color: "#666" }}>データがありません。</Text>
      ) : (
        <>
          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
            <Text style={{ fontWeight: "900" }}>概要</Text>
            <Text>pending: {stats.overview.pendingInquiries}</Text>
            <Text>in_progress: {stats.overview.inProgressInquiries}</Text>
            <Text>resolved today: {stats.overview.resolvedToday}</Text>
            <Text>total: {stats.overview.totalInquiries}</Text>
            <Text>my resolved (7d): {stats.overview.myResolvedThisWeek}</Text>
          </View>

          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
            <Text style={{ fontWeight: "900" }}>種別（pending）</Text>
            {Object.keys(stats.inquiriesByType ?? {}).length === 0 ? (
              <Text style={{ color: "#666" }}>なし</Text>
            ) : (
              Object.entries(stats.inquiriesByType).map(([k, v]) => (
                <Text key={k}>
                  - {k}: {v}
                </Text>
              ))
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}


