"use client";

/**
 * 凍結 (BAN) 中の利用者の「有料プランの解約・お支払い」の画面 (billing/01 §10.5・§9.8)
 *
 * 凍結は契約も Stripe の課金も止めないので、凍結中も有料プランの解約の予約と Billing Portal (カード・請求書) を使えるようにする。
 * 凍結の画面 (/frozen) からここへ来る。middleware (lib/supabase/middleware.ts) は /frozen 以下を凍結の差し戻しの対象外にしているので、
 * 凍結中でもこの画面は開ける。この画面が呼ぶ API は、凍結中でも止めない API (src/lib/auth/frozen.ts の FROZEN_ALLOWED_API_PATHS) の
 * うち課金の 3 本 (契約の要約・解約の予約・Billing Portal) だけ。解約の取り消しと購入は凍結中はできないので、そのボタンもリンクも置かない。
 * アプリの WebView では状態の文だけを出す (ボタンは描かない。§10.4)。
 * App Store / Google Play の契約 (manage_in_store が null でない) は解約のボタンを描かず、ストアの定期購読の管理から解約できることを
 * 文で出す (管理のページへのリンクはアプリの WebView でなければ出す。billing/03 §10.4)。
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IAP_STORE_LABELS, STORE_SUBSCRIPTION_MANAGEMENT_URL } from "@homegohan/shared";
import { isInNativeWebView } from "@/lib/native-auth-bridge";
import { BILLING_CANCEL_API_PATH, BILLING_PORTAL_API_PATH, BILLING_SUBSCRIPTION_API_PATH } from "@/lib/auth/frozen";
import {
  BILLING_ERROR_MESSAGES,
  billingStatusLines,
  formatBillingDate,
  type BillingErrorCode,
  type BillingSummary,
} from "@/lib/billing/core";

const LOGIN_PATH = "/login";
const HTTP_UNAUTHORIZED = 401;

const LOAD_FAILED_TEXT = "契約の状態を読み込めませんでした。時間をおいて再度お試しください。";
const UNKNOWN_ERROR_TEXT = "処理中にエラーが発生しました。時間をおいて再度お試しください。";
const NO_CONTRACT_TEXT = "有料プランの契約はありません。";
const CANCEL_SCHEDULED_TEXT = "解約を予約しました。";
/** ストアの定期購読の管理のページへのリンクの文 (アプリの購入の画面のボタンと同じ文。billing/03 §10.4) */
const STORE_MANAGE_LINK_TEXT = "定期購読の管理を開く";

function isBillingErrorCode(code: unknown): code is BillingErrorCode {
  return typeof code === "string" && Object.hasOwn(BILLING_ERROR_MESSAGES, code);
}

/** 2xx 以外の応答の本文から固定の文を選ぶ (BILLING_ERROR_MESSAGES のキーならその文、それ以外 (429 の RATE_LIMITED・500 など) は汎用の文) */
async function errorTextOf(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const error = (body as { error: unknown }).error;
      if (typeof error === "object" && error !== null && "code" in error) {
        const code = (error as { code: unknown }).code;
        if (isBillingErrorCode(code)) return BILLING_ERROR_MESSAGES[code];
      }
    }
  } catch {
    // 本文が JSON でない (500 の HTML など) ときは汎用の文
  }
  return UNKNOWN_ERROR_TEXT;
}

type Notice = { tone: "info" | "error"; text: string } | null;

export default function FrozenBillingPage() {
  const router = useRouter();
  // 読み込みの effect は router の参照が変わっても流し直さない (ログインへ移るときだけ使う)
  const routerRef = useRef(router);
  routerRef.current = router;
  const [isNativeApp, setIsNativeApp] = useState(false);
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    // /frozen/account と同じ判定にそろえる (useNativeAppMode は useSearchParams を使うので、ここでは使わない)
    setIsNativeApp(isInNativeWebView());
    let cancelled = false;
    const run = async () => {
      try {
        const res = await fetch(BILLING_SUBSCRIPTION_API_PATH, { method: "GET" });
        if (cancelled) return;
        if (res.status === HTTP_UNAUTHORIZED) {
          routerRef.current.push(LOGIN_PATH);
          return;
        }
        if (!res.ok) {
          setLoadError(true);
          return;
        }
        const body = (await res.json()) as { data: BillingSummary };
        if (!cancelled) setSummary(body.data);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  // App Store / Google Play の契約はストアで解約する (解約のボタンを描かない。billing/03 §10.4)
  const store = summary?.manage_in_store ?? null;

  const handleCancel = async () => {
    if (!summary || busy) return;
    const d = formatBillingDate(summary.current_period_end);
    if (!window.confirm(`有料プランの解約を予約します。${d ?? "次回の更新日"}以降は請求されません。よろしいですか？`)) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(BILLING_CANCEL_API_PATH, { method: "POST" });
      if (res.status === HTTP_UNAUTHORIZED) {
        router.push(LOGIN_PATH);
        return;
      }
      if (!res.ok) {
        setNotice({ tone: "error", text: await errorTextOf(res) });
        return;
      }
      const body = (await res.json()) as { data: BillingSummary };
      setSummary(body.data);
      setNotice({ tone: "info", text: CANCEL_SCHEDULED_TEXT });
    } catch {
      setNotice({ tone: "error", text: UNKNOWN_ERROR_TEXT });
    } finally {
      setBusy(false);
    }
  };

  const handlePortal = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(BILLING_PORTAL_API_PATH, { method: "POST" });
      if (res.status === HTTP_UNAUTHORIZED) {
        router.push(LOGIN_PATH);
        return;
      }
      if (!res.ok) {
        setNotice({ tone: "error", text: await errorTextOf(res) });
        return;
      }
      const body = (await res.json()) as { data: { url: string } };
      // Portal の戻り先は /account/billing (凍結中は middleware が /frozen へ回す)
      window.location.assign(body.data.url);
    } catch {
      setNotice({ tone: "error", text: UNKNOWN_ERROR_TEXT });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center px-4 sm:px-6 lg:px-8 py-12">
      <div className="max-w-md w-full space-y-8">
        <div className="space-y-3 text-center">
          <h1 className="text-2xl font-bold text-gray-900">有料プランの解約・お支払い</h1>
          <p className="text-gray-600 leading-relaxed text-sm">
            アカウントが凍結されている間も、有料プランの解約の予約と、お支払い方法・請求書の確認はできます。
          </p>
        </div>

        <section className="bg-white rounded-2xl border border-gray-100 p-5 space-y-3">
          {!summary && !loadError && <p className="text-sm text-gray-500">読み込んでいます…</p>}
          {loadError && (
            <p role="alert" className="text-sm text-red-600">
              {LOAD_FAILED_TEXT}
            </p>
          )}
          {summary && summary.status === null && <p className="text-sm text-gray-700">{NO_CONTRACT_TEXT}</p>}
          {summary &&
            summary.status !== null &&
            billingStatusLines(summary).map((line) => (
              <p key={line} className="text-sm text-gray-700">
                {line}
              </p>
            ))}
          {store !== null && (
            <div className="space-y-2" data-testid="frozen-billing-store-notice">
              <p className="text-sm text-gray-700">{IAP_STORE_LABELS[store]} の定期購読の管理から解約できます。</p>
              {!isNativeApp && (
                <a
                  href={STORE_SUBSCRIPTION_MANAGEMENT_URL[store]}
                  target="_blank"
                  rel="noopener"
                  className="inline-block text-sm font-bold text-orange-600 underline"
                >
                  {STORE_MANAGE_LINK_TEXT}
                </a>
              )}
            </div>
          )}

          {summary && !isNativeApp && (
            <div className="space-y-3 pt-2">
              {store === null && summary.can_cancel && (
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={busy}
                  className="w-full py-3 rounded-xl border border-red-200 text-red-600 font-bold hover:bg-red-50 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  解約する
                </button>
              )}
              {summary.has_customer && (
                <button
                  type="button"
                  onClick={handlePortal}
                  disabled={busy}
                  className="w-full py-3 rounded-xl border border-gray-300 text-gray-700 font-bold hover:bg-gray-100 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  お支払い方法・請求書 (Stripe)
                </button>
              )}
            </div>
          )}

          {notice && (
            <p role={notice.tone === "error" ? "alert" : "status"} className={notice.tone === "error" ? "text-sm text-red-600" : "text-sm text-gray-600"}>
              {notice.text}
            </p>
          )}
        </section>

        <div className="flex flex-col gap-3 text-center text-sm">
          <a href="/frozen" className="text-gray-600 hover:underline">
            凍結のお知らせに戻る
          </a>
          <a href="/contact" className="text-orange-600 font-medium hover:underline">
            サポートに問い合わせる
          </a>
        </div>
      </div>
    </div>
  );
}
