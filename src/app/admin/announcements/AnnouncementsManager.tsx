'use client';

/**
 * お知らせ管理の本体 (一覧 + 新規作成)
 * operator/03-ui-spec.md §21 準拠
 *
 * 権限 (admin / super_admin) の確認は、同じフォルダの page.tsx (サーバー) で行う。
 * API (GET / POST /api/announcements) も、同じロールだけを通す。
 *
 * API には、お知らせの編集・削除・「下書きを後から公開」が無い。この画面でできるのは、
 * 一覧の確認と新規作成だけ。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { extractApiErrorMessage } from '@/lib/admin/api-error-message';
import { formatJstDateTime } from '@/lib/admin/format-datetime';

/** GET /api/announcements が返す 1 件 (この画面で使う列だけ) */
interface Announcement {
  id: string;
  title: string;
  is_public: boolean | null;
  published_at: string | null;
  created_at: string | null;
}

const LOAD_ERROR = 'お知らせ一覧を取得できませんでした。しばらくしてから、もう一度お試しください。';
const CREATE_ERROR = 'お知らせを作成できませんでした。しばらくしてから、もう一度お試しください。';
const UNAUTHENTICATED_ERROR = 'ログインの有効期限が切れました。ログインし直してください。';
const FORBIDDEN_ERROR = '権限がありません。';

/** 失敗した応答のステータスから、画面に出す文言を決める (API の生のエラー文は出さない) */
function failureMessage(status: number, fallback: string): string {
  if (status === 401) return UNAUTHENTICATED_ERROR;
  if (status === 403) return FORBIDDEN_ERROR;
  return fallback;
}

/** 作成日時を数値にする。無い・読めないものは、いちばん古い扱い */
function createdAtMs(announcement: Announcement): number {
  const ms = announcement.created_at ? Date.parse(announcement.created_at) : Number.NaN;
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * 作成が新しい順に並べる (同じ日時なら API が返した順のまま)。
 * API も新しい順で返すが、この画面の約束 (一覧は新しい順) なので、ここでも守る。
 */
function newestFirst(list: Announcement[]): Announcement[] {
  return [...list].sort((a, b) => {
    const left = createdAtMs(a);
    const right = createdAtMs(b);
    return left === right ? 0 : right > left ? 1 : -1;
  });
}

export default function AnnouncementsManager() {
  const [announcements, setAnnouncements] = useState<Announcement[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 一覧を読み込むたびに増やす通し番号。遅れて届いた古い応答で、新しい一覧を上書きしないために使う
  const latestLoad = useRef(0);

  const loadAnnouncements = useCallback(async () => {
    const loadId = ++latestLoad.current;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/announcements');
      const body: unknown = res.ok ? await res.json() : null;
      if (loadId !== latestLoad.current) return;

      if (!res.ok) {
        setLoadError(failureMessage(res.status, LOAD_ERROR));
        return;
      }
      const list = (body as { announcements?: unknown } | null)?.announcements;
      if (!Array.isArray(list)) {
        // 想定外の形を「お知らせが 0 件」と見せない
        setLoadError(LOAD_ERROR);
        return;
      }
      setAnnouncements(newestFirst(list as Announcement[]));
    } catch {
      if (loadId === latestLoad.current) setLoadError(LOAD_ERROR);
    } finally {
      if (loadId === latestLoad.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAnnouncements();
  }, [loadAnnouncements]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setFormError(null);
    setNotice(null);

    const trimmedTitle = title.trim();
    const trimmedContent = content.trim();
    if (trimmedTitle === '' || trimmedContent === '') {
      setFormError('タイトルと本文を入力してください。');
      return;
    }

    const publishing = isPublic;
    setSubmitting(true);
    let created = false;
    try {
      const res = await fetch('/api/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmedTitle, content: trimmedContent, isPublic: publishing }),
      });
      if (res.ok) {
        created = true;
      } else if (res.status === 400) {
        // 入力の誤り: API が返したメッセージをそのまま出す
        const body: unknown = await res.json().catch(() => null);
        setFormError(extractApiErrorMessage(body) ?? CREATE_ERROR);
      } else {
        setFormError(failureMessage(res.status, CREATE_ERROR));
      }
    } catch {
      setFormError(CREATE_ERROR);
    } finally {
      setSubmitting(false);
    }

    if (created) {
      setTitle('');
      setContent('');
      setIsPublic(false);
      setNotice(publishing ? 'お知らせを公開しました。' : 'お知らせを下書きとして保存しました。');
      await loadAnnouncements();
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">お知らせ管理</h1>
        {announcements && (
          <span className="text-sm text-gray-500">全 {announcements.length.toLocaleString()} 件</span>
        )}
      </div>

      {/* 新規作成 */}
      <section
        aria-labelledby="announcement-create-heading"
        className="mb-8 rounded-lg border border-gray-200 bg-white p-5"
      >
        <h2 id="announcement-create-heading" className="mb-4 text-base font-semibold text-gray-900">
          お知らせを作成
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="announcement-title" className="mb-1 block text-sm font-medium text-gray-700">
              タイトル <span aria-hidden="true" className="text-red-600">*</span>
            </label>
            <input
              id="announcement-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              disabled={submitting}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-100"
            />
          </div>

          <div>
            <label htmlFor="announcement-content" className="mb-1 block text-sm font-medium text-gray-700">
              本文 <span aria-hidden="true" className="text-red-600">*</span>
            </label>
            <textarea
              id="announcement-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              required
              rows={5}
              disabled={submitting}
              className="w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-gray-100"
            />
          </div>

          <div className="flex items-start gap-2">
            <input
              id="announcement-is-public"
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
              disabled={submitting}
              aria-describedby="announcement-is-public-help"
              className="mt-1 h-4 w-4 rounded border-gray-300 text-orange-600 focus:ring-orange-500"
            />
            <div>
              <label htmlFor="announcement-is-public" className="text-sm font-medium text-gray-700">
                公開する
              </label>
              <p id="announcement-is-public-help" className="text-xs text-gray-500">
                公開すると、利用者のホーム画面に表示されます。作成したあと、この画面から編集・削除はできません。
              </p>
            </div>
          </div>

          {formError && (
            <p role="alert" className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {formError}
            </p>
          )}
          {notice && (
            <p role="status" className="rounded border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
              {notice}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-orange-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? '作成中...' : '作成する'}
          </button>
        </form>
      </section>

      {/* 一覧 */}
      <section aria-labelledby="announcement-list-heading" aria-busy={loading}>
        <h2 id="announcement-list-heading" className="mb-3 text-base font-semibold text-gray-900">
          お知らせ一覧
        </h2>

        {loadError && (
          <div
            role="alert"
            className="mb-4 flex items-center justify-between gap-4 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            <span>{loadError}</span>
            <button
              type="button"
              onClick={() => void loadAnnouncements()}
              className="shrink-0 rounded border border-red-300 bg-white px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-50"
            >
              再読み込み
            </button>
          </div>
        )}

        {announcements === null ? (
          loading && (
            <p role="status" className="py-8 text-center text-sm text-gray-500">
              読み込み中...
            </p>
          )
        ) : announcements.length === 0 ? (
          <p className="rounded-lg border border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-500">
            お知らせはまだありません
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <caption className="sr-only">お知らせの一覧 (作成が新しい順)</caption>
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-600">
                    タイトル
                  </th>
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-600">
                    状態
                  </th>
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-600">
                    公開日時
                  </th>
                  <th scope="col" className="px-4 py-3 text-left font-medium text-gray-600">
                    作成日時
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {announcements.map((announcement) => (
                  <tr key={announcement.id}>
                    <td className="px-4 py-3 font-medium text-gray-900">{announcement.title}</td>
                    <td className="px-4 py-3">
                      {announcement.is_public ? (
                        <span className="inline-block rounded bg-green-50 px-2 py-0.5 text-xs font-medium text-green-800">
                          公開
                        </span>
                      ) : (
                        <span className="inline-block rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                          下書き
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">{formatJstDateTime(announcement.published_at)}</td>
                    <td className="px-4 py-3 text-xs text-gray-600">{formatJstDateTime(announcement.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
