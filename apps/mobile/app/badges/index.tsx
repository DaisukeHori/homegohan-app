import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";

import { getApi } from "../../src/lib/api";

type Badge = {
  id: string;
  code: string;
  name: string;
  description: string;
  earned: boolean;
  obtainedAt: string | null;
};

export default function BadgesPage() {
  const [badges, setBadges] = useState<Badge[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setIsLoading(true);
      setError(null);
      try {
        const api = getApi();
        const res = await api.get<{ badges: Badge[] }>("/api/badges");
        if (!cancelled) setBadges(res.badges ?? []);
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
      <Text style={{ fontSize: 20, fontWeight: "900" }}>バッジ</Text>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {badges.map((b) => (
            <View
              key={b.id}
              style={{
                padding: 12,
                borderWidth: 1,
                borderColor: "#eee",
                borderRadius: 12,
                backgroundColor: b.earned ? "#E8F5E9" : "white",
                gap: 4,
              }}
            >
              <Text style={{ fontWeight: "900" }}>
                {b.earned ? "✅ " : "⬜️ "}
                {b.name}
              </Text>
              <Text style={{ color: "#666" }}>{b.description}</Text>
              {b.obtainedAt ? <Text style={{ color: "#999" }}>獲得: {b.obtainedAt}</Text> : null}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}



