"use client";

// src/app/(main)/settings/ai-consent/page.tsx
// 外国の AI 事業者への提供の同意: 状況の確認と撤回 (T15 / #1154)
//
// 設定のトップ (settings/page.tsx) からのリンクは、モバイルの設定画面の変更 (PR #1079) が片付いてから足す。
// それまでは、同意画面 (AiDataConsentModal) のリンクと、この URL (/settings/ai-consent) から開く。
//
// 【未同意なら AI へ送らない】同意していない間 (撤回後・文面の版が上がったあとを含む) は、AI 機能を使えない
// (サーバーが送る手前で 403 AI_CONSENT_REQUIRED で止める)。AI の API に止められた画面からは、同意画面か、このページへ案内する。
// 文面は仮 (src/lib/ai/consent-config.ts)。

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import { ConfirmDeleteModal } from "@/components/common/ConfirmDeleteModal";
import { AiConsentDetails, consentColors as colors } from "@/components/consent/AiConsentDetails";
import { forgetAiConsentStatus } from "@/hooks/useAiConsent";
import { fetchAiConsentStatus, postAiConsentGrant, postAiConsentRevoke } from "@/lib/ai/consent-client";
import {
  AI_CONSENT_COPY,
  AI_CONSENT_PROVIDER_INFO,
  type AiConsentProviderState,
  type AiConsentStatus,
} from "@/lib/ai/consent-config";

const STATE_LABEL: Record<AiConsentProviderState, string> = {
  granted: "同意済み",
  outdated: "再確認が必要",
  none: "未同意",
};

function formatDateTime(value: string | null): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(time));
}

/** 画面の見出しに出す、全体の状況 */
function describeOverall(status: AiConsentStatus): { label: string; tone: "ok" | "warn" | "none"; detail: string | null } {
  if (status.consented) {
    const at = formatDateTime(status.consentedAt);
    return { label: "同意済みです", tone: "ok", detail: at ? `${at} に同意しました` : null };
  }
  if (status.providers.some((p) => p.state === "outdated")) {
    return {
      label: "もう一度ご確認ください",
      tone: "warn",
      detail: "同意の文面が更新されました。あらためて内容をご確認のうえ同意するまで、AI 機能はお使いいただけません。",
    };
  }
  const revokedAt = formatDateTime(status.revokedAt);
  const unavailable = "同意するまで、AI 機能はお使いいただけません。";
  return {
    label: "まだ同意していません",
    tone: "none",
    detail: revokedAt ? `${revokedAt} に同意を撤回しました。${unavailable}` : unavailable,
  };
}

export default function AiConsentSettingsPage() {
  const [status, setStatus] = useState<AiConsentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<"grant" | "revoke" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    const next = await fetchAiConsentStatus();
    if (next) setStatus(next);
    else setLoadFailed(true);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleGrant = async () => {
    setBusy("grant");
    setActionError(null);
    setNotice(null);
    const result = await postAiConsentGrant();
    if (result.ok) {
      setStatus(result.data);
      setNotice("同意を記録しました。");
      forgetAiConsentStatus();
    } else {
      setActionError(result.message);
    }
    setBusy(null);
  };

  const handleRevoke = async () => {
    setBusy("revoke");
    setActionError(null);
    setNotice(null);
    const result = await postAiConsentRevoke();
    setShowRevokeConfirm(false);
    if (result.ok) {
      setStatus(result.data);
      setNotice("同意を撤回しました。");
      forgetAiConsentStatus();
    } else {
      setActionError(result.message);
    }
    setBusy(null);
  };

  const hasActiveConsent = status ? status.providers.some((p) => p.state !== "none") : false;
  const overall = status ? describeOverall(status) : null;

  return (
    <div className="min-h-screen" style={{ background: colors.bg }}>
      <div className="sticky top-0 bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 z-10">
        <Link href="/settings" className="p-1.5 rounded-full hover:bg-gray-100" aria-label="設定に戻る">
          <ChevronLeft size={20} color={colors.text} />
        </Link>
        <h1 className="text-lg font-semibold" style={{ color: colors.text }}>
          {AI_CONSENT_COPY.settingsTitle}
        </h1>
      </div>

      <div className="px-4 py-6 space-y-4 max-w-2xl mx-auto">
        {loading && !status ? (
          <div className="flex items-center justify-center py-16" role="status" aria-label="読み込み中">
            <Loader2 size={24} className="animate-spin" color={colors.accent} />
          </div>
        ) : loadFailed && !status ? (
          <section className="bg-white rounded-2xl shadow-sm px-4 py-6 text-center" data-testid="ai-consent-load-failed">
            <p style={{ fontSize: 14, color: colors.textLight, margin: 0 }}>
              同意の状況を読み込めませんでした。通信状況を確認して、もう一度お試しください。
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-4 px-5 py-2.5 rounded-xl"
              style={{ background: colors.accent, color: "#fff", fontSize: 14, fontWeight: 600 }}
            >
              再読み込み
            </button>
          </section>
        ) : status && overall ? (
          <>
            <section className="bg-white rounded-2xl shadow-sm px-4 py-4" aria-live="polite" data-testid="ai-consent-status">
              <div className="flex items-start gap-3">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ background: overall.tone === "ok" ? colors.successLight : colors.accentLight }}
                  aria-hidden="true"
                >
                  {overall.tone === "ok" ? (
                    <ShieldCheck size={20} color={colors.success} />
                  ) : (
                    <ShieldOff size={20} color={colors.accent} />
                  )}
                </div>
                <div>
                  <p data-testid="ai-consent-overall" style={{ fontSize: 15, fontWeight: 700, color: colors.text, margin: 0 }}>
                    {overall.label}
                  </p>
                  {overall.detail && (
                    <p style={{ fontSize: 12, color: colors.textMuted, margin: "2px 0 0", lineHeight: 1.6 }}>
                      {overall.detail}
                    </p>
                  )}
                </div>
              </div>

              <ul className="mt-4" style={{ listStyle: "none", margin: "16px 0 0", padding: 0, display: "grid", gap: 6 }}>
                {status.providers.map((provider) => {
                  const info = AI_CONSENT_PROVIDER_INFO[provider.provider];
                  return (
                    <li
                      key={provider.provider}
                      data-testid={`ai-consent-status-${provider.provider}`}
                      className="flex items-center justify-between"
                      style={{ fontSize: 13, color: colors.textLight }}
                    >
                      <span>
                        {info.name}
                        <span style={{ fontSize: 12, color: colors.textMuted }}>（{info.country}）</span>
                      </span>
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: provider.state === "granted" ? colors.success : colors.textMuted,
                        }}
                      >
                        {STATE_LABEL[provider.state]}
                      </span>
                    </li>
                  );
                })}
              </ul>

              {notice && (
                <p role="status" data-testid="ai-consent-notice" style={{ fontSize: 12, color: colors.success, margin: "12px 0 0" }}>
                  {notice}
                </p>
              )}
              {actionError && (
                <p
                  role="alert"
                  data-testid="ai-consent-action-error"
                  style={{
                    fontSize: 12,
                    color: colors.danger,
                    background: colors.dangerLight,
                    borderRadius: 10,
                    padding: "8px 10px",
                    margin: "12px 0 0",
                    lineHeight: 1.6,
                  }}
                >
                  {actionError}
                </p>
              )}

              <div className="flex flex-col gap-2 mt-4">
                {!status.consented && (
                  <button
                    type="button"
                    onClick={() => void handleGrant()}
                    disabled={busy !== null}
                    data-testid="ai-consent-grant"
                    className="w-full py-3 rounded-xl flex items-center justify-center gap-2 disabled:opacity-70"
                    style={{ background: colors.accent, color: "#fff", fontSize: 14, fontWeight: 700 }}
                  >
                    {busy === "grant" && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                    {AI_CONSENT_COPY.acceptLabel}
                  </button>
                )}
                {hasActiveConsent && (
                  <button
                    type="button"
                    onClick={() => {
                      setActionError(null);
                      setNotice(null);
                      setShowRevokeConfirm(true);
                    }}
                    disabled={busy !== null}
                    data-testid="ai-consent-revoke"
                    className="w-full py-3 rounded-xl disabled:opacity-70"
                    style={{
                      background: colors.card,
                      color: colors.danger,
                      border: `1px solid ${colors.danger}`,
                      fontSize: 14,
                      fontWeight: 600,
                    }}
                  >
                    同意を撤回する
                  </button>
                )}
              </div>
            </section>

            <section className="bg-white rounded-2xl shadow-sm px-4 py-4">
              <AiConsentDetails headingLevel={2} />
              <p style={{ fontSize: 12, color: colors.textMuted, lineHeight: 1.6, margin: "16px 0 0" }}>
                {AI_CONSENT_COPY.revokeNote}
              </p>
            </section>
          </>
        ) : null}
      </div>

      {showRevokeConfirm && (
        <ConfirmDeleteModal
          title="同意を撤回しますか？"
          message={AI_CONSENT_COPY.revokeNote}
          isDeleting={busy === "revoke"}
          tone="danger"
          icon={ShieldOff}
          confirmLabel="撤回する"
          onCancel={() => setShowRevokeConfirm(false)}
          onConfirm={() => void handleRevoke()}
        />
      )}
    </div>
  );
}
