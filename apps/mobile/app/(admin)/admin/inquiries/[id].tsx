import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../../../src/lib/api";

type Inquiry = {
  id: string;
  userId: string | null;
  userName: string | null;
  inquiryType: string;
  email: string;
  subject: string;
  message: string;
  status: string;
  adminNotes: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

export default function AdminInquiryDetailPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const apiPath = useMemo(() => `/api/admin/inquiries/${id}`, [id]);

  const [inquiry, setInquiry] = useState<Inquiry | null>(null);
  const [adminNotes, setAdminNotes] = useState("");
  const [status, setStatus] = useState("pending");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!id) return;
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ inquiry: Inquiry }>(apiPath);
      setInquiry(res.inquiry);
      setAdminNotes(res.inquiry.adminNotes ?? "");
      setStatus(res.inquiry.status ?? "pending");
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  async function save() {
    if (!id || isSaving) return;
    setIsSaving(true);
    try {
      const api = getApi();
      await api.patch(apiPath, { status, adminNotes });
      Alert.alert("保存しました", "更新しました。");
      await load();
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 20, fontWeight: "900" }}>Inquiry</Text>
        <Pressable onPress={() => router.back()}>
          <Text style={{ color: "#666" }}>戻る</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : !inquiry ? (
        <Text style={{ color: "#666" }}>見つかりませんでした。</Text>
      ) : (
        <>
          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
            <Text style={{ fontWeight: "900" }}>{inquiry.subject}</Text>
            <Text style={{ color: "#666" }}>
              {inquiry.inquiryType} / {inquiry.status} / {inquiry.userName ?? inquiry.email}
            </Text>
            <Text style={{ color: "#333" }}>{inquiry.message}</Text>
          </View>

          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
            <Text style={{ fontWeight: "900" }}>更新</Text>
            <TextInput value={status} onChangeText={setStatus} placeholder="status（pending/in_progress/resolved/closed）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
            <TextInput
              value={adminNotes}
              onChangeText={setAdminNotes}
              placeholder="管理メモ"
              multiline
              style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10, minHeight: 100 }}
            />
            <Pressable onPress={save} disabled={isSaving} style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isSaving ? "#999" : "#333" }}>
              <Text style={{ color: "white", fontWeight: "900" }}>{isSaving ? "保存中..." : "保存"}</Text>
            </Pressable>
          </View>
        </>
      )}
    </ScrollView>
  );
}



