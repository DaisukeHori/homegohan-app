import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Card, Button, SectionHeader, LoadingState, EmptyState } from "../../../src/components/ui";
import { Input } from "../../../src/components/ui";
import { getApi } from "../../../src/lib/api";
import { colors, spacing } from "../../../src/theme";

type Dept = {
  id: string;
  name: string;
  memberCount: number;
  displayOrder: number;
};

export default function OrgDepartmentsPage() {
  const router = useRouter();
  const [items, setItems] = useState<Dept[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ departments: Dept[] }>("/api/org/departments");
      setItems(res.departments ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create() {
    const n = name.trim();
    if (!n || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.post("/api/org/departments", { name: n });
      setName("");
      await load();
    } catch (e: any) {
      Alert.alert("作成失敗", e?.message ?? "作成に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function rename(id: string, current: string) {
    Alert.prompt?.(
      "部署名変更",
      "新しい部署名を入力してください",
      async (text) => {
        const n = (text ?? "").trim();
        if (!n || n === current) return;
        try {
          const api = getApi();
          await api.put("/api/org/departments", { id, name: n });
          await load();
        } catch (e: any) {
          Alert.alert("更新失敗", e?.message ?? "更新に失敗しました。");
        }
      },
      "plain-text",
      current
    );
  }

  async function remove(id: string) {
    Alert.alert("削除", "この部署を削除しますか？", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: async () => {
          try {
            const api = getApi();
            await api.del(`/api/org/departments?id=${id}`);
            await load();
          } catch (e: any) {
            Alert.alert("削除失敗", e?.message ?? "削除に失敗しました。");
          }
        },
      },
    ]);
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: spacing["4xl"] }}>
      {/* Header */}
      <View style={{ paddingTop: 56, paddingHorizontal: spacing.xl, paddingBottom: spacing.lg, flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <Pressable onPress={() => router.push("/org/dashboard")} hitSlop={8}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "800", color: colors.text, flex: 1 }}>部署</Text>
        <Pressable onPress={load} hitSlop={8}>
          <Ionicons name="refresh" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <View style={{ paddingHorizontal: spacing.xl, gap: spacing.lg }}>
        {/* Create Form */}
        <Card>
          <SectionHeader title="部署を追加" />
          <View style={{ gap: spacing.md, marginTop: spacing.sm }}>
            <Input value={name} onChangeText={setName} placeholder="部署名" label="部署名" />
            <Button onPress={create} loading={isSubmitting} disabled={isSubmitting}>
              {isSubmitting ? "追加中..." : "追加"}
            </Button>
          </View>
        </Card>

        {/* List */}
        <SectionHeader title="部署一覧" />

        {isLoading ? (
          <LoadingState message="部署を読み込み中..." />
        ) : error ? (
          <Card variant="error">
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <Ionicons name="alert-circle" size={20} color={colors.error} />
              <Text style={{ fontSize: 14, color: colors.error, flex: 1 }}>{error}</Text>
            </View>
          </Card>
        ) : items.length === 0 ? (
          <EmptyState icon={<Ionicons name="business-outline" size={40} color={colors.textMuted} />} message="部署がありません。" />
        ) : (
          <View style={{ gap: spacing.md }}>
            {items.map((d) => (
              <Card key={d.id}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                  <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.purpleLight, alignItems: "center", justifyContent: "center" }}>
                    <Ionicons name="business" size={20} color={colors.purple} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 16, fontWeight: "700", color: colors.text }}>{d.name}</Text>
                    <Text style={{ fontSize: 13, color: colors.textMuted }}>{d.memberCount}人</Text>
                  </View>
                  <View style={{ flexDirection: "row", gap: spacing.sm }}>
                    <Button onPress={() => rename(d.id, d.name)} variant="outline" size="sm">
                      変更
                    </Button>
                    <Button onPress={() => remove(d.id)} variant="destructive" size="sm">
                      削除
                    </Button>
                  </View>
                </View>
              </Card>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}
