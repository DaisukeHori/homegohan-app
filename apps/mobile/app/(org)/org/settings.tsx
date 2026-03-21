import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Card, Button, SectionHeader, StatusBadge, LoadingState, EmptyState } from "../../../src/components/ui";
import { Input } from "../../../src/components/ui";
import { getApi } from "../../../src/lib/api";
import { colors, spacing } from "../../../src/theme";

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
  const router = useRouter();
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
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: spacing["4xl"] }}>
      {/* Header */}
      <View style={{ paddingTop: 56, paddingHorizontal: spacing.xl, paddingBottom: spacing.lg, flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <Pressable onPress={() => router.push("/org/dashboard")} hitSlop={8}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "800", color: colors.text, flex: 1 }}>組織 設定</Text>
        <Pressable onPress={load} hitSlop={8}>
          <Ionicons name="refresh" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <View style={{ paddingHorizontal: spacing.xl, gap: spacing.lg }}>
        {isLoading ? (
          <LoadingState message="設定を読み込み中..." />
        ) : error ? (
          <Card variant="error">
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <Ionicons name="alert-circle" size={20} color={colors.error} />
              <Text style={{ fontSize: 14, color: colors.error, flex: 1 }}>{error}</Text>
            </View>
            <Button onPress={load} variant="outline" size="sm" style={{ marginTop: spacing.md }}>
              再試行
            </Button>
          </Card>
        ) : !org ? (
          <EmptyState icon={<Ionicons name="settings-outline" size={40} color={colors.textMuted} />} message="見つかりませんでした。" />
        ) : (
          <>
            {/* Plan Info */}
            <Card>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                  <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.successLight, alignItems: "center", justifyContent: "center" }}>
                    <Ionicons name="ribbon" size={20} color={colors.success} />
                  </View>
                  <View>
                    <Text style={{ fontSize: 13, color: colors.textMuted }}>プラン</Text>
                    <Text style={{ fontSize: 16, fontWeight: "700", color: colors.text }}>{org.plan ?? "未設定"}</Text>
                  </View>
                </View>
                <StatusBadge variant="info" label={org.plan ?? "-"} />
              </View>
            </Card>

            {/* Settings Form */}
            <Card>
              <SectionHeader title="基本情報" />
              <View style={{ gap: spacing.md, marginTop: spacing.sm }}>
                <Input value={name} onChangeText={setName} placeholder="組織名" label="組織名" />
                <Input value={industry} onChangeText={setIndustry} placeholder="例: IT / 製造 / 医療" label="業種（任意）" />
                <Input value={employeeCount} onChangeText={setEmployeeCount} placeholder="例: 50" label="従業員数（任意）" keyboardType="number-pad" />
                <Input value={contactEmail} onChangeText={setContactEmail} placeholder="example@email.com" label="連絡先メール（任意）" keyboardType="email-address" autoCapitalize="none" />
                <Input value={contactName} onChangeText={setContactName} placeholder="担当者名" label="連絡先担当（任意）" />
                <Button onPress={save} loading={isSubmitting} disabled={isSubmitting}>
                  {isSubmitting ? "保存中..." : "保存"}
                </Button>
              </View>
            </Card>
          </>
        )}
      </View>
    </ScrollView>
  );
}
