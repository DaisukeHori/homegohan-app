import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";

import { getApi } from "../../src/lib/api";

type ComparisonResponse = {
  rankings: Array<{
    metric: { code: string; name: string; unit: string | null; higher_is_better: boolean };
    segments: Array<{
      segment: { code: string; name: string };
      rank: number;
      totalUsers: number;
      percentile: number;
      value: number;
      avgValue: number | null;
      vsAvgRate: number | null;
      prize: { name: string; icon: string; message: string } | null;
    }>;
  }>;
  highlights: Array<{ type: string; message: string; icon: string }>;
  periodType: string;
  periodStart: string;
  periodEnd: string;
};

export default function ComparisonPage() {
  const [periodType, setPeriodType] = useState<"daily" | "weekly" | "monthly">("weekly");
  const [data, setData] = useState<ComparisonResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<ComparisonResponse>(`/api/comparison/rankings?periodType=${periodType}`);
      setData(res);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [periodType]);

  async function trigger() {
    try {
      const api = getApi();
      const res = await api.post<any>("/api/comparison/trigger", { periodType });
      Alert.alert("実行しました", JSON.stringify(res));
      await load();
    } catch (e: any) {
      Alert.alert("実行失敗", e?.message ?? "失敗しました。");
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 20, fontWeight: "900" }}>比較</Text>
        <Pressable onPress={trigger} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#333" }}>
          <Text style={{ color: "white", fontWeight: "900" }}>再計算</Text>
        </Pressable>
      </View>

      <View style={{ flexDirection: "row", gap: 8 }}>
        {(["daily", "weekly", "monthly"] as const).map((p) => (
          <Pressable
            key={p}
            onPress={() => setPeriodType(p)}
            style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: periodType === p ? "#E07A5F" : "#eee" }}
          >
            <Text style={{ fontWeight: "900", color: periodType === p ? "white" : "#333" }}>
              {p === "daily" ? "日" : p === "weekly" ? "週" : "月"}
            </Text>
          </Pressable>
        ))}
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
          <Text style={{ color: "#666" }}>
            期間: {data.periodStart} 〜 {data.periodEnd}
          </Text>

          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
            <Text style={{ fontWeight: "900" }}>ハイライト</Text>
            {data.highlights?.length ? (
              data.highlights.map((h, idx) => (
                <Text key={idx}>
                  {h.icon} {h.message}
                </Text>
              ))
            ) : (
              <Text style={{ color: "#666" }}>まだありません。</Text>
            )}
          </View>

          <View style={{ gap: 12 }}>
            {data.rankings?.map((m) => (
              <View key={m.metric.code} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
                <Text style={{ fontWeight: "900" }}>{m.metric.name}</Text>
                {m.segments.map((s) => (
                  <View key={`${m.metric.code}-${s.segment.code}`} style={{ gap: 4 }}>
                    <Text style={{ fontWeight: "900" }}>
                      {s.segment.name}: {s.rank}/{s.totalUsers}（{Math.round(s.percentile)}%）
                    </Text>
                    <Text style={{ color: "#666" }}>
                      値: {s.value}
                      {m.metric.unit ? ` ${m.metric.unit}` : ""} / 平均: {s.avgValue ?? "-"} / 平均比: {s.vsAvgRate ? `${Math.round(s.vsAvgRate)}%` : "-"}
                    </Text>
                    {s.prize ? (
                      <Text>
                        {s.prize.icon} {s.prize.message}
                      </Text>
                    ) : null}
                  </View>
                ))}
              </View>
            ))}
          </View>
        </>
      )}

      <Pressable onPress={load} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>更新</Text>
      </Pressable>
    </ScrollView>
  );
}


