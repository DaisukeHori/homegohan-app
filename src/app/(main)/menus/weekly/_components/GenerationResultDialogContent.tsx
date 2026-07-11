"use client";

import { AlertTriangle, Info, Check } from "lucide-react";
import type { UiFlagMessage } from "../_state/reducers/uiFlagReducer";
// #1050 レビュー残ポリッシュ (Opus 再レビュー Warning): 独自の colors 定義が weekly
// page.tsx の正本と乖離していた（success/successLight/border が別値）ため、
// 唯一の正本 ./colors.ts から import する形に統一（成功モーダルの見た目回帰を是正）。
import { colors } from "./colors";

export interface GenerationResultDialogContentProps {
  message: UiFlagMessage;
  /** onRetry が無い場合の単一 OK ボタン、または retry 側の「閉じる」ボタンで呼ばれる */
  onDismiss: () => void;
}

/**
 * 完了/エラー通知モーダルの中身（アイコン・タイトル・本文・ボタン）。
 *
 * #1050 round-2 (UX2-02 残課題): 単品再生成・単品AI生成・写真解析・AI画像生成・献立改善の
 * 計11箇所で AI 生成失敗が alert() 頼みでリトライ導線が無かった問題への対応として、
 * `UiFlagMessage.onRetry` を追加し、指定時は「もう一度試す」+「閉じる」の2ボタンを
 * 表示するようにした。この分岐ロジックをテスト容易性のため独立コンポーネント化している
 * （page.tsx 本体は supabase client 等の重い依存を大量に import するため、
 * ボタン分岐だけを切り出して実レンダリングで検証する）。
 */
export function GenerationResultDialogContent({ message, onDismiss }: GenerationResultDialogContentProps) {
  return (
    <div
      className="w-full max-w-xs rounded-2xl p-6 text-center"
      style={{ background: colors.card }}
    >
      {/* UX2-01: エラー通知が緑チェックの成功モーダルと同じ見た目で出ていた問題の是正。
          type: 'error' は AlertTriangle + 赤系、'info' は Info + ニュートラル系、
          未指定（既定 'success'）は従来どおり Check + 緑系。 */}
      <div
        data-testid="success-message-icon"
        className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
        style={{
          background: message.type === 'error'
            ? colors.dangerLight
            : message.type === 'info'
              ? colors.bg
              : colors.successLight,
        }}
      >
        {message.type === 'error' ? (
          <AlertTriangle size={32} color={colors.danger} />
        ) : message.type === 'info' ? (
          <Info size={32} color={colors.textLight} />
        ) : (
          <Check size={32} color={colors.success} />
        )}
      </div>
      <h3 data-testid="success-message-title" style={{ fontSize: 18, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
        {message.title}
      </h3>
      <p data-testid="success-message-body" style={{ fontSize: 14, color: colors.textLight, marginBottom: 20 }}>
        {message.message}
      </p>
      {message.onRetry ? (
        <div className="flex gap-2">
          <button
            data-testid="success-message-retry-button"
            onClick={() => {
              const retry = message.onRetry;
              onDismiss();
              retry?.();
            }}
            className="flex-1 p-3 rounded-xl font-semibold"
            style={{ background: colors.accent, color: '#fff' }}
          >
            {message.retryLabel || 'もう一度試す'}
          </button>
          <button
            data-testid="success-message-close-button"
            onClick={onDismiss}
            className="flex-1 p-3 rounded-xl font-semibold"
            style={{ background: colors.border, color: colors.text }}
          >
            閉じる
          </button>
        </div>
      ) : (
        <button
          data-testid="success-message-ok-button"
          onClick={onDismiss}
          className="w-full p-3 rounded-xl font-semibold"
          style={{ background: colors.accent, color: '#fff' }}
        >
          OK
        </button>
      )}
    </div>
  );
}
