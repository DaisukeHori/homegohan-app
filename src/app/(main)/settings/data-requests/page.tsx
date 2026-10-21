"use client";

// src/app/(main)/settings/data-requests/page.tsx
// 個人情報の開示・訂正・利用停止・消去の請求: 新しい請求と、自分の請求の一覧 (#1178 / #1702)
//
// 設計: docs/design/cross/15-data-subject-requests.md §9.1。入口は設定のトップ (settings/page.tsx の「データとプライバシー」)。
// 上: 新しい請求の form (種類 4 択・内容 2000 字まで)。下: 自分の請求の一覧 (GET /api/account/data-requests)。
//   - 本人確認待ち: 「確認メールを再送」(POST resend-verification) と、リンクの期限切れの表示
//   - 開いている請求 (本人確認待ち・受付済み・対応中): 「取り下げ」(確認のあとに POST withdraw)
//   - 対応済み・対応できず: 運営からの応答 (response_note) を表示する
// 文は API が返す固定の文 (error) をそのまま出す (どれもこちらで書いた文)。429 は Retry-After から分の文を作る。

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ChevronLeft, Loader2, Undo2 } from "lucide-react";
import { ConfirmDeleteModal } from "@/components/common/ConfirmDeleteModal";
import {
  DSR_ACCOUNT_API_PATH,
  DSR_DETAILS_MAX_LENGTH,
  DSR_REQUEST_TYPES,
  DSR_REQUEST_TYPE_LABELS,
  DSR_SETTINGS_ENTRY_TITLE,
  DSR_STATUS_LABELS,
  canWithdrawDsr,
  shortDsrId,
  type DsrOwnDto,
  type DsrRequestType,
} from "@/lib/data-subject-requests/core";
import { dsrRateLimitedMessage } from "@/lib/data-subject-requests/client-messages";
import { STORE_SUBSCRIPTION_DELETION_NOTICE } from "@homegohan/shared";

/**
 * 種類ごとの説明 (開示は自分で書き出す方法、消去はすぐに退会できることを添える。§9.1)。
 * 消去は退会と同じく、App Store / Google Play の購読は自動では解約されないことも添える (STORE_SUBSCRIPTION_DELETION_NOTICE。billing/03 §10.4)
 */
const REQUEST_TYPE_DESCRIPTIONS: Record<DsrRequestType, string> = {
  disclosure:
    "保有している個人情報の開示を求めます。登録した記録はいつでも、設定の「データをエクスポート」から自分で書き出せます。書き出しに含まれない情報や、書面での回答が必要なときにご利用ください。",
  correction: "誤っている個人情報の訂正を求めます。プロフィールなど、ご自身で直せる項目は各画面から直せます。",
  suspension: "個人情報の利用の停止を求めます。止めたい利用の内容をお書きください。",
  erasure:
    `個人情報の消去を求めます。アカウントの削除は設定画面からすぐにできます (削除すると記録はすべて消え、元に戻せません)。${STORE_SUBSCRIPTION_DELETION_NOTICE}`,
};

/** 通信に失敗したとき・想定外の応答のときの文 */
const GENERIC_FAILURE_MESSAGE = "処理できませんでした。通信状況を確認して、もう一度お試しください。";
const LOAD_FAILURE_MESSAGE = "請求の一覧を読み込めませんでした。通信状況を確認して、もう一度お試しください。";
const CREATED_NOTICE =
  "請求を受け付ける前に、本人確認のメールを登録のメールアドレスへ送りました。メールのリンクを開くと受付になります。";
const RESENT_NOTICE = "本人確認のメールを送り直しました。新しいメールのリンクを開いてください (前のリンクは使えなくなります)。";
const WITHDRAWN_NOTICE = "請求を取り下げました。";

/** 429 (連打の上限) の状態コード */
const HTTP_TOO_MANY_REQUESTS = 429;

/** 日本時間の日付 (期限・作成日) */
function formatDate(value: string | null): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "long", timeZone: "Asia/Tokyo" }).format(new Date(time));
}

/** 応答の本文の error (固定の文) を読む。読めなければ null */
async function readErrorMessage(res: Response): Promise<string | null> {
  const body: unknown = await res.json().catch(() => null);
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error) return error;
  }
  return null;
}

/** 失敗の応答を画面の文にする (429 は Retry-After から分の文、それ以外は API の固定の文) */
async function failureMessage(res: Response): Promise<string> {
  if (res.status === HTTP_TOO_MANY_REQUESTS) {
    const header = res.headers.get("Retry-After");
    const seconds = header === null ? null : Number(header);
    return dsrRateLimitedMessage(seconds !== null && Number.isFinite(seconds) ? seconds : null);
  }
  return (await readErrorMessage(res)) ?? GENERIC_FAILURE_MESSAGE;
}

function isOwnDtoList(body: unknown): body is { requests: DsrOwnDto[] } {
  return !!body && typeof body === "object" && Array.isArray((body as { requests?: unknown }).requests);
}

type PendingAction = { kind: "resend" | "withdraw"; id: string } | null;

export default function DataRequestsSettingsPage() {
  const [requests, setRequests] = useState<DsrOwnDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const [requestType, setRequestType] = useState<DsrRequestType | null>(null);
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [pending, setPending] = useState<PendingAction>(null);
  const [withdrawTarget, setWithdrawTarget] = useState<DsrOwnDto | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const res = await fetch(DSR_ACCOUNT_API_PATH, { method: "GET", cache: "no-store" });
      const body: unknown = res.ok ? await res.json().catch(() => null) : null;
      if (res.ok && isOwnDtoList(body)) {
        setRequests(body.requests);
      } else {
        setLoadFailed(true);
      }
    } catch {
      setLoadFailed(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!requestType || submitting) return;
    setSubmitting(true);
    setFormError(null);
    setNotice(null);
    try {
      const res = await fetch(DSR_ACCOUNT_API_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_type: requestType, details }),
      });
      if (res.ok) {
        setDetails("");
        setRequestType(null);
        setNotice(CREATED_NOTICE);
        await load();
      } else {
        setFormError(await failureMessage(res));
      }
    } catch {
      setFormError(GENERIC_FAILURE_MESSAGE);
    }
    setSubmitting(false);
  };

  const runAction = async (kind: "resend" | "withdraw", id: string) => {
    setPending({ kind, id });
    setActionError(null);
    setNotice(null);
    const path = kind === "resend" ? "resend-verification" : "withdraw";
    try {
      const res = await fetch(`${DSR_ACCOUNT_API_PATH}/${encodeURIComponent(id)}/${path}`, { method: "POST" });
      if (res.ok) {
        setNotice(kind === "resend" ? RESENT_NOTICE : WITHDRAWN_NOTICE);
        await load();
      } else {
        setActionError(await failureMessage(res));
      }
    } catch {
      setActionError(GENERIC_FAILURE_MESSAGE);
    }
    setPending(null);
    setWithdrawTarget(null);
  };

  const detailsLength = details.trim().length;
  const canSubmit = requestType !== null && detailsLength > 0 && details.length <= DSR_DETAILS_MAX_LENGTH && !submitting;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="sticky top-0 bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 z-10">
        <Link href="/settings" className="p-1.5 rounded-full hover:bg-gray-100" aria-label="設定に戻る">
          <ChevronLeft size={20} />
        </Link>
        <h1 className="text-lg font-semibold text-gray-800">{DSR_SETTINGS_ENTRY_TITLE}</h1>
      </div>

      <div className="px-4 py-6 space-y-6 max-w-2xl mx-auto">
        {notice && (
          <p role="status" data-testid="dsr-notice" className="bg-green-50 text-green-800 text-sm rounded-xl px-4 py-3">
            {notice}
          </p>
        )}

        {/* 新しい請求 */}
        <section className="bg-white rounded-2xl shadow-sm px-4 py-5">
          <h2 className="text-base font-bold text-gray-800">新しい請求</h2>
          <p className="text-xs text-gray-500 mt-1 leading-relaxed">
            送信すると、登録のメールアドレスに本人確認のメールが届きます。メールのリンクを開くと受付になり、応答の期限が決まります。
          </p>
          <form data-testid="dsr-new-form" onSubmit={(event) => void handleSubmit(event)} className="mt-4 space-y-4">
            <fieldset>
              <legend className="text-sm font-bold text-gray-700 mb-2">請求の種類</legend>
              <div className="space-y-2">
                {DSR_REQUEST_TYPES.map((type) => (
                  <label
                    key={type}
                    className={`block rounded-xl border px-3 py-3 cursor-pointer ${
                      requestType === type ? "border-orange-400 bg-orange-50" : "border-gray-200"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="request_type"
                        value={type}
                        checked={requestType === type}
                        onChange={() => setRequestType(type)}
                        data-testid={`dsr-type-${type}`}
                      />
                      <span className="text-sm font-bold text-gray-800">{DSR_REQUEST_TYPE_LABELS[type]}</span>
                    </span>
                    <span className="block text-xs text-gray-500 mt-1 leading-relaxed">{REQUEST_TYPE_DESCRIPTIONS[type]}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div>
              <label htmlFor="dsr-details" className="text-sm font-bold text-gray-700">
                請求の内容
              </label>
              <textarea
                id="dsr-details"
                data-testid="dsr-details"
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                maxLength={DSR_DETAILS_MAX_LENGTH}
                rows={5}
                className="mt-2 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
                placeholder="対象の情報や、求める内容をお書きください"
              />
              <p className="text-xs text-gray-400 text-right">
                {details.length} / {DSR_DETAILS_MAX_LENGTH}
              </p>
            </div>

            {formError && (
              <p role="alert" data-testid="dsr-form-error" className="text-sm text-red-600">
                {formError}
              </p>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              data-testid="dsr-submit"
              className="w-full rounded-xl bg-orange-500 text-white font-bold py-3 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "送信中…" : "請求を送信する"}
            </button>
          </form>
        </section>

        {/* 自分の請求の一覧 */}
        <section className="bg-white rounded-2xl shadow-sm px-4 py-5">
          <h2 className="text-base font-bold text-gray-800">これまでの請求</h2>
          {actionError && (
            <p role="alert" data-testid="dsr-action-error" className="text-sm text-red-600 mt-3">
              {actionError}
            </p>
          )}
          {loading && !requests ? (
            <div className="flex items-center justify-center py-10" role="status" aria-label="読み込み中">
              <Loader2 size={24} className="animate-spin text-orange-500" />
            </div>
          ) : loadFailed && !requests ? (
            <div className="text-center py-6" data-testid="dsr-load-failed">
              <p className="text-sm text-gray-500">{LOAD_FAILURE_MESSAGE}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-3 px-5 py-2 rounded-xl bg-orange-500 text-white text-sm font-bold"
              >
                再読み込み
              </button>
            </div>
          ) : requests && requests.length === 0 ? (
            <p className="text-sm text-gray-500 mt-3" data-testid="dsr-list-empty">
              まだ請求はありません。
            </p>
          ) : (
            <ul data-testid="dsr-list" className="mt-3 divide-y divide-gray-100">
              {(requests ?? []).map((request) => {
                const dueDate = formatDate(request.due_at);
                const createdDate = formatDate(request.created_at);
                const busy = pending?.id === request.id;
                const showResponse = request.status === "fulfilled" || request.status === "rejected";
                return (
                  <li key={request.id} data-testid={`dsr-item-${request.id}`} className="py-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-bold text-gray-800">
                        {DSR_REQUEST_TYPE_LABELS[request.request_type]}
                      </span>
                      <span data-testid="dsr-item-status" className="text-xs font-bold text-gray-600">
                        {DSR_STATUS_LABELS[request.status]}
                      </span>
                    </div>
                    <dl className="mt-1 text-xs text-gray-500 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                      <dt>受付番号</dt>
                      <dd>{shortDsrId(request.id)}</dd>
                      {createdDate && (
                        <>
                          <dt>作成日</dt>
                          <dd>{createdDate}</dd>
                        </>
                      )}
                      {dueDate && (
                        <>
                          <dt>応答の期限</dt>
                          <dd data-testid="dsr-item-due">{dueDate}</dd>
                        </>
                      )}
                    </dl>

                    {request.status === "pending_verification" && (
                      <div className="mt-2 space-y-2">
                        <p
                          data-testid="dsr-item-verification"
                          className={`text-xs ${request.verification_expired ? "text-red-600" : "text-gray-500"}`}
                        >
                          {request.verification_expired
                            ? "本人確認のリンクの期限が切れています。確認メールを再送してください。"
                            : "本人確認のメールのリンクを開くと受付になります。"}
                        </p>
                        <button
                          type="button"
                          data-testid="dsr-item-resend"
                          disabled={busy}
                          onClick={() => void runAction("resend", request.id)}
                          className="text-xs font-bold text-orange-600 underline disabled:opacity-50"
                        >
                          {busy && pending?.kind === "resend" ? "送信中…" : "確認メールを再送"}
                        </button>
                      </div>
                    )}

                    {showResponse && (
                      <div className="mt-2 rounded-xl bg-gray-50 px-3 py-2" data-testid="dsr-item-response">
                        <p className="text-xs font-bold text-gray-600">運営からの応答</p>
                        <p className="text-sm text-gray-800 whitespace-pre-wrap mt-1">{request.response_note ?? ""}</p>
                      </div>
                    )}

                    {canWithdrawDsr(request.status) && (
                      <button
                        type="button"
                        data-testid="dsr-item-withdraw"
                        disabled={busy}
                        onClick={() => setWithdrawTarget(request)}
                        className="mt-2 text-xs font-bold text-gray-500 underline disabled:opacity-50"
                      >
                        取り下げ
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {withdrawTarget && (
        <ConfirmDeleteModal
          title="請求を取り下げますか？"
          message={`${DSR_REQUEST_TYPE_LABELS[withdrawTarget.request_type]}の請求 (受付番号 ${shortDsrId(withdrawTarget.id)}) を取り下げます。取り下げた請求は元に戻せません。`}
          isDeleting={pending?.kind === "withdraw" && pending.id === withdrawTarget.id}
          tone="neutral"
          icon={Undo2}
          confirmLabel="取り下げる"
          onCancel={() => setWithdrawTarget(null)}
          onConfirm={() => void runAction("withdraw", withdrawTarget.id)}
        />
      )}
    </div>
  );
}
