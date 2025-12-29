import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import { getApi } from "../../../src/lib/api";

type OrgStats = {
  overview: {
    totalMembers: number;
    activeMembers: number;
    weeklyMeals: number;
    breakfastRate: number;
  };
  dailyStats: any[];
  departmentStats: Array<{ id: string; name: string; memberCount: number }>;
};

export default function OrgDashboardPage() {
  const [data, setData] = useState<OrgStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<OrgStats>("/api/org/stats");
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
        <Text style={{ fontSize: 20, fontWeight: "900" }}>組織ダッシュボード</Text>
        <Pressable onPress={load}>
          <Text style={{ color: "#666" }}>更新</Text>
        </Pressable>
      </View>

      <View style={{ gap: 10 }}>
        <Link href="/org/members">メンバー</Link>
        <Link href="/org/invites">招待</Link>
        <Link href="/org/departments">部署</Link>
        <Link href="/org/challenges">チャレンジ</Link>
        <Link href="/org/settings">設定</Link>
        <Link href="/home">アプリに戻る</Link>
      </View>

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
            <Text style={{ fontWeight: "900" }}>概要</Text>
            <Text>総メンバー: {data.overview.totalMembers}</Text>
            <Text>アクティブ（30日）: {data.overview.activeMembers}</Text>
            <Text>今週の完了食事: {data.overview.weeklyMeals}</Text>
            <Text>朝食率: {data.overview.breakfastRate}%</Text>
          </View>

          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
            <Text style={{ fontWeight: "900" }}>部署別</Text>
            {(data.departmentStats ?? []).length === 0 ? (
              <Text style={{ color: "#666" }}>部署がありません。</Text>
            ) : (
              data.departmentStats.map((d) => (
                <Text key={d.id}>
                  - {d.name}: {d.memberCount}人
                </Text>
              ))
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}


