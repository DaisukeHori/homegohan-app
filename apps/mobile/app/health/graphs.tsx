import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import Svg, { Circle, Line, Path, Polygon, Text as SvgText } from "react-native-svg";

import { Button, Card, EmptyState, LoadingState, PageHeader } from "../../src/components/ui";
import { colors, spacing, radius } from "../../src/theme";
import { getApi } from "../../src/lib/api";

// ----------------------------------------------------------------
// 型定義
// ----------------------------------------------------------------
type Period = "week" | "month" | "3months" | "year";
type Metric = "weight" | "body_fat" | "bp" | "sleep" | "mood" | "energy_level" | "heart_rate" | "body_temp";

interface HealthRecord {
  id: string;
  record_date: string;
  weight?: number | null;
  body_fat_percentage?: number | null;
  systolic_bp?: number | null;
  sleep_hours?: number | null;
  mood_score?: number | null;
  energy_level?: number | null;
  heart_rate?: number | null;
  body_temp?: number | null;
  fromCheckup?: boolean;
}

interface CheckupRecord {
  checkup_date: string;
  weight?: number | null;
  blood_pressure_systolic?: number | null;
}

interface GoalRecord {
  goal_type: string;
  target_value: number;
}

// ----------------------------------------------------------------
// 折れ線グラフコンポーネント
// ----------------------------------------------------------------
interface LineGraphProps {
  data: { date: string; value: number | null; fromCheckup?: boolean }[];
  min: number | null;
  max: number | null;
  targetValue?: number | null;
  color: string;
  period: Period;
}

function LineGraph({ data, min, max, targetValue, color, period }: LineGraphProps) {
  const svgWidth = 300;
  const svgHeight = 160;
  const pad = { top: 20, right: 16, bottom: 28, left: 36 };
  const gw = svgWidth - pad.left - pad.right;
  const gh = svgHeight - pad.top - pad.bottom;

  if (data.length === 0 || min === null || max === null) return null;

  const range = max - min || 1;
  const yMin = min - range * 0.1;
  const yMax = max + range * 0.1;
  const yRange = yMax - yMin;

  const toX = (i: number) =>
    data.length > 1 ? pad.left + (i / (data.length - 1)) * gw : pad.left + gw / 2;
  const toY = (v: number) => pad.top + gh - ((v - yMin) / yRange) * gh;

  type ValidPoint = { x: number; y: number; fromCheckup: boolean | undefined };
  const validPoints: ValidPoint[] = data
    .map((d, i) => ({ x: toX(i), y: d.value !== null ? toY(d.value) : null, fromCheckup: d.fromCheckup }))
    .filter((p): p is { x: number; y: number; fromCheckup: boolean | undefined } => p.y !== null);

  const pathD =
    validPoints.length > 1
      ? `M ${validPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ")}`
      : "";

  const targetY =
    targetValue != null && targetValue >= yMin && targetValue <= yMax
      ? toY(targetValue)
      : null;

  // X軸ラベル: 期間に応じてサンプリング
  const xLabelIndices: number[] = [];
  if (data.length > 0) {
    xLabelIndices.push(0);
    xLabelIndices.push(data.length - 1);
    if (period === "3months" || period === "year") {
      const step = Math.ceil(data.length / 4);
      for (let i = step; i < data.length - 1; i += step) {
        xLabelIndices.push(i);
      }
    }
  }

  return (
    <View style={{ alignItems: "center" }}>
      <Svg width="100%" viewBox={`0 0 ${svgWidth} ${svgHeight}`} style={{ overflow: "visible" }}>
        {/* グリッド線 */}
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = pad.top + gh * ratio;
          return (
            <Line
              key={ratio}
              x1={pad.left}
              y1={y}
              x2={svgWidth - pad.right}
              y2={y}
              stroke={colors.border}
              strokeDasharray="4,4"
              strokeWidth={1}
            />
          );
        })}

        {/* 目標ライン */}
        {targetY !== null && (() => {
          const ty = targetY as number;
          return (
            <>
              <Line
                x1={pad.left}
                y1={ty}
                x2={svgWidth - pad.right}
                y2={ty}
                stroke={colors.success}
                strokeWidth={2}
                strokeDasharray="6,4"
              />
              <SvgText
                x={svgWidth - pad.right + 4}
                y={ty + 4}
                fontSize={9}
                fill={colors.success}
              >
                目標
              </SvgText>
            </>
          );
        })()}

        {/* 折れ線 */}
        {pathD !== "" && (
          <Path
            d={pathD}
            fill="none"
            stroke={color}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* データポイント */}
        {validPoints.map((p, i) =>
          p.fromCheckup ? (
            // 健診データ: 菱形
            <Polygon
              key={i}
              points={`${p.x},${p.y - 5} ${p.x + 5},${p.y} ${p.x},${p.y + 5} ${p.x - 5},${p.y}`}
              fill={colors.purple}
              stroke={colors.card}
              strokeWidth={1.5}
            />
          ) : (
            <Circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={4}
              fill={colors.card}
              stroke={color}
              strokeWidth={2}
            />
          )
        )}

        {/* Y軸ラベル */}
        <SvgText
          x={pad.left - 4}
          y={pad.top + 5}
          fontSize={9}
          fill={colors.textMuted}
          textAnchor="end"
        >
          {yMax.toFixed(1)}
        </SvgText>
        <SvgText
          x={pad.left - 4}
          y={pad.top + gh + 3}
          fontSize={9}
          fill={colors.textMuted}
          textAnchor="end"
        >
          {yMin.toFixed(1)}
        </SvgText>

        {/* X軸ラベル */}
        {xLabelIndices.map((idx) => {
          const d = data[idx];
          if (!d) return null;
          const x = toX(idx);
          return (
            <SvgText
              key={idx}
              x={x}
              y={svgHeight - 4}
              fontSize={9}
              fill={colors.textMuted}
              textAnchor="middle"
            >
              {d.date.slice(5)}
            </SvgText>
          );
        })}
      </Svg>
    </View>
  );
}

// ----------------------------------------------------------------
// メインページ
// ----------------------------------------------------------------
export default function HealthGraphsPage() {
  const [records, setRecords] = useState<HealthRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("month");
  const [metric, setMetric] = useState<Metric>("weight");
  const [targetWeight, setTargetWeight] = useState<number | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const days =
        period === "week" ? 7 : period === "month" ? 30 : period === "3months" ? 90 : 365;

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const startStr = startDate.toISOString().slice(0, 10);

      const [recordsRes, checkupsRes, goalsRes] = await Promise.all([
        api.get<{ records: HealthRecord[] }>(
          `/api/health/records?start_date=${startStr}&limit=365`
        ),
        api.get<{ checkups: CheckupRecord[] }>(`/api/health/checkups?limit=365`),
        api.get<{ goals: GoalRecord[] }>("/api/health/goals?status=active"),
      ]);

      const merged: HealthRecord[] = [...(recordsRes.records ?? [])];

      // 健診データを補完
      for (const c of checkupsRes.checkups ?? []) {
        if (c.checkup_date < startStr) continue;
        const existing = merged.find((r) => r.record_date === c.checkup_date);
        if (existing) {
          if (c.weight != null && existing.weight == null) existing.weight = c.weight;
          if (c.blood_pressure_systolic != null && existing.systolic_bp == null) {
            existing.systolic_bp = c.blood_pressure_systolic;
          }
        } else {
          merged.push({
            id: `checkup-${c.checkup_date}`,
            record_date: c.checkup_date,
            weight: c.weight ?? null,
            systolic_bp: c.blood_pressure_systolic ?? null,
            fromCheckup: true,
          });
        }
      }

      merged.sort((a, b) => a.record_date.localeCompare(b.record_date));
      setRecords(merged);

      const weightGoal = (goalsRes.goals ?? []).find((g) => g.goal_type === "weight");
      setTargetWeight(weightGoal?.target_value ?? null);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  // 期間内の全日付スロットを生成し、各日に値をマッピング
  const graphData = useMemo(() => {
    const days =
      period === "week" ? 7 : period === "month" ? 30 : period === "3months" ? 90 : 365;
    const result: { date: string; value: number | null; fromCheckup?: boolean }[] = [];
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days + 1);

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      const rec = records.find((r) => r.record_date === dateStr);
      let value: number | null = null;
      if (rec) {
        switch (metric) {
          case "weight":
            value = rec.weight ?? null;
            break;
          case "body_fat":
            value = rec.body_fat_percentage ?? null;
            break;
          case "bp":
            value = rec.systolic_bp ?? null;
            break;
          case "sleep":
            value = rec.sleep_hours ?? null;
            break;
          case "mood":
            value = rec.mood_score ?? null;
            break;
          case "energy_level":
            value = rec.energy_level ?? null;
            break;
          case "heart_rate":
            value = rec.heart_rate ?? null;
            break;
          case "body_temp":
            value = rec.body_temp ?? null;
            break;
        }
      }
      result.push({ date: dateStr, value, fromCheckup: rec?.fromCheckup });
    }
    return result;
  }, [records, period, metric]);

  const { min, max, avg } = useMemo(() => {
    const vals = graphData.filter((d) => d.value !== null).map((d) => d.value as number);
    if (vals.length === 0) return { min: null, max: null, avg: null };
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    const av = vals.reduce((a, b) => a + b, 0) / vals.length;
    return { min: mn, max: mx, avg: av };
  }, [graphData]);

  const latestValue = useMemo(() => {
    const valid = graphData.filter((d) => d.value !== null);
    return valid.length > 0 ? valid[valid.length - 1].value : null;
  }, [graphData]);

  const change = useMemo(() => {
    const valid = graphData.filter((d) => d.value !== null);
    if (valid.length < 2) return null;
    return parseFloat(((valid[valid.length - 1].value ?? 0) - (valid[0].value ?? 0)).toFixed(2));
  }, [graphData]);

  const formatStat = (v: number | null) => (v === null ? "-" : v.toFixed(1));

  const metricConfig: Record<Metric, { label: string; unit: string; color: string }> = {
    weight: { label: "体重", unit: "kg", color: colors.accent },
    body_fat: { label: "体脂肪率", unit: "%", color: colors.purple },
    bp: { label: "血圧(収縮期)", unit: "mmHg", color: colors.error },
    sleep: { label: "睡眠時間", unit: "h", color: colors.blue },
    mood: { label: "気分スコア", unit: "/ 5", color: colors.warning },
    energy_level: { label: "エネルギー", unit: "/ 5", color: colors.success },
    heart_rate: { label: "心拍数", unit: "bpm", color: colors.streak },
    body_temp: { label: "体温", unit: "℃", color: colors.accentDark },
  };

  const currentMetric = metricConfig[metric];
  const hasData = graphData.some((d) => d.value !== null);

  return (
    <View testID="health-graphs-screen" style={styles.screen}>
      <PageHeader
        title="推移グラフ"
        right={
          <Link href="/health">
            <Text style={styles.linkText}>健康トップへ</Text>
          </Link>
        }
      />
      <ScrollView contentContainerStyle={styles.container}>
        {/* 指標セレクタ */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll}>
          {(Object.keys(metricConfig) as Metric[]).map((m) => (
            <TouchableOpacity
              key={m}
              testID={`health-graphs-metric-${m}`}
              onPress={() => setMetric(m)}
              style={[
                styles.chip,
                { backgroundColor: metric === m ? metricConfig[m].color : colors.card },
              ]}
            >
              <Text
                style={[
                  styles.chipText,
                  { color: metric === m ? colors.card : colors.textLight },
                ]}
              >
                {metricConfig[m].label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* 期間セレクタ */}
        <View style={styles.periodRow}>
          {(["week", "month", "3months", "year"] as Period[]).map((p) => (
            <TouchableOpacity
              key={p}
              testID={`health-graphs-period-${p}`}
              onPress={() => setPeriod(p)}
              style={[
                styles.periodBtn,
                { backgroundColor: period === p ? colors.accent : colors.card },
              ]}
            >
              <Text
                style={[
                  styles.periodText,
                  { color: period === p ? colors.card : colors.textLight },
                ]}
              >
                {p === "week" ? "1週" : p === "month" ? "1ヶ月" : p === "3months" ? "3ヶ月" : "1年"}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* グラフカード */}
        {isLoading ? (
          <LoadingState message="データを読み込み中..." />
        ) : error ? (
          <Card variant="error">
            <View style={styles.errorRow}>
              <Ionicons name="alert-circle" size={20} color={colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          </Card>
        ) : !hasData ? (
          <EmptyState
            testID="health-graphs-empty"
            icon={<Ionicons name="analytics-outline" size={48} color={colors.textMuted} />}
            message="データがありません。健康記録を開始しましょう。"
            actionLabel="記録する"
            onAction={() => {}}
          />
        ) : (
          <>
            {/* メトリクスカード */}
            <View testID="health-graphs-chart" style={styles.chartCard}>
              {/* サマリーヘッダー */}
              <View style={styles.chartHeader}>
                <View>
                  <Text style={styles.metricLabel}>{currentMetric.label}の推移</Text>
                  <View style={styles.valueRow}>
                    <Text style={[styles.latestValue, { color: currentMetric.color }]}>
                      {latestValue !== null ? latestValue.toFixed(1) : "-"}
                    </Text>
                    <Text style={styles.unitText}>{currentMetric.unit}</Text>
                  </View>
                </View>
                {change !== null && (
                  <View
                    style={[
                      styles.changeBadge,
                      {
                        backgroundColor:
                          change < 0
                            ? colors.successLight
                            : change > 0
                            ? colors.errorLight
                            : colors.bg,
                      },
                    ]}
                  >
                    <Ionicons
                      name={
                        change < 0
                          ? "trending-down"
                          : change > 0
                          ? "trending-up"
                          : "remove"
                      }
                      size={14}
                      color={
                        change < 0
                          ? colors.success
                          : change > 0
                          ? colors.error
                          : colors.textMuted
                      }
                    />
                    <Text
                      style={[
                        styles.changeText,
                        {
                          color:
                            change < 0
                              ? colors.success
                              : change > 0
                              ? colors.error
                              : colors.textMuted,
                        },
                      ]}
                    >
                      {change > 0 ? "+" : ""}
                      {change} {currentMetric.unit}
                    </Text>
                  </View>
                )}
              </View>

              {/* 折れ線グラフ */}
              <LineGraph
                data={graphData}
                min={min}
                max={max}
                targetValue={metric === "weight" ? targetWeight : null}
                color={currentMetric.color}
                period={period}
              />

              {/* 凡例 */}
              <View style={styles.legendRow}>
                <View style={styles.legendItem}>
                  <Circle cx={4} cy={4} r={4} />
                  <View style={[styles.legendDot, { backgroundColor: currentMetric.color }]} />
                  <Text style={styles.legendText}>実測</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={styles.legendDiamond} />
                  <Text style={styles.legendText}>健診データ</Text>
                </View>
              </View>
            </View>

            {/* 統計カード */}
            <View style={styles.statsRow}>
              <View style={styles.statBox}>
                <Text style={styles.statLabel}>最小</Text>
                <Text style={styles.statValue}>{formatStat(min)}</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statLabel}>平均</Text>
                <Text style={styles.statValue}>{formatStat(avg)}</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statLabel}>最大</Text>
                <Text style={styles.statValue}>{formatStat(max)}</Text>
              </View>
            </View>

            {/* 体重目標カード */}
            {metric === "weight" && targetWeight !== null && (
              <View style={[styles.goalCard, { backgroundColor: colors.successLight }]}>
                <Ionicons name="trophy-outline" size={24} color={colors.success} />
                <View style={{ marginLeft: spacing.md }}>
                  <Text style={[styles.goalTitle, { color: colors.success }]}>
                    目標体重: {targetWeight} kg
                  </Text>
                  {latestValue !== null && (
                    <Text style={[styles.goalSub, { color: colors.success }]}>
                      あと {(latestValue - targetWeight).toFixed(1)} kg
                    </Text>
                  )}
                </View>
              </View>
            )}
          </>
        )}

        <Button onPress={load} variant="ghost" size="sm">
          <Ionicons name="refresh-outline" size={16} color={colors.textLight} />
          <Text style={{ color: colors.textLight, fontWeight: "700", fontSize: 13 }}>
            更新
          </Text>
        </Button>
      </ScrollView>
    </View>
  );
}

// ----------------------------------------------------------------
// スタイル
// ----------------------------------------------------------------
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    padding: spacing.lg,
    gap: spacing.lg,
    paddingBottom: spacing["4xl"],
  },
  linkText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.accent,
  },
  chipScroll: {
    flexGrow: 0,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    marginRight: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipText: {
    fontSize: 13,
    fontWeight: "600",
  },
  periodRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  periodBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  periodText: {
    fontSize: 12,
    fontWeight: "600",
  },
  chartCard: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chartHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: spacing.md,
  },
  metricLabel: {
    fontSize: 13,
    color: colors.textMuted,
    marginBottom: 2,
  },
  valueRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 4,
  },
  latestValue: {
    fontSize: 28,
    fontWeight: "900",
  },
  unitText: {
    fontSize: 13,
    color: colors.textMuted,
    fontWeight: "600",
  },
  changeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
  },
  changeText: {
    fontSize: 12,
    fontWeight: "700",
  },
  legendRow: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendDiamond: {
    width: 8,
    height: 8,
    backgroundColor: colors.purple,
    transform: [{ rotate: "45deg" }],
  },
  legendText: {
    fontSize: 11,
    color: colors.textMuted,
  },
  statsRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  statBox: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    padding: spacing.md,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  statLabel: {
    fontSize: 11,
    color: colors.textMuted,
    marginBottom: 4,
  },
  statValue: {
    fontSize: 18,
    fontWeight: "800",
    color: colors.text,
  },
  goalCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    borderRadius: radius.xl,
  },
  goalTitle: {
    fontSize: 15,
    fontWeight: "700",
  },
  goalSub: {
    fontSize: 13,
    marginTop: 2,
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
});
