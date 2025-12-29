import { Link, router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import { getApi } from "../../../src/lib/api";

type HealthRecord = {
  id: string;
  record_date: string;
  weight?: number | null;
  mood_score?: number | null;
  sleep_quality?: number | null;
};

export default function HealthRecordListPage() {
  const [records, setRecords] = useState<HealthRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setIsLoading(true);
      setError(null);
      try {
        const api = getApi();
        const res = await api.get<{ records: HealthRecord[] }>("/api/health/records?limit=30");
        if (!cancelled) setRecords(res.records ?? []);
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

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 20, fontWeight: "900" }}>健康記録</Text>
        <Link href="/health/record/quick">クイック入力</Link>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : records.length === 0 ? (
        <Text style={{ color: "#666" }}>まだ記録がありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {records.map((r) => (
            <Pressable
              key={r.id}
              onPress={() => router.push(`/health/record/${encodeURIComponent(r.record_date)}`)}
              style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 4 }}
            >
              <Text style={{ fontWeight: "900" }}>{r.record_date}</Text>
              <Text style={{ color: "#666" }}>
                体重: {r.weight ?? "-"} / 気分: {r.mood_score ?? "-"} / 睡眠: {r.sleep_quality ?? "-"}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      <View style={{ marginTop: 12, gap: 8 }}>
        <Link href="/health">健康トップへ</Link>
      </View>
    </ScrollView>
  );
}


