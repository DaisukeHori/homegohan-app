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
import { extractApiErrorMessage, forbiddenMessageForScreen } from '@/lib/admin/api-error-message';
import { formatJstDateTime } from '@/lib/admin/format-datetime';
import {
  ADMIN_ACTION_NO_RESPONSE_STATUSES,
  adminActionNoResponseSummary,
  adminCreateUnconfirmedMessage,
} from '@/lib/admin/admin-screen-messages';
import {
  ADMIN_CREATE_REOPEN_TO_RETRY_GUIDE,
  adminCreateFoundGuide,
  adminCreateNoResponseMessage,
  adminCreateNotFoundGuide,
  confirmCreatedRow,
} from '@/lib/admin/admin-create-no-response';

/** GET /api/announcements が返す 1 件 (この画面で使う列だけ。content は作成の応答を受け取れなかったときの読み直しで比べる。#2101 X2) */
interface Announcement {
  id: string;
  title: string;
  content: string | null;
  is_public: boolean | null;
  published_at: string | null;
  created_at: string | null;
}

const LOAD_ERROR = 'お知らせ一覧を取得できませんでした。しばらくしてから、もう一度お試しください。';
const CREATE_ERROR = 'お知らせを作成できませんでした。しばらくしてから、もう一度お試しください。';
const UNAUTHENTICATED_ERROR = 'ログインの有効期限が切れました。ログインし直してください。';
const FORBIDDEN_ERROR = '権限がありません。';
/** 応答を受け取れなかったときの文の操作の名前 (「お知らせの作成の応答を受け取れませんでした（通信エラー）」。#2101 X2) */
const CREATE_ACTION = 'お知らせの作成';
/** 読み直したときの文の対象の名前 (「読み込み直したところ、お知らせは保存されていました」。#2101 X2) */
const CREATE_SUBJECT = 'お知らせ';
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/** 送ったお知らせ (前後の空白を除いた値。route はこの値をそのまま insert する) */
interface SentAnnouncement {
  readonly title: string;
  readonly content: string;
  readonly isPublic: boolean;
}

/**
 * 作成の応答を受け取れなかった (サーバーで済んだか分からない) お知らせ (#2101 X2)。これがあるあいだは送信を止める。
 *   - retryable: 「確かめ直す」で読み直せば決まりうるか (読み直しの失敗が通信・サーバーの一時的なもの)。
 *     読み直しが 401 / 403 (押しても必ず失敗する) と、比べる元が無くて決められない (ambiguous) ときは false
 */
interface UnconfirmedCreate {
  readonly sent: SentAnnouncement;
  readonly knownIds: ReadonlySet<string> | null;
  readonly summary: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** お知らせの一覧の読み込みの失敗 (画面に出す文を持つ。status は HTTP の失敗のときだけ) */
class AnnouncementListLoadError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'AnnouncementListLoadError';
    this.status = status;
  }
}

/** 読み直したお知らせが、送ったお知らせと同じ内容か (公開の設定も比べる。route は is_public に送った値をそのまま書く) */
function isSameAnnouncement(row: Announcement, sent: SentAnnouncement): boolean {
  return row.title === sent.title && row.content === sent.content && (row.is_public ?? false) === sent.isPublic;
}

/**
 * 失敗した応答のステータスから、画面に出す文言を決める (API の生のエラー文は出さない)。
 * 403 だけは、本文の文が理由の文 (二段階認証の確認が要る・凍結) ならその文を出す (forbiddenMessageForScreen。#1917)
 */
function failureMessage(status: number, fallback: string, body: unknown): string {
  if (status === 401) return UNAUTHENTICATED_ERROR;
  if (status === 403) return forbiddenMessageForScreen(body, FORBIDDEN_ERROR);
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

  // 作成の応答を受け取れなかった (済んだか分からない) お知らせ (#2101 X2)。これがあるあいだは送信を止める。
  // ref は再描画の前に続けて押されたときの守り
  const [unconfirmed, setUnconfirmed] = useState<UnconfirmedCreate | null>(null);
  const unconfirmedRef = useRef<UnconfirmedCreate | null>(null);
  // 送信と、そのあとの読み直しを待っているあいだは true (再描画の前に続けて押されたときも送らない守り。#2101 X2)
  const submitLockedRef = useRef(false);

  // 一覧を読み込むたびに増やす通し番号。遅れて届いた古い応答で、新しい一覧を上書きしないために使う
  const latestLoad = useRef(0);
  // 最後に失敗した一覧の読み込みの HTTP ステータス (通信の失敗・形の違いは null)。読み直しの 401 / 403 を見分ける (#2101 X2)
  const lastLoadFailureStatus = useRef<number | null>(null);

  /**
   * 一覧を読み、画面に出して返す。読めなかったときは画面に文を出して null を返す。
   * あとから出した読み込みに追い越されたら (遅れて届いた古い応答)、画面を変えずに undefined を返す
   */
  const loadAnnouncements = useCallback(async (): Promise<Announcement[] | null | undefined> => {
    const loadId = ++latestLoad.current;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/announcements');
      // 失敗の本文は 403 の理由の文を読むためだけに読む (読めなければ null)
      const body: unknown = res.ok ? await res.json() : await res.json().catch(() => null);
      if (loadId !== latestLoad.current) return undefined;

      if (!res.ok) throw new AnnouncementListLoadError(failureMessage(res.status, LOAD_ERROR, body), res.status);
      const list = (body as { announcements?: unknown } | null)?.announcements;
      // 想定外の形を「お知らせが 0 件」と見せない
      if (!Array.isArray(list)) throw new AnnouncementListLoadError(LOAD_ERROR, null);
      const sorted = newestFirst(list as Announcement[]);
      setAnnouncements(sorted);
      return sorted;
    } catch (error: unknown) {
      if (loadId !== latestLoad.current) return undefined;
      setLoadError(error instanceof AnnouncementListLoadError ? error.message : LOAD_ERROR);
      lastLoadFailureStatus.current = error instanceof AnnouncementListLoadError ? error.status : null;
      return null;
    } finally {
      if (loadId === latestLoad.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAnnouncements();
  }, [loadAnnouncements]);

  const markUnconfirmed = (pending: UnconfirmedCreate | null) => {
    unconfirmedRef.current = pending;
    setUnconfirmed(pending);
  };

  /** 作成が済んだ (応答で・読み直しで) ときに入力を空にする */
  const clearForm = () => {
    setTitle('');
    setContent('');
    setIsPublic(false);
  };

  /**
   * 作成の応答を受け取れなかったあと、一覧を読み直して送ったお知らせができていたかを確かめる (#2101 X2)。
   * できていれば済んだとして入力を空にし、無ければ入力を残して押し直せるようにする。
   * 読み直しにも失敗した・前からあった行か決められないときは、送信を止める
   */
  const confirmUnconfirmedCreate = async (pending: Omit<UnconfirmedCreate, 'message' | 'retryable'>) => {
    const reloaded = await loadAnnouncements();
    if (reloaded === undefined || reloaded === null) {
      // 読み直せなかった (あとから出した読み込みに追い越されたときも、この読み直しでは確かめられていない)。送信を止める。
      // 401 / 403 は読み直しても必ず失敗するので「確かめ直す」を出さない (理由の文は一覧の欄に出ている)
      const status = reloaded === null ? lastLoadFailureStatus.current : null;
      markUnconfirmed({
        ...pending,
        message: adminCreateUnconfirmedMessage(pending.summary),
        retryable: status !== HTTP_UNAUTHORIZED && status !== HTTP_FORBIDDEN,
      });
      return;
    }
    const outcome = confirmCreatedRow(reloaded, pending.knownIds, (row) => isSameAnnouncement(row, pending.sent));
    if (outcome === 'ambiguous') {
      markUnconfirmed({
        ...pending,
        message: adminCreateNoResponseMessage(adminCreateUnconfirmedMessage(pending.summary), ADMIN_CREATE_REOPEN_TO_RETRY_GUIDE),
        retryable: false,
      });
      return;
    }
    markUnconfirmed(null);
    if (outcome === 'created') {
      clearForm();
      setFormError(null);
      setNotice(adminCreateNoResponseMessage(pending.summary, adminCreateFoundGuide(CREATE_SUBJECT)));
      return;
    }
    setFormError(adminCreateNoResponseMessage(pending.summary, adminCreateNotFoundGuide(CREATE_SUBJECT)));
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || submitLockedRef.current || unconfirmedRef.current !== null) return;

    setFormError(null);
    setNotice(null);

    const trimmedTitle = title.trim();
    const trimmedContent = content.trim();
    if (trimmedTitle === '' || trimmedContent === '') {
      setFormError('タイトルと本文を入力してください。');
      return;
    }

    const sent: SentAnnouncement = { title: trimmedTitle, content: trimmedContent, isPublic };
    // 応答を受け取れなかったときに、読み直した一覧と比べるための、送る前の一覧の行 (読めていなければ null。#2101 X2)
    const knownIds: ReadonlySet<string> | null =
      announcements === null ? null : new Set(announcements.map((announcement) => announcement.id));
    submitLockedRef.current = true;
    setSubmitting(true);
    let created = false;
    // 応答を受け取れなかった (サーバーで済んだか分からない) ときの文の頭 (#2101 X2)
    let noResponseSummary: string | null = null;
    try {
      // 通信そのものが失敗 (fetch の reject) したら null
      let res: Response | null;
      try {
        res = await fetch('/api/announcements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: sent.title, content: sent.content, isPublic: sent.isPublic }),
        });
      } catch {
        res = null;
      }
      if (res === null) {
        // 通信そのものの失敗。サーバーが作ってから応答が切れたこともあるので、失敗とは言わずに読み直す (#2101 X2)
        noResponseSummary = adminActionNoResponseSummary(CREATE_ACTION, null);
      } else if (res.ok) {
        created = true;
      } else if (res.status === 400) {
        // 入力の誤り: API が返したメッセージをそのまま出す
        const body: unknown = await res.json().catch(() => null);
        setFormError(extractApiErrorMessage(body) ?? CREATE_ERROR);
      } else {
        const body: unknown = await res.json().catch(() => null);
        if (extractApiErrorMessage(body) === null && ADMIN_ACTION_NO_RESPONSE_STATUSES.includes(res.status)) {
          // 本文に API の文の無い 502 / 503 / 504 は、手前のプロキシ・ホスティングの応答 (関数の時間切れなど)。
          // サーバーで済んだか分からないので、失敗とは言わずに読み直す (#2101 X2)
          noResponseSummary = adminActionNoResponseSummary(CREATE_ACTION, res.status);
        } else {
          setFormError(failureMessage(res.status, CREATE_ERROR, body));
        }
      }
      if (noResponseSummary !== null) {
        await confirmUnconfirmedCreate({ sent, knownIds, summary: noResponseSummary });
      }
    } catch {
      setFormError(CREATE_ERROR);
    } finally {
      submitLockedRef.current = false;
      setSubmitting(false);
    }

    if (created) {
      clearForm();
      setNotice(sent.isPublic ? 'お知らせを公開しました。' : 'お知らせを下書きとして保存しました。');
      await loadAnnouncements();
    }
  }

  /** 「確かめ直す」: 済んだか分からない作成を、一覧を読み直して確かめる (#2101 X2) */
  async function handleRetryConfirm() {
    const pending = unconfirmedRef.current;
    if (pending === null || !pending.retryable || submitLockedRef.current) return;
    submitLockedRef.current = true;
    setSubmitting(true);
    try {
      await confirmUnconfirmedCreate(pending);
    } finally {
      submitLockedRef.current = false;
      setSubmitting(false);
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
          {unconfirmed && (
            <div
              role="alert"
              className="flex items-center justify-between gap-4 rounded border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800"
            >
              <span>{unconfirmed.message}</span>
              {unconfirmed.retryable && (
                <button
                  type="button"
                  onClick={() => void handleRetryConfirm()}
                  disabled={submitting}
                  className="shrink-0 rounded border border-yellow-300 bg-white px-3 py-1 text-sm font-medium text-yellow-800 hover:bg-yellow-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  確かめ直す
                </button>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || unconfirmed !== null}
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
