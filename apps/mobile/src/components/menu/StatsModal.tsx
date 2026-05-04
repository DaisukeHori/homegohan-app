import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  DEFAULT_RADAR_NUTRIENTS,
  NUTRIENT_DEFINITIONS,
} from '@homegohan/shared';

import { getApi } from '../../lib/api';
import { subscribeNutritionFeedback } from '../../lib/realtime';
import { colors } from '../../theme/colors';
import { radius, spacing } from '../../theme/spacing';
import { shadows } from '../../theme';
import { typography } from '../../theme/typography';
import { BarChart } from './BarChart';
import { DriBar } from './DriBar';
import { RadarChart } from './RadarChart';
import { RadarKeyPicker } from './RadarKeyPicker';

// ============================================================
// 型定義
// ============================================================

export interface NutrientValues {
  caloriesKcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  fiberG: number;
  sodiumG?: number;
  sugarG?: number;
  potassiumMg?: number;
  calciumMg?: number;
  magnesiumMg?: number;
  phosphorusMg?: number;
  ironMg?: number;
  zincMg?: number;
  iodineUg?: number;
  cholesterolMg?: number;
  vitaminAUg?: number;
  vitaminB1Mg?: number;
  vitaminB2Mg?: number;
  vitaminB6Mg?: number;
  vitaminB12Ug?: number;
  vitaminCMg?: number;
  vitaminDUg?: number;
  vitaminEMg?: number;
  vitaminKUg?: number;
  folicAcidUg?: number;
  saturatedFatG?: number;
  [key: string]: number | undefined;
}

export interface WeekNutrientData {
  avgCalories: number;
  dailyKcal: number[];
  avgProtein: number;
  avgFat: number;
  avgCarbs: number;
  avgFiber: number;
}

export interface StatsModalProps {
  visible: boolean;
  onClose: () => void;
  onOpenImprove: () => void;
  selectedDate: string;
  weekRange: { start: string; end: string };
  todayNutrients: NutrientValues;
  weekNutrients: WeekNutrientData;
  userId: string;
  /** 週の日付ラベル (曜日) */
  weekDayLabels?: string[];
  /** 既存の Today の meals (AI feedback 取得に使用) */
  todayMeals?: Array<{ dish_name: string; calories_kcal: number | null }>;
}

type Tab = 'today' | 'week';

// NutrientValues を Record<string, number> に変換するヘルパー
function toTotals(n: NutrientValues): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of Object.keys(n)) {
    result[key] = n[key] ?? 0;
  }
  return result;
}

// ============================================================
// カロリーバー (big)
// ============================================================

function CalBar({ calories }: { calories: number }) {
  const calDef = NUTRIENT_DEFINITIONS.find((d) => d.key === 'caloriesKcal');
  const dri = calDef?.dri ?? 2000;
  const pct = Math.min((calories / dri) * 100, 100);

  let barCol = colors.accent;
  if (pct >= 80 && pct <= 120) barCol = colors.success;
  else if (pct > 120) barCol = colors.error;

  return (
    <View style={calStyles.card}>
      <View style={calStyles.header}>
        <Ionicons name="flame" size={16} color={colors.accent} />
        <Text style={calStyles.title}>カロリー</Text>
        <Text style={[calStyles.pct, { color: barCol }]}>{Math.round(pct)}%</Text>
      </View>
      <Text style={calStyles.value}>
        {Math.round(calories)} / {dri} kcal
      </Text>
      <View style={calStyles.track}>
        <View style={[calStyles.fill, { width: `${pct}%`, backgroundColor: barCol }]} />
      </View>
    </View>
  );
}

const calStyles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    ...shadows.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  title: {
    ...typography.label,
    flex: 1,
  },
  pct: {
    fontSize: 13,
    fontWeight: '700',
  },
  value: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.text,
  },
  track: {
    height: 8,
    backgroundColor: colors.border,
    borderRadius: 4,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 4,
  },
});

// ============================================================
// P/F/C ミニカード
// ============================================================

function PfcRow({ nutrients }: { nutrients: NutrientValues }) {
  const items = [
    { key: 'proteinG', label: 'タンパク質', short: 'P', value: nutrients.proteinG },
    { key: 'fatG', label: '脂質', short: 'F', value: nutrients.fatG },
    { key: 'carbsG', label: '炭水化物', short: 'C', value: nutrients.carbsG },
  ] as const;

  return (
    <View style={pfcStyles.row}>
      {items.map(({ key, label, short, value }) => {
        const def = NUTRIENT_DEFINITIONS.find((d) => d.key === key);
        const dri = def?.dri ?? 1;
        const pct = Math.round((value / dri) * 100);
        const decimals = def?.decimals ?? 1;
        return (
          <View key={key} style={pfcStyles.card}>
            <Text style={pfcStyles.short}>{short}</Text>
            <Text style={pfcStyles.label}>{label}</Text>
            <Text style={pfcStyles.val}>
              {value.toFixed(decimals)}g
            </Text>
            <Text style={pfcStyles.pct}>{pct}%</Text>
          </View>
        );
      })}
    </View>
  );
}

const pfcStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  card: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'center',
    gap: 2,
    ...shadows.sm,
  },
  short: {
    fontSize: 16,
    fontWeight: '900',
    color: colors.accent,
  },
  label: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'center',
  },
  val: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text,
  },
  pct: {
    fontSize: 11,
    color: colors.textLight,
  },
});

// ============================================================
// 今日タブ
// ============================================================

interface TodayTabProps {
  nutrients: NutrientValues;
  radarKeys: string[];
  setRadarKeys: (keys: string[]) => void;
  editingRadar: boolean;
  setEditingRadar: (v: boolean) => void;
  feedback: { praise: string | null; advice: string | null } | null;
  isLoadingFeedback: boolean;
  onOpenImprove: () => void;
  selectedDate: string;
  mealCount: number;
}

function TodayTab({
  nutrients,
  radarKeys,
  setRadarKeys,
  editingRadar,
  setEditingRadar,
  feedback,
  isLoadingFeedback,
  onOpenImprove,
  selectedDate,
  mealCount,
}: TodayTabProps) {
  const dateLabel = selectedDate.replace(/-/g, '/');
  const totals = toTotals(nutrients);

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={todayStyles.scroll}
      showsVerticalScrollIndicator={false}
    >
      <Text style={todayStyles.dateTitle}>{dateLabel} の栄養</Text>
      <Text style={todayStyles.mealCount}>{mealCount} 食分</Text>

      {/* カロリー大バー */}
      <CalBar calories={nutrients.caloriesKcal} />

      {/* P/F/C */}
      <PfcRow nutrients={nutrients} />

      {/* レーダーチャート */}
      <View style={todayStyles.radarSection}>
        <View style={todayStyles.radarHeader}>
          <Text style={todayStyles.sectionTitle}>栄養バランス</Text>
          <Pressable
            testID="stats-radar-edit-btn"
            onPress={() => setEditingRadar(!editingRadar)}
            style={todayStyles.editBtn}
          >
            <Text style={todayStyles.editBtnText}>{editingRadar ? '完了' : '編集'}</Text>
          </Pressable>
        </View>
        {editingRadar ? (
          <RadarKeyPicker
            selectedKeys={radarKeys}
            onSaved={(keys) => {
              setRadarKeys(keys);
              setEditingRadar(false);
            }}
          />
        ) : (
          <View style={{ alignItems: 'center' }}>
            <RadarChart totals={totals} nutrientKeys={radarKeys} size={220} />
          </View>
        )}
      </View>

      {/* AI フィードバック */}
      <View testID="stats-ai-feedback" style={todayStyles.feedbackSection}>
        {/* 褒めポイント */}
        <View style={todayStyles.praiseCard}>
          <View style={todayStyles.feedbackHeader}>
            <Ionicons name="heart" size={14} color={colors.success} />
            <Text style={todayStyles.praiseTitleText}>褒めポイント</Text>
          </View>
          {isLoadingFeedback ? (
            <View style={todayStyles.loadingRow}>
              <ActivityIndicator size="small" color={colors.success} />
              <Text style={todayStyles.loadingText}>あなたの献立を分析中...</Text>
            </View>
          ) : feedback?.praise ? (
            <Text style={todayStyles.feedbackText}>{feedback.praise}</Text>
          ) : (
            <Text style={todayStyles.feedbackEmpty}>分析データがありません</Text>
          )}
        </View>

        {/* 改善アドバイス */}
        {(isLoadingFeedback || feedback?.advice) && (
          <View style={todayStyles.adviceCard}>
            <View style={todayStyles.feedbackHeader}>
              <Ionicons name="sparkles" size={14} color={colors.accent} />
              <Text style={todayStyles.adviceTitleText}>改善アドバイス</Text>
            </View>
            {isLoadingFeedback ? (
              <Text style={todayStyles.loadingText}>...</Text>
            ) : (
              <Text style={todayStyles.feedbackText}>{feedback?.advice}</Text>
            )}
          </View>
        )}
      </View>

      {/* DRI バー (主要栄養素 14 種) */}
      <View style={todayStyles.driSection}>
        <Text style={todayStyles.sectionTitle}>栄養素の達成率</Text>
        <View style={{ gap: spacing.sm }}>
          {NUTRIENT_DEFINITIONS.slice(0, 14).map((def) => (
            <DriBar
              key={def.key}
              def={def}
              value={totals[def.key] ?? 0}
            />
          ))}
        </View>
      </View>

      {/* 献立を改善ボタン */}
      <Pressable
        testID="stats-improve-btn"
        onPress={onOpenImprove}
        style={({ pressed }) => [todayStyles.improveBtn, pressed && { opacity: 0.85 }]}
      >
        <Ionicons name="refresh" size={16} color="#FFF" />
        <Text style={todayStyles.improveBtnText}>献立を改善</Text>
      </Pressable>

      <View style={{ height: spacing['2xl'] }} />
    </ScrollView>
  );
}

const todayStyles = StyleSheet.create({
  scroll: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  dateTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
  },
  mealCount: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: -spacing.sm,
  },
  radarSection: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
    ...shadows.sm,
  },
  radarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    ...typography.label,
    color: colors.text,
  },
  editBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: colors.accent,
    backgroundColor: colors.accentLight,
  },
  editBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent,
  },
  feedbackSection: {
    gap: spacing.sm,
  },
  praiseCard: {
    backgroundColor: colors.successLight,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  adviceCard: {
    backgroundColor: colors.accentLight,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  feedbackHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  praiseTitleText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.success,
  },
  adviceTitleText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent,
  },
  feedbackText: {
    fontSize: 13,
    color: colors.text,
    lineHeight: 20,
  },
  feedbackEmpty: {
    fontSize: 11,
    color: colors.textMuted,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  loadingText: {
    fontSize: 11,
    color: colors.textLight,
  },
  driSection: {
    gap: spacing.md,
  },
  improveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    ...shadows.sm,
  },
  improveBtnText: {
    ...typography.label,
    color: '#FFF',
  },
});

// ============================================================
// 今週タブ
// ============================================================

interface WeekTabProps {
  data: WeekNutrientData;
  weekDayLabels: string[];
  weekRange: { start: string; end: string };
}

function WeekTab({ data, weekDayLabels, weekRange }: WeekTabProps) {
  const rangeLabel = `${weekRange.start.slice(5).replace('-', '/')} 〜 ${weekRange.end.slice(5).replace('-', '/')}`;

  const avgNutrients = [
    { key: 'proteinG', value: data.avgProtein },
    { key: 'fatG', value: data.avgFat },
    { key: 'carbsG', value: data.avgCarbs },
    { key: 'fiberG', value: data.avgFiber },
  ] as const;

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={weekStyles.scroll}
      showsVerticalScrollIndicator={false}
    >
      <Text style={weekStyles.rangeLabel}>{rangeLabel} の平均栄養</Text>

      {/* 平均カロリー */}
      <View style={weekStyles.avgCard}>
        <Ionicons name="flame" size={18} color={colors.accent} />
        <View style={weekStyles.avgBody}>
          <Text style={weekStyles.avgValue}>{Math.round(data.avgCalories)}</Text>
          <Text style={weekStyles.avgUnit}>kcal / 日</Text>
        </View>
      </View>

      {/* 曜日別バーチャート */}
      <View style={weekStyles.chartCard}>
        <Text style={weekStyles.chartTitle}>曜日別カロリー</Text>
        <BarChart
          values={data.dailyKcal}
          labels={weekDayLabels}
          maxBarHeight={100}
        />
      </View>

      {/* 週間栄養バー */}
      <View style={weekStyles.nutrientSection}>
        <Text style={weekStyles.sectionTitle}>週間栄養 (1 日平均比)</Text>
        <View style={{ gap: spacing.sm }}>
          {avgNutrients.map(({ key, value }) => {
            const def = NUTRIENT_DEFINITIONS.find((d) => d.key === key);
            if (!def) return null;
            return (
              <DriBar
                key={key}
                def={def}
                value={value}
              />
            );
          })}
        </View>
      </View>

      <View style={{ height: spacing['2xl'] }} />
    </ScrollView>
  );
}

const weekStyles = StyleSheet.create({
  scroll: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  rangeLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
  },
  avgCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    ...shadows.sm,
  },
  avgBody: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs,
  },
  avgValue: {
    fontSize: 36,
    fontWeight: '900',
    color: colors.text,
  },
  avgUnit: {
    fontSize: 14,
    color: colors.textMuted,
    fontWeight: '600',
  },
  chartCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    ...shadows.sm,
  },
  chartTitle: {
    ...typography.label,
    color: colors.text,
  },
  nutrientSection: {
    gap: spacing.md,
  },
  sectionTitle: {
    ...typography.label,
    color: colors.text,
  },
});

// ============================================================
// StatsModal メイン
// ============================================================

export const StatsModal: React.FC<StatsModalProps> = ({
  visible,
  onClose,
  onOpenImprove,
  selectedDate,
  weekRange,
  todayNutrients,
  weekNutrients,
  userId,
  weekDayLabels = ['月', '火', '水', '木', '金', '土', '日'],
  todayMeals = [],
}) => {
  const [tab, setTab] = useState<Tab>('today');
  const [editingRadar, setEditingRadar] = useState(false);
  const [radarKeys, setRadarKeys] = useState<string[]>(DEFAULT_RADAR_NUTRIENTS);
  const [feedback, setFeedback] = useState<{ praise: string | null; advice: string | null } | null>(null);
  const [isLoadingFeedback, setIsLoadingFeedback] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const mealCount = todayMeals.filter((m) => m.dish_name).length;

  useEffect(() => {
    if (!visible || tab !== 'today') return;

    setFeedback(null);
    setIsLoadingFeedback(true);

    if (mealCount === 0) {
      setIsLoadingFeedback(false);
      return;
    }

    // Realtime subscription
    unsubRef.current = subscribeNutritionFeedback(userId, (row) => {
      if (row.praise_comment || row.advice) {
        setFeedback({ praise: row.praise_comment ?? null, advice: row.advice ?? null });
        setIsLoadingFeedback(false);
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }
    });

    // ポーリング fallback (2 秒間隔、最大 40 秒)
    let resolved = false;

    const fetchFeedback = async () => {
      try {
        const api = getApi();
        const nutrition = {
          caloriesKcal: todayNutrients.caloriesKcal,
          proteinG: todayNutrients.proteinG,
          fatG: todayNutrients.fatG,
          carbsG: todayNutrients.carbsG,
          fiberG: todayNutrients.fiberG,
        };
        const res = await api.post<any>('/api/ai/nutrition/feedback', {
          date: selectedDate,
          nutrition,
          mealCount,
          forceRefresh: false,
          weekData: [],
        });

        if (res.cached && (res.praiseComment || res.feedback)) {
          setFeedback({
            praise: res.praiseComment ?? null,
            advice: res.advice ?? res.feedback ?? null,
          });
          setIsLoadingFeedback(false);
          resolved = true;
          return;
        }

        if (res.status === 'generating' && res.cacheId) {
          let count = 0;
          pollRef.current = setInterval(async () => {
            count++;
            if (resolved || count >= 20) {
              if (pollRef.current) clearInterval(pollRef.current);
              setIsLoadingFeedback(false);
              return;
            }
            try {
              const pollRes = await api.get<any>(`/api/ai/nutrition/feedback?cacheId=${res.cacheId}`);
              if (pollRes.status === 'completed' && (pollRes.feedback || pollRes.praiseComment)) {
                resolved = true;
                setFeedback({
                  praise: pollRes.praiseComment ?? null,
                  advice: pollRes.advice ?? pollRes.feedback ?? null,
                });
                setIsLoadingFeedback(false);
                if (pollRef.current) clearInterval(pollRef.current);
              }
            } catch {
              // ignore
            }
          }, 2000);
        } else {
          setIsLoadingFeedback(false);
        }
      } catch {
        setIsLoadingFeedback(false);
      }
    };

    fetchFeedback();

    return () => {
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [visible, tab, userId, selectedDate]);

  // モーダルを閉じたときにリセット
  useEffect(() => {
    if (!visible) {
      setTab('today');
      setEditingRadar(false);
    }
  }, [visible]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <View testID="stats-modal" style={styles.container}>
          {/* ヘッダー */}
          <View style={styles.header}>
            <Ionicons name="bar-chart" size={18} color={colors.accent} />
            <Text style={styles.headerTitle}>栄養分析</Text>
            <Pressable testID="stats-modal-close" onPress={onClose} style={styles.closeBtn} hitSlop={8}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </Pressable>
          </View>

          {/* タブ切替 */}
          <View style={styles.tabRow}>
            <Pressable
              testID="stats-tab-today"
              onPress={() => setTab('today')}
              style={[styles.tab, tab === 'today' && styles.tabActive]}
            >
              <Ionicons
                name="today"
                size={14}
                color={tab === 'today' ? colors.accent : colors.textMuted}
              />
              <Text style={[styles.tabText, tab === 'today' && styles.tabTextActive]}>今日</Text>
            </Pressable>
            <Pressable
              testID="stats-tab-week"
              onPress={() => setTab('week')}
              style={[styles.tab, tab === 'week' && styles.tabActive]}
            >
              <Ionicons
                name="calendar"
                size={14}
                color={tab === 'week' ? colors.accent : colors.textMuted}
              />
              <Text style={[styles.tabText, tab === 'week' && styles.tabTextActive]}>今週</Text>
            </Pressable>
          </View>

          {/* コンテンツ */}
          {tab === 'today' ? (
            <TodayTab
              nutrients={todayNutrients}
              radarKeys={radarKeys}
              setRadarKeys={setRadarKeys}
              editingRadar={editingRadar}
              setEditingRadar={setEditingRadar}
              feedback={feedback}
              isLoadingFeedback={isLoadingFeedback}
              onOpenImprove={onOpenImprove}
              selectedDate={selectedDate}
              mealCount={mealCount}
            />
          ) : (
            <WeekTab
              data={weekNutrients}
              weekDayLabels={weekDayLabels}
              weekRange={weekRange}
            />
          )}
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  container: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius['2xl'],
    borderTopRightRadius: radius['2xl'],
    maxHeight: '92%',
    flex: 1,
    ...shadows.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    ...typography.h3,
    flex: 1,
    fontSize: 16,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  tabRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  tabActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accentLight,
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textMuted,
  },
  tabTextActive: {
    color: colors.accent,
  },
});
