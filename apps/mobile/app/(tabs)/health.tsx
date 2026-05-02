import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button, Card, LoadingState, ProgressBar } from "../../src/components/ui";
import { colors, spacing, radius, shadows } from "../../src/theme";
import { getApi } from "../../src/lib/api";

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─── Types ───────────────────────────────────────────
interface HealthRecord {
  id: string;
  record_date: string;
  weight?: number;
  body_fat_percentage?: number;
  systolic_bp?: number;
  diastolic_bp?: number;
  heart_rate?: number;
  sleep_hours?: number;
  sleep_quality?: number;
  mood_score?: number;
  overall_condition?: number;
  water_intake?: number;
  step_count?: number;
}

interface HealthStreak {
  current_streak: number;
  longest_streak: number;
  achieved_badges: string[];
  total_records: number;
}

interface HealthGoal {
  id: string;
  goal_type: string;
  target_value: number;
  target_unit: string;
  current_value?: number;
  progress_percentage?: number;
  target_date?: string;
  status: string;
}

// ─── Helpers ─────────────────────────────────────────
const MOOD_ICONS: Record<string, { icon: keyof typeof Ionicons.glyphMap; color: string }> = {
  high: { icon: "happy-outline", color: colors.success },
  mid: { icon: "remove-circle-outline", color: "#FF9800" },
  low: { icon: "sad-outline", color: colors.error },
};

function moodStyle(score: number | undefined) {
  if (!score) return MOOD_ICONS.mid;
  if (score >= 4) return MOOD_ICONS.high;
  if (score <= 2) return MOOD_ICONS.low;
  return MOOD_ICONS.mid;
}

function getWeekDays() {
  const days: { date: string; day: string; dayNum: number; isToday: boolean }[] = [];
  const DAYS = ["日", "月", "火", "水", "木", "金", "土"];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push({
      date: formatLocalDate(d),
      day: DAYS[d.getDay()],
      dayNum: d.getDate(),
      isToday: i === 0,
    });
  }
  return days;
}

const GOAL_LABELS: Record<string, string> = {
  weight: "目標体重",
  body_fat: "目標体脂肪率",
  sleep_hours: "睡眠時間",
  step_count: "歩数",
};

// ─── Quick Actions ───────────────────────────────────
const QUICK_ACTIONS = [
  { href: "/health/record" as const, icon: "calendar-outline" as const, label: "詳細記録", sub: "すべての項目を記録", bg: colors.accentLight, fg: colors.accent },
  { href: "/health/record/quick" as const, icon: "camera-outline" as const, label: "写真で記録", sub: "体重計を撮影", bg: "#E3F2FD", fg: "#2196F3" },
  { href: "/health/graphs" as const, icon: "trending-up-outline" as const, label: "グラフ", sub: "推移を確認", bg: "#EDE7F6", fg: "#7C4DFF" },
  { href: "/health/goals" as const, icon: "flag-outline" as const, label: "目標設定", sub: "目標を管理", bg: "#E8F5E9", fg: colors.success },
] as const;

// ─── Component ───────────────────────────────────────
export default function HealthDashboardTab() {
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [todayRecord, setTodayRecord] = useState<HealthRecord | null>(null);
  const [yesterdayRecord, setYesterdayRecord] = useState<HealthRecord | null>(null);
  const [streak, setStreak] = useState<HealthStreak | null>(null);
  const [weeklyRecords, setWeeklyRecords] = useState<string[]>([]);
  const [goals, setGoals] = useState<HealthGoal[]>([]);

  // Calendar day selection
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedDateRecord, setSelectedDateRecord] = useState<HealthRecord | null>(null);
  const [loadingSelectedDate, setLoadingSelectedDate] = useState(false);

  // Quick record modal
  const [showQuickRecord, setShowQuickRecord] = useState(false);
  const [quickWeight, setQuickWeight] = useState("");
  const [quickMood, setQuickMood] = useState<number | null>(null);
  const [quickSleep, setQuickSleep] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const today = useMemo(() => formatLocalDate(new Date()), []);
  const weekDays = useMemo(() => getWeekDays(), []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const api = getApi();
      const [recordRes, streakRes, goalsRes] = await Promise.allSettled([
        api.get<{ record: HealthRecord | null; previous: HealthRecord | null }>(`/api/health/records/${today}`),
        api.get<{ streak: HealthStreak; weeklyRecords: string[] }>("/api/health/streaks"),
        api.get<{ goals: HealthGoal[] }>("/api/health/goals?status=active"),
      ]);

      if (recordRes.status === "fulfilled") {
        setTodayRecord(recordRes.value.record);
        setYesterdayRecord(recordRes.value.previous);
        if (recordRes.value.record?.weight) {
          setQuickWeight(recordRes.value.record.weight.toString());
        }
      }
      if (streakRes.status === "fulfilled") {
        setStreak(streakRes.value.streak);
        setWeeklyRecords(streakRes.value.weeklyRecords ?? []);
      }
      if (goalsRes.status === "fulfilled") {
        setGoals(goalsRes.value.goals ?? []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [today]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const weightChange = useMemo(() => {
    if (!todayRecord?.weight || !yesterdayRecord?.weight) return null;
    return parseFloat((todayRecord.weight - yesterdayRecord.weight).toFixed(2));
  }, [todayRecord, yesterdayRecord]);

  const handleDaySelect = useCallback(async (date: string) => {
    // 今日のセル、または既に選択中の日をタップ → パネルを閉じる
    if (date === today || date === selectedDate) {
      setSelectedDate(null);
      setSelectedDateRecord(null);
      return;
    }
    setSelectedDate(date);
    setLoadingSelectedDate(true);
    try {
      const api = getApi();
      const data = await api.get<{ record: HealthRecord | null }>(`/api/health/records/${date}`);
      setSelectedDateRecord(data.record ?? null);
    } catch {
      setSelectedDateRecord(null);
    } finally {
      setLoadingSelectedDate(false);
    }
  }, [today, selectedDate]);

  async function handleQuickSave() {
    if (!quickWeight && quickMood === null && quickSleep === null) return;
    setSaving(true);
    try {
      const api = getApi();
      const res = await api.post<{ record: HealthRecord; message: string }>("/api/health/records/quick", {
        weight: quickWeight ? parseFloat(quickWeight) : undefined,
        mood_score: quickMood ?? undefined,
        sleep_quality: quickSleep ?? undefined,
        record_date: today,
      });
      setTodayRecord(res.record);
      setMessage(res.message);
      setShowQuickRecord(false);
      void fetchData();
      setTimeout(() => setMessage(null), 5000);
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "記録の保存に失敗しました。");
    } finally {
      setSaving(false);
    }
  }

  // ─── Render ──────────────────────────────────────
  if (loading) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <LoadingState message="健康データを読み込み中..." />
      </View>
    );
  }

  return (
    <View testID="health-screen" style={[styles.screen, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

        {/* ─── Header ─── */}
        <View style={styles.header}>
          <View>
            <Text style={styles.headerTitle}>健康記録</Text>
            <Text style={styles.headerSub}>毎日の記録があなたの健康を支えます</Text>
          </View>
          <Link href="/comparison" asChild>
            <Pressable hitSlop={12}>
              <Ionicons name="bar-chart-outline" size={24} color={colors.accent} />
            </Pressable>
          </Link>
        </View>

        {/* ─── Success Message ─── */}
        {message && (
          <View testID="health-message-toast" style={styles.successBanner}>
            <Ionicons name="checkmark-circle" size={22} color={colors.success} />
            <Text style={styles.successText}>{message}</Text>
          </View>
        )}

        {/* ─── Streak Card ─── */}
        <View style={styles.streakCard}>
          <View style={styles.streakTop}>
            <View>
              <View style={styles.streakLabelRow}>
                <Ionicons name="flame" size={20} color="#fff" />
                <Text style={styles.streakLabel}>連続記録</Text>
              </View>
              <View style={styles.streakValueRow}>
                <Text testID="health-streak-value" style={styles.streakValue}>{streak?.current_streak ?? 0}</Text>
                <Text style={styles.streakUnit}>日</Text>
              </View>
              <Text style={styles.streakLongest}>最長: {streak?.longest_streak ?? 0}日</Text>
            </View>
            <Ionicons name="trophy" size={48} color="rgba(255,255,255,0.25)" />
          </View>

          {/* Weekly calendar */}
          <View testID="health-day-calendar" style={styles.weekRow}>
            {weekDays.map((d) => {
              const has = weeklyRecords.includes(d.date);
              const isSelected = selectedDate === d.date;
              return (
                <Pressable
                  key={d.date}
                  testID={`health-day-tab-${d.date}`}
                  onPress={() => void handleDaySelect(d.date)}
                  style={[
                    styles.weekDay,
                    { backgroundColor: has ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.1)" },
                    d.isToday && styles.weekDayToday,
                    isSelected && styles.weekDaySelected,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`${d.day}${d.dayNum}日${has ? "（記録あり）" : ""}`}
                  accessibilityState={{ selected: isSelected }}
                >
                  <Text style={styles.weekDayLabel}>{d.day}</Text>
                  <Text style={styles.weekDayNum}>{d.dayNum}</Text>
                  {has && <Ionicons name="checkmark-circle" size={12} color="#fff" style={{ marginTop: 2 }} />}
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* ─── Selected Date Preview ─── */}
        {selectedDate && (
          <View style={styles.previewCard}>
            <View style={styles.previewHeader}>
              <Text style={styles.previewTitle}>{selectedDate} の記録</Text>
              <Link href={`/health/record/${selectedDate}` as any} asChild>
                <Pressable style={styles.seeAllRow}>
                  <Text style={styles.seeAllText}>{selectedDateRecord ? "詳細を編集" : "記録を追加"}</Text>
                  <Ionicons name="chevron-forward" size={16} color={colors.accent} />
                </Pressable>
              </Link>
            </View>
            {loadingSelectedDate ? (
              <View style={styles.previewLoading}>
                <Ionicons name="ellipsis-horizontal" size={24} color={colors.textMuted} />
              </View>
            ) : selectedDateRecord ? (
              <View style={styles.todayGrid}>
                {/* Weight */}
                <View style={styles.todayCell}>
                  <Ionicons name="scale-outline" size={20} color={colors.accent} />
                  <Text style={styles.todayCellValue}>{selectedDateRecord.weight ?? "-"}</Text>
                  <Text style={styles.todayCellUnit}>kg</Text>
                </View>
                {/* Mood */}
                <View style={styles.todayCell}>
                  <Ionicons name={moodStyle(selectedDateRecord.mood_score).icon} size={20} color={moodStyle(selectedDateRecord.mood_score).color} />
                  <Text style={styles.todayCellValue}>{selectedDateRecord.mood_score ?? "-"}</Text>
                  <Text style={styles.todayCellUnit}>{selectedDateRecord.mood_score ? "/ 5" : "気分"}</Text>
                </View>
                {/* Sleep */}
                <View style={styles.todayCell}>
                  <Ionicons name="moon-outline" size={20} color="#7C4DFF" />
                  <Text style={styles.todayCellValue}>
                    {selectedDateRecord.sleep_hours ?? selectedDateRecord.sleep_quality ?? "-"}
                  </Text>
                  <Text style={styles.todayCellUnit}>
                    {selectedDateRecord.sleep_hours ? "時間" : selectedDateRecord.sleep_quality ? "/ 5" : "睡眠"}
                  </Text>
                </View>
              </View>
            ) : (
              <View style={styles.previewEmpty}>
                <Text style={styles.previewEmptyText}>この日の記録はありません</Text>
              </View>
            )}
          </View>
        )}

        {/* ─── Today's Record or Quick Record Button ─── */}
        {!todayRecord ? (
          <Pressable testID="health-quick-record-button" style={styles.quickRecordBtn} onPress={() => setShowQuickRecord(true)}>
            <View style={[styles.iconBox, { backgroundColor: colors.accentLight }]}>
              <Ionicons name="add" size={24} color={colors.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.quickRecordTitle}>今日の記録をつける</Text>
              <Text style={styles.quickRecordSub}>体重・気分・睡眠を30秒で記録</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </Pressable>
        ) : (
          <Card>
            <View style={styles.todayHeader}>
              <Text style={styles.todaySectionTitle}>今日の記録</Text>
              <Link href="/health/record" asChild>
                <Pressable testID="health-record-detail-button" style={styles.todayEditRow}>
                  <Text style={styles.todayEditText}>詳細を編集</Text>
                  <Ionicons name="chevron-forward" size={16} color={colors.accent} />
                </Pressable>
              </Link>
            </View>
            <View style={styles.todayGrid}>
              {/* Weight */}
              <View style={styles.todayCell}>
                <Ionicons name="scale-outline" size={20} color={colors.accent} />
                <Text testID="health-today-weight" style={styles.todayCellValue}>{todayRecord.weight ?? "-"}</Text>
                <Text style={styles.todayCellUnit}>kg</Text>
                {weightChange !== null && (
                  <View style={styles.trendRow}>
                    <Ionicons
                      name={weightChange < 0 ? "trending-down" : weightChange > 0 ? "trending-up" : "remove"}
                      size={12}
                      color={weightChange < 0 ? colors.success : weightChange > 0 ? colors.error : colors.textMuted}
                    />
                    <Text style={{ fontSize: 11, color: weightChange < 0 ? colors.success : weightChange > 0 ? colors.error : colors.textMuted }}>
                      {weightChange > 0 ? "+" : ""}{weightChange}
                    </Text>
                  </View>
                )}
              </View>
              {/* Mood */}
              <View style={styles.todayCell}>
                <Ionicons name={moodStyle(todayRecord.mood_score).icon} size={20} color={moodStyle(todayRecord.mood_score).color} />
                <Text style={styles.todayCellValue}>{todayRecord.mood_score ?? "-"}</Text>
                <Text style={styles.todayCellUnit}>{todayRecord.mood_score ? "/ 5" : "気分"}</Text>
              </View>
              {/* Sleep */}
              <View style={styles.todayCell}>
                <Ionicons name="moon-outline" size={20} color="#7C4DFF" />
                <Text style={styles.todayCellValue}>
                  {todayRecord.sleep_hours ?? todayRecord.sleep_quality ?? "-"}
                </Text>
                <Text style={styles.todayCellUnit}>
                  {todayRecord.sleep_hours ? "時間" : todayRecord.sleep_quality ? "/ 5" : "睡眠"}
                </Text>
              </View>
            </View>
          </Card>
        )}

        {/* ─── Goals ─── */}
        {goals.length > 0 && (
          <View>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>目標進捗</Text>
              <Link href="/health/goals" asChild>
                <Pressable style={styles.seeAllRow}>
                  <Text style={styles.seeAllText}>すべて見る</Text>
                  <Ionicons name="chevron-forward" size={16} color={colors.accent} />
                </Pressable>
              </Link>
            </View>
            <View style={{ gap: spacing.sm }}>
              {goals.slice(0, 2).map((g) => (
                <Card key={g.id}>
                  <View style={styles.goalHeader}>
                    <View style={styles.goalLabelRow}>
                      <Ionicons name="flag" size={18} color={colors.accent} />
                      <Text style={styles.goalLabel}>{GOAL_LABELS[g.goal_type] ?? g.goal_type}</Text>
                    </View>
                    <Text style={styles.goalTarget}>{g.target_value}{g.target_unit}</Text>
                  </View>
                  <ProgressBar value={g.progress_percentage ?? 0} max={100} showPercentage />
                  <Text style={styles.goalCurrent}>現在: {g.current_value ?? "-"}{g.target_unit}</Text>
                </Card>
              ))}
            </View>
          </View>
        )}

        {/* ─── Quick Actions ─── */}
        <View>
          <Text style={styles.sectionTitle}>クイックアクション</Text>
          <View style={styles.actionsGrid}>
            {QUICK_ACTIONS.map((a) => {
              const testID =
                a.href === "/health/record"
                  ? "health-record-detail-button"
                  : a.href === "/health/graphs"
                  ? "health-graphs-button"
                  : a.href === "/health/goals"
                  ? "health-goals-button"
                  : undefined;
              return (
                <Link key={a.href} href={a.href} asChild>
                  <Pressable testID={testID} style={styles.actionCard}>
                    <View style={[styles.actionIcon, { backgroundColor: a.bg }]}>
                      <Ionicons name={a.icon} size={20} color={a.fg} />
                    </View>
                    <Text style={styles.actionLabel}>{a.label}</Text>
                    <Text style={styles.actionSub}>{a.sub}</Text>
                  </Pressable>
                </Link>
              );
            })}
          </View>
        </View>

        {/* ─── Health Checkups ─── */}
        <View>
          <View style={styles.sectionRow}>
            <Text style={styles.sectionTitle}>健康診断</Text>
            <Link href="/health/checkups" asChild>
              <Pressable style={styles.seeAllRow}>
                <Text style={styles.seeAllText}>すべて見る</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.accent} />
              </Pressable>
            </Link>
          </View>
          <Link href="/health/checkups" asChild>
            <Pressable testID="health-checkups-button" style={styles.checkupCard}>
              <View style={[styles.iconBox, { backgroundColor: "#FFEBEE" }]}>
                <Ionicons name="pulse" size={24} color={colors.error} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.checkupTitle}>健康診断結果を記録</Text>
                <Text style={styles.checkupSub}>検査値をAIが分析・献立に反映</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </Pressable>
          </Link>
        </View>

        {/* ─── More Links ─── */}
        <View style={{ gap: spacing.sm }}>
          <Link href="/health/streaks" asChild>
            <Pressable testID="health-streaks-button" style={styles.moreLink}>
              <Ionicons name="flame-outline" size={20} color={colors.accent} />
              <Text style={styles.moreLinkText}>連続記録・バッジ</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </Pressable>
          </Link>
          <Link href="/health/challenges" asChild>
            <Pressable style={styles.moreLink}>
              <Ionicons name="trophy-outline" size={20} color={colors.accent} />
              <Text style={styles.moreLinkText}>チャレンジ</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </Pressable>
          </Link>
          <Link href="/health/insights" asChild>
            <Pressable testID="health-insights-button" style={styles.moreLink}>
              <Ionicons name="sparkles-outline" size={20} color={colors.accent} />
              <Text style={styles.moreLinkText}>AIインサイト</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </Pressable>
          </Link>
          <Link href="/health/settings" asChild>
            <Pressable style={styles.moreLink}>
              <Ionicons name="settings-outline" size={20} color={colors.accent} />
              <Text style={styles.moreLinkText}>健康設定</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </Pressable>
          </Link>
        </View>
      </ScrollView>

      {/* ─── Quick Record Modal ─── */}
      <Modal visible={showQuickRecord} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <Pressable style={styles.modalBackdrop} onPress={() => setShowQuickRecord(false)} />
          <View testID="health-quick-modal" style={[styles.modalSheet, { paddingBottom: insets.bottom + spacing.lg }]}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>今日の記録</Text>

            {/* Weight */}
            <View style={styles.modalField}>
              <Text style={styles.modalLabel}>体重 (kg)</Text>
              <TextInput
                testID="health-quick-weight-input"
                style={styles.modalInput}
                value={quickWeight}
                onChangeText={setQuickWeight}
                placeholder={yesterdayRecord?.weight?.toString() ?? "65.0"}
                placeholderTextColor={colors.textMuted}
                keyboardType="decimal-pad"
              />
              {yesterdayRecord?.weight && (
                <Text style={styles.modalHint}>昨日: {yesterdayRecord.weight}kg</Text>
              )}
            </View>

            {/* Mood */}
            <View style={styles.modalField}>
              <Text style={styles.modalLabel}>今の気分</Text>
              <View style={styles.moodRow}>
                {[
                  { score: 1, icon: "sad-outline" as const, label: "悪い" },
                  { score: 2, icon: "sad-outline" as const, label: "やや悪い" },
                  { score: 3, icon: "remove-circle-outline" as const, label: "普通" },
                  { score: 4, icon: "happy-outline" as const, label: "良い" },
                  { score: 5, icon: "happy-outline" as const, label: "最高" },
                ].map((m) => (
                  <Pressable
                    key={m.score}
                    testID={`health-quick-mood-${m.score}`}
                    style={[styles.moodBtn, quickMood === m.score && styles.moodBtnActive]}
                    onPress={() => setQuickMood(quickMood === m.score ? null : m.score)}
                  >
                    <Ionicons
                      name={m.icon}
                      size={24}
                      color={quickMood === m.score ? colors.accent : colors.textMuted}
                    />
                    <Text style={[styles.moodBtnLabel, quickMood === m.score && { color: colors.accent }]}>
                      {m.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Sleep */}
            <View style={styles.modalField}>
              <Text style={styles.modalLabel}>睡眠の質</Text>
              <View style={styles.sleepRow}>
                {[1, 2, 3, 4, 5].map((s) => (
                  <Pressable
                    key={s}
                    testID={`health-quick-sleep-${s}`}
                    style={[styles.sleepBtn, quickSleep === s && styles.sleepBtnActive]}
                    onPress={() => setQuickSleep(quickSleep === s ? null : s)}
                  >
                    <Ionicons
                      name="moon"
                      size={18}
                      color={quickSleep !== null && s <= quickSleep ? "#7C4DFF" : colors.textMuted}
                    />
                    <Text style={[styles.sleepBtnLabel, quickSleep === s && { color: "#7C4DFF" }]}>{s}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <Button testID="health-quick-save-button" onPress={handleQuickSave} loading={saving} disabled={saving}>
              {saving ? "保存中..." : "記録する"}
            </Button>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scrollContent: {
    padding: spacing.lg,
    gap: spacing.lg,
    paddingBottom: 120,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "800",
    color: colors.text,
  },
  headerSub: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2,
  },

  // ─── Success ───
  successBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: "#E8F5E9",
    padding: spacing.md,
    borderRadius: radius.lg,
  },
  successText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.success,
    flex: 1,
  },

  // ─── Streak ───
  streakCard: {
    padding: spacing.lg,
    borderRadius: radius.xl,
    backgroundColor: colors.accent,
  },
  streakTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  streakLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginBottom: 4,
  },
  streakLabel: {
    fontSize: 13,
    color: "rgba(255,255,255,0.8)",
  },
  streakValueRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 4,
  },
  streakValue: {
    fontSize: 40,
    fontWeight: "900",
    color: "#fff",
  },
  streakUnit: {
    fontSize: 14,
    color: "rgba(255,255,255,0.8)",
  },
  streakLongest: {
    fontSize: 12,
    color: "rgba(255,255,255,0.6)",
    marginTop: 2,
  },
  weekRow: {
    flexDirection: "row",
    gap: spacing.xs,
    marginTop: spacing.md,
  },
  weekDay: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  weekDayToday: {
    borderWidth: 2,
    borderColor: "#fff",
  },
  weekDaySelected: {
    borderWidth: 2,
    borderColor: "#fff",
    backgroundColor: "rgba(255,255,255,0.45)" as const,
  },
  weekDayLabel: {
    fontSize: 10,
    color: "rgba(255,255,255,0.6)",
  },
  weekDayNum: {
    fontSize: 13,
    fontWeight: "800",
    color: "#fff",
  },

  // ─── Selected Date Preview ───
  previewCard: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    padding: spacing.lg,
    ...shadows.sm,
  },
  previewHeader: {
    flexDirection: "row" as const,
    justifyContent: "space-between" as const,
    alignItems: "center" as const,
    marginBottom: spacing.md,
  },
  previewTitle: {
    fontSize: 15,
    fontWeight: "700" as const,
    color: colors.text,
  },
  previewLoading: {
    alignItems: "center" as const,
    paddingVertical: spacing.lg,
  },
  previewEmpty: {
    alignItems: "center" as const,
    paddingVertical: spacing.lg,
  },
  previewEmptyText: {
    fontSize: 14,
    color: colors.textMuted,
  },

  // ─── Quick Record Button ───
  quickRecordBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.card,
    padding: spacing.lg,
    borderRadius: radius.xl,
    ...shadows.sm,
  },
  iconBox: {
    width: 48,
    height: 48,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  quickRecordTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.text,
  },
  quickRecordSub: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2,
  },

  // ─── Today's Record ───
  todayHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.md,
  },
  todaySectionTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.text,
  },
  todayEditRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  todayEditText: {
    fontSize: 13,
    color: colors.accent,
    fontWeight: "600",
  },
  todayGrid: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  todayCell: {
    flex: 1,
    alignItems: "center",
    backgroundColor: colors.bg,
    padding: spacing.md,
    borderRadius: radius.lg,
  },
  todayCellValue: {
    fontSize: 20,
    fontWeight: "900",
    color: colors.text,
    marginTop: 4,
  },
  todayCellUnit: {
    fontSize: 11,
    color: colors.textMuted,
  },
  trendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    marginTop: 4,
  },

  // ─── Goals ───
  sectionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
  },
  seeAllRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  seeAllText: {
    fontSize: 13,
    color: colors.accent,
    fontWeight: "600",
  },
  goalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  goalLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  goalLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  goalTarget: {
    fontSize: 14,
    fontWeight: "800",
    color: colors.accent,
  },
  goalCurrent: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },

  // ─── Quick Actions ───
  actionsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  actionCard: {
    width: "48%",
    backgroundColor: colors.card,
    padding: spacing.lg,
    borderRadius: radius.xl,
    ...shadows.sm,
  },
  actionIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  actionLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.text,
  },
  actionSub: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
  },

  // ─── Checkup ───
  checkupCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.card,
    padding: spacing.lg,
    borderRadius: radius.xl,
    ...shadows.sm,
  },
  checkupTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.text,
  },
  checkupSub: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2,
  },

  // ─── More Links ───
  moreLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.card,
    padding: spacing.lg,
    borderRadius: radius.xl,
    ...shadows.sm,
  },
  moreLinkText: {
    flex: 1,
    fontSize: 15,
    fontWeight: "600",
    color: colors.text,
  },

  // ─── Modal ───
  modalOverlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  modalSheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius["2xl"],
    borderTopRightRadius: radius["2xl"],
    padding: spacing.xl,
    gap: spacing.lg,
  },
  modalHandle: {
    width: 48,
    height: 4,
    backgroundColor: colors.border,
    borderRadius: 2,
    alignSelf: "center",
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: colors.text,
  },
  modalField: {
    gap: spacing.sm,
  },
  modalLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textLight,
  },
  modalInput: {
    backgroundColor: colors.bg,
    borderRadius: radius.lg,
    padding: spacing.lg,
    fontSize: 24,
    fontWeight: "800",
    color: colors.text,
    textAlign: "center",
  },
  modalHint: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: "center",
  },
  moodRow: {
    flexDirection: "row",
    gap: spacing.xs,
  },
  moodBtn: {
    flex: 1,
    alignItems: "center",
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    gap: 4,
  },
  moodBtnActive: {
    backgroundColor: colors.accentLight,
    borderWidth: 2,
    borderColor: colors.accent,
  },
  moodBtnLabel: {
    fontSize: 10,
    color: colors.textMuted,
    fontWeight: "600",
  },
  sleepRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  sleepBtn: {
    flex: 1,
    alignItems: "center",
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    gap: 4,
  },
  sleepBtnActive: {
    backgroundColor: "#EDE7F6",
    borderWidth: 2,
    borderColor: "#7C4DFF",
  },
  sleepBtnLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textMuted,
  },
});
