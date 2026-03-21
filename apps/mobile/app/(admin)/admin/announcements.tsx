import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Card, Button, SectionHeader, StatusBadge, LoadingState, EmptyState } from "../../../src/components/ui";
import { Input } from "../../../src/components/ui";
import { colors, spacing, radius, shadows } from "../../../src/theme";
import { getApi } from "../../../src/lib/api";

type Announcement = {
  id: string;
  title: string;
  content: string;
  category: string;
  priority: number;
  targetAudience: string;
  isPublic: boolean;
  publishedAt: string | null;
  createdAt: string;
};

export default function AdminAnnouncementsPage() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ announcements: Announcement[] }>("/api/admin/announcements?include_unpublished=true");
      setItems(res.announcements ?? []);
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
    const t = title.trim();
    const c = content.trim();
    if (!t || !c || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.post("/api/admin/announcements", { title: t, content: c, isPublic });
      setTitle("");
      setContent("");
      await load();
    } catch (e: any) {
      Alert.alert("作成失敗", e?.message ?? "作成に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function remove(id: string) {
    Alert.alert("削除", "このお知らせを削除しますか？", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: async () => {
          try {
            const api = getApi();
            await api.del(`/api/admin/announcements/${id}`);
            await load();
          } catch (e: any) {
            Alert.alert("削除失敗", e?.message ?? "削除に失敗しました。");
          }
        },
      },
    ]);
  }

  async function togglePublic(a: Announcement) {
    try {
      const api = getApi();
      await api.put(`/api/admin/announcements/${a.id}`, { isPublic: !a.isPublic });
      await load();
    } catch (e: any) {
      Alert.alert("更新失敗", e?.message ?? "更新に失敗しました。");
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: 56, paddingHorizontal: spacing.lg, paddingBottom: spacing["3xl"], gap: spacing.lg }}>
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "800", color: colors.text }}>Announcements</Text>
      </View>

      {/* Create Form */}
      <Card>
        <View style={{ gap: spacing.md }}>
          <SectionHeader title="新規作成" />
          <Input value={title} onChangeText={setTitle} placeholder="タイトル" />
          <Input
            value={content}
            onChangeText={setContent}
            placeholder="内容"
            multiline
            style={{ minHeight: 120, textAlignVertical: "top" }}
          />
          <Pressable
            onPress={() => setIsPublic((v) => !v)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: spacing.sm,
              paddingVertical: spacing.md,
              paddingHorizontal: spacing.lg,
              borderRadius: radius.md,
              backgroundColor: isPublic ? colors.accentLight : colors.bg,
              borderWidth: 1,
              borderColor: isPublic ? colors.accent : colors.border,
            }}
          >
            <Ionicons name={isPublic ? "eye" : "eye-off"} size={20} color={isPublic ? colors.accent : colors.textMuted} />
            <Text style={{ fontSize: 15, fontWeight: "700", color: isPublic ? colors.accent : colors.textMuted }}>
              {isPublic ? "公開: ON" : "公開: OFF"}
            </Text>
          </Pressable>
          <Button onPress={create} loading={isSubmitting} disabled={isSubmitting}>
            {isSubmitting ? "作成中..." : "作成"}
          </Button>
        </View>
      </Card>

      {/* List */}
      <SectionHeader
        title="一覧"
        right={
          <Pressable onPress={load} hitSlop={8}>
            <Ionicons name="refresh" size={20} color={colors.textMuted} />
          </Pressable>
        }
      />

      {isLoading ? (
        <LoadingState message="読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ fontSize: 14, color: colors.error, flex: 1 }}>{error}</Text>
          </View>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState icon={<Ionicons name="megaphone-outline" size={40} color={colors.textMuted} />} message="お知らせがありません。" />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {items.map((a) => (
            <Card key={a.id}>
              <View style={{ gap: spacing.sm }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <Ionicons name="megaphone" size={18} color={colors.accent} />
                  <Text style={{ flex: 1, fontSize: 15, fontWeight: "700", color: colors.text }}>{a.title}</Text>
                  <StatusBadge variant={a.isPublic ? "completed" : "pending"} label={a.isPublic ? "公開" : "非公開"} />
                </View>
                <Text style={{ fontSize: 13, color: colors.textMuted, lineHeight: 20 }}>
                  {a.content.substring(0, 120)}{a.content.length > 120 ? "..." : ""}
                </Text>
                <Text style={{ fontSize: 12, color: colors.textMuted }}>{new Date(a.createdAt).toLocaleString("ja-JP")}</Text>
                <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs }}>
                  <Button onPress={() => togglePublic(a)} variant="secondary" size="sm">
                    {a.isPublic ? "非公開にする" : "公開にする"}
                  </Button>
                  <Button onPress={() => remove(a.id)} variant="destructive" size="sm">
                    削除
                  </Button>
                </View>
              </View>
            </Card>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
