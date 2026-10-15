"use client";

/**
 * /account/billing/checkout?plan_key=&interval= — 特定商取引法の最終確認 (billing/01 §10.2・cross/08 §3)
 *
 * GET /api/billing/checkout/preview で内容を取り、CheckoutConfirmation に渡す。「上記内容を確認しました」を ON にして
 * 「申し込む」を押すと POST /api/billing/checkout → 応答の data.url (Stripe Checkout) へ移る。
 * 422 / 409 / 503 などは BILLING_ERROR_MESSAGES の固定の文を出す。
 * アプリの WebView (isNativeApp) では「この操作はアプリでは行えません」とだけ描き、API を呼ばない (§10.4)。
 */

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useNativeAppMode } from "@/hooks/useNativeAppMode";
import { CheckoutConfirmation } from "@/components/billing/checkout-confirmation";
import { BILLING_ERROR_MESSAGES, type BillingErrorCode } from "@/lib/billing/core";
import type { CheckoutPreview } from "@/lib/billing/service";

const CHECKOUT_API_PATH = "/api/billing/checkout";
const PREVIEW_API_PATH = "/api/billing/checkout/preview";
const LOGIN_PATH = "/login";
const HTTP_UNAUTHORIZED = 401;

const NATIVE_APP_TEXT = "この操作はアプリでは行えません";
const UNKNOWN_ERROR_TEXT = "処理中にエラーが発生しました。時間をおいて再度お試しください。";

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

function CheckoutContent() {
  const router = useRouter();
  // 読み込みの effect は router の参照が変わっても流し直さない (ログインへ移るときだけ使う)
  const routerRef = useRef(router);
  routerRef.current = router;
  const searchParams = useSearchParams();
  const isNativeApp = useNativeAppMode();
  const planKey = searchParams.get("plan_key") ?? "";
  const interval = searchParams.get("interval") ?? "";

  const [preview, setPreview] = useState<CheckoutPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (isNativeApp) return;
    let cancelled = false;
    const run = async () => {
      try {
        const query = new URLSearchParams({ plan_key: planKey, interval });
        const res = await fetch(`${PREVIEW_API_PATH}?${query.toString()}`, { method: "GET" });
        if (cancelled) return;
        if (res.status === HTTP_UNAUTHORIZED) {
          routerRef.current.push(LOGIN_PATH);
          return;
        }
        if (!res.ok) {
          const text = await errorTextOf(res);
          if (!cancelled) setLoadError(text);
          return;
        }
        const body = (await res.json()) as { data: CheckoutPreview };
        if (!cancelled) setPreview(body.data);
      } catch {
        if (!cancelled) setLoadError(UNKNOWN_ERROR_TEXT);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [isNativeApp, planKey, interval]);

  const handleConfirm = async () => {
    if (!preview || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(CHECKOUT_API_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_key: preview.plan_key, interval: preview.interval }),
      });
      if (res.status === HTTP_UNAUTHORIZED) {
        router.push(LOGIN_PATH);
        return;
      }
      if (!res.ok) {
        setSubmitError(await errorTextOf(res));
        setSubmitting(false);
        return;
      }
      const body = (await res.json()) as { data: { url: string } };
      // Stripe Checkout へ移る (移るまでボタンは押せないまま)
      window.location.assign(body.data.url);
    } catch {
      setSubmitError(UNKNOWN_ERROR_TEXT);
      setSubmitting(false);
    }
  };

  if (isNativeApp) {
    return (
      <div className="max-w-xl mx-auto px-4 py-8">
        <p className="text-sm text-gray-700">{NATIVE_APP_TEXT}</p>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-8 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">お申し込み</h1>
      {loadError !== null && (
        <p role="alert" className="text-sm text-red-600">
          {loadError}
        </p>
      )}
      {preview === null && loadError === null && <p className="text-sm text-gray-500">読み込んでいます…</p>}
      {preview !== null && (
        <CheckoutConfirmation
          preview={preview}
          submitting={submitting}
          errorMessage={submitError}
          onConfirm={() => void handleConfirm()}
        />
      )}
    </div>
  );
}

export default function AccountBillingCheckoutPage() {
  // useSearchParams (useNativeAppMode の中も) を使うので Suspense の境界を置く
  return (
    <Suspense fallback={null}>
      <CheckoutContent />
    </Suspense>
  );
}
