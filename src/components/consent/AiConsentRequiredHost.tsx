"use client";

// 外国の AI 事業者への提供の同意: サーバーに「同意が必要です」で止められたときに、同意画面を出す (T15 / #1154)
//
// (main) の全画面に 1 つだけ置く (src/app/(main)/MainLayout.tsx)。
// 利用者が始めた AI の操作の fetch (aiFetch) が 403 AI_CONSENT_REQUIRED を受けると、window に AI_CONSENT_REQUIRED_EVENT が出る。
// ここはそれを聞いて、同意画面 (「この機能を使うには、次の内容への同意が必要です。」) を出す。
//   - 同意する  : 同意を記録する。画面の操作はやり直してもらう (止められた操作を自動では送り直さない。
//                 何を送るかを利用者が見直せるように、また二重に送らないように)
//   - 同意しない: 閉じる。AI の操作は止まったまま
// 同意を記録したら、やり直してもらうための一言を画面の下に少しの間だけ出す。

import { useEffect, useState } from "react";
import { useAiConsent } from "@/hooks/useAiConsent";
import { AI_CONSENT_REQUIRED_EVENT } from "@/lib/ai/consent-required";
import { consentColors as colors } from "./AiConsentDetails";

/** 同意を記録したあとに出す一言を、表示しておく時間 (ミリ秒)。読み切れる長さとして 5 秒 */
const RETRY_NOTICE_MS = 5_000;

export function AiConsentRequiredHost() {
  // 使われるまで状況を取りにいかない (全画面に常駐するため)
  const { promptAiConsent, consentModal } = useAiConsent({ prefetch: false });
  const [showRetryNotice, setShowRetryNotice] = useState(false);

  useEffect(() => {
    const onRequired = () => {
      void promptAiConsent().then((outcome) => {
        if (outcome === "consented") setShowRetryNotice(true);
      });
    };
    window.addEventListener(AI_CONSENT_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(AI_CONSENT_REQUIRED_EVENT, onRequired);
  }, [promptAiConsent]);

  useEffect(() => {
    if (!showRetryNotice) return;
    const timer = setTimeout(() => setShowRetryNotice(false), RETRY_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [showRetryNotice]);

  return (
    <>
      {consentModal}
      {showRetryNotice && (
        <div
          role="status"
          data-testid="ai-consent-retry-notice"
          className="fixed left-0 right-0 bottom-24 z-[401] flex justify-center px-4"
        >
          <p
            style={{
              background: colors.text,
              color: "#fff",
              fontSize: 13,
              lineHeight: 1.6,
              borderRadius: 12,
              padding: "10px 14px",
              margin: 0,
              maxWidth: 420,
            }}
          >
            同意を記録しました。もう一度、操作をやり直してください。
          </p>
        </div>
      )}
    </>
  );
}
