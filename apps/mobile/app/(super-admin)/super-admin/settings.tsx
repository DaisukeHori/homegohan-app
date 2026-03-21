import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Button, Card, EmptyState, Input, LoadingState, SectionHeader } from "../../../src/components/ui";
import { getApi } from "../../../src/lib/api";
import { colors, spacing, radius } from "../../../src/theme";

type SettingRow = {
  key: string;
  value: any;
  description: string | null;
  updatedAt: string | null;
};

export default function SuperAdminSettingsPage() {
  const [items, setItems] = useState<SettingRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [keyText, setKeyText] = useState("");
  const [valueText, setValueText] = useState("{}");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ settings: SettingRow[] }>("/api/super-admin/settings");
      setItems(res.settings ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function upsert() {
    const k = keyText.trim();
    if (!k || isSubmitting) return;

    let value: any = valueText;
    try {
      value = JSON.parse(valueText);
    } catch {
      value = valueText;
    }

    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.put("/api/super-admin/settings", {
        key: k,
        value,
        description: description.trim() || null,
      });
      Alert.alert("保存しました", "設定を更新しました。");
      await load();
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  const selected = useMemo(() => items.find((i) => i.key === keyText.trim()) ?? null, [items, keyText]);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: spacing["4xl"] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, paddingTop: 56 }}>
        <Pressable onPress={() => router.back()} style={{ padding: spacing.xs }}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "900", color: colors.text, flex: 1 }}>システム設定</Text>
        <Pressable onPress={load} style={{ padding: spacing.sm }}>
          <Ionicons name="refresh" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <SectionHeader title="Upsert" />
      <Card>
        <View style={{ gap: spacing.sm }}>
          <Input
            label="Key"
            value={keyText}
            onChangeText={setKeyText}
            placeholder="key"
          />
          <Input
            label="Value"
            value={valueText}
            onChangeText={setValueText}
            placeholder="value (JSON推奨)"
            multiline
            style={{ minHeight: 120, textAlignVertical: "top" }}
          />
          <Input
            label="Description"
            value={description}
            onChangeText={setDescription}
            placeholder="description (任意)"
          />
          {selected ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
              <Ionicons name="time-outline" size={14} color={colors.textMuted} />
              <Text style={{ fontSize: 12, color: colors.textMuted }}>現在の更新日時: {selected.updatedAt ?? "-"}</Text>
            </View>
          ) : null}
          <Button onPress={upsert} loading={isSubmitting} disabled={isSubmitting}>
            {isSubmitting ? "保存中..." : "保存"}
          </Button>
        </View>
      </Card>

      <SectionHeader title="設定一覧" />
      {isLoading ? (
        <LoadingState message="読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ color: colors.error, fontSize: 14, flex: 1 }}>{error}</Text>
          </View>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState icon={<Ionicons name="settings-outline" size={40} color={colors.textMuted} />} message="設定がありません。" />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {items.map((s) => (
            <Card
              key={s.key}
              onPress={() => {
                setKeyText(s.key);
                setValueText(JSON.stringify(s.value ?? {}, null, 2));
                setDescription(s.description ?? "");
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.blueLight, alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="key-outline" size={20} color={colors.blue} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{s.key}</Text>
                  {s.description ? <Text style={{ fontSize: 13, color: colors.textLight }}>{s.description}</Text> : null}
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                    <Ionicons name="time-outline" size={12} color={colors.textMuted} />
                    <Text style={{ fontSize: 12, color: colors.textMuted }}>{s.updatedAt ?? "-"}</Text>
                  </View>
                </View>
                <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
              </View>
            </Card>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
