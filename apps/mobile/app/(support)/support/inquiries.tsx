import { Link, router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import { getApi } from "../../../src/lib/api";

type InquiryRow = {
  id: string;
  userId: string | null;
  userName: string | null;
  inquiryType: string;
  email: string;
  subject: string;
  status: string;
  createdAt: string;
};

export default function SupportInquiriesPage() {
  const [status, setStatus] = useState("pending");
  const [items, setItems] = useState<InquiryRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ inquiries: InquiryRow[] }>(`/api/admin/inquiries?limit=50&status=${encodeURIComponent(status)}`);
      setItems(res.inquiries ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [status]);

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>問い合わせ</Text>
      <Link href="/support">Support Home</Link>

      <View style={{ flexDirection: "row", gap: 8 }}>
        {["pending", "in_progress", "resolved", "closed"].map((s) => (
          <Pressable key={s} onPress={() => setStatus(s)} style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: status === s ? "#E07A5F" : "#eee" }}>
            <Text style={{ fontWeight: "900", color: status === s ? "white" : "#333" }}>{s}</Text>
          </Pressable>
        ))}
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>問い合わせがありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((i) => (
            <Pressable
              key={i.id}
              onPress={() => router.push(`/support/inquiries/${i.id}`)}
              style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 4 }}
            >
              <Text style={{ fontWeight: "900" }}>{i.subject}</Text>
              <Text style={{ color: "#666" }}>
                {i.inquiryType} / {i.status} / {i.userName ?? i.email}
              </Text>
              <Text style={{ color: "#999" }}>{new Date(i.createdAt).toLocaleString("ja-JP")}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <Pressable onPress={load} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>更新</Text>
      </Pressable>
    </ScrollView>
  );
}


