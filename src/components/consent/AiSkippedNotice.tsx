"use client";

// 外国の AI 事業者への提供の同意: サーバーが AI の部分を省いたときの表示 (T15 / #1154)
//
// 記録の保存・集計と AI の分析を一緒にする API (健康診断の保存、ホームの栄養の集計など) は、同意が無ければ
// 保存・集計だけをして、AI の部分を省いたことを応答の aiSkipped で知らせる (supabase/functions/_shared/ai-consent.ts の
// aiConsentSkippedField)。画面は aiSkippedReasonOf(応答) をここへ渡す。
//   - consent_required: 同意が必要な旨の一文と、同意の確認ページ (/settings/ai-consent) へのリンク
//   - check_failed    : 「一時的に行えませんでした」の一文
// 文面は 2 種類: 保存の画面 (variant="saved") と、画面を開くと自動で作る AI のコメント (variant="automatic")。

import type { CSSProperties } from "react";
import Link from "next/link";
import {
  AI_CONSENT_AUTOMATIC_LOCKED_NOTE,
  AI_CONSENT_CHECK_FAILED_MESSAGE,
  AI_CONSENT_CHECK_FAILED_SKIPPED_NOTE,
  AI_CONSENT_SETTINGS_PATH,
  AI_CONSENT_SKIPPED_NOTE,
  type AiSkippedReason,
} from "@/lib/ai/consent-config";

/** 同意の確認ページへのリンクの文言 */
export const AI_CONSENT_OPEN_LINK_LABEL = "同意の内容を確認する";

export function aiSkippedNoteText(reason: AiSkippedReason, variant: "saved" | "automatic"): string {
  if (reason === "consent_required") {
    return variant === "saved" ? AI_CONSENT_SKIPPED_NOTE : AI_CONSENT_AUTOMATIC_LOCKED_NOTE;
  }
  return variant === "saved" ? AI_CONSENT_CHECK_FAILED_SKIPPED_NOTE : AI_CONSENT_CHECK_FAILED_MESSAGE;
}

export function AiSkippedNotice({
  reason,
  variant,
  className,
  style,
}: {
  reason: AiSkippedReason;
  variant: "saved" | "automatic";
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div role="status" data-testid="ai-skipped-notice" className={className} style={style}>
      <p className="text-sm">{aiSkippedNoteText(reason, variant)}</p>
      {reason === "consent_required" && (
        <Link
          href={AI_CONSENT_SETTINGS_PATH}
          data-testid="ai-skipped-open-consent"
          className="mt-2 inline-block text-sm font-bold underline"
        >
          {AI_CONSENT_OPEN_LINK_LABEL}
        </Link>
      )}
    </div>
  );
}
