import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";

import { getApi } from "../../../src/lib/api";

export default function SuperAdminFeatureFlagsPage() {
  const [flags, setFlags] = useState<Record<string, any> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ flags: Record<string, any> }>("/api/super-admin/feature-flags");
      setFlags(res.flags ?? {});
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
    if (!flags || isSaving) return;
    setIsSaving(true);
    try {
      const api = getApi();
      await api.put("/api/super-admin/feature-flags", { flags });
      Alert.alert("保存しました", "機能フラグを更新しました。");
      await load();
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  }

  function toggle(key: string) {
    setFlags((prev) => {
      if (!prev) return prev;
      return { ...prev, [key]: !prev[key] };
    });
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>機能フラグ</Text>
      <Link href="/super-admin">Super Admin Home</Link>

      <Pressable onPress={save} disabled={isSaving || !flags} style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isSaving ? "#999" : "#333" }}>
        <Text style={{ color: "white", fontWeight: "900" }}>{isSaving ? "保存中..." : "保存"}</Text>
      </Pressable>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : !flags ? (
        <Text style={{ color: "#666" }}>データがありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {Object.keys(flags).sort().map((k) => (
            <View key={k} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
              <Text style={{ fontWeight: "900" }}>{k}</Text>
              <Pressable onPress={() => toggle(k)} style={{ padding: 12, borderRadius: 12, backgroundColor: flags[k] ? "#E07A5F" : "#333", alignItems: "center" }}>
                <Text style={{ color: "white", fontWeight: "900" }}>{flags[k] ? "ON" : "OFF"}</Text>
              </Pressable>
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


