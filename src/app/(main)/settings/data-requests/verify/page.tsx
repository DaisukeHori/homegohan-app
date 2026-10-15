"use client";

// src/app/(main)/settings/data-requests/verify/page.tsx
// 個人情報の請求の本人確認 (メールのリンクの開き先) (#1178 / #1702)
//
// 設計: docs/design/cross/15-data-subject-requests.md §9.1。`?id=&token=` を読み、開いた時点で POST verify を 1 回だけ呼ぶ。
//   200 → 「受け付けました。応答の期限は {due_at (日本時間)} です」
//   410 → 「リンクの期限が切れています」(一覧で確認メールを再送できる)
//   400・404・409 (と、id / token が無いリンク) → 「このリンクは使えません」
// どの結果にも一覧へのリンクを出す。ログインしていなければ (main) の既存の仕組み (middleware) が /login へ移す。
// useSearchParams は Suspense の境界の中で呼ぶ (MainLayout.tsx の BottomNav と同じ)。

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { DSR_ACCOUNT_API_PATH, DSR_SETTINGS_ENTRY_TITLE, DSR_SETTINGS_PATH, type DsrOwnDto } from "@/lib/data-subject-requests/core";

/** 410 (確認リンクの期限切れ) の状態コード */
const HTTP_GONE = 410;
/** 401 (ログインが切れている) の状態コード */
const HTTP_UNAUTHORIZED = 401;
/** 「このリンクは使えません」にする状態コード (トークンの不一致・無い請求・本人確認待ちでない請求) */
const UNUSABLE_LINK_STATUSES: ReadonlySet<number> = new Set([400, 404, 409]);

type VerifyOutcome =
  | { kind: "verifying" }
  | { kind: "received"; dueAt: string | null }
  | { kind: "expired" }
  | { kind: "unusable" }
  | { kind: "unauthorized" }
  | { kind: "failed" };

/** 応答期限 (日本時間の日付) */
function formatDueDate(value: string | null): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "long", timeZone: "Asia/Tokyo" }).format(new Date(time));
}

function readRequest(body: unknown): DsrOwnDto | null {
  if (!body || typeof body !== "object") return null;
  const request = (body as { request?: unknown }).request;
  return request && typeof request === "object" ? (request as DsrOwnDto) : null;
}

function messageOf(outcome: VerifyOutcome): string {
  switch (outcome.kind) {
    case "verifying":
      return "本人確認をしています…";
    case "received": {
      const due = formatDueDate(outcome.dueAt);
      return due ? `受け付けました。応答の期限は ${due} です。` : "受け付けました。";
    }
    case "expired":
      return "リンクの期限が切れています。請求の一覧から確認メールを再送してください。";
    case "unusable":
      return "このリンクは使えません。請求の一覧で状態をご確認ください。";
    case "unauthorized":
      return "ログインの期限が切れています。ログインしてから、メールのリンクをもう一度開いてください。";
    case "failed":
      return "本人確認ができませんでした。通信状況を確認して、メールのリンクをもう一度開いてください。";
  }
}

function VerifyResult() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  const token = searchParams.get("token") ?? "";
  const [outcome, setOutcome] = useState<VerifyOutcome>({ kind: "verifying" });
  // 開いた時点で 1 回だけ呼ぶ (開発時の二重の effect でも 2 回送らない。2 回目は 409 になり「使えません」が出てしまう)
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!id || !token) {
      setOutcome({ kind: "unusable" });
      return;
    }
    void (async () => {
      try {
        const res = await fetch(`${DSR_ACCOUNT_API_PATH}/${encodeURIComponent(id)}/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (res.ok) {
          const request = readRequest(await res.json().catch(() => null));
          setOutcome({ kind: "received", dueAt: request?.due_at ?? null });
        } else if (res.status === HTTP_GONE) {
          setOutcome({ kind: "expired" });
        } else if (UNUSABLE_LINK_STATUSES.has(res.status)) {
          setOutcome({ kind: "unusable" });
        } else if (res.status === HTTP_UNAUTHORIZED) {
          setOutcome({ kind: "unauthorized" });
        } else {
          setOutcome({ kind: "failed" });
        }
      } catch {
        setOutcome({ kind: "failed" });
      }
    })();
  }, [id, token]);

  return (
    <section className="bg-white rounded-2xl shadow-sm px-4 py-8 text-center" aria-live="polite">
      {outcome.kind === "verifying" && (
        <Loader2 size={24} className="animate-spin text-orange-500 mx-auto mb-3" aria-hidden="true" />
      )}
      <p data-testid="dsr-verify-result" data-outcome={outcome.kind} className="text-sm text-gray-800 leading-relaxed">
        {messageOf(outcome)}
      </p>
      {outcome.kind !== "verifying" && (
        <Link
          href={DSR_SETTINGS_PATH}
          data-testid="dsr-verify-list-link"
          className="inline-block mt-5 px-5 py-2.5 rounded-xl bg-orange-500 text-white text-sm font-bold"
        >
          請求の一覧へ
        </Link>
      )}
    </section>
  );
}

export default function DataRequestVerifyPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="sticky top-0 bg-white border-b border-gray-100 px-4 py-3 z-10">
        <h1 className="text-lg font-semibold text-gray-800">{DSR_SETTINGS_ENTRY_TITLE}</h1>
      </div>
      <div className="px-4 py-6 max-w-2xl mx-auto">
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-16" role="status" aria-label="読み込み中">
              <Loader2 size={24} className="animate-spin text-orange-500" />
            </div>
          }
        >
          <VerifyResult />
        </Suspense>
      </div>
    </div>
  );
}
