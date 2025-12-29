import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";

import { getApi } from "../../src/lib/api";

type Streak = {
  id?: string;
  streak_type: string;
  current_streak: number;
  longest_streak: number;
  last_activity_date: string | null;
  streak_start_date: string | null;
  achieved_badges: string[] | null;
  total_records: number;
};

type StreakResponse = {
  streak: Streak;
  nextBadge: number | null;
  daysToNextBadge: number | null;
  weeklyRecords: string[];
  weeklyRecordCount: number;
};

function toYmd(d: Date): string {
  return d.toISOString().split("T")[0];
}

export default function HealthStreaksPage() {
  const [data, setData] = useState<StreakResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<StreakResponse>("/api/health/streaks?type=daily_record");
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

  const weekly = useMemo(() => {
    const recorded = new Set(data?.weeklyRecords ?? []);
    const days: { date: string; recorded: boolean }[] = [];
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const ymd = toYmd(d);
      days.push({ date: ymd, recorded: recorded.has(ymd) });
    }
    return days;
  }, [data]);

  async function reset() {
    Alert.alert("リセット", "連続記録をリセットしますか？（テスト用）", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "リセット",
        style: "destructive",
        onPress: async () => {
          try {
            const api = getApi();
            await api.del("/api/health/streaks?type=daily_record");
            await load();
          } catch (e: any) {
            Alert.alert("失敗", e?.message ?? "失敗しました。");
          }
        },
      },
    ]);
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>連続記録</Text>
      <Link href="/health">健康トップへ</Link>

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
            <Text style={{ fontWeight: "900" }}>daily_record</Text>
            <Text style={{ color: "#333" }}>current: {data.streak.current_streak}日</Text>
            <Text style={{ color: "#333" }}>longest: {data.streak.longest_streak}日</Text>
            <Text style={{ color: "#666" }}>last: {data.streak.last_activity_date ?? "-"}</Text>
            <Text style={{ color: "#666" }}>start: {data.streak.streak_start_date ?? "-"}</Text>
            <Text style={{ color: "#666" }}>total: {data.streak.total_records}</Text>
            {data.nextBadge ? (
              <Text style={{ color: "#666" }}>
                next badge: {data.nextBadge}日（あと{data.daysToNextBadge ?? "-"}日）
              </Text>
            ) : (
              <Text style={{ color: "#666" }}>next badge: なし</Text>
            )}
          </View>

          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
            <Text style={{ fontWeight: "900" }}>直近7日</Text>
            <Text style={{ color: "#666" }}>今週の記録数: {data.weeklyRecordCount}/7</Text>
            {weekly.map((d) => (
              <Text key={d.date} style={{ color: d.recorded ? "#333" : "#999" }}>
                {d.recorded ? "✓" : "·"} {d.date}
              </Text>
            ))}
          </View>

          <Pressable onPress={reset} style={{ padding: 12, borderRadius: 12, backgroundColor: "#c00", alignItems: "center" }}>
            <Text style={{ color: "white", fontWeight: "900" }}>リセット（テスト用）</Text>
          </Pressable>
        </>
      )}

      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Pressable onPress={load}>
          <Text style={{ color: "#666" }}>更新</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}



