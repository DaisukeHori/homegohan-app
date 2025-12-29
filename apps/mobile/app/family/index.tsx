import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../src/lib/api";
import { supabase } from "../../src/lib/supabase";

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
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>家族</Text>

      <View style={{ gap: 8 }}>
        <Link href="/home">ホームへ</Link>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : !group ? (
        <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
          <Text style={{ fontWeight: "900" }}>家族グループ作成</Text>
          <TextInput value={groupName} onChangeText={setGroupName} placeholder="グループ名" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
          <Pressable onPress={createGroup} disabled={isCreatingGroup} style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isCreatingGroup ? "#999" : "#333" }}>
            <Text style={{ color: "white", fontWeight: "900" }}>{isCreatingGroup ? "作成中..." : "作成"}</Text>
          </Pressable>
          <Text style={{ color: "#666" }}>※ 1ユーザーにつき家族グループは1つまでです。</Text>
        </View>
      ) : (
        <>
          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
            <Text style={{ fontWeight: "900" }}>{group.name}</Text>
            <Text style={{ color: "#666" }}>メンバー: {group.memberCount}人</Text>
          </View>

          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
            <Text style={{ fontWeight: "900" }}>メンバー追加</Text>
            <TextInput value={memberName} onChangeText={setMemberName} placeholder="名前" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
            <TextInput
              value={memberRelation}
              onChangeText={setMemberRelation}
              placeholder="relation（例: child/spouse/other）"
              style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
            />
            <Pressable onPress={addMember} disabled={isAddingMember} style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isAddingMember ? "#999" : "#E07A5F" }}>
              <Text style={{ color: "white", fontWeight: "900" }}>{isAddingMember ? "追加中..." : "追加"}</Text>
            </Pressable>
          </View>

          <View style={{ gap: 10 }}>
            {group.members?.map((m) => (
              <View key={m.id} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
                <Text style={{ fontWeight: "900" }}>
                  {m.name}（{m.relation}）
                </Text>
                <Text style={{ color: "#666" }}>
                  {m.height ? `${m.height}cm` : ""} {m.weight ? `${m.weight}kg` : ""}
                </Text>
                {m.relation !== "self" ? (
                  <Pressable onPress={() => deactivateMember(m.id)} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#c00", alignSelf: "flex-start" }}>
                    <Text style={{ color: "white", fontWeight: "900" }}>削除</Text>
                  </Pressable>
                ) : (
                  <Text style={{ color: "#999" }}>（オーナー）</Text>
                )}
              </View>
            ))}
          </View>
        </>
      )}

      <Pressable onPress={load} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>更新</Text>
      </Pressable>
    </ScrollView>
  );
}



