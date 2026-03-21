import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";

import { Button, Card, EmptyState, Input, ListItem, LoadingState, PageHeader, SectionHeader } from "../../src/components/ui";
import { getApi } from "../../src/lib/api";
import { supabase } from "../../src/lib/supabase";
import { colors, spacing } from "../../src/theme";

type FamilyMemberLite = {
  id: string;
  name: string;
  relation: string;
  gender?: string | null;
  height?: number | null;
  weight?: number | null;
  user_id?: string | null;
};

type FamilyGroup = {
  id: string;
  name: string;
  memberCount: number;
  members: FamilyMemberLite[];
  createdAt: string;
};

export default function FamilyPage() {
  const [groups, setGroups] = useState<FamilyGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [groupName, setGroupName] = useState("我が家");
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);

  const [memberName, setMemberName] = useState("");
  const [memberRelation, setMemberRelation] = useState("other");
  const [isAddingMember, setIsAddingMember] = useState(false);

  const group = useMemo(() => groups[0] ?? null, [groups]);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ groups: FamilyGroup[] }>("/api/family/groups");
      setGroups(res.groups ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createGroup() {
    if (isCreatingGroup) return;
    setIsCreatingGroup(true);
    try {
      const api = getApi();
      await api.post("/api/family/groups", { name: groupName.trim() || "我が家" });
      await load();
    } catch (e: any) {
      Alert.alert("作成失敗", e?.message ?? "作成に失敗しました。");
    } finally {
      setIsCreatingGroup(false);
    }
  }

  async function addMember() {
    if (!group) return;
    const n = memberName.trim();
    if (!n) return;
    setIsAddingMember(true);
    try {
      const api = getApi();
      await api.post("/api/family/members", { groupId: group.id, name: n, relation: memberRelation || "other" });
      setMemberName("");
      setMemberRelation("other");
      await load();
    } catch (e: any) {
      Alert.alert("追加失敗", e?.message ?? "追加に失敗しました。");
    } finally {
      setIsAddingMember(false);
    }
  }

  async function deactivateMember(memberId: string) {
    if (!group) return;
    Alert.alert("削除", "このメンバーを削除しますか？（非表示になります）", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: async () => {
          try {
            const { error: updateError } = await supabase.from("family_members").update({ is_active: false }).eq("id", memberId);
            if (updateError) throw updateError;
            await load();
          } catch (e: any) {
            Alert.alert("削除失敗", e?.message ?? "削除に失敗しました。");
          }
        },
      },
    ]);
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="家族" />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>

      <View style={{ gap: spacing.sm }}>
        <Link href="/home" style={{ color: colors.accent, fontSize: 14, fontWeight: "600" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
            <Ionicons name="home-outline" size={16} color={colors.accent} />
            <Text style={{ color: colors.accent, fontSize: 14, fontWeight: "600" }}>ホームへ</Text>
          </View>
        </Link>
      </View>

      {isLoading ? (
        <LoadingState message="家族情報を読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ color: colors.error, fontSize: 14, fontWeight: "600" }}>{error}</Text>
          </View>
        </Card>
      ) : !group ? (
        <Card>
          <SectionHeader
            title="家族グループ作成"
            right={<Ionicons name="people" size={20} color={colors.accent} />}
          />
          <View style={{ gap: spacing.md, marginTop: spacing.sm }}>
            <Input
              label="グループ名"
              value={groupName}
              onChangeText={setGroupName}
              placeholder="グループ名"
            />
            <Button onPress={createGroup} loading={isCreatingGroup}>
              {isCreatingGroup ? "作成中..." : "作成"}
            </Button>
            <Text style={{ fontSize: 12, color: colors.textMuted }}>
              ※ 1ユーザーにつき家族グループは1つまでです。
            </Text>
          </View>
        </Card>
      ) : (
        <>
          <Card>
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
              <View
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: colors.accentLight,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ionicons name="people" size={24} color={colors.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 16, fontWeight: "700", color: colors.text }}>{group.name}</Text>
                <Text style={{ fontSize: 13, color: colors.textMuted }}>メンバー: {group.memberCount}人</Text>
              </View>
            </View>
          </Card>

          <Card>
            <SectionHeader
              title="メンバー追加"
              right={<Ionicons name="person-add-outline" size={18} color={colors.accent} />}
            />
            <View style={{ gap: spacing.md, marginTop: spacing.sm }}>
              <Input
                label="名前"
                value={memberName}
                onChangeText={setMemberName}
                placeholder="名前"
              />
              <Input
                label="関係"
                value={memberRelation}
                onChangeText={setMemberRelation}
                placeholder="relation（例: child/spouse/other）"
              />
              <Button onPress={addMember} loading={isAddingMember}>
                {isAddingMember ? "追加中..." : "追加"}
              </Button>
            </View>
          </Card>

          <SectionHeader title="メンバー一覧" />
          <View style={{ gap: spacing.sm }}>
            {group.members?.map((m) => (
              <ListItem
                key={m.id}
                title={`${m.name}（${m.relation}）`}
                subtitle={[m.height ? `${m.height}cm` : "", m.weight ? `${m.weight}kg` : ""].filter(Boolean).join(" ") || undefined}
                left={
                  <View
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 18,
                      backgroundColor: m.relation === "self" ? colors.accentLight : colors.blueLight,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Ionicons
                      name={m.relation === "self" ? "person" : "person-outline"}
                      size={18}
                      color={m.relation === "self" ? colors.accent : colors.blue}
                    />
                  </View>
                }
                right={
                  m.relation !== "self" ? (
                    <Button onPress={() => deactivateMember(m.id)} variant="destructive" size="sm">
                      <Ionicons name="trash-outline" size={16} color="#FFFFFF" />
                    </Button>
                  ) : (
                    <Text style={{ fontSize: 12, color: colors.textMuted }}>オーナー</Text>
                  )
                }
              />
            ))}
          </View>
        </>
      )}

      <Button onPress={load} variant="ghost" size="sm">
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
          <Ionicons name="reload-outline" size={16} color={colors.textLight} />
          <Text style={{ color: colors.textLight, fontWeight: "600", fontSize: 14 }}>更新</Text>
        </View>
      </Button>
    </ScrollView>
    </View>
  );
}
