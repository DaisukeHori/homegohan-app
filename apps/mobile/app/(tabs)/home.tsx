import { Ionicons } from "@expo/vector-icons";
import { Link, router } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Card, Button, EmptyState, LoadingState, ProgressBar, StatCard, SectionHeader, StatusBadge } from "../../src/components/ui";
import { colors, spacing, shadows, radius } from "../../src/theme";
import { useAuth } from "../../src/providers/AuthProvider";
import { useProfile } from "../../src/providers/ProfileProvider";
import { useHomeData } from "../../src/hooks/useHomeData";

const MEAL_ORDER = ["breakfast", "lunch", "snack", "dinner", "midnight_snack"] as const;
const MEAL_CONFIG: Record<string, { icon: keyof typeof Ionicons.glyphMap; label: string; color: string }> = {
  breakfast: { icon: "sunny", label: "朝食", color: "#FF9800" },
  lunch: { icon: "partly-sunny", label: "昼食", color: "#4CAF50" },
  snack: { icon: "cafe", label: "おやつ", color: "#E91E63" },
  dinner: { icon: "moon", label: "夕食", color: "#7C4DFF" },
  midnight_snack: { icon: "cloudy-night", label: "夜食", color: "#3F51B5" },
};

const MODE_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  cook: { label: "自炊", color: colors.success, bg: colors.successLight },
  quick: { label: "時短", color: colors.blue, bg: colors.blueLight },
  buy: { label: "買う", color: colors.purple, bg: colors.purpleLight },
  out: { label: "外食", color: colors.warning, bg: colors.warningLight },
  skip: { label: "なし", color: colors.textMuted, bg: colors.bg },
};

const DOW = ["日", "月", "火", "水", "木", "金", "土"];

const CONDITION_OPTIONS = [
  { id: "rest", label: "休息日", icon: "🛋️" },
  { id: "normal", label: "通常", icon: "🚶" },
  { id: "active", label: "活動的", icon: "🔥" },
  { id: "stressed", label: "ストレス", icon: "🤯" },
] as const;

const CHECKIN_FIELDS = [
  { key: "sleepQuality" as const, label: "💤 睡眠の質", options: ["悪い", "やや悪い", "普通", "良い", "最高"] },
  { key: "fatigue" as const, label: "😫 疲労度", options: ["元気", "やや疲れ", "普通", "疲れ", "ヘトヘト"] },
  { key: "focus" as const, label: "🎯 集中力", options: ["低い", "やや低い", "普通", "良い", "最高"] },
  { key: "hunger" as const, label: "🍽️ 空腹感", options: ["ない", "少し", "普通", "ある", "すごくある"] },
];

const getGreeting = () => {
  const hour = new Date().getHours();
  if (hour < 5) return "おやすみなさい";
  if (hour < 11) return "おはようございます";
  if (hour < 17) return "こんにちは";
  return "こんばんは";
};

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { profile } = useProfile();

  const {
    loading,
    todayMeals,
    dailySummary,
    cookingStreak,
    weeklyStats,
    monthlyStats,
    healthSummary,
    nutritionAnalysis,
    expiringItems,
    shoppingRemaining,
    badgeCount,
    latestBadge,
    activityLevel,
    suggestion,
    performanceAnalysis,
    toggleMealCompletion,
    updateActivityLevel,
    setSuggestion,
    submitPerformanceCheckin,
    refetch,
  } = useHomeData(user?.id);

  const [showCheckin, setShowCheckin] = useState(false);
  const [checkinSubmitting, setCheckinSubmitting] = useState(false);
  const [checkinForm, setCheckinForm] = useState({
    sleepHours: 7,
    sleepQuality: 3,
    fatigue: 3,
    focus: 3,
    hunger: 3,
  });

  const sortedMeals = useMemo(() => {
    return [...todayMeals].sort((a, b) => {
      const ai = MEAL_ORDER.indexOf(a.meal_type as any);
      const bi = MEAL_ORDER.indexOf(b.meal_type as any);
      return ai - bi;
    });
  }, [todayMeals]);

  const nextMeal = useMemo(() => sortedMeals.find((m) => !m.is_completed) ?? null, [sortedMeals]);

  const completionRate = dailySummary.totalCount > 0
    ? Math.round((dailySummary.completedCount / dailySummary.totalCount) * 100)
    : 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        {/* ========== ヒーローセクション ========== */}
        <View style={{ backgroundColor: "#FFF7ED", paddingTop: insets.top + 8, paddingBottom: 20, paddingHorizontal: spacing.lg }}>
          {/* 日付 & プロフィール */}
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: spacing.lg }}>
            <View>
              <Text style={{ fontSize: 13, fontWeight: "500", color: colors.textMuted, marginBottom: 2 }}>
                {new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}
              </Text>
              <Text style={{ fontSize: 24, fontWeight: "800", color: colors.text }}>
                {getGreeting()}、
                <Text style={{ color: colors.accent }}>{profile?.nickname || user?.email?.split("@")[0] || "ゲスト"}</Text>
                さん
              </Text>
            </View>
            <Pressable onPress={() => router.push("/profile")}>
              <View style={{
                width: 44, height: 44, borderRadius: 22,
                backgroundColor: colors.card, alignItems: "center", justifyContent: "center",
                ...shadows.md, borderWidth: 1, borderColor: colors.border,
              }}>
                <Text style={{ fontSize: 18, fontWeight: "700", color: colors.textLight }}>
                  {user?.email?.[0]?.toUpperCase() || "G"}
                </Text>
              </View>
            </Pressable>
          </View>

          {/* ストリーク & 今月の自炊 */}
          <View style={{ flexDirection: "row", gap: spacing.md }}>
            <StatCard
              icon={<Ionicons name="flame" size={22} color="#fff" />}
              label="連続自炊"
              value={cookingStreak}
              unit="日"
              borderColor="#FED7AA"
              accentColor={colors.streak}
            />
            <StatCard
              icon={<Ionicons name="restaurant" size={22} color="#fff" />}
              label="今月の自炊"
              value={monthlyStats.cookCount}
              unit="食"
              borderColor="#C8E6C9"
              accentColor={colors.success}
            />
          </View>
        </View>

        <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.lg }}>

          {/* ========== 健康記録カード ========== */}
          <Pressable onPress={() => router.push("/health")} style={({ pressed }) => ({
            backgroundColor: colors.card, borderRadius: radius.xl, padding: spacing.lg,
            borderWidth: 1, borderColor: colors.purpleLight, ...shadows.sm,
            ...(pressed ? { opacity: 0.9 } : {}),
          })}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.md }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                <Ionicons name="pulse" size={18} color={colors.purple} />
                <Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>健康記録</Text>
                {healthSummary.hasAlert && (
                  <View style={{ backgroundColor: "#FFEBEE", paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.sm }}>
                    <Text style={{ fontSize: 10, fontWeight: "700", color: colors.error }}>要確認</Text>
                  </View>
                )}
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                <Text style={{ fontSize: 12, color: colors.purple, fontWeight: "600" }}>詳細を見る</Text>
                <Ionicons name="chevron-forward" size={14} color={colors.purple} />
              </View>
            </View>

            <View style={{ flexDirection: "row", gap: spacing.sm }}>
              {/* 体重 */}
              <View style={{ flex: 1, alignItems: "center" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 4 }}>
                  <Ionicons name="scale-outline" size={14} color={colors.accent} />
                  <Text style={{ fontSize: 11, color: colors.textMuted }}>体重</Text>
                </View>
                <Text style={{ fontSize: 18, fontWeight: "800", color: colors.text }}>
                  {healthSummary.latestWeight ?? "-"}
                  <Text style={{ fontSize: 11, fontWeight: "500", color: colors.textMuted }}> kg</Text>
                </Text>
                {healthSummary.weightChange !== null && (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 2, marginTop: 2 }}>
                    <Ionicons
                      name={healthSummary.weightChange < 0 ? "trending-down" : "trending-up"}
                      size={12}
                      color={healthSummary.weightChange < 0 ? colors.success : colors.error}
                    />
                    <Text style={{
                      fontSize: 11,
                      color: healthSummary.weightChange < 0 ? colors.success : colors.error,
                    }}>
                      {healthSummary.weightChange > 0 ? "+" : ""}{healthSummary.weightChange}
                    </Text>
                  </View>
                )}
              </View>

              {/* 連続 */}
              <View style={{ flex: 1, alignItems: "center" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 4 }}>
                  <Ionicons name="flame-outline" size={14} color={colors.streak} />
                  <Text style={{ fontSize: 11, color: colors.textMuted }}>連続</Text>
                </View>
                <Text style={{ fontSize: 18, fontWeight: "800", color: colors.text }}>
                  {healthSummary.healthStreak}
                  <Text style={{ fontSize: 11, fontWeight: "500", color: colors.textMuted }}> 日</Text>
                </Text>
              </View>

              {/* 目標まで */}
              <View style={{ flex: 1, alignItems: "center" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 4 }}>
                  <Ionicons name="flag-outline" size={14} color={colors.success} />
                  <Text style={{ fontSize: 11, color: colors.textMuted }}>目標まで</Text>
                </View>
                {healthSummary.latestWeight && healthSummary.targetWeight ? (
                  <Text style={{ fontSize: 18, fontWeight: "800", color: colors.text }}>
                    {(healthSummary.latestWeight - healthSummary.targetWeight).toFixed(1)}
                    <Text style={{ fontSize: 11, fontWeight: "500", color: colors.textMuted }}> kg</Text>
                  </Text>
                ) : (
                  <Text style={{ fontSize: 18, fontWeight: "800", color: colors.textMuted }}>-</Text>
                )}
              </View>
            </View>

            {!healthSummary.todayRecord && (
              <View style={{ marginTop: spacing.md, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, alignItems: "center" }}>
                <Text style={{ fontSize: 12, color: colors.accent }}>📝 今日の記録がまだありません</Text>
              </View>
            )}
          </Pressable>

          {/* ========== 栄養スコア ========== */}
          {!nutritionAnalysis.loading && nutritionAnalysis.score > 0 && (
            <Card onPress={() => router.push("/profile/nutrition-targets")}>
              <View style={{ gap: spacing.sm }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <Ionicons name="trending-up" size={18} color={colors.success} />
                    <Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>今日の栄養スコア</Text>
                  </View>
                  <View style={{
                    backgroundColor: nutritionAnalysis.score >= 80 ? colors.successLight : nutritionAnalysis.score >= 60 ? colors.warningLight : "#FFEBEE",
                    paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: radius.lg,
                  }}>
                    <Text style={{
                      fontSize: 14, fontWeight: "800",
                      color: nutritionAnalysis.score >= 80 ? colors.success : nutritionAnalysis.score >= 60 ? colors.warning : colors.error,
                    }}>
                      {nutritionAnalysis.score}点
                    </Text>
                  </View>
                </View>

                {/* 栄養素バー */}
                <View style={{ flexDirection: "row", gap: spacing.sm }}>
                  {[
                    { key: "calories", label: "カロリー", color: colors.accent },
                    { key: "protein", label: "タンパク質", color: colors.success },
                    { key: "fat", label: "脂質", color: colors.warning },
                    { key: "carbs", label: "炭水化物", color: colors.blue },
                  ].map((item) => {
                    const data = nutritionAnalysis.comparison[item.key];
                    const pct = data ? Math.min(data.percentage, 100) : 0;
                    return (
                      <View key={item.key} style={{ flex: 1, alignItems: "center" }}>
                        <Text style={{ fontSize: 9, color: colors.textMuted, fontWeight: "600" }}>{item.label}</Text>
                        <View style={{ width: "100%", height: 4, backgroundColor: colors.border, borderRadius: 2, marginVertical: 4, overflow: "hidden" }}>
                          <View style={{ width: `${pct}%`, height: "100%", backgroundColor: item.color, borderRadius: 2 }} />
                        </View>
                        <Text style={{ fontSize: 9, color: colors.textLight }}>{pct}%</Text>
                      </View>
                    );
                  })}
                </View>

                {nutritionAnalysis.issues.length > 0 && (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs, backgroundColor: colors.warningLight, padding: spacing.sm, borderRadius: radius.md }}>
                    <Ionicons name="alert" size={12} color={colors.warning} />
                    <Text style={{ fontSize: 11, color: colors.warning, flex: 1 }} numberOfLines={1}>
                      {nutritionAnalysis.issues[0]}
                    </Text>
                  </View>
                )}
              </View>
            </Card>
          )}

          {/* ========== 今日のコンディション ========== */}
          <View>
            <Text style={{ fontSize: 11, fontWeight: "800", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 1, marginBottom: spacing.sm }}>
              今日のコンディション
            </Text>
            <View style={{
              flexDirection: "row", gap: 4, backgroundColor: colors.card, borderRadius: radius.xl,
              padding: 4, borderWidth: 1, borderColor: colors.border,
            }}>
              {CONDITION_OPTIONS.map((item) => (
                <Pressable
                  key={item.id}
                  onPress={() => updateActivityLevel(item.id)}
                  style={{
                    flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: radius.lg,
                    backgroundColor: activityLevel === item.id ? colors.text : "transparent",
                    gap: 2,
                  }}
                >
                  <Text style={{ fontSize: 16 }}>{item.icon}</Text>
                  <Text style={{
                    fontSize: 9, fontWeight: "800",
                    color: activityLevel === item.id ? "#fff" : colors.textMuted,
                  }}>
                    {item.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* ========== 30秒チェックイン ========== */}
          {!performanceAnalysis.todayCheckin && (
            <Card>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.sm }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <Ionicons name="pulse" size={16} color={colors.purple} />
                  <Text style={{ fontSize: 14, fontWeight: "800", color: colors.text }}>30秒チェックイン</Text>
                </View>
                <Pressable
                  onPress={() => setShowCheckin(!showCheckin)}
                  style={{
                    paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.xl,
                    backgroundColor: showCheckin ? colors.purple : colors.purpleLight,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "800", color: showCheckin ? "#fff" : colors.purple }}>
                    {showCheckin ? "閉じる" : "記録する"}
                  </Text>
                </Pressable>
              </View>

              {showCheckin ? (
                <View style={{ gap: spacing.md, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border }}>
                  {/* 睡眠時間 */}
                  <View>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: spacing.xs }}>
                      <Text style={{ fontSize: 12, fontWeight: "600", color: colors.textLight }}>😴 睡眠時間</Text>
                      <Text style={{ fontSize: 13, fontWeight: "800", color: colors.text }}>{checkinForm.sleepHours}時間</Text>
                    </View>
                    <View style={{ flexDirection: "row", gap: 4 }}>
                      {[4, 5, 6, 7, 8, 9, 10].map((h) => (
                        <Pressable
                          key={h}
                          onPress={() => setCheckinForm({ ...checkinForm, sleepHours: h })}
                          style={{
                            flex: 1, paddingVertical: 6, borderRadius: radius.md, alignItems: "center",
                            backgroundColor: checkinForm.sleepHours === h ? colors.purple : colors.bg,
                          }}
                        >
                          <Text style={{ fontSize: 11, fontWeight: "800", color: checkinForm.sleepHours === h ? "#fff" : colors.textMuted }}>{h}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>

                  {/* 各項目（5段階） */}
                  {CHECKIN_FIELDS.map((item) => (
                    <View key={item.key}>
                      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: spacing.xs }}>
                        <Text style={{ fontSize: 12, fontWeight: "600", color: colors.textLight }}>{item.label}</Text>
                        <Text style={{ fontSize: 11, color: colors.textMuted }}>
                          {item.options[(checkinForm as any)[item.key] - 1]}
                        </Text>
                      </View>
                      <View style={{ flexDirection: "row", gap: 4 }}>
                        {[1, 2, 3, 4, 5].map((val) => (
                          <Pressable
                            key={val}
                            onPress={() => setCheckinForm({ ...checkinForm, [item.key]: val })}
                            style={{
                              flex: 1, paddingVertical: 6, borderRadius: radius.md, alignItems: "center",
                              backgroundColor: (checkinForm as any)[item.key] === val ? colors.purple : colors.bg,
                            }}
                          >
                            <Text style={{
                              fontSize: 12, fontWeight: "800",
                              color: (checkinForm as any)[item.key] === val ? "#fff" : colors.textMuted,
                            }}>{val}</Text>
                          </Pressable>
                        ))}
                      </View>
                    </View>
                  ))}

                  <Button
                    onPress={async () => {
                      setCheckinSubmitting(true);
                      const result = await submitPerformanceCheckin(checkinForm);
                      setCheckinSubmitting(false);
                      if (result.success) setShowCheckin(false);
                    }}
                    loading={checkinSubmitting}
                    disabled={checkinSubmitting}
                  >
                    {checkinSubmitting ? "保存中..." : "✓ チェックイン完了"}
                  </Button>
                </View>
              ) : (
                <Text style={{ fontSize: 12, color: colors.textMuted }}>
                  {performanceAnalysis.eligibilityReason || "チェックインデータがありません"}
                </Text>
              )}
            </Card>
          )}

          {/* チェックイン完了済み */}
          {performanceAnalysis.todayCheckin && !performanceAnalysis.nextAction && (
            <View style={{
              flexDirection: "row", alignItems: "center", gap: spacing.sm,
              backgroundColor: colors.successLight, padding: spacing.lg, borderRadius: radius.xl,
              borderWidth: 1, borderColor: "#C8E6C9",
            }}>
              <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: "#C8E6C9", alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="checkmark" size={16} color={colors.success} />
              </View>
              <View>
                <Text style={{ fontSize: 13, fontWeight: "800", color: colors.success }}>今日のチェックイン完了！</Text>
                <Text style={{ fontSize: 11, color: colors.textMuted }}>
                  {performanceAnalysis.eligibilityReason || "7日分のデータが揃うと分析が始まります"}
                </Text>
              </View>
            </View>
          )}

          {/* ========== AIサジェスト ========== */}
          {suggestion && (
            <View style={{
              padding: spacing.lg, borderRadius: radius.xl, backgroundColor: colors.accent,
              ...shadows.md,
            }}>
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.sm }}>
                <Ionicons name="sparkles" size={18} color="#fff" style={{ marginTop: 2 }} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, fontWeight: "800", color: "rgba(255,255,255,0.8)", marginBottom: 2 }}>💡 今日のアドバイス</Text>
                  <Text style={{ fontSize: 13, fontWeight: "600", color: "#fff", lineHeight: 20 }}>{suggestion}</Text>
                </View>
                <Pressable onPress={() => setSuggestion(null)} hitSlop={12}>
                  <Ionicons name="close" size={16} color="rgba(255,255,255,0.6)" />
                </Pressable>
              </View>
            </View>
          )}

          {/* ========== 今日の献立 ========== */}
          <Card>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.md }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                <View style={{ width: 32, height: 32, borderRadius: radius.md, backgroundColor: colors.accentLight, alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="calendar" size={16} color={colors.accent} />
                </View>
                <Text style={{ fontSize: 15, fontWeight: "800", color: colors.text }}>今日の献立</Text>
              </View>
              <Pressable onPress={() => router.push("/menus/weekly")} style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                <Text style={{ fontSize: 12, fontWeight: "700", color: colors.accent }}>献立表</Text>
                <Ionicons name="chevron-forward" size={14} color={colors.accent} />
              </Pressable>
            </View>

            {loading ? (
              <LoadingState />
            ) : todayMeals.length === 0 ? (
              <EmptyState
                icon={<Ionicons name="calendar-outline" size={40} color={colors.textMuted} />}
                message="今日の献立がまだありません"
                actionLabel="献立を作成する"
                onAction={() => router.push("/menus/weekly/request")}
              />
            ) : (
              <View style={{ gap: spacing.sm }}>
                {sortedMeals.map((m) => {
                  const mealCfg = MEAL_CONFIG[m.meal_type] ?? { icon: "ellipse", label: m.meal_type, color: colors.textMuted };
                  const modeCfg = MODE_CONFIG[m.mode ?? "cook"] ?? MODE_CONFIG.cook;
                  return (
                    <Pressable
                      key={m.id}
                      onPress={() => toggleMealCompletion(m.id, !!m.is_completed)}
                      style={({ pressed }) => ({
                        flexDirection: "row", alignItems: "center", gap: spacing.md,
                        padding: spacing.md, borderRadius: radius.lg,
                        backgroundColor: m.is_completed ? colors.bg : "transparent",
                        opacity: m.is_completed ? 0.6 : pressed ? 0.9 : 1,
                        borderWidth: 1, borderColor: m.is_completed ? "transparent" : colors.border,
                      })}
                    >
                      {/* 完了チェック */}
                      <View style={{
                        width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center",
                        backgroundColor: m.is_completed ? colors.success : "transparent",
                        borderWidth: m.is_completed ? 0 : 2, borderColor: colors.border,
                      }}>
                        {m.is_completed && <Ionicons name="checkmark" size={16} color="#fff" />}
                      </View>

                      {/* アイコン */}
                      <View style={{
                        width: 44, height: 44, borderRadius: radius.lg, backgroundColor: colors.bg,
                        alignItems: "center", justifyContent: "center",
                      }}>
                        <Ionicons name={mealCfg.icon} size={20} color={mealCfg.color} />
                      </View>

                      {/* 情報 */}
                      <View style={{ flex: 1, gap: 2 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                          <Text style={{ fontSize: 11, fontWeight: "800", color: mealCfg.color }}>{mealCfg.label}</Text>
                          <View style={{ backgroundColor: modeCfg.bg, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
                            <Text style={{ fontSize: 9, fontWeight: "800", color: modeCfg.color }}>{modeCfg.label}</Text>
                          </View>
                        </View>
                        <Text style={{
                          fontSize: 14, fontWeight: "600", color: colors.text,
                          textDecorationLine: m.is_completed ? "line-through" : "none",
                        }} numberOfLines={1}>
                          {m.dish_name || "（未設定）"}
                        </Text>
                      </View>

                      {/* カロリー */}
                      <View style={{ alignItems: "flex-end" }}>
                        <Text style={{ fontSize: 14, fontWeight: "800", color: colors.text }}>{m.calories_kcal || "-"}</Text>
                        <Text style={{ fontSize: 9, color: colors.textMuted }}>kcal</Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </Card>

          {/* ========== クイックアクション ========== */}
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <Pressable
              onPress={() => router.push("/meals/new")}
              style={{ flex: 1, backgroundColor: colors.card, borderRadius: radius.xl, padding: spacing.lg, borderWidth: 1, borderColor: colors.border, ...shadows.sm }}
            >
              <View style={{ width: 40, height: 40, borderRadius: radius.lg, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", marginBottom: spacing.sm }}>
                <Ionicons name="camera" size={20} color="#fff" />
              </View>
              <Text style={{ fontSize: 13, fontWeight: "800", color: colors.text }}>食事を記録</Text>
              <Text style={{ fontSize: 11, color: colors.textMuted }}>写真から入力</Text>
            </Pressable>
            <Pressable
              onPress={() => router.push("/menus/weekly/request")}
              style={{ flex: 1, backgroundColor: colors.card, borderRadius: radius.xl, padding: spacing.lg, borderWidth: 1, borderColor: colors.border, ...shadows.sm }}
            >
              <View style={{ width: 40, height: 40, borderRadius: radius.lg, backgroundColor: colors.purple, alignItems: "center", justifyContent: "center", marginBottom: spacing.sm }}>
                <Ionicons name="sparkles" size={20} color="#fff" />
              </View>
              <Text style={{ fontSize: 13, fontWeight: "800", color: colors.text }}>AI献立</Text>
              <Text style={{ fontSize: 11, color: colors.textMuted }}>1週間分を生成</Text>
            </Pressable>
          </View>

          {/* ========== 週間自炊率グラフ ========== */}
          {weeklyStats.days.length > 0 && (
            <Card>
              <View style={{ gap: spacing.sm }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <View style={{ width: 32, height: 32, borderRadius: radius.md, backgroundColor: colors.successLight, alignItems: "center", justifyContent: "center" }}>
                      <Ionicons name="trending-up" size={16} color={colors.success} />
                    </View>
                    <Text style={{ fontSize: 15, fontWeight: "800", color: colors.text }}>今週の自炊率</Text>
                  </View>
                  <Text style={{ fontSize: 22, fontWeight: "900", color: colors.success }}>{weeklyStats.avgCookRate}%</Text>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", height: 60 }}>
                  {weeklyStats.days.map((day) => {
                    const barH = Math.max(4, (day.cookRate / 100) * 48);
                    const isToday = day.dayOfWeek === DOW[new Date().getDay()];
                    return (
                      <View key={day.date} style={{ alignItems: "center", gap: 4, flex: 1 }}>
                        <View style={{
                          width: 20, height: barH, borderRadius: 6,
                          backgroundColor: isToday ? colors.success : day.cookRate > 0 ? "#C8E6C9" : colors.border,
                        }} />
                        <Text style={{
                          fontSize: 10, fontWeight: isToday ? "800" : "500",
                          color: isToday ? colors.success : colors.textMuted,
                        }}>
                          {day.dayOfWeek}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            </Card>
          )}

          {/* ========== 冷蔵庫アラート ========== */}
          {expiringItems.length > 0 && (
            <Card onPress={() => router.push("/pantry")} variant="accent">
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                <View style={{ width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.warning, alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="alert" size={22} color="#fff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: "700", color: colors.text }}>期限間近の食材が{expiringItems.length}件</Text>
                  <Text style={{ fontSize: 12, color: colors.textMuted }} numberOfLines={1}>
                    {expiringItems.slice(0, 3).map((it: any) => it.name || it.item_name).join("、")}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
              </View>
            </Card>
          )}

          {/* バッジ */}
          <Pressable onPress={() => router.push("/badges")} style={{
            flexDirection: "row", alignItems: "center", gap: spacing.md,
            backgroundColor: colors.purpleLight, borderRadius: radius.xl, padding: spacing.lg,
            borderWidth: 1, borderColor: "#D1C4E9",
          }}>
            <View style={{ width: 40, height: 40, borderRadius: radius.lg, backgroundColor: colors.purple, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="trophy" size={18} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: "800", color: "#4A148C" }}>獲得バッジ</Text>
              <Text style={{ fontSize: 12, color: colors.purple }}>{badgeCount}個獲得</Text>
            </View>
            {latestBadge && (
              <View style={{ alignItems: "flex-end" }}>
                <Text style={{ fontSize: 9, color: "#9575CD" }}>最新</Text>
                <Text style={{ fontSize: 12, fontWeight: "800", color: "#4A148C" }}>{latestBadge.name}</Text>
              </View>
            )}
          </Pressable>
        </View>
      </ScrollView>

      {/* ========== AIフローティングボタン ========== */}
      <Pressable
        onPress={() => router.push("/ai")}
        style={{
          position: "absolute", bottom: 100, right: spacing.lg,
          width: 56, height: 56, borderRadius: 28,
          backgroundColor: colors.accent, alignItems: "center", justifyContent: "center",
          ...shadows.lg,
        }}
      >
        <Ionicons name="chatbubble-ellipses" size={24} color="#fff" />
      </Pressable>
    </View>
  );
}
