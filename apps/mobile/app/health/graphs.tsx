import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import { getApi } from "../../src/lib/api";

type HealthRecord = {
  id: string;
  record_date: string;
  weight: number | null;
  mood_score: number | null;
  sleep_quality: number | null;
};

export default function HealthGraphsPage() {
  const [records, setRecords] = useState<HealthRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ records: HealthRecord[] }>("/api/health/records?limit=30");
      setRecords(res.records ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const weights = useMemo(() => records.filter((r) => typeof r.weight === "number").map((r) => ({ date: r.record_date, value: r.weight as number })), [records]);

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>グラフ</Text>
      <Link href="/health">健康トップへ</Link>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : (
        <>
          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
            <Text style={{ fontWeight: "900" }}>体重（直近30件）</Text>
            {weights.length === 0 ? (
              <Text style={{ color: "#666" }}>体重データがありません。</Text>
            ) : (
              weights.map((w) => (
                <Text key={w.date} style={{ color: "#333" }}>
                  {w.date}: {w.value} kg
                </Text>
              ))
            )}
          </View>
        </>
      )}

      <Pressable onPress={load} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>更新</Text>
      </Pressable>
    </ScrollView>
  );
}


