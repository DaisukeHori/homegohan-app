import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../../src/lib/api";

type Org = {
  id: string;
  name: string;
  plan: string | null;
  industry: string | null;
  employeeCount: number | null;
  contactEmail: string | null;
  contactName: string | null;
};

export default function OrgSettingsPage() {
  const [org, setOrg] = useState<Org | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [employeeCount, setEmployeeCount] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactName, setContactName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ organization: Org }>("/api/org/settings");
      setOrg(res.organization);
      setName(res.organization.name ?? "");
      setIndustry(res.organization.industry ?? "");
      setEmployeeCount(res.organization.employeeCount ? String(res.organization.employeeCount) : "");
      setContactEmail(res.organization.contactEmail ?? "");
      setContactName(res.organization.contactName ?? "");
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    if (!org || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.put("/api/org/settings", {
        name: name.trim() || org.name,
        industry: industry.trim() || null,
        employeeCount: employeeCount.trim() ? Number(employeeCount.trim()) : null,
        contactEmail: contactEmail.trim() || null,
        contactName: contactName.trim() || null,
      });
      Alert.alert("保存しました", "組織設定を更新しました。");
      await load();
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>組織 設定</Text>

      <View style={{ gap: 8 }}>
        <Link href="/org/dashboard">ダッシュボードへ</Link>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : !org ? (
        <Text style={{ color: "#666" }}>見つかりませんでした。</Text>
      ) : (
        <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
          <Text style={{ fontWeight: "900" }}>基本情報</Text>
          <Text style={{ color: "#666" }}>plan: {org.plan ?? "-"}</Text>
          <TextInput value={name} onChangeText={setName} placeholder="組織名" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
          <TextInput value={industry} onChangeText={setIndustry} placeholder="業種（任意）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
          <TextInput value={employeeCount} onChangeText={setEmployeeCount} placeholder="従業員数（任意）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
          <TextInput value={contactEmail} onChangeText={setContactEmail} placeholder="連絡先メール（任意）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
          <TextInput value={contactName} onChangeText={setContactName} placeholder="連絡先担当（任意）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
          <Pressable onPress={save} disabled={isSubmitting} style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isSubmitting ? "#999" : "#333" }}>
            <Text style={{ color: "white", fontWeight: "900" }}>{isSubmitting ? "保存中..." : "保存"}</Text>
          </Pressable>
        </View>
      )}

      <Pressable onPress={load} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>更新</Text>
      </Pressable>
    </ScrollView>
  );
}


