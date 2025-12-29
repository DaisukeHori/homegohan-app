import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../../src/lib/api";

type Member = {
  id: string;
  nickname: string | null;
  roles: string[] | null;
  department: string | null;
  created_at: string;
};

export default function OrgMembersPage() {
  const [items, setItems] = useState<Member[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ members: Member[] }>("/api/org/users");
      setItems(res.members ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createUser() {
    const e = email.trim();
    const p = password.trim();
    const n = nickname.trim();
    if (!e || !p || !n || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.post("/api/org/users", { email: e, password: p, nickname: n });
      setEmail("");
      setPassword("");
      setNickname("");
      Alert.alert("作成しました", "ユーザーを作成しました。");
      await load();
    } catch (err: any) {
      Alert.alert("作成失敗", err?.message ?? "作成に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>メンバー</Text>

      <View style={{ gap: 8 }}>
        <Link href="/org/dashboard">ダッシュボードへ</Link>
      </View>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>ユーザー作成（組織内）</Text>
        <TextInput value={email} onChangeText={setEmail} placeholder="email" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder="password"
          secureTextEntry
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
        />
        <TextInput value={nickname} onChangeText={setNickname} placeholder="nickname" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <Pressable onPress={createUser} disabled={isSubmitting} style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isSubmitting ? "#999" : "#333" }}>
          <Text style={{ color: "white", fontWeight: "900" }}>{isSubmitting ? "作成中..." : "作成"}</Text>
        </Pressable>
        <Text style={{ color: "#999" }}>※ メール送信は未実装。初期パスワードでログインできます。</Text>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>メンバーがいません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((m) => (
            <View key={m.id} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 4 }}>
              <Text style={{ fontWeight: "900" }}>{m.nickname ?? "(no name)"}</Text>
              <Text style={{ color: "#666" }}>roles: {(m.roles ?? []).join(", ") || "(none)"}</Text>
              <Text style={{ color: "#666" }}>dept: {m.department ?? "-"}</Text>
              <Text style={{ color: "#999" }}>{m.id}</Text>
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


