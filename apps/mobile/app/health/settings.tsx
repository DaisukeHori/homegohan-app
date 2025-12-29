import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../src/lib/api";
import { registerAndSaveExpoPushToken } from "../../src/lib/pushNotifications";
import { supabase } from "../../src/lib/supabase";

type Preferences = {
  enabled: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  record_mode: string;
  personality_type: string;
  morning_reminder_enabled: boolean;
  morning_reminder_time: string;
  evening_reminder_enabled: boolean;
  evening_reminder_time: string;
  vacation_mode: boolean;
  vacation_until: string | null;
};

type PushTokenRow = { id: string; expo_push_token: string; platform: string | null; created_at: string };

export default function HealthSettingsPage() {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [tokens, setTokens] = useState<PushTokenRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ preferences: Preferences }>("/api/health/notifications/preferences");
      setPrefs(res.preferences);

      const { data, error: tokenErr } = await supabase
        .from("user_push_tokens")
        .select("id,expo_push_token,platform,created_at")
        .order("created_at", { ascending: false });
      if (tokenErr) throw tokenErr;
      setTokens((data as any) ?? []);
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
    if (!prefs || isSaving) return;
    setIsSaving(true);
    try {
      const api = getApi();
      await api.put("/api/health/notifications/preferences", prefs);
      Alert.alert("保存しました", "通知設定を更新しました。");
      await load();
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  }

  async function registerPush() {
    try {
      const token = await registerAndSaveExpoPushToken();
      if (!token) {
        Alert.alert("通知", "通知許可が必要です（または物理端末で試してください）。");
      } else {
        Alert.alert("登録しました", token);
      }
      await load();
    } catch (e: any) {
      Alert.alert("失敗", e?.message ?? "失敗しました。");
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>健康 設定</Text>
      <Link href="/health">健康トップへ</Link>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : !prefs ? (
        <Text style={{ color: "#666" }}>設定がありません。</Text>
      ) : (
        <>
          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
            <Text style={{ fontWeight: "900" }}>Push通知</Text>
            <Pressable onPress={registerPush} style={{ padding: 12, borderRadius: 12, backgroundColor: "#333", alignItems: "center" }}>
              <Text style={{ color: "white", fontWeight: "900" }}>端末を登録（Expo Push Token）</Text>
            </Pressable>
            {tokens.length === 0 ? (
              <Text style={{ color: "#666" }}>未登録</Text>
            ) : (
              tokens.slice(0, 3).map((t) => (
                <Text key={t.id} style={{ color: "#666" }}>
                  - {t.platform ?? "-"}: {t.expo_push_token}
                </Text>
              ))
            )}
          </View>

          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
            <Text style={{ fontWeight: "900" }}>通知設定</Text>
            <Pressable onPress={() => setPrefs({ ...prefs, enabled: !prefs.enabled })} style={{ padding: 12, borderRadius: 12, backgroundColor: prefs.enabled ? "#E07A5F" : "#333", alignItems: "center" }}>
              <Text style={{ color: "white", fontWeight: "900" }}>{prefs.enabled ? "通知: ON" : "通知: OFF"}</Text>
            </Pressable>

            <Text style={{ fontWeight: "900" }}>Quiet Hours</Text>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <TextInput
                value={prefs.quiet_hours_start}
                onChangeText={(v) => setPrefs({ ...prefs, quiet_hours_start: v })}
                placeholder="start"
                style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
              />
              <TextInput
                value={prefs.quiet_hours_end}
                onChangeText={(v) => setPrefs({ ...prefs, quiet_hours_end: v })}
                placeholder="end"
                style={{ flex: 1, borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
              />
            </View>

            <Pressable
              onPress={() => setPrefs({ ...prefs, morning_reminder_enabled: !prefs.morning_reminder_enabled })}
              style={{ padding: 12, borderRadius: 12, backgroundColor: prefs.morning_reminder_enabled ? "#E07A5F" : "#333", alignItems: "center" }}
            >
              <Text style={{ color: "white", fontWeight: "900" }}>{prefs.morning_reminder_enabled ? "朝リマインド: ON" : "朝リマインド: OFF"}</Text>
            </Pressable>
            <TextInput
              value={prefs.morning_reminder_time}
              onChangeText={(v) => setPrefs({ ...prefs, morning_reminder_time: v })}
              placeholder="07:30"
              style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
            />

            <Pressable
              onPress={() => setPrefs({ ...prefs, evening_reminder_enabled: !prefs.evening_reminder_enabled })}
              style={{ padding: 12, borderRadius: 12, backgroundColor: prefs.evening_reminder_enabled ? "#E07A5F" : "#333", alignItems: "center" }}
            >
              <Text style={{ color: "white", fontWeight: "900" }}>{prefs.evening_reminder_enabled ? "夜リマインド: ON" : "夜リマインド: OFF"}</Text>
            </Pressable>
            <TextInput
              value={prefs.evening_reminder_time}
              onChangeText={(v) => setPrefs({ ...prefs, evening_reminder_time: v })}
              placeholder="21:00"
              style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
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


