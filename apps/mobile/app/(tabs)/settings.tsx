import { Ionicons } from "@expo/vector-icons";
import * as FileSystem from "expo-file-system";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import * as Sharing from "expo-sharing";
import React, { useEffect, useState } from "react";
import { Alert, Linking, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { getApi, getApiBaseUrl } from "../../src/lib/api";
import { supabase } from "../../src/lib/supabase";
import { useAuth } from "../../src/providers/AuthProvider";
import { colors, spacing, radius, shadows } from "../../src/theme";
import { clearUserScopedAsyncStorage } from "../../src/lib/user-storage";

type WeekStartDay = "sunday" | "monday";

type SettingRowProps = {
  icon: string;
  iconBg: string;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  last?: boolean;
};

function SettingRow({ icon, iconBg, title, subtitle, right, onPress, last }: SettingRowProps) {
  const content = (
    <View style={[styles.settingRow, !last && styles.settingRowBorder]}>
      <View style={styles.settingLeft}>
        <View style={[styles.settingIcon, { backgroundColor: iconBg }]}>
          <Text style={{ fontSize: 16 }}>{icon}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.settingTitle}>{title}</Text>
          {subtitle ? <Text style={styles.settingSub}>{subtitle}</Text> : null}
        </View>
      </View>
      {right ?? <Ionicons name="chevron-forward" size={20} color="#D1D5DB" />}
    </View>
  );

  if (onPress) {
    return <Pressable onPress={onPress}>{content}</Pressable>;
  }
  return content;
}

export default function SettingsTab() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();

  const [notifications, setNotifications] = useState(true);
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [dataShare, setDataShare] = useState(true);
  const [weekStartDay, setWeekStartDay] = useState<WeekStartDay>("monday");
  const [savingWeekStart, setSavingWeekStart] = useState(false);
  const [showLogoutModal, setShowLogoutModal] = useState(false);

  useEffect(() => {
    async function fetchSettings() {
      if (!user) return;

      // 週の開始日
      const { data } = await supabase
        .from("user_profiles")
        .select("week_start_day")
        .eq("id", user.id)
        .single();
      if (data?.week_start_day) {
        setWeekStartDay(data.week_start_day as WeekStartDay);
      }

      // 通知・自動解析設定を API から取得
      try {
        const api = getApi();
        const res = await api.get<{ settings: { notifications_enabled: boolean; auto_analyze_enabled: boolean; data_share_enabled: boolean } }>("/api/notification-preferences");
        if (res.settings) {
          setNotifications(res.settings.notifications_enabled);
          setAutoAnalyze(res.settings.auto_analyze_enabled);
          setDataShare(res.settings.data_share_enabled);
        }
      } catch (e) {
        console.error("Failed to fetch notification preferences:", e);
      }
    }
    fetchSettings();
  }, [user]);

  async function handleToggleNotificationPreference(
    key: "notifications_enabled" | "auto_analyze_enabled" | "data_share_enabled",
    setter: React.Dispatch<React.SetStateAction<boolean>>,
    currentValue: boolean,
  ) {
    const newValue = !currentValue;

    // 通知を ON にするときは OS の通知権限をリクエスト
    if (key === "notifications_enabled" && newValue) {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;
      if (existingStatus !== "granted") {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }
      if (finalStatus !== "granted") {
        Alert.alert(
          "通知が許可されていません",
          "通知を受け取るには、端末の設定からアプリの通知を許可してください。",
          [
            { text: "キャンセル", style: "cancel" },
            { text: "設定を開く", onPress: () => Linking.openSettings() },
          ],
        );
        return; // DB への保存も行わない
      }
    }

    setter(newValue);
    try {
      const api = getApi();
      await api.patch("/api/notification-preferences", { [key]: newValue });
    } catch (e) {
      console.error("Failed to save preference:", e);
      setter(currentValue); // ロールバック
    }
  }

  async function handleWeekStartDayChange(newValue: WeekStartDay) {
    if (!user) return;
    setWeekStartDay(newValue);
    setSavingWeekStart(true);
    try {
      await supabase
        .from("user_profiles")
        .update({ week_start_day: newValue })
        .eq("id", user.id);
    } catch (error) {
      console.error("Failed to save week start day:", error);
    } finally {
      setSavingWeekStart(false);
    }
  }

  const [exportingJson, setExportingJson] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);

  async function getAuthToken(): Promise<string | null> {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }

  async function handleExportJson() {
    if (exportingJson) return;
    setExportingJson(true);
    try {
      const token = await getAuthToken();
      if (!token) {
        Alert.alert("エラー", "ログインが必要です。");
        return;
      }
      const baseUrl = getApiBaseUrl();
      const res = await fetch(`${baseUrl}/api/account/export`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const text = await res.text();
      const today = new Date().toISOString().slice(0, 10);
      const filename = `homegohan-export-${today}.json`;
      const fileUri = (FileSystem.documentDirectory ?? "") + filename;
      await FileSystem.writeAsStringAsync(fileUri, text, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(fileUri, {
          mimeType: "application/json",
          dialogTitle: "JSONデータをエクスポート",
          UTI: "public.json",
        });
      } else {
        Alert.alert("完了", `ファイルを保存しました:\n${fileUri}`);
      }
    } catch (err) {
      console.error("JSON export error:", err);
      Alert.alert("エラー", "JSONエクスポートに失敗しました。時間をおいて再度お試しください。");
    } finally {
      setExportingJson(false);
    }
  }

  async function handleExportCsv() {
    if (exportingCsv) return;
    setExportingCsv(true);
    try {
      const token = await getAuthToken();
      if (!token) {
        Alert.alert("エラー", "ログインが必要です。");
        return;
      }
      const baseUrl = getApiBaseUrl();
      const res = await fetch(`${baseUrl}/api/export/meals`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const text = await res.text();
      const today = new Date().toISOString().slice(0, 10);
      const filename = `homegohan-meals-${today}.csv`;
      const fileUri = (FileSystem.documentDirectory ?? "") + filename;
      await FileSystem.writeAsStringAsync(fileUri, text, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(fileUri, {
          mimeType: "text/csv",
          dialogTitle: "食事記録をCSVでエクスポート",
          UTI: "public.comma-separated-values-text",
        });
      } else {
        Alert.alert("完了", `ファイルを保存しました:\n${fileUri}`);
      }
    } catch (err) {
      console.error("CSV export error:", err);
      Alert.alert("エラー", "CSVエクスポートに失敗しました。時間をおいて再度お試しください。");
    } finally {
      setExportingCsv(false);
    }
  }

  async function handleLogout() {
    try {
      await clearUserScopedAsyncStorage(user?.id ?? null);
      await supabase.auth.signOut();
    } catch {}
    router.replace("/");
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>設定</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

        {/* ── 一般 ── */}
        <View>
          <Text style={styles.sectionLabel}>一般</Text>
          <View style={styles.sectionCard}>
            <SettingRow
              icon="🔔"
              iconBg="#EFF6FF"
              title="通知"
              right={<Switch value={notifications} onValueChange={() => handleToggleNotificationPreference("notifications_enabled", setNotifications, notifications)} trackColor={{ true: colors.accent }} />}
            />
            <SettingRow
              icon="🤖"
              iconBg="#F3E8FF"
              title="自動解析"
              right={<Switch value={autoAnalyze} onValueChange={() => handleToggleNotificationPreference("auto_analyze_enabled", setAutoAnalyze, autoAnalyze)} trackColor={{ true: colors.accent }} />}
            />
            <SettingRow
              icon="📅"
              iconBg="#F0FDFA"
              title="週の開始日"
              subtitle="カレンダーの開始曜日"
              last
              right={
                <View style={styles.weekStartRow}>
                  <Pressable
                    onPress={() => handleWeekStartDayChange("sunday")}
                    disabled={savingWeekStart}
                    style={[styles.weekStartBtn, weekStartDay === "sunday" && styles.weekStartBtnActive]}
                  >
                    <Text style={[styles.weekStartText, weekStartDay === "sunday" && styles.weekStartTextActive]}>日曜</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => handleWeekStartDayChange("monday")}
                    disabled={savingWeekStart}
                    style={[styles.weekStartBtn, weekStartDay === "monday" && styles.weekStartBtnActive]}
                  >
                    <Text style={[styles.weekStartText, weekStartDay === "monday" && styles.weekStartTextActive]}>月曜</Text>
                  </Pressable>
                </View>
              }
            />
          </View>
        </View>

        {/* ── 個人情報 ── */}
        <View>
          <Text style={styles.sectionLabel}>個人情報</Text>
          <View style={styles.sectionCard}>
            <SettingRow
              icon="👤"
              iconBg="#EFF6FF"
              title="プロフィール"
              subtitle="名前、年齢、身長・体重など"
              onPress={() => router.push("/profile")}
            />
            <SettingRow
              icon="🩺"
              iconBg="#FEF2F2"
              title="健康診断"
              subtitle="検査結果の記録・分析"
              onPress={() => router.push("/health/blood-tests")}
            />
            <SettingRow
              icon="🎯"
              iconBg="#FFF7ED"
              title="栄養目標を再設定"
              subtitle="計算根拠を見ながら目標カロリーを調整"
              onPress={() => router.push("/profile/nutrition-targets")}
              last
            />
          </View>
        </View>

        {/* ── データとプライバシー ── */}
        <View>
          <Text style={styles.sectionLabel}>データとプライバシー</Text>
          <View style={styles.sectionCard}>
            <SettingRow
              icon="📋"
              iconBg="#F0FDF4"
              title="JSONでエクスポート"
              subtitle="全データを JSON 形式でダウンロード"
              onPress={handleExportJson}
              right={exportingJson ? <Text style={{ fontSize: 12, color: "#6B7280" }}>処理中…</Text> : undefined}
            />
            <SettingRow
              icon="☁️"
              iconBg="#F0FDF4"
              title="CSVでエクスポート"
              subtitle="食事記録を CSV 形式でダウンロード"
              onPress={handleExportCsv}
              right={exportingCsv ? <Text style={{ fontSize: 12, color: "#6B7280" }}>処理中…</Text> : undefined}
            />
            <SettingRow
              icon="📊"
              iconBg="#FFF7ED"
              title="トレーナーと共有"
              subtitle="栄養士やジムと連携"
              last
              right={<Switch value={dataShare} onValueChange={() => handleToggleNotificationPreference("data_share_enabled", setDataShare, dataShare)} trackColor={{ true: colors.accent }} />}
            />
          </View>
        </View>

        {/* ── サポートと法的情報 ── */}
        <View>
          <Text style={styles.sectionLabel}>サポートと法的情報</Text>
          <View style={styles.sectionCard}>
            <SettingRow
              icon="📄"
              iconBg="#F9FAFB"
              title="利用規約"
              onPress={() => Linking.openURL("https://homegohan.app/terms")}
            />
            <SettingRow
              icon="🔒"
              iconBg="#F9FAFB"
              title="プライバシーポリシー"
              onPress={() => Linking.openURL("https://homegohan.app/privacy")}
            />
            <SettingRow
              icon="✉️"
              iconBg="#F9FAFB"
              title="お問い合わせ"
              onPress={() => Linking.openURL("mailto:support@homegohan.jp")}
              last
            />
          </View>
        </View>

        {/* ── アカウント ── */}
        <View>
          <Text style={styles.sectionLabel}>アカウント</Text>
          <View style={styles.sectionCard}>
            <SettingRow
              icon="⚠️"
              iconBg="#FEF2F2"
              title="アカウント管理"
              subtitle="アカウント削除"
              onPress={() => router.push("/settings/account")}
              last
            />
          </View>
        </View>

        {/* ── ログアウト ── */}
        <Pressable onPress={() => setShowLogoutModal(true)} style={styles.logoutBtn}>
          <Text style={styles.logoutText}>ログアウト</Text>
        </Pressable>

        <Text style={styles.versionText}>
          Version 1.0.0{"\n"}© 2025 ほめゴハン
        </Text>
      </ScrollView>

      {/* ── ログアウト確認モーダル ── */}
      <Modal visible={showLogoutModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalIcon}>
              <Text style={{ fontSize: 32 }}>👋</Text>
            </View>
            <Text style={styles.modalTitle}>ログアウトしますか？</Text>
            <Text style={styles.modalSub}>
              ログアウトしてもデータは保持されます。{"\n"}またすぐにお会いしましょう。
            </Text>
            <Pressable onPress={handleLogout} style={styles.modalLogoutBtn}>
              <Text style={styles.modalLogoutText}>ログアウト</Text>
            </Pressable>
            <Pressable onPress={() => setShowLogoutModal(false)} style={styles.modalCancelBtn}>
              <Text style={styles.modalCancelText}>キャンセル</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#F9FAFB",
  },
  header: {
    backgroundColor: "#fff",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "800",
    color: "#1F2937",
  },
  scrollContent: {
    padding: spacing.lg,
    gap: spacing.xl,
    paddingBottom: 120,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: "#9CA3AF",
    textTransform: "uppercase",
    letterSpacing: 2,
    marginBottom: spacing.sm,
    paddingLeft: 8,
  },
  sectionCard: {
    backgroundColor: "#fff",
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: "#F3F4F6",
    ...shadows.sm,
    overflow: "hidden",
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
  },
  settingRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: "#F9FAFB",
  },
  settingLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    flex: 1,
  },
  settingIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  settingTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#374151",
  },
  settingSub: {
    fontSize: 12,
    color: "#9CA3AF",
    marginTop: 1,
  },
  weekStartRow: {
    flexDirection: "row",
    gap: 4,
  },
  weekStartBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.md,
    backgroundColor: "#F3F4F6",
  },
  weekStartBtnActive: {
    backgroundColor: colors.accent,
  },
  weekStartText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#4B5563",
  },
  weekStartTextActive: {
    color: "#fff",
  },
  logoutBtn: {
    borderWidth: 1,
    borderColor: "#FEE2E2",
    borderRadius: radius.xl,
    paddingVertical: 18,
    alignItems: "center",
    backgroundColor: "#fff",
  },
  logoutText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#EF4444",
  },
  versionText: {
    textAlign: "center",
    fontSize: 12,
    color: "#9CA3AF",
    lineHeight: 18,
  },
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
  },
  modalCard: {
    backgroundColor: "#fff",
    borderRadius: radius["2xl"],
    padding: spacing["2xl"],
    width: "100%",
    maxWidth: 340,
    alignItems: "center",
    ...shadows.lg,
  },
  modalIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#F3F4F6",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: "#1F2937",
    marginBottom: spacing.sm,
  },
  modalSub: {
    fontSize: 14,
    color: "#6B7280",
    textAlign: "center",
    lineHeight: 20,
    marginBottom: spacing.xl,
  },
  modalLogoutBtn: {
    width: "100%",
    backgroundColor: "#1F2937",
    paddingVertical: 14,
    borderRadius: radius.full,
    alignItems: "center",
    marginBottom: spacing.sm,
    ...shadows.md,
  },
  modalLogoutText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 16,
  },
  modalCancelBtn: {
    width: "100%",
    paddingVertical: 14,
    borderRadius: radius.full,
    alignItems: "center",
  },
  modalCancelText: {
    color: "#6B7280",
    fontWeight: "700",
    fontSize: 16,
  },
});
