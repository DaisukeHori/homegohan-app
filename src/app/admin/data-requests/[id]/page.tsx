'use client';

/**
 * /admin/data-requests/[id] — 個人情報の請求の詳細と対応 (#1178 / #1702 段 C)
 *
 * 設計: docs/design/cross/15-data-subject-requests.md §9.2・§7.4。API は GET / PATCH /api/admin/data-requests/[id] (`{ data }`)。
 * 権限: admin / super_admin (DSR_OPERATOR_ROLES)。
 *
 * - 上: 種類・状態・受付番号・請求者 (ニックネーム / メールアドレス / user_id。退会済みは「退会済み」)・本人確認・期限・請求の内容
 * - 中: 種類ごとの対応の手段の案内 (固定の文)。利用停止の手段に凍結 (BAN) は挙げない
 *   (凍結すると本人は /settings にも /api/account/data-requests にも入れず、応答を読めなくなる。§8.1)
 * - 下: 状態の select (遷移表に無い選択肢は disabled)・本人への応答・内部メモ・保存 (PATCH。ヘッダ If-Unmodified-Since に
 *   最後に取得した updated_at をそのまま送る)。status は select の値が読み込んだ状態から変わったときだけ本文に入れる
 * - 本人確認待ちと終わった請求 (対応済み・対応できず・取り下げ) は select・応答・内部メモ・保存をすべて disabled (表示だけ。API も 409)
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { loginPathWithNext } from '@/lib/auth/signed-in-user';
import { forbiddenMessageOfResponse } from '@/lib/admin/api-error-message';
import {
  DSR_ACTIONABLE_STATUSES,
  DSR_ADMIN_API_PATH,
  DSR_NOTE_MAX_LENGTH,
  DSR_OPERATOR_TARGET_STATUSES,
  DSR_REQUEST_TYPE_LABELS,
  DSR_STATUS_LABELS,
  findDsrTransition,
  shortDsrId,
  type DsrAdminDetailDto,
  type DsrAdminUpdateInput,
  type DsrRequestType,
  type DsrStatus,
} from '@/lib/data-subject-requests/core';

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_PRECONDITION_FAILED = 412;
const HTTP_UNPROCESSABLE = 422;

/** 本人への応答・内部メモの入力欄の高さ (行)。応答は数段落を書くので内部メモより高くする */
const RESPONSE_NOTE_ROWS = 6;
const ADMIN_NOTES_ROWS = 4;

/** 楽観的ロックのヘッダ (GET が返した updated_at の文字列をそのまま送る) */
const IF_UNMODIFIED_SINCE_HEADER = 'If-Unmodified-Since';

const LOAD_FAILURE_MESSAGE = '請求を読み込めませんでした。再読み込みしてください';
const NOT_FOUND_MESSAGE = '請求が見つかりません';
/** 403 の文。本文の理由の文 (二段階認証の確認が要る など) があればそちらを出す (forbiddenMessageOfResponse。#1917) */
const FORBIDDEN_MESSAGE = '権限がありません';
/** 412 / 409 (別の運営者が先に更新した・状態が変わった) の文 (§9.2) */
const CONFLICT_MESSAGE = '別の運営者が更新しました。再読み込みしてください';
/** 422 (対応済み・対応できずで応答が空) の文 (§9.2) */
const RESPONSE_NOTE_REQUIRED_MESSAGE = '応答を書いてください';
const SAVE_FAILURE_MESSAGE = '保存できませんでした。通信状況を確認して、もう一度お試しください';
const SAVED_MESSAGE = '保存しました';
const READ_ONLY_NOTICE =
  '本人確認待ちの請求と、終わった請求 (対応済み・対応できず・取り下げ) は変更できません (表示だけ)。';

/** 種類ごとの対応の手段の案内 (§9.2。固定の文) */
const HANDLING_GUIDES: Record<DsrRequestType, string> = {
  disclosure:
    '利用者詳細で保有している情報を確かめ、開示する内容を「本人への応答」に書いてください。登録した記録は、本人が設定の「データをエクスポート」から自分で書き出すこともできます (案内として応答に添えてください)。',
  correction:
    'プロフィールなど本人が直せる項目は、その画面を案内してください。運営が直す項目は利用者詳細で直し、何を直したかを「本人への応答」に書いてください。',
  suspension:
    '請求の内容から止める利用の範囲を確かめ、止めた内容・本人が設定で止められる項目 (AI の外部送信の同意・通知の設定)・全体を止めたいときは退会 (消去の請求) できることを「本人への応答」に書いてください。凍結は利用停止の手段に使わないでください (凍結すると本人は設定画面に入れず、応答を読めなくなります)。',
  erasure:
    '本人に設定画面からの退会 (アカウントの削除) を案内してください。退会すると請求者が「退会済み」になるので、そのあとで対応済みにしてください。',
};

/** 日本時間の日時 */
function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return '—';
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tokyo' }).format(
    new Date(time),
  );
}

/** 運営が手を付けられる状態 (受付済み / 対応中) か */
function isEditable(status: DsrStatus): boolean {
  return DSR_ACTIONABLE_STATUSES.includes(status);
}

type DsrOperatorTargetStatus = (typeof DSR_OPERATOR_TARGET_STATUSES)[number];

/** 運営が PATCH の status に指定できる状態か (DSR_OPERATOR_TARGET_STATUSES) */
function isOperatorTargetStatus(status: DsrStatus): status is DsrOperatorTargetStatus {
  return DSR_OPERATOR_TARGET_STATUSES.some((target) => target === status);
}

/** select に並べる状態 (今の状態 + 運営が選べる遷移先) */
function statusOptions(current: DsrStatus): DsrStatus[] {
  return [current, ...DSR_OPERATOR_TARGET_STATUSES.filter((status) => status !== current)];
}

function isDetailBody(body: unknown): body is { data: DsrAdminDetailDto } {
  return !!body && typeof body === 'object' && !!(body as { data?: unknown }).data;
}

/** nested のエラーの本文 ({ error: { message } }) の文を読む。読めなければ null */
async function readErrorMessage(res: Response): Promise<string | null> {
  const body: unknown = await res.json().catch(() => null);
  if (body && typeof body === 'object') {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === 'object') {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message) return message;
    }
  }
  return null;
}

export default function AdminDataRequestDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const router = useRouter();
  // ログインが切れた (401) ときに、ログインし直したあとこの画面へ戻れるよう next に付けるパス (#2101 X5)
  const pathname = usePathname();

  const [detail, setDetail] = useState<DsrAdminDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [status, setStatus] = useState<DsrStatus | null>(null);
  const [responseNote, setResponseNote] = useState('');
  const [adminNotes, setAdminNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /** 読み込んだ (保存した) 請求を画面とフォームに反映する */
  const applyDetail = useCallback((next: DsrAdminDetailDto) => {
    setDetail(next);
    setStatus(next.status);
    setResponseNote(next.response_note ?? '');
    setAdminNotes(next.admin_notes ?? '');
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`${DSR_ADMIN_API_PATH}/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (res.status === HTTP_UNAUTHORIZED) {
        router.push(loginPathWithNext(pathname));
        return;
      }
      if (res.status === HTTP_FORBIDDEN) {
        setLoadError(await forbiddenMessageOfResponse(res, FORBIDDEN_MESSAGE));
        return;
      }
      if (res.status === HTTP_NOT_FOUND) {
        setLoadError(NOT_FOUND_MESSAGE);
        return;
      }
      const body: unknown = res.ok ? await res.json().catch(() => null) : null;
      if (!res.ok || !isDetailBody(body)) {
        setLoadError(LOAD_FAILURE_MESSAGE);
        return;
      }
      applyDetail(body.data);
    } catch {
      setLoadError(LOAD_FAILURE_MESSAGE);
    } finally {
      setLoading(false);
    }
  }, [id, router, pathname, applyDetail]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    if (!detail || !status || saving) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    // status は読み込んだ状態から変えたときだけ送る (同じ状態の指定は遷移ではないので 409 になる。§7.4)
    const payload: DsrAdminUpdateInput = { response_note: responseNote, admin_notes: adminNotes };
    if (status !== detail.status && isOperatorTargetStatus(status)) {
      payload.status = status;
    }
    try {
      const res = await fetch(`${DSR_ADMIN_API_PATH}/${encodeURIComponent(detail.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', [IF_UNMODIFIED_SINCE_HEADER]: detail.updated_at },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const body: unknown = await res.json().catch(() => null);
        if (isDetailBody(body)) {
          applyDetail(body.data);
          setSaved(true);
        } else {
          setSaveError(SAVE_FAILURE_MESSAGE);
        }
        return;
      }
      if (res.status === HTTP_UNAUTHORIZED) {
        router.push(loginPathWithNext(pathname));
        return;
      }
      if (res.status === HTTP_PRECONDITION_FAILED || res.status === HTTP_CONFLICT) {
        setSaveError(CONFLICT_MESSAGE);
        return;
      }
      if (res.status === HTTP_UNPROCESSABLE) {
        setSaveError(RESPONSE_NOTE_REQUIRED_MESSAGE);
        return;
      }
      setSaveError((await readErrorMessage(res)) ?? SAVE_FAILURE_MESSAGE);
    } catch {
      setSaveError(SAVE_FAILURE_MESSAGE);
    } finally {
      setSaving(false);
    }
  };

  if (loading && !detail) {
    return <div className="text-center py-12 text-gray-500">読み込み中...</div>;
  }
  if (loadError || !detail || !status) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4" role="alert">
          {loadError ?? LOAD_FAILURE_MESSAGE}
        </div>
        <Link href="/admin/data-requests" className="text-sm text-orange-600 hover:underline">
          一覧に戻る
        </Link>
      </div>
    );
  }

  const editable = isEditable(detail.status);
  const disabled = !editable || saving;

  return (
    <div className="max-w-4xl mx-auto space-y-6" data-testid="admin-dsr-detail">
      <div>
        <Link href="/admin/data-requests" className="text-sm text-orange-600 hover:underline">
          ← 一覧に戻る
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-gray-900">
          {DSR_REQUEST_TYPE_LABELS[detail.request_type]}の請求
          <span className="ml-2 text-base font-mono text-gray-500">#{shortDsrId(detail.id)}</span>
        </h1>
      </div>

      <section className="bg-white rounded-lg shadow p-4">
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <div>
            <dt className="text-gray-500">状態</dt>
            <dd className="text-gray-900" data-testid="admin-dsr-status">
              {DSR_STATUS_LABELS[detail.status]}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">請求者</dt>
            <dd className="text-gray-900" data-testid="admin-dsr-requester">
              {detail.requester ? (
                <>
                  <span>{detail.requester.nickname ?? '(ニックネームなし)'}</span>
                  {detail.requester.email && <span className="ml-2 text-gray-600">{detail.requester.email}</span>}
                  <Link
                    href={`/admin/users/${detail.requester.user_id}`}
                    className="ml-2 font-mono text-xs text-orange-600 hover:underline"
                  >
                    {detail.requester.user_id}
                  </Link>
                </>
              ) : (
                '退会済み'
              )}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">本人確認</dt>
            <dd className="text-gray-900">
              {detail.verified_at ? `確認済み (${formatDateTime(detail.verified_at)})` : '未確認'} ・ 方法:{' '}
              {detail.verification_method === 'email_link' ? 'メールのリンク' : detail.verification_method} ・ 確認メールの送信{' '}
              {detail.verification_send_count} 回
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">応答期限</dt>
            <dd
              data-testid="admin-dsr-due"
              data-overdue={detail.overdue ? 'true' : 'false'}
              className={detail.overdue ? 'text-red-600 font-semibold' : 'text-gray-900'}
            >
              {formatDateTime(detail.due_at)}
              {detail.overdue && <span className="ml-1">(期限超過)</span>}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">作成</dt>
            <dd className="text-gray-900">{formatDateTime(detail.created_at)}</dd>
          </div>
          <div>
            <dt className="text-gray-500">終了</dt>
            <dd className="text-gray-900">{formatDateTime(detail.resolved_at)}</dd>
          </div>
        </dl>
        <div className="mt-4">
          <h2 className="text-sm text-gray-500">請求の内容</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm text-gray-900" data-testid="admin-dsr-details">
            {detail.details}
          </p>
        </div>
      </section>

      <section className="bg-orange-50 border border-orange-200 rounded-lg p-4" data-testid="admin-dsr-guide">
        <h2 className="text-sm font-semibold text-gray-900">対応の手段</h2>
        <p className="mt-1 text-sm text-gray-700">{HANDLING_GUIDES[detail.request_type]}</p>
        {detail.requester && (detail.request_type === 'disclosure' || detail.request_type === 'correction') && (
          <Link
            href={`/admin/users/${detail.requester.user_id}`}
            className="mt-2 inline-block text-sm text-orange-600 hover:underline"
          >
            利用者詳細を開く
          </Link>
        )}
      </section>

      <section className="bg-white rounded-lg shadow p-4 space-y-4">
        {!editable && (
          <p className="text-sm text-gray-600" data-testid="admin-dsr-read-only">
            {READ_ONLY_NOTICE}
          </p>
        )}
        <div>
          <label htmlFor="admin-dsr-status-select" className="block text-sm text-gray-500">
            状態
          </label>
          <select
            id="admin-dsr-status-select"
            data-testid="admin-dsr-status-select"
            value={status}
            disabled={disabled}
            onChange={(e) => setStatus(e.target.value as DsrStatus)}
            className="mt-1 text-sm border border-gray-300 rounded px-2 py-1 disabled:bg-gray-100"
          >
            {statusOptions(detail.status).map((option) => (
              <option
                key={option}
                value={option}
                disabled={option !== detail.status && !findDsrTransition('operator', detail.status, option)}
              >
                {DSR_STATUS_LABELS[option]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="admin-dsr-response-note" className="block text-sm text-gray-500">
            本人への応答 (本人が設定画面で読みます。対応済み・対応できずにするときは必須)
          </label>
          <textarea
            id="admin-dsr-response-note"
            data-testid="admin-dsr-response-note"
            value={responseNote}
            disabled={disabled}
            maxLength={DSR_NOTE_MAX_LENGTH}
            rows={RESPONSE_NOTE_ROWS}
            onChange={(e) => setResponseNote(e.target.value)}
            className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1 disabled:bg-gray-100"
          />
        </div>
        <div>
          <label htmlFor="admin-dsr-admin-notes" className="block text-sm text-gray-500">
            内部メモ (本人には見せません)
          </label>
          <textarea
            id="admin-dsr-admin-notes"
            data-testid="admin-dsr-admin-notes"
            value={adminNotes}
            disabled={disabled}
            maxLength={DSR_NOTE_MAX_LENGTH}
            rows={ADMIN_NOTES_ROWS}
            onChange={(e) => setAdminNotes(e.target.value)}
            className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1 disabled:bg-gray-100"
          />
        </div>
        {saveError && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded" role="alert" data-testid="admin-dsr-save-error">
            {saveError}
          </div>
        )}
        {saved && !saveError && (
          <p className="text-sm text-green-700" role="status">
            {SAVED_MESSAGE}
          </p>
        )}
        <button
          type="button"
          data-testid="admin-dsr-save"
          onClick={() => void handleSave()}
          disabled={disabled}
          className="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600 disabled:opacity-50"
        >
          {saving ? '保存中...' : '保存'}
        </button>
      </section>
    </div>
  );
}
