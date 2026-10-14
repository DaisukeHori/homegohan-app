/**
 * 記録の保存と AI の分析を一緒にする画面 (健康診断・血液検査の保存) で、サーバーが AI の分析を省いたときの表示 (T15 / #1154)
 *
 * サーバー (/api/health/checkups・/api/health/blood-tests の POST) は、同意が無ければ記録だけを保存し、
 * AI の分析を省いたことを応答の aiSkipped で知らせる。画面は aiSkippedReasonOf(応答) をここへ渡す。
 *   - consent_required: 同意が必要な旨の一文と、同意画面を開くボタン
 *   - check_failed    : 「一時的に行えませんでした」の一文
 *   - daily_limit     : 今日の AI の利用回数の上限 (#1149) に達したので省いた旨と、「明日 0 時から」の一文
 *   - null            : 省いていないのに分析が無い (AI の失敗)。従来どおり「AI分析を実行できませんでした」
 */
import { router } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import {
  AI_CONSENT_CHECK_FAILED_SKIPPED_NOTE,
  AI_CONSENT_SCREEN_PATH,
  AI_CONSENT_SKIPPED_NOTE,
  AI_DAILY_LIMIT_SKIPPED_NOTE,
  type AiSkippedReason,
} from "../../lib/ai-consent";
import { colors, radius, spacing } from "../../theme";
import { Button } from "../ui";

/** AI の分析が無いが、省いた理由も無いとき (AI の失敗) の一文 */
export const AI_REVIEW_FAILED_NOTE = "AI分析を実行できませんでした";

/** 同意画面を開くボタンの文言 */
export const AI_CONSENT_OPEN_BUTTON_LABEL = "同意画面を開く";

export function AiSkippedNotice({ reason }: { reason: AiSkippedReason | null }) {
  const text =
    reason === "consent_required"
      ? AI_CONSENT_SKIPPED_NOTE
      : reason === "check_failed"
        ? AI_CONSENT_CHECK_FAILED_SKIPPED_NOTE
        : reason === "daily_limit"
          ? AI_DAILY_LIMIT_SKIPPED_NOTE
          : AI_REVIEW_FAILED_NOTE;
  return (
    <View style={styles.card} testID="ai-skipped-notice">
      <Text style={styles.text}>{text}</Text>
      {reason === "consent_required" ? (
        <View style={styles.action}>
          <Button
            testID="ai-skipped-open-consent"
            onPress={() => router.push(AI_CONSENT_SCREEN_PATH)}
          >
            {AI_CONSENT_OPEN_BUTTON_LABEL}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    padding: spacing.lg,
  },
  // 文字の大きさは、置き換えた「AI分析を実行できませんでした」(各画面の reviewCardBody) と同じ
  text: {
    fontSize: 13,
    lineHeight: 20,
    color: colors.textMuted,
    textAlign: "center",
  },
  action: {
    marginTop: spacing.md,
  },
});
