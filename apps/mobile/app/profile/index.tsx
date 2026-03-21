import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";

import { Button, Card, ListItem, LoadingState, PageHeader } from "../../src/components/ui";
import { getApi } from "../../src/lib/api";
import { supabase } from "../../src/lib/supabase";
import { useAuth } from "../../src/providers/AuthProvider";
import { useProfile } from "../../src/providers/ProfileProvider";
import { colors, spacing, radius, shadows } from "../../src/theme";

type TabType = "basic" | "goals" | "sports" | "health" | "diet" | "cooking" | "lifestyle";

const TABS: { id: TabType; label: string; icon: string }[] = [
  { id: "basic", label: "基本", icon: "👤" },
  { id: "goals", label: "目標", icon: "🎯" },
  { id: "sports", label: "競技", icon: "🏆" },
  { id: "health", label: "健康", icon: "❤️" },
  { id: "diet", label: "食事", icon: "🍽️" },
  { id: "cooking", label: "調理", icon: "👨‍🍳" },
  { id: "lifestyle", label: "生活", icon: "🏠" },
];

const FITNESS_GOALS = [
  { value: "lose_weight", label: "減量", icon: "🏃" },
  { value: "build_muscle", label: "筋肉増加", icon: "💪" },
  { value: "improve_energy", label: "エネルギーUP", icon: "⚡" },
  { value: "improve_skin", label: "美肌", icon: "✨" },
  { value: "gut_health", label: "腸活", icon: "🌿" },
  { value: "immunity", label: "免疫力", icon: "🛡️" },
  { value: "focus", label: "集中力", icon: "🧠" },
  { value: "gain_weight", label: "増量", icon: "📈" },
];

const HEALTH_CONDITIONS = ["高血圧", "糖尿病", "脂質異常症", "貧血", "痛風", "骨粗しょう症", "睡眠障害", "ストレス"];

const WORK_STYLES = [
  { value: "sedentary", label: "デスクワーク" },
  { value: "light_active", label: "オフィス" },
  { value: "moderately_active", label: "立ち仕事" },
  { value: "very_active", label: "肉体労働" },
  { value: "student", label: "学生" },
  { value: "homemaker", label: "主婦/主夫" },
];

const COOKING_EXP = [
  { value: "beginner", label: "初心者" },
  { value: "intermediate", label: "中級者" },
  { value: "advanced", label: "上級者" },
];

export default function ProfilePage() {
  const { user } = useAuth();
  const { profile: ctxProfile, refresh: refreshProfile } = useProfile();

  const [profileData, setProfileData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>("basic");
  const [editForm, setEditForm] = useState<any>({});
  const [badgeCount, setBadgeCount] = useState(0);
  const [weekStartDay, setWeekStartDay] = useState<"sunday" | "monday">("monday");
  const [notifications, setNotifications] = useState(true);
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  useEffect(() => {
    async function load() {
      setIsLoading(true);
      try {
        const api = getApi();
        const data = await api.get<any>("/api/profile");
        setProfileData(data);
        setEditForm(data);

        try {
          const badgeRes = await api.get<{ badges: any[] }>("/api/badges");
          setBadgeCount(badgeRes.badges?.filter((b: any) => b.earned).length ?? 0);
        } catch {}
      } catch (e: any) {
        console.error("Profile fetch error:", e);
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, []);

  // Fetch week start day
  useEffect(() => {
    (async () => {
      const { data: { user: u } } = await supabase.auth.getUser();
      if (!u) return;
      const { data: p } = await supabase.from("user_profiles").select("week_start_day").eq("id", u.id).single();
      if (p?.week_start_day) setWeekStartDay(p.week_start_day as "sunday" | "monday");
    })();
  }, []);

  async function handleWeekStartDayChange(newValue: "sunday" | "monday") {
    setWeekStartDay(newValue);
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) return;
    await supabase.from("user_profiles").update({ week_start_day: newValue }).eq("id", u.id);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  const displayName = profileData?.nickname || ctxProfile?.nickname || user?.email?.split("@")[0] || "ゲスト";

  function updateField(field: string, value: any) {
    setEditForm((prev: any) => ({ ...prev, [field]: value }));
  }

  function toggleArrayItem(field: string, value: string) {
    const current = (editForm[field] as string[]) || [];
    if (current.includes(value)) {
      updateField(field, current.filter((v: string) => v !== value));
    } else {
      updateField(field, [...current, value]);
    }
  }

  async function handleSave() {
    setIsSaving(true);
    try {
      const api = getApi();
      const updated = await api.put<any>("/api/profile", editForm);
      setProfileData(updated);
      setEditForm(updated);
      setIsEditing(false);
      await refreshProfile();
    } catch (e: any) {
      Alert.alert("更新失敗", e?.message ?? "プロフィールの更新に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <PageHeader title="マイページ" />
        <LoadingState />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader
        title="マイページ"
        right={
          isEditing ? (
            <View style={{ flexDirection: "row", gap: spacing.sm }}>
              <Pressable onPress={() => { setEditForm(profileData); setIsEditing(false); }}>
                <Text style={{ fontSize: 15, color: colors.textMuted, fontWeight: "600" }}>キャンセル</Text>
              </Pressable>
              <Pressable onPress={handleSave} disabled={isSaving}>
                <Text style={{ fontSize: 15, color: colors.accent, fontWeight: "700" }}>
                  {isSaving ? "保存中..." : "保存"}
                </Text>
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={() => setIsEditing(true)}>
              <Text style={{ fontSize: 15, color: colors.accent, fontWeight: "700" }}>編集</Text>
            </Pressable>
          )
        }
      />

      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, paddingBottom: 120 }}>
        {/* プロフィールカード */}
        <Card>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
            <View style={s.avatar}>
              <Ionicons name="person" size={28} color={colors.accent} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 18, fontWeight: "700", color: colors.text }}>{displayName}</Text>
              <Text style={{ fontSize: 14, color: colors.textMuted }}>{user?.email ?? ""}</Text>
            </View>
            <View style={s.badgePill}>
              <Text style={{ fontSize: 12, fontWeight: "700", color: colors.accent }}>🏅 {badgeCount}</Text>
            </View>
          </View>
        </Card>

        {/* タブバー */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -spacing.lg }} contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.xs }}>
          {TABS.map((tab) => (
            <Pressable
              key={tab.id}
              onPress={() => setActiveTab(tab.id)}
              style={[s.tab, activeTab === tab.id && s.tabActive]}
            >
              <Text style={{ fontSize: 14 }}>{tab.icon}</Text>
              <Text style={[s.tabLabel, activeTab === tab.id && s.tabLabelActive]}>{tab.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        {/* ── タブコンテンツ ── */}
        {activeTab === "basic" && (
          <Card>
            <Text style={s.cardTitle}>基本情報</Text>
            <Field label="ニックネーム" value={editForm.nickname} editing={isEditing} onChange={(v) => updateField("nickname", v)} />
            <Field label="年齢" value={editForm.age?.toString()} editing={isEditing} onChange={(v) => updateField("age", v ? parseInt(v) : null)} keyboardType="number-pad" />
            <Field label="性別" value={editForm.gender === "male" ? "男性" : editForm.gender === "female" ? "女性" : "未設定"} editing={false} />
            <Field label="身長 (cm)" value={editForm.height?.toString()} editing={isEditing} onChange={(v) => updateField("height", v ? parseFloat(v) : null)} keyboardType="decimal-pad" />
            <Field label="体重 (kg)" value={editForm.weight?.toString()} editing={isEditing} onChange={(v) => updateField("weight", v ? parseFloat(v) : null)} keyboardType="decimal-pad" />
            <Field label="職業" value={editForm.occupation} editing={isEditing} onChange={(v) => updateField("occupation", v)} />
          </Card>
        )}

        {activeTab === "goals" && (
          <Card>
            <Text style={s.cardTitle}>目標</Text>
            <Text style={s.fieldLabel}>フィットネス目標</Text>
            <View style={s.chipWrap}>
              {FITNESS_GOALS.map((g) => {
                const selected = (editForm.fitnessGoals || []).includes(g.value);
                return (
                  <Pressable
                    key={g.value}
                    onPress={() => isEditing && toggleArrayItem("fitnessGoals", g.value)}
                    style={[s.chip, selected && s.chipSelected]}
                  >
                    <Text style={{ fontSize: 14 }}>{g.icon}</Text>
                    <Text style={[s.chipText, selected && { color: "#fff" }]}>{g.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Field label="目標体重 (kg)" value={editForm.targetWeight?.toString()} editing={isEditing} onChange={(v) => updateField("targetWeight", v ? parseFloat(v) : null)} keyboardType="decimal-pad" />
          </Card>
        )}

        {activeTab === "sports" && (
          <Card>
            <Text style={s.cardTitle}>競技・運動</Text>
            <Field label="主要スポーツ" value={editForm.primarySport} editing={isEditing} onChange={(v) => updateField("primarySport", v)} />
            <Field label="週の運動回数" value={editForm.exerciseFrequency?.toString()} editing={isEditing} onChange={(v) => updateField("exerciseFrequency", v ? parseInt(v) : null)} keyboardType="number-pad" />
            <Field label="運動強度" value={editForm.exerciseIntensity} editing={isEditing} onChange={(v) => updateField("exerciseIntensity", v)} />
          </Card>
        )}

        {activeTab === "health" && (
          <Card>
            <Text style={s.cardTitle}>健康状態</Text>
            <Text style={s.fieldLabel}>気になる症状</Text>
            <View style={s.chipWrap}>
              {HEALTH_CONDITIONS.map((c) => {
                const selected = (editForm.healthConditions || []).includes(c);
                return (
                  <Pressable
                    key={c}
                    onPress={() => isEditing && toggleArrayItem("healthConditions", c)}
                    style={[s.chip, selected && s.chipSelected]}
                  >
                    <Text style={[s.chipText, selected && { color: "#fff" }]}>{c}</Text>
                  </Pressable>
                );
              })}
            </View>
          </Card>
        )}

        {activeTab === "diet" && (
          <Card>
            <Text style={s.cardTitle}>食事</Text>
            <Field label="アレルギー" value={(editForm.dietFlags?.allergies || []).join("、")} editing={false} />
            <Field label="苦手な食材" value={(editForm.dietFlags?.dislikes || []).join("、")} editing={false} />
          </Card>
        )}

        {activeTab === "cooking" && (
          <Card>
            <Text style={s.cardTitle}>調理</Text>
            <Text style={s.fieldLabel}>料理経験</Text>
            <View style={s.chipWrap}>
              {COOKING_EXP.map((c) => {
                const selected = editForm.cookingExperience === c.value;
                return (
                  <Pressable
                    key={c.value}
                    onPress={() => isEditing && updateField("cookingExperience", c.value)}
                    style={[s.chip, selected && s.chipSelected]}
                  >
                    <Text style={[s.chipText, selected && { color: "#fff" }]}>{c.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Field label="平日の調理時間 (分)" value={editForm.weekdayCookingMinutes?.toString()} editing={isEditing} onChange={(v) => updateField("weekdayCookingMinutes", v ? parseInt(v) : null)} keyboardType="number-pad" />
          </Card>
        )}

        {activeTab === "lifestyle" && (
          <Card>
            <Text style={s.cardTitle}>生活</Text>
            <Text style={s.fieldLabel}>仕事・活動スタイル</Text>
            <View style={s.chipWrap}>
              {WORK_STYLES.map((w) => {
                const selected = editForm.workStyle === w.value;
                return (
                  <Pressable
                    key={w.value}
                    onPress={() => isEditing && updateField("workStyle", w.value)}
                    style={[s.chip, selected && s.chipSelected]}
                  >
                    <Text style={[s.chipText, selected && { color: "#fff" }]}>{w.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Field label="家族人数" value={editForm.familySize?.toString()} editing={isEditing} onChange={(v) => updateField("familySize", v ? parseInt(v) : null)} keyboardType="number-pad" />
          </Card>
        )}

        {/* ── リンクメニュー ── */}
        <View style={{ gap: spacing.sm }}>
          <ListItem
            title="栄養目標"
            subtitle="目標値の確認・再計算"
            onPress={() => router.push("/profile/nutrition-targets")}
            left={<View style={[s.menuIcon, { backgroundColor: colors.successLight }]}><Ionicons name="nutrition-outline" size={18} color={colors.success} /></View>}
            right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          />
          <ListItem
            title="プロフィールを見直す"
            subtitle="オンボーディングをやり直す"
            onPress={() => router.push("/onboarding")}
            left={<View style={[s.menuIcon, { backgroundColor: colors.blueLight }]}><Ionicons name="refresh-outline" size={18} color={colors.blue} /></View>}
            right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          />
          <ListItem
            title="バッジ"
            subtitle="獲得した実績"
            onPress={() => router.push("/badges")}
            left={<View style={[s.menuIcon, { backgroundColor: colors.warningLight }]}><Ionicons name="trophy-outline" size={18} color={colors.warning} /></View>}
            right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          />
          <ListItem
            title="比較"
            subtitle="他のユーザーと比較"
            onPress={() => router.push("/comparison")}
            left={<View style={[s.menuIcon, { backgroundColor: colors.purpleLight }]}><Ionicons name="bar-chart-outline" size={18} color={colors.purple} /></View>}
            right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          />
          <ListItem
            title="家族管理"
            subtitle="家族アカウント"
            onPress={() => router.push("/family")}
            left={<View style={[s.menuIcon, { backgroundColor: colors.accentLight }]}><Ionicons name="people-outline" size={18} color={colors.accent} /></View>}
            right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          />
        </View>

        {/* ── 設定セクション ── */}
        <View style={{ gap: spacing.sm }}>
          <Text style={{ fontSize: 11, fontWeight: "800", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>設定</Text>
          <Card>
            <View style={{ gap: 0 }}>
              {/* 通知 */}
              <View style={s.settingRow}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <View style={[s.menuIcon, { backgroundColor: colors.blueLight }]}>
                    <Ionicons name="notifications-outline" size={18} color={colors.blue} />
                  </View>
                  <Text style={s.settingLabel}>通知</Text>
                </View>
                <Switch value={notifications} onValueChange={setNotifications} trackColor={{ true: colors.accent }} />
              </View>

              {/* 自動解析 */}
              <View style={s.settingRow}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <View style={[s.menuIcon, { backgroundColor: colors.purpleLight }]}>
                    <Ionicons name="sparkles-outline" size={18} color={colors.purple} />
                  </View>
                  <Text style={s.settingLabel}>自動解析</Text>
                </View>
                <Switch value={autoAnalyze} onValueChange={setAutoAnalyze} trackColor={{ true: colors.accent }} />
              </View>

              {/* 週の開始日 */}
              <View style={s.settingRow}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <View style={[s.menuIcon, { backgroundColor: colors.successLight }]}>
                    <Ionicons name="calendar-outline" size={18} color={colors.success} />
                  </View>
                  <View>
                    <Text style={s.settingLabel}>週の開始日</Text>
                    <Text style={{ fontSize: 11, color: colors.textMuted }}>カレンダーの開始曜日</Text>
                  </View>
                </View>
                <View style={{ flexDirection: "row", gap: 4 }}>
                  <Pressable
                    onPress={() => handleWeekStartDayChange("sunday")}
                    style={[s.dayPill, weekStartDay === "sunday" && s.dayPillActive]}
                  >
                    <Text style={[s.dayPillText, weekStartDay === "sunday" && s.dayPillTextActive]}>日曜</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => handleWeekStartDayChange("monday")}
                    style={[s.dayPill, weekStartDay === "monday" && s.dayPillActive]}
                  >
                    <Text style={[s.dayPillText, weekStartDay === "monday" && s.dayPillTextActive]}>月曜</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          </Card>
        </View>

        {/* ── サポート ── */}
        <View style={{ gap: spacing.sm }}>
          <Text style={{ fontSize: 11, fontWeight: "800", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>サポート</Text>
          <ListItem
            title="利用規約"
            onPress={() => Linking.openURL("https://homegohan.app/terms")}
            left={<View style={[s.menuIcon, { backgroundColor: colors.bg }]}><Ionicons name="document-text-outline" size={18} color={colors.textLight} /></View>}
            right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          />
          <ListItem
            title="プライバシーポリシー"
            onPress={() => Linking.openURL("https://homegohan.app/privacy")}
            left={<View style={[s.menuIcon, { backgroundColor: colors.bg }]}><Ionicons name="lock-closed-outline" size={18} color={colors.textLight} /></View>}
            right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          />
          <ListItem
            title="お問い合わせ"
            onPress={() => Linking.openURL("mailto:support@homegohan.jp")}
            left={<View style={[s.menuIcon, { backgroundColor: colors.bg }]}><Ionicons name="mail-outline" size={18} color={colors.textLight} /></View>}
            right={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
          />
        </View>

        {/* ── ログアウト ── */}
        <Pressable
          onPress={() => {
            Alert.alert(
              "ログアウトしますか？",
              "ログアウトしてもデータは保持されます。\nまたすぐにお会いしましょう。",
              [
                { text: "キャンセル", style: "cancel" },
                { text: "ログアウト", style: "destructive", onPress: handleLogout },
              ]
            );
          }}
          style={s.logoutButton}
        >
          <Ionicons name="log-out-outline" size={18} color={colors.error} />
          <Text style={{ fontSize: 15, fontWeight: "700", color: colors.error }}>ログアウト</Text>
        </Pressable>

        <Text style={{ textAlign: "center", fontSize: 11, color: colors.textMuted, marginTop: spacing.sm }}>
          Version 1.0.0{"\n"}© 2025 ほめゴハン
        </Text>
      </ScrollView>
    </View>
  );
}

function Field({ label, value, editing, onChange, keyboardType }: {
  label: string;
  value?: string | null;
  editing: boolean;
  onChange?: (v: string) => void;
  keyboardType?: "default" | "number-pad" | "decimal-pad";
}) {
  return (
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      {editing && onChange ? (
        <TextInput
          style={s.fieldInput}
          value={value ?? ""}
          onChangeText={onChange}
          keyboardType={keyboardType ?? "default"}
          placeholderTextColor={colors.textMuted}
        />
      ) : (
        <Text style={s.fieldValue}>{value || "未設定"}</Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  avatar: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: colors.accentLight,
    alignItems: "center", justifyContent: "center",
  },
  badgePill: {
    backgroundColor: colors.accentLight,
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: radius.full,
  },
  tab: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: radius.full,
    backgroundColor: "#fff",
    borderWidth: 1, borderColor: "#E5E7EB",
  },
  tabActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  tabLabel: {
    fontSize: 13, fontWeight: "700", color: "#4B5563",
  },
  tabLabelActive: {
    color: "#fff",
  },
  cardTitle: {
    fontSize: 16, fontWeight: "800", color: "#1F2937", marginBottom: spacing.md,
  },
  field: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  fieldLabel: {
    fontSize: 12, fontWeight: "700", color: "#6B7280", marginBottom: 4,
  },
  fieldValue: {
    fontSize: 15, fontWeight: "600", color: "#1F2937",
  },
  fieldInput: {
    fontSize: 15, fontWeight: "600", color: "#1F2937",
    backgroundColor: "#F9FAFB",
    paddingHorizontal: spacing.md, paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: "#E5E7EB",
  },
  chipWrap: {
    flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginBottom: spacing.sm,
  },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: radius.full,
    borderWidth: 1, borderColor: "#E5E7EB",
    backgroundColor: "#fff",
  },
  chipSelected: {
    backgroundColor: colors.accent, borderColor: colors.accent,
  },
  chipText: {
    fontSize: 13, fontWeight: "600", color: "#4B5563",
  },
  menuIcon: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: "center", justifyContent: "center",
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  settingLabel: {
    fontSize: 14, fontWeight: "700", color: colors.text,
  },
  dayPill: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
  },
  dayPillActive: {
    backgroundColor: colors.accent,
  },
  dayPillText: {
    fontSize: 12, fontWeight: "700", color: colors.textMuted,
  },
  dayPillTextActive: {
    color: "#fff",
  },
  logoutButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: 16,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: "#FEE2E2",
    backgroundColor: "#FFF5F5",
  },
});
