import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import { getApi } from "../../../src/lib/api";

type AdminStats = {
  overview: {
    totalUsers: number;
    newUsersToday: number;
    activeUsers: number;
    totalMeals: number;
    completedMealsToday: number;
    healthRecordsToday: number;
    aiSessionsTotal: number;
    pendingInquiries: number;
    publicRecipes: number;
  };
  dailyStats: any[];
};

export default function AdminHomePage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<AdminStats>("/api/admin/stats");
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
        <Text style={{ fontSize: 20, fontWeight: "900" }}>Admin Console</Text>
        <Pressable onPress={load}>
          <Text style={{ color: "#666" }}>更新</Text>
        </Pressable>
      </View>

      <View style={{ gap: 10 }}>
        <Link href="/admin/users">Users</Link>
        <Link href="/admin/inquiries">Inquiries</Link>
        <Link href="/admin/announcements">Announcements</Link>
        <Link href="/admin/organizations">Organizations</Link>
        <Link href="/admin/moderation">Moderation</Link>
        <Link href="/admin/audit-logs">Audit Logs</Link>
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
        <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
          <Text style={{ fontWeight: "900" }}>概要</Text>
          <Text>Users: {stats.overview.totalUsers}</Text>
          <Text>New Today: {stats.overview.newUsersToday}</Text>
          <Text>Active (30d): {stats.overview.activeUsers}</Text>
          <Text>Meals: {stats.overview.totalMeals}</Text>
          <Text>Completed Today: {stats.overview.completedMealsToday}</Text>
          <Text>Health Today: {stats.overview.healthRecordsToday}</Text>
          <Text>AI Sessions: {stats.overview.aiSessionsTotal}</Text>
          <Text>Pending Inquiries: {stats.overview.pendingInquiries}</Text>
          <Text>Public Recipes: {stats.overview.publicRecipes}</Text>
        </View>
      )}
    </ScrollView>
  );
}


