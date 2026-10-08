"use client";

// 外国の AI 事業者への提供の同意画面 (T15 / #1154)
//
// AI 機能を初めて使う前に出す。押せるのは「同意する」と「あとで」の 2 つだけ。
//   - 同意する: 同意を記録する (POST /api/ai/consent)。記録できなかったときは画面に出し、もう一度押せる
//   - あとで   : 記録は作らない (拒否の行は作らない)。Esc キーも同じ扱い
// 【AI への送信は止めない】どちらを選んでも、利用者が始めた AI の操作はそのまま進む (オーナーの決定。強制は別タスク T18)。
// このコンポーネントは見た目だけを持つ。いつ出すか・押した結果どうするかは src/hooks/useAiConsent.tsx が決める。
//
// 文面は仮 (弁護士の確認前)。文面と版は src/lib/ai/consent-config.ts にある。

import Link from "next/link";
import { createPortal } from "react-dom";
import { useEffect, useId, useRef, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { BottomSheet } from "@/components/common/BottomSheet";
import { AI_CONSENT_COPY, AI_CONSENT_SETTINGS_PATH } from "@/lib/ai/consent-config";
import { AiConsentDetails, consentColors as colors } from "./AiConsentDetails";

export interface AiDataConsentModalProps {
  isOpen: boolean;
  /** 「同意する」を記録している最中 */
  isSubmitting?: boolean;
  /** 「同意する」の記録に失敗したときに出す文言 */
  errorMessage?: string | null;
  onAccept: () => void;
  /** 「あとで」・Esc キー。AI の操作は止めない */
  onLater: () => void;
  /** 画面が実際に表示されたとき。呼び出し側 (useAiConsent) が「画面が出なかったので待たずに進める」判断に使う */
  onShown?: () => void;
}

export function AiDataConsentModal({
  isOpen,
  isSubmitting = false,
  errorMessage = null,
  onAccept,
  onLater,
  onShown,
}: AiDataConsentModalProps) {
  const titleId = useId();

  // 開いた直後に出るので SSR と食い違うことは無いが、document が無い環境 (SSR) では何も描画しない
  const [canPortal, setCanPortal] = useState(false);
  useEffect(() => {
    setCanPortal(true);
  }, []);
  // 呼び出し側の関数が毎回変わっても、表示の通知は「開いた」ときの 1 回だけにする
  const onShownRef = useRef(onShown);
  onShownRef.current = onShown;
  useEffect(() => {
    if (canPortal && isOpen) onShownRef.current?.();
  }, [canPortal, isOpen]);
  if (!canPortal) return null;

  // transform を持つ祖先の中に置くと position: fixed の基準がずれるため、body 直下に描画する
  return createPortal(
    <BottomSheet
      isOpen={isOpen}
      onClose={onLater}
      ariaLabelledBy={titleId}
      // 背景のクリックでは閉じない (うっかり「あとで」にしないため)。Esc は「あとで」
      closeOnOverlayClick={false}
      // 週間献立のモーダル (z-[201]) や確認ダイアログ (z-[202]) より前に出す
      overlayClassName="z-[400]"
      panelClassName="w-full max-w-md max-h-[90vh] flex flex-col rounded-2xl overflow-hidden"
      panelStyle={{ background: colors.card }}
      testId="ai-consent-modal"
    >
      <div className="flex items-start gap-3 px-5 pt-5 pb-3">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ background: colors.accentLight }}
          aria-hidden="true"
        >
          <ShieldCheck size={20} color={colors.accent} />
        </div>
        <h2 id={titleId} style={{ fontSize: 16, fontWeight: 700, color: colors.text, margin: 0, lineHeight: 1.5 }}>
          {AI_CONSENT_COPY.title}
        </h2>
      </div>

      {/* 長い文面はこの中でスクロールする。キーボードでもスクロールできるよう tabIndex を付ける */}
      <div
        className="flex-1 overflow-y-auto px-5 pb-3"
        tabIndex={0}
        role="region"
        aria-label="提供先・提供する情報・利用目的の説明"
      >
        <AiConsentDetails headingLevel={3} />

        <section style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, color: colors.text, margin: "0 0 6px" }}>
            {AI_CONSENT_COPY.withdrawalHeading}
          </h3>
          <p style={{ fontSize: 13, color: colors.textLight, lineHeight: 1.7, margin: 0 }}>
            {AI_CONSENT_COPY.withdrawal}
            <br />
            <Link
              href={AI_CONSENT_SETTINGS_PATH}
              style={{ color: colors.accent, textDecoration: "underline", fontWeight: 600 }}
              data-testid="ai-consent-settings-link"
            >
              {AI_CONSENT_COPY.settingsLinkLabel}
            </Link>
          </p>
        </section>

        <p
          data-testid="ai-consent-later-note"
          style={{
            fontSize: 12,
            color: colors.textMuted,
            lineHeight: 1.6,
            margin: "16px 0 0",
            background: colors.bg,
            borderRadius: 10,
            padding: "8px 10px",
          }}
        >
          {AI_CONSENT_COPY.laterNote}
        </p>
      </div>

      <div className="px-5 pt-3 pb-5" style={{ borderTop: `1px solid ${colors.border}` }}>
        {errorMessage && (
          <p
            role="alert"
            data-testid="ai-consent-error"
            style={{
              fontSize: 12,
              color: colors.danger,
              background: colors.dangerLight,
              borderRadius: 10,
              padding: "8px 10px",
              margin: "0 0 10px",
              lineHeight: 1.6,
            }}
          >
            {errorMessage}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onLater}
            data-testid="ai-consent-later"
            className="flex-1 py-3 rounded-xl"
            style={{ background: colors.bg, color: colors.textLight, fontSize: 14, fontWeight: 600 }}
          >
            {AI_CONSENT_COPY.laterLabel}
          </button>
          <button
            type="button"
            onClick={onAccept}
            disabled={isSubmitting}
            data-testid="ai-consent-accept"
            className="flex-1 py-3 rounded-xl flex items-center justify-center gap-2 disabled:opacity-70"
            style={{ background: colors.accent, color: "#fff", fontSize: 14, fontWeight: 700 }}
          >
            {isSubmitting ? (
              <>
                <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                記録しています
              </>
            ) : (
              AI_CONSENT_COPY.acceptLabel
            )}
          </button>
        </div>
      </div>
    </BottomSheet>,
    document.body,
  );
}
