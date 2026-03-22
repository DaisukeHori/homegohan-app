import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Linking, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { supabase } from "../../src/lib/supabase";
import { useAuth } from "../../src/providers/AuthProvider";
import { colors, spacing, radius, shadows } from "../../src/theme";

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
      const { data } = await supabase
        .from("user_profiles")
        .select("week_start_day")
        .eq("id", user.id)
        .single();
      if (data?.week_start_day) {
        setWeekStartDay(data.week_start_day as WeekStartDay);
      }
    }
    fetchSettings();
  }, [user]);

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

  async function handleLogout() {
    try {
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
              right={<Switch value={notifications} onValueChange={setNotifications} trackColor={{ true: colors.accent }} />}
            />
            <SettingRow
              icon="🤖"
              iconBg="#F3E8FF"
              title="自動解析"
              right={<Switch value={autoAnalyze} onValueChange={setAutoAnalyze} trackColor={{ true: colors.accent }} />}
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
              icon="☁️"
              iconBg="#F0FDF4"
              title="データをエクスポート"
              subtitle="CSV, JSON, PDF形式で出力"
              onPress={() => Alert.alert("準備中", "この機能は準備中です。")}
            />
            <SettingRow
              icon="📊"
              iconBg="#FFF7ED"
              title="トレーナーと共有"
              subtitle="栄養士やジムと連携"
              last
              right={<Switch value={dataShare} onValueChange={setDataShare} trackColor={{ true: colors.accent }} />}
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
