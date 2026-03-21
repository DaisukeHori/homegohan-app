import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, EmptyState, Input, LoadingState, PageHeader, SectionHeader } from "../../src/components/ui";
import { colors, spacing, radius } from "../../src/theme";
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

  function ToggleRow({
    label,
    value,
    onToggle,
    icon,
  }: {
    label: string;
    value: boolean;
    onToggle: () => void;
    icon: string;
  }) {
    return (
      <Button
        onPress={onToggle}
        variant={value ? "primary" : "secondary"}
        size="md"
      >
        <Ionicons name={icon as any} size={18} color={value ? "#FFFFFF" : colors.text} />
        <Text style={{ color: value ? "#FFFFFF" : colors.text, fontWeight: "700", fontSize: 14 }}>
          {label}: {value ? "ON" : "OFF"}
        </Text>
      </Button>
    );
  }

  return (
    <View style={styles.screen}>
      <PageHeader
        title="健康 設定"
        right={
          <Link href="/health">
            <Text style={styles.linkText}>健康トップへ</Text>
          </Link>
        }
      />
      <ScrollView contentContainerStyle={styles.container}>

      {isLoading ? (
        <LoadingState message="設定を読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={styles.errorRow}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        </Card>
      ) : !prefs ? (
        <EmptyState
          icon={<Ionicons name="settings-outline" size={40} color={colors.textMuted} />}
          message="設定がありません。"
        />
      ) : (
        <>
          <Card>
            <SectionHeader
              title="Push通知"
              right={<Ionicons name="notifications-outline" size={20} color={colors.accent} />}
            />
            <View style={styles.pushSection}>
              <Button onPress={registerPush} variant="primary">
                <Ionicons name="phone-portrait-outline" size={18} color="#FFFFFF" />
                <Text style={{ color: "#FFFFFF", fontWeight: "700", fontSize: 14 }}>端末を登録（Expo Push Token）</Text>
              </Button>
              {tokens.length === 0 ? (
                <Text style={styles.noTokenText}>未登録</Text>
              ) : (
                <View style={styles.tokenList}>
                  {tokens.slice(0, 3).map((t) => (
                    <View key={t.id} style={styles.tokenRow}>
                      <Ionicons name="phone-portrait-outline" size={14} color={colors.textMuted} />
                      <Text style={styles.tokenText} numberOfLines={1}>
                        {t.platform ?? "-"}: {t.expo_push_token}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          </Card>

          <Card>
            <SectionHeader
              title="通知設定"
              right={<Ionicons name="options-outline" size={20} color={colors.accent} />}
            />
            <View style={styles.settingsSection}>
              <ToggleRow
                label="通知"
                value={prefs.enabled}
                onToggle={() => setPrefs({ ...prefs, enabled: !prefs.enabled })}
                icon="notifications"
              />

              <View style={styles.settingGroup}>
                <View style={styles.settingLabelRow}>
                  <Ionicons name="moon-outline" size={16} color={colors.textLight} />
                  <Text style={styles.settingLabel}>Quiet Hours</Text>
                </View>
                <View style={styles.timeRow}>
                  <Input
                    value={prefs.quiet_hours_start}
                    onChangeText={(v) => setPrefs({ ...prefs, quiet_hours_start: v })}
                    placeholder="開始"
                    containerStyle={styles.flex1}
                  />
                  <Text style={styles.timeSeparator}>-</Text>
                  <Input
                    value={prefs.quiet_hours_end}
                    onChangeText={(v) => setPrefs({ ...prefs, quiet_hours_end: v })}
                    placeholder="終了"
                    containerStyle={styles.flex1}
                  />
                </View>
              </View>

              <View style={styles.settingGroup}>
                <View style={styles.settingLabelRow}>
                  <Ionicons name="sunny-outline" size={16} color={colors.textLight} />
                  <Text style={styles.settingLabel}>朝リマインド</Text>
                </View>
                <ToggleRow
                  label="朝リマインド"
                  value={prefs.morning_reminder_enabled}
                  onToggle={() => setPrefs({ ...prefs, morning_reminder_enabled: !prefs.morning_reminder_enabled })}
                  icon="sunny"
                />
                <Input
                  value={prefs.morning_reminder_time}
                  onChangeText={(v) => setPrefs({ ...prefs, morning_reminder_time: v })}
                  placeholder="07:30"
                />
              </View>

              <View style={styles.settingGroup}>
                <View style={styles.settingLabelRow}>
                  <Ionicons name="moon" size={16} color={colors.textLight} />
                  <Text style={styles.settingLabel}>夜リマインド</Text>
                </View>
                <ToggleRow
                  label="夜リマインド"
                  value={prefs.evening_reminder_enabled}
                  onToggle={() => setPrefs({ ...prefs, evening_reminder_enabled: !prefs.evening_reminder_enabled })}
                  icon="moon"
                />
                <Input
                  value={prefs.evening_reminder_time}
                  onChangeText={(v) => setPrefs({ ...prefs, evening_reminder_time: v })}
                  placeholder="21:00"
                />
              </View>

              <Button onPress={save} disabled={isSaving} loading={isSaving}>
                {isSaving ? "保存中..." : "保存"}
              </Button>
            </View>
          </Card>
        </>
      )}
    </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing["4xl"],
  },
  linkText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.accent,
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  errorText: {
    fontSize: 14,
    color: colors.error,
    fontWeight: "600",
    flex: 1,
  },
  pushSection: {
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  noTokenText: {
    fontSize: 13,
    color: colors.textMuted,
  },
  tokenList: {
    gap: spacing.xs,
  },
  tokenRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.bg,
    padding: spacing.sm,
    borderRadius: radius.sm,
  },
  tokenText: {
    fontSize: 12,
    color: colors.textMuted,
    flex: 1,
  },
  settingsSection: {
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  settingGroup: {
    gap: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  settingLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  settingLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.text,
  },
  timeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  timeSeparator: {
    fontSize: 16,
    color: colors.textMuted,
    fontWeight: "700",
  },
  flex1: {
    flex: 1,
  },
});
