"use client";

/**
 * /account/billing — 契約の管理 (billing/01 §10.3)
 *
 * - GET /api/billing/subscription の要約 (BillingSummary) を描く。状態の文は billingStatusLines (§10.3 の表) を 1 行ずつ出す (画面に文を書かない)
 * - 現在のプランはモバイルの購入の画面と同じ分岐 (@homegohan/shared の currentPlanDisplay。#1912): 自分の契約が live ならその名前、
 *   そうでなければ effective_plan_key で 無料プラン / 組織のプラン / <名前> (ご家族のプラン) / 有料プラン。
 *   自分の契約ではないプラン (組織・家族・汎用) が効いているときは、自分の契約が無いことを添え書き (NOT_OWN_PLAN_NOTE) で出す
 * - ?checkout=success&session_id=… で開いたら、先に POST /api/billing/checkout/sync を呼ぶ (S9)。契約がまだ写っていなければ
 *   「お申し込みを処理しています」を出し、CHECKOUT_SYNC_RETRY_MS ごとに GET を最大 CHECKOUT_SYNC_MAX_RETRIES 回読み直す
 * - ?checkout=cancelled なら「お申し込みは完了していません」(S17。sync は呼ばない)
 * - ボタン: has_customer → Billing Portal / can_cancel → 解約する / can_resume → 解約を取り消す / can_purchase → プランを見る (/pricing)
 * - アプリの WebView (isNativeApp) では表示だけ (ボタンは描かない。§10.4・S14)
 * - ボタンの POST が 2xx 以外なら BILLING_ERROR_MESSAGES の固定の文を出す (鍵が無いときの 503 は「お支払いを受け付けていません」)
 * - App Store / Google Play の契約 (manage_in_store が null でない) は Portal・解約・取り消しのボタンを描かず、ストアの定期購読の管理で
 *   解約することを文で出し、管理のページへのリンクを置く (アプリの WebView では文だけ。billing/03 §10.3)
 */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FAMILY_PLAN_STATUS_SUFFIX, IAP_STORE_LABELS, STORE_SUBSCRIPTION_MANAGEMENT_URL, currentPlanDisplay, type CurrentPlanSource } from "@homegohan/shared";
import { useNativeAppMode } from "@/hooks/useNativeAppMode";
import { BILLING_CANCEL_API_PATH, BILLING_PORTAL_API_PATH, BILLING_SUBSCRIPTION_API_PATH } from "@/lib/auth/frozen";
import {
  BILLING_ERROR_MESSAGES,
  CHECKOUT_RESULT_CANCELLED,
  CHECKOUT_RESULT_QUERY,
  CHECKOUT_RESULT_SUCCESS,
  CHECKOUT_SESSION_QUERY,
  billingStatusLines,
  formatBillingDate,
  type BillingErrorCode,
  type BillingInterval,
  type BillingSummary,
} from "@/lib/billing/core";

/**
 * 決済の完了のあと、契約が写るまで読み直す間隔 (ミリ秒)。
 * 根拠: Stripe の Webhook の到着は通常 1〜5 秒 (billing/01 §15.3)
 */
const CHECKOUT_SYNC_RETRY_MS = 3000;
/**
 * 読み直す回数の上限。3 秒 × 10 回 = 30 秒で諦めて「時間をおいて再読み込み」を出す (billing/01 §15.3)
 */
const CHECKOUT_SYNC_MAX_RETRIES = 10;

const SUBSCRIPTION_API_PATH = BILLING_SUBSCRIPTION_API_PATH;
const CANCEL_API_PATH = BILLING_CANCEL_API_PATH;
const PORTAL_API_PATH = BILLING_PORTAL_API_PATH;
const CHECKOUT_SYNC_API_PATH = "/api/billing/checkout/sync";
const RESUME_API_PATH = "/api/billing/subscription/resume";
const PRICING_PATH = "/pricing";
const LOGIN_PATH = "/login";
const HTTP_UNAUTHORIZED = 401;

const LOAD_FAILED_TEXT = "契約の状態を読み込めませんでした。時間をおいて再度お試しください。";
const UNKNOWN_ERROR_TEXT = "処理中にエラーが発生しました。時間をおいて再度お試しください。";
const CHECKOUT_PROCESSING_TEXT = "お申し込みを処理しています";
const CHECKOUT_SLOW_TEXT = "お申し込みの反映に時間がかかっています。時間をおいて再読み込みしてください。";
const CHECKOUT_CANCELLED_TEXT = "お申し込みは完了していません";
/**
 * 自分の契約ではないプラン (組織・家族・汎用。currentPlanDisplay の source が own でも free でもない) が効いているときの添え書き (#1912)。
 * 解約・お支払い方法の変更はそのプランの契約の側で行い、この画面ではできない (自分のプランの申し込みは「プランを見る」からできる)
 */
const NOT_OWN_PLAN_NOTE = "ご自身の契約ではないため、このプランの解約やお支払い方法の変更はこの画面では行えません。";
/** 添え書き (NOT_OWN_PLAN_NOTE) を出す出どころ */
const NOT_OWN_PLAN_SOURCES: readonly CurrentPlanSource[] = ["org", "family", "generic"];
/** ストアの定期購読の管理のページへのリンクの文 (アプリの購入の画面のボタンと同じ文。billing/03 §10.3) */
const STORE_MANAGE_LINK_TEXT = "定期購読の管理を開く";

const INTERVAL_TEXT: Readonly<Record<BillingInterval, string>> = { month: "月額", year: "年額" };

type CheckoutNotice = "processing" | "slow" | "cancelled" | null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isBillingErrorCode(code: unknown): code is BillingErrorCode {
  return typeof code === "string" && Object.hasOwn(BILLING_ERROR_MESSAGES, code);
}

/** 2xx 以外の応答の本文から固定の文を選ぶ (BILLING_ERROR_MESSAGES のキーならその文、それ以外は汎用の文) */
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

function AccountBillingContent() {
  const router = useRouter();
  // 読み込みの effect は router の参照が変わっても流し直さない (ログインへ移るときだけ使う)
  const routerRef = useRef(router);
  routerRef.current = router;
  const searchParams = useSearchParams();
  const isNativeApp = useNativeAppMode();
  const checkoutResult = searchParams.get(CHECKOUT_RESULT_QUERY);
  const sessionId = searchParams.get(CHECKOUT_SESSION_QUERY);

  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [checkoutNotice, setCheckoutNotice] = useState<CheckoutNotice>(
    checkoutResult === CHECKOUT_RESULT_CANCELLED ? "cancelled" : null,
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  /** GET の要約。401 はログインへ。読めなければ null */
  const fetchSummary = useCallback(async (): Promise<BillingSummary | null> => {
    const res = await fetch(SUBSCRIPTION_API_PATH, { method: "GET" });
    if (res.status === HTTP_UNAUTHORIZED) {
      routerRef.current.push(LOGIN_PATH);
      return null;
    }
    if (!res.ok) return null;
    const body = (await res.json()) as { data: BillingSummary };
    return body.data;
  }, []);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        if (checkoutResult === CHECKOUT_RESULT_SUCCESS && sessionId) {
          // 戻り画面が Webhook より先に開いたときのために、Checkout Session から契約を写す (S9)
          setCheckoutNotice("processing");
          const res = await fetch(CHECKOUT_SYNC_API_PATH, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: sessionId }),
          });
          if (res.status === HTTP_UNAUTHORIZED) {
            routerRef.current.push(LOGIN_PATH);
            return;
          }
          let current: BillingSummary | null = res.ok ? ((await res.json()) as { data: BillingSummary }).data : null;
          if (current === null || current.status === null) current = await fetchSummary();
          for (let attempt = 0; attempt < CHECKOUT_SYNC_MAX_RETRIES && !cancelled && (current === null || current.status === null); attempt += 1) {
            if (current !== null) setSummary(current);
            await sleep(CHECKOUT_SYNC_RETRY_MS);
            if (cancelled) return;
            current = await fetchSummary();
          }
          if (cancelled) return;
          if (current === null) {
            setLoadError(true);
            setCheckoutNotice(null);
            return;
          }
          setSummary(current);
          setCheckoutNotice(current.status === null ? "slow" : null);
          return;
        }
        const current = await fetchSummary();
        if (cancelled) return;
        if (current === null) setLoadError(true);
        else setSummary(current);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [checkoutResult, sessionId, fetchSummary]);

  /** POST のボタン (解約・取り消し)。200 の要約で置き換える */
  const postForSummary = async (path: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(path, { method: "POST" });
      if (res.status === HTTP_UNAUTHORIZED) {
        router.push(LOGIN_PATH);
        return;
      }
      if (!res.ok) {
        setActionError(await errorTextOf(res));
        return;
      }
      setSummary(((await res.json()) as { data: BillingSummary }).data);
    } catch {
      setActionError(UNKNOWN_ERROR_TEXT);
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (!summary) return;
    const d = formatBillingDate(summary.current_period_end);
    if (!window.confirm(`有料プランの解約を予約します。${d ?? "次回の更新日"}以降は請求されません。よろしいですか？`)) return;
    await postForSummary(CANCEL_API_PATH);
  };

  const handlePortal = async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(PORTAL_API_PATH, { method: "POST" });
      if (res.status === HTTP_UNAUTHORIZED) {
        router.push(LOGIN_PATH);
        return;
      }
      if (!res.ok) {
        setActionError(await errorTextOf(res));
        return;
      }
      const body = (await res.json()) as { data: { url: string } };
      window.location.assign(body.data.url);
    } catch {
      setActionError(UNKNOWN_ERROR_TEXT);
    } finally {
      setBusy(false);
    }
  };

  const statusLines = summary ? billingStatusLines(summary) : [];
  const currentPlan = summary ? currentPlanDisplay(summary) : null;
  // App Store / Google Play の契約はストアで管理する (Portal・解約・取り消しを描かない。billing/03 §10.3)
  const store = summary?.manage_in_store ?? null;
  const nextRenewal =
    summary && summary.status !== null && !summary.cancel_at_period_end ? formatBillingDate(summary.current_period_end) : null;

  return (
    <div className="max-w-xl mx-auto px-4 py-8 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">プランとお支払い</h1>

      {checkoutNotice === "processing" && <p role="status" className="text-sm text-gray-600">{CHECKOUT_PROCESSING_TEXT}</p>}
      {checkoutNotice === "slow" && <p role="status" className="text-sm text-gray-600">{CHECKOUT_SLOW_TEXT}</p>}
      {checkoutNotice === "cancelled" && <p role="status" className="text-sm text-gray-600">{CHECKOUT_CANCELLED_TEXT}</p>}

      {loadError && (
        <p role="alert" className="text-sm text-red-600">
          {LOAD_FAILED_TEXT}
        </p>
      )}

      {!summary && !loadError && <p className="text-sm text-gray-500">読み込んでいます…</p>}

      {summary && (
        <section className="bg-white rounded-2xl border border-gray-100 p-5 space-y-3" data-testid="billing-summary">
          <div>
            <p className="text-xs text-gray-400">現在のプラン</p>
            {currentPlan !== null && (
              <>
                <p className="font-bold text-gray-800" data-testid="billing-plan">
                  {currentPlan.source === "family" ? `${currentPlan.name}${FAMILY_PLAN_STATUS_SUFFIX}` : currentPlan.name}
                </p>
                {NOT_OWN_PLAN_SOURCES.includes(currentPlan.source) && (
                  <p className="text-xs text-gray-500" data-testid="billing-plan-note">
                    {NOT_OWN_PLAN_NOTE}
                  </p>
                )}
              </>
            )}
          </div>
          <div data-testid="billing-status-lines">
            {statusLines.map((line) => (
              <p key={line} className="text-sm text-gray-700">
                {line}
              </p>
            ))}
          </div>
          {nextRenewal !== null && <p className="text-sm text-gray-600">次回更新日: {nextRenewal}</p>}
          {summary.billing_interval !== null && (
            <p className="text-sm text-gray-600">支払い周期: {INTERVAL_TEXT[summary.billing_interval]}</p>
          )}
          {store !== null && (
            <div className="space-y-2" data-testid="billing-store-notice">
              <p className="text-sm text-gray-700">
                {IAP_STORE_LABELS[store]} でご契約中です。解約・お支払い方法の変更は {IAP_STORE_LABELS[store]} の定期購読の管理から行えます。
              </p>
              {!isNativeApp && (
                <a
                  href={STORE_SUBSCRIPTION_MANAGEMENT_URL[store]}
                  target="_blank"
                  rel="noopener"
                  className="inline-block text-sm font-bold underline text-[#E07A5F]"
                >
                  {STORE_MANAGE_LINK_TEXT}
                </a>
              )}
            </div>
          )}
        </section>
      )}

      {summary && !isNativeApp && (
        <div className="space-y-3">
          {store === null && summary.has_customer && (
            <button
              type="button"
              onClick={handlePortal}
              disabled={busy}
              className="w-full py-3 rounded-xl border border-gray-300 text-gray-700 font-bold hover:bg-gray-100 transition-colors text-sm disabled:opacity-50"
            >
              お支払い方法・請求書 (Stripe)
            </button>
          )}
          {store === null && summary.can_cancel && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={busy}
              className="w-full py-3 rounded-xl border border-red-200 text-red-600 font-bold hover:bg-red-50 transition-colors text-sm disabled:opacity-50"
            >
              解約する
            </button>
          )}
          {store === null && summary.can_resume && (
            <button
              type="button"
              onClick={() => void postForSummary(RESUME_API_PATH)}
              disabled={busy}
              className="w-full py-3 rounded-xl border border-gray-300 text-gray-700 font-bold hover:bg-gray-100 transition-colors text-sm disabled:opacity-50"
            >
              解約を取り消す
            </button>
          )}
          {summary.can_purchase && (
            <Link
              href={PRICING_PATH}
              className="block w-full py-3 rounded-xl text-center text-white font-bold text-sm bg-[#E07A5F]"
            >
              プランを見る
            </Link>
          )}
          {actionError !== null && (
            <p role="alert" className="text-sm text-red-600">
              {actionError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function AccountBillingPage() {
  // useSearchParams (useNativeAppMode の中も) を使うので Suspense の境界を置く
  return (
    <Suspense fallback={null}>
      <AccountBillingContent />
    </Suspense>
  );
}
