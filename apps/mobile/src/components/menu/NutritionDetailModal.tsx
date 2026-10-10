/**
 * NutritionDetailModal — 26 栄養素詳細モーダル (PR 6-2)
 *
 * 機能:
 * - 26 栄養素を category 別 (basic/mineral/vitamin/fat) に section 表示
 * - 各栄養素 DRI バー (DriBar コンポーネント)
 * - Radar chart 上部 + 編集ボタン (RadarChart / RadarKeyPicker)
 * - AI feedback: nutrition_feedback_cache の Realtime 通知 + 2 秒ポーリング (最大 40 秒) (useNutritionFeedbackWatch)
 * - 「献立を改善」ボタン → ImproveMealModal
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
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

import { useNutritionFeedbackWatch } from '../../hooks/useNutritionFeedbackWatch';
import { getApi } from '../../lib/api';
import type { ImproveMealRequest } from '../../lib/improve-meal';
import { colors } from '../../theme/colors';
import { radius, spacing } from '../../theme/spacing';
import { typography } from '../../theme/typography';
import { DriBar } from './DriBar';
import { ImproveMealModal } from './ImproveMealModal';
import { RadarChart } from './RadarChart';
import { RadarKeyPicker } from './RadarKeyPicker';
import { AI_CONSENT_AUTOMATIC_LOCKED_NOTE, isAiConsentRequiredError, promptAiConsentRequired } from '../../lib/ai-consent';

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
  /**
   * 「献立を改善」の確定処理 (献立の生成を始める)。
   * 改善モーダルの内容に、このモーダルで表示中の AI栄養士の提案 (advice) を添えて呼ばれる。
   * 失敗 (reject) したら改善モーダル側でエラーを表示する。成功後にこの画面を閉じるかどうかは親が決める。
   */
  onImprove: (request: ImproveMealRequest) => Promise<void>;
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
  onImprove,
}) => {
  // --- AI feedback state ---
  const [praiseComment, setPraiseComment] = useState<string | null>(null);
  const [adviceText, setAdviceText] = useState<string | null>(null);
  // adviceText が分析の失敗・タイムアウトのメッセージのとき true。
  // これは AI栄養士の提案ではないので、「献立を改善」の要望 (LLM に送る note) には渡さない
  const [adviceIsError, setAdviceIsError] = useState(false);
  const [nutritionTip, setNutritionTip] = useState<string | null>(null);
  const [isLoadingFeedback, setIsLoadingFeedback] = useState(false);

  // 生成待ち (Realtime + ポーリング) の持ち主。閉じる / 日付変更 / アンマウントで必ず解除される
  const feedbackWatch = useNutritionFeedbackWatch();

  // --- ImproveMealModal state ---
  const [showImprove, setShowImprove] = useState(false);

  // ----------------------------------------------------------------
  // fetch helpers
  // ----------------------------------------------------------------

  const fetchFeedback = useCallback(
    async (forceRefresh = false) => {
      if (mealCount === 0) return;
      // 前回の取得の待ち受けを止め、前回の応答を無効にする
      const request = feedbackWatch.startRequest();
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
        // 応答を待つ間にモーダルが閉じられた / 日付が変わった / 別の取得が始まった場合は何もしない
        if (!request.isCurrent()) return;
        if (res.cached && (res.feedback || res.praiseComment)) {
          setPraiseComment(res.praiseComment ?? null);
          setAdviceText(res.advice ?? res.feedback ?? null);
          setAdviceIsError(false);
          setNutritionTip(res.nutritionTip ?? null);
          setIsLoadingFeedback(false);
          return;
        }
        if (res.status === 'generating' && res.cacheId) {
          // nutrition_feedback_cache の行 (cacheId) が completed / error になるのを待つ
          request.watch(res.cacheId, {
            onResolved: (content) => {
              setPraiseComment(content.praiseComment);
              setAdviceText(content.advice || null);
              setAdviceIsError(false);
              setNutritionTip(content.nutritionTip);
              setIsLoadingFeedback(false);
            },
            onFailed: (message) => {
              // 失敗 / タイムアウト。メッセージを出し、再分析ボタンで再試行できるようにする
              setPraiseComment(null);
              setAdviceText(message);
              setAdviceIsError(true);
              setNutritionTip(null);
              setIsLoadingFeedback(false);
            },
          });
        } else {
          setIsLoadingFeedback(false);
        }
      } catch (e) {
        if (!request.isCurrent()) return;
        // 同意が無いため AI に送らなかった (403 AI_CONSENT_REQUIRED。T15 / #1154)。開くと自動で頼む処理なので、
        // 同意の案内は出さず、案内の一文だけを出す
        if (isAiConsentRequiredError(e)) {
          setAdviceText(AI_CONSENT_AUTOMATIC_LOCKED_NOTE);
          setAdviceIsError(false);
        }
        setIsLoadingFeedback(false);
      }
    },
    [date, totals, mealCount, weekDays, feedbackWatch]
  );

  // ----------------------------------------------------------------
  // effect: open / close
  // ----------------------------------------------------------------

  useEffect(() => {
    if (!visible) return;

    // reset
    setPraiseComment(null);
    setAdviceText(null);
    setAdviceIsError(false);
    setNutritionTip(null);
    setIsLoadingFeedback(false);

    fetchFeedback();

    // 閉じる / 日付変更 / アンマウントで、待ち受け (購読とポーリング) を必ず解除する
    return () => {
      feedbackWatch.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, date]);

  // ----------------------------------------------------------------
  // render
  // ----------------------------------------------------------------

  return (
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

          {/*
            献立改善モーダル。
            iOS は表示中のモーダルの上に、兄弟のモーダルを重ねて出せない。
            この栄養分析モーダルの内側に置くことで、栄養分析の上に重ねて表示できるようにする。
          */}
          <ImproveMealModal
            visible={showImprove}
            onClose={() => setShowImprove(false)}
            selectedDate={date}
            advice={adviceIsError ? null : adviceText}
            onSubmit={onImprove}
            // 改善が「同意が必要です」で止められた (T15 / #1154。改善モーダルは自分を閉じてから呼ぶ): この栄養分析の詳細も
            // 閉じてから案内を出す (閉じないと、案内から開いた同意画面がこのモーダルの下に隠れる)
            onAiConsentRequired={() => {
              onClose();
              promptAiConsentRequired();
            }}
          />
        </View>
      </SafeAreaView>
    </Modal>
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
