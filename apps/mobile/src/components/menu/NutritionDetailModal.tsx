/**
 * NutritionDetailModal — 26 栄養素詳細モーダル (PR 6-2)
 *
 * 機能:
 * - 26 栄養素を category 別 (basic/mineral/vitamin/fat) に section 表示
 * - 各栄養素 DRI バー (DriBar コンポーネント)
 * - Radar chart 上部 + 編集ボタン (RadarChart / RadarKeyPicker)
 * - AI feedback Realtime + 2 秒ポーリング (最大 40 秒)
 * - 「献立を改善」ボタン → ImproveMealModal
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  CATEGORY_LABELS,
  NUTRIENT_BY_CATEGORY,
} from '@homegohan/shared';

import { getApi } from '../../lib/api';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../providers/AuthProvider';
import { colors } from '../../theme/colors';
import { radius, spacing } from '../../theme/spacing';
import { typography } from '../../theme/typography';
import { DriBar } from './DriBar';
import { ImproveMealModal } from './ImproveMealModal';
import { RadarChart } from './RadarChart';
import { RadarKeyPicker } from './RadarKeyPicker';

// ============================================================
// Types
// ============================================================

/** 26 栄養素の集計値マップ (nutrientKey → 数値) */
export type NutritionTotals = Record<string, number>;

interface Props {
  visible: boolean;
  onClose: () => void;
  /** 表示日 (YYYY-MM-DD) */
  date: string;
  /** 画面上部に表示する日付ラベル (例: "5/4") */
  dateLabel: string;
  /** 集計済み 26 栄養素の値 */
  totals: NutritionTotals;
  /** 食事数 (フィードバック API に渡す) */
  mealCount: number;
  /** レーダーチャートに表示する栄養素キー */
  radarKeys: string[];
  /** radarKeys が変更されたときに呼ばれる */
  onRadarKeysSaved: (keys: string[]) => void;
  /** weekDays (フィードバック API に渡す) */
  weekDays?: Array<{ date: string; meals: Array<{ title: string; calories: number | null }> }>;
}

// ============================================================
// Category section order
// ============================================================

const CATEGORY_ORDER = ['basic', 'mineral', 'vitamin', 'fat'] as const;

// ============================================================
// NutritionDetailModal
// ============================================================

export const NutritionDetailModal: React.FC<Props> = ({
  visible,
  onClose,
  date,
  dateLabel,
  totals,
  mealCount,
  radarKeys,
  onRadarKeysSaved,
  weekDays = [],
}) => {
  const { user } = useAuth();

  // --- AI feedback state ---
  const [praiseComment, setPraiseComment] = useState<string | null>(null);
  const [adviceText, setAdviceText] = useState<string | null>(null);
  const [nutritionTip, setNutritionTip] = useState<string | null>(null);
  const [isLoadingFeedback, setIsLoadingFeedback] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const realtimeCleanupRef = useRef<(() => void) | null>(null);

  // --- ImproveMealModal state ---
  const [showImprove, setShowImprove] = useState(false);

  // ----------------------------------------------------------------
  // fetch / polling helpers
  // ----------------------------------------------------------------

  const clearPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const clearRealtime = useCallback(() => {
    if (realtimeCleanupRef.current) {
      realtimeCleanupRef.current();
      realtimeCleanupRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (cacheId: string) => {
      let resolved = false;
      let count = 0;
      pollRef.current = setInterval(async () => {
        if (resolved || count >= 20) {
          clearPolling();
          setIsLoadingFeedback(false);
          return;
        }
        count++;
        try {
          const api = getApi();
          const res = await api.get<any>(
            `/api/ai/nutrition/feedback?cacheId=${cacheId}`
          );
          if (res.status === 'completed' && (res.feedback || res.praiseComment)) {
            resolved = true;
            setPraiseComment(res.praiseComment ?? null);
            setAdviceText(res.advice ?? res.feedback ?? null);
            setNutritionTip(res.nutritionTip ?? null);
            setIsLoadingFeedback(false);
            clearPolling();
          }
        } catch {
          // ignore
        }
      }, 2000);
    },
    [clearPolling]
  );

  const fetchFeedback = useCallback(
    async (forceRefresh = false) => {
      if (mealCount === 0) return;
      setIsLoadingFeedback(true);
      try {
        const api = getApi();
        const res = await api.post<any>('/api/ai/nutrition/feedback', {
          date,
          nutrition: totals,
          mealCount,
          forceRefresh,
          weekData: weekDays,
        });
        if (res.cached && (res.feedback || res.praiseComment)) {
          setPraiseComment(res.praiseComment ?? null);
          setAdviceText(res.advice ?? res.feedback ?? null);
          setNutritionTip(res.nutritionTip ?? null);
          setIsLoadingFeedback(false);
          return;
        }
        if (res.status === 'generating' && res.cacheId) {
          startPolling(res.cacheId);
        } else {
          setIsLoadingFeedback(false);
        }
      } catch {
        setIsLoadingFeedback(false);
      }
    },
    [date, totals, mealCount, weekDays, startPolling]
  );

  // ----------------------------------------------------------------
  // effect: open / close
  // ----------------------------------------------------------------

  useEffect(() => {
    if (!visible) {
      clearPolling();
      clearRealtime();
      return;
    }

    // reset
    setPraiseComment(null);
    setAdviceText(null);
    setNutritionTip(null);
    clearPolling();
    clearRealtime();

    // Realtime subscription for ai_nutrition_feedback INSERT
    if (user?.id) {
      const channel = supabase
        .channel(`nutrition-detail-${user.id}-${date}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'ai_nutrition_feedback',
            filter: `user_id=eq.${user.id}`,
          },
          (payload: any) => {
            if (payload.new?.summary) {
              setPraiseComment(payload.new.summary);
              setIsLoadingFeedback(false);
              clearPolling();
            }
          }
        )
        .subscribe();

      realtimeCleanupRef.current = () => {
        supabase.removeChannel(channel);
      };
    }

    fetchFeedback();

    return () => {
      clearPolling();
      clearRealtime();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, date]);

  // ----------------------------------------------------------------
  // render
  // ----------------------------------------------------------------

  return (
    <>
      <Modal
        testID="nutrition-detail-modal"
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={onClose}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
          <View style={{ flex: 1 }}>
            {/* Header */}
            <View style={styles.header}>
              <View style={styles.headerLeft}>
                <Ionicons name="bar-chart" size={18} color={colors.accent} />
                <Text style={styles.headerTitle}>
                  {dateLabel} の栄養分析
                </Text>
              </View>
              <Pressable
                testID="nutrition-detail-close"
                onPress={onClose}
                hitSlop={8}
                style={styles.closeBtn}
              >
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </Pressable>
            </View>

            <ScrollView
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
            >
              {/* Radar Chart */}
              <View style={styles.radarSection}>
                <View style={styles.radarChart}>
                  <RadarChart totals={totals} nutrientKeys={radarKeys} size={220} />
                </View>
                <View style={styles.radarPickerWrapper}>
                  <RadarKeyPicker
                    selectedKeys={radarKeys}
                    onSaved={onRadarKeysSaved}
                  />
                </View>
              </View>

              {/* AI Feedback */}
              <View testID="nutrition-detail-ai-feedback" style={styles.feedbackSection}>
                {/* 褒めポイント */}
                <View style={styles.praiseCard}>
                  <View style={styles.cardHeader}>
                    <Ionicons name="heart" size={14} color={colors.success} />
                    <Text style={styles.praiseTitle}>褒めポイント</Text>
                    {(praiseComment || adviceText) && !isLoadingFeedback && (
                      <Pressable
                        onPress={() => fetchFeedback(true)}
                        style={styles.reanalyzeBtn}
                      >
                        <Text style={styles.reanalyzeBtnText}>再分析</Text>
                      </Pressable>
                    )}
                  </View>
                  {isLoadingFeedback ? (
                    <View style={styles.loadingRow}>
                      <ActivityIndicator size="small" color={colors.success} />
                      <Text style={styles.loadingText}>
                        あなたの献立を分析中...
                      </Text>
                    </View>
                  ) : praiseComment ? (
                    <Text style={styles.praiseText}>{praiseComment}</Text>
                  ) : (
                    <Text style={styles.emptyText}>分析データがありません</Text>
                  )}
                </View>

                {/* 改善アドバイス */}
                {(adviceText || isLoadingFeedback) && (
                  <View style={styles.adviceCard}>
                    <View style={styles.cardHeader}>
                      <Ionicons name="sparkles" size={14} color={colors.accent} />
                      <Text style={styles.adviceTitle}>改善アドバイス</Text>
                    </View>
                    {isLoadingFeedback ? (
                      <Text style={styles.emptyText}>...</Text>
                    ) : (
                      <Text style={styles.adviceText}>{adviceText}</Text>
                    )}
                  </View>
                )}

                {/* 栄養豆知識 */}
                {nutritionTip && (
                  <View style={styles.tipCard}>
                    <Text style={styles.tipIcon}>💡</Text>
                    <Text style={styles.tipText}>{nutritionTip}</Text>
                  </View>
                )}
              </View>

              {/* 献立を改善ボタン */}
              {mealCount > 0 && (
                <Pressable
                  testID="nutrition-detail-improve-btn"
                  onPress={() => setShowImprove(true)}
                  style={({ pressed }) => [
                    styles.improveBtn,
                    pressed && styles.improveBtnPressed,
                  ]}
                >
                  <Ionicons name="refresh" size={16} color="#FFF" />
                  <Text style={styles.improveBtnText}>献立を改善</Text>
                </Pressable>
              )}

              {/* 全 26 栄養素 DRI バー */}
              {CATEGORY_ORDER.map((cat) => {
                const defs = NUTRIENT_BY_CATEGORY[cat];
                return (
                  <View
                    key={cat}
                    testID={`nutrition-detail-section-${cat}`}
                    style={styles.categorySection}
                  >
                    <Text style={styles.categoryLabel}>
                      {CATEGORY_LABELS[cat]}（{defs.length}）
                    </Text>
                    <View style={styles.barList}>
                      {defs.map((def) => (
                        <DriBar
                          key={def.key}
                          def={def}
                          value={totals[def.key] ?? 0}
                        />
                      ))}
                    </View>
                  </View>
                );
              })}

              <View style={styles.bottomPad} />
            </ScrollView>
          </View>
        </SafeAreaView>
      </Modal>

      {/* 献立改善モーダル */}
      <ImproveMealModal
        visible={showImprove}
        onClose={() => setShowImprove(false)}
        selectedDate={date}
      />
    </>
  );
};

// ============================================================
// Styles
// ============================================================

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scrollContent: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  // --- Radar ---
  radarSection: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  radarChart: {
    alignItems: 'center',
  },
  radarPickerWrapper: {
    width: '100%',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  // --- AI Feedback ---
  feedbackSection: {
    gap: spacing.md,
  },
  praiseCard: {
    backgroundColor: colors.successLight,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  praiseTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.success,
    flex: 1,
  },
  reanalyzeBtn: {
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
  },
  reanalyzeBtnText: {
    fontSize: 10,
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
  praiseText: {
    fontSize: 13,
    color: colors.text,
    lineHeight: 20,
  },
  emptyText: {
    fontSize: 11,
    color: colors.textMuted,
  },
  adviceCard: {
    backgroundColor: colors.accentLight,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  adviceTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent,
  },
  adviceText: {
    fontSize: 12,
    color: colors.text,
    lineHeight: 18,
  },
  tipCard: {
    backgroundColor: colors.blueLight,
    borderRadius: radius.md,
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  tipIcon: {
    fontSize: 12,
  },
  tipText: {
    flex: 1,
    fontSize: 11,
    color: colors.blue,
    lineHeight: 17,
  },
  // --- Improve button ---
  improveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
  },
  improveBtnPressed: {
    opacity: 0.85,
  },
  improveBtnText: {
    ...typography.label,
    color: '#FFF',
  },
  // --- Category sections ---
  categorySection: {
    gap: spacing.sm,
  },
  categoryLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  barList: {
    gap: spacing.sm,
  },
  // --- Bottom padding ---
  bottomPad: {
    height: spacing.xl,
  },
});
