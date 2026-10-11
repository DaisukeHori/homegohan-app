"use client";

// AI の 1 日の利用回数の上限 (#1149 / T40): サーバーに「今日の上限に達しました」で止められたときに、固定の文を出す
//
// (main) の全画面に 1 つだけ置く (src/app/(main)/MainLayout.tsx。同意の AiConsentRequiredHost と同じ置き方)。
// 利用者が始めた AI の操作の fetch (aiFetch) が 429 AI_DAILY_LIMIT を受けると、window に AI_DAILY_LIMIT_EVENT が出る。
// ここはそれを聞いて、「今日の AI の利用回数の上限 (10 回) に達しました。明日 0 時から使えます。」を画面の下に出す
// (文は src/lib/ai/daily-limit-client.ts が応答の limit から作る。本文の文をそのまま出さない)。
// 少しの間で消える。「閉じる」でもすぐ消せる。

import { useEffect, useState } from "react";
import { AI_DAILY_LIMIT_EVENT } from "@/lib/ai/daily-limit-client";
import { consentColors as colors } from "./AiConsentDetails";

/** 案内を出しておく時間 (ミリ秒)。読み切れる長さとして 8 秒 */
const NOTICE_MS = 8_000;

export function AiDailyLimitHost() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const onLimit = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (typeof detail === "string" && detail) setMessage(detail);
    };
    window.addEventListener(AI_DAILY_LIMIT_EVENT, onLimit);
    return () => window.removeEventListener(AI_DAILY_LIMIT_EVENT, onLimit);
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [message]);

  if (!message) return null;
  return (
    <div role="alert" data-testid="ai-daily-limit-notice" className="fixed left-0 right-0 bottom-24 z-[401] flex justify-center px-4">
      <div
        style={{
          background: colors.text,
          color: "#fff",
          fontSize: 13,
          lineHeight: 1.6,
          borderRadius: 12,
          padding: "10px 14px",
          maxWidth: 420,
          display: "flex",
          gap: 12,
          alignItems: "flex-start",
        }}
      >
        <p style={{ margin: 0 }}>{message}</p>
        <button
          type="button"
          onClick={() => setMessage(null)}
          style={{ color: "#fff", fontSize: 12, textDecoration: "underline", whiteSpace: "nowrap", background: "none", border: 0 }}
        >
          閉じる
        </button>
      </div>
    </div>
  );
}
