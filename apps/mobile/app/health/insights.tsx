import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";

import { getApi } from "../../src/lib/api";

type Insight = {
  id: string;
  title: string;
  summary: string;
  is_read: boolean;
  is_alert: boolean;
  created_at: string;
};

export default function HealthInsightsPage() {
  const [items, setItems] = useState<Insight[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [alertCount, setAlertCount] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ insights: Insight[]; unreadCount: number; alertCount: number }>(
        `/api/health/insights?limit=20${unreadOnly ? "&unread=true" : ""}`
      );
      setItems(res.insights ?? []);
      setUnreadCount(res.unreadCount ?? 0);
      setAlertCount(res.alertCount ?? 0);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [unreadOnly]);

  async function markRead(id: string) {
    try {
      const api = getApi();
      await api.post(`/api/health/insights/${id}/read`, {});
      await load();
    } catch (e: any) {
      Alert.alert("失敗", e?.message ?? "失敗しました。");
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>インサイト</Text>
      <Link href="/health">健康トップへ</Link>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
        <Text style={{ fontWeight: "900" }}>カウント</Text>
        <Text>未読: {unreadCount}</Text>
        <Text>アラート: {alertCount}</Text>
        <Pressable onPress={() => setUnreadOnly((v) => !v)} style={{ padding: 12, borderRadius: 12, backgroundColor: unreadOnly ? "#E07A5F" : "#333", alignItems: "center" }}>
          <Text style={{ color: "white", fontWeight: "900" }}>{unreadOnly ? "未読のみ: ON" : "未読のみ: OFF"}</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>インサイトがありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((i) => (
            <View key={i.id} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: i.is_alert ? "#FFF3E0" : "white", gap: 6 }}>
              <Text style={{ fontWeight: "900" }}>
                {i.title} {i.is_read ? "" : "（未読）"}
              </Text>
              <Text style={{ color: "#666" }}>{i.summary}</Text>
              <Text style={{ color: "#999" }}>{new Date(i.created_at).toLocaleString("ja-JP")}</Text>
              {!i.is_read ? (
                <Pressable onPress={() => markRead(i.id)} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#333", alignSelf: "flex-start" }}>
                  <Text style={{ color: "white", fontWeight: "900" }}>既読にする</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      )}

      <Pressable onPress={load} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>更新</Text>
      </Pressable>
    </ScrollView>
  );
}


