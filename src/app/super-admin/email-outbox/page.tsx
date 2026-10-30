'use client';

/**
 * /super-admin/email-outbox — メールの送信待ち (email_outbox) の一覧と再送 (#1708 / #1193)
 *
 * 正本: docs/design/operator/10-logs-and-mail-retry.md §9.2。
 * GET /api/super-admin/email-outbox を呼んで、アプリが送るメールの送信待ち・送信済み・届けられなかったもの (dead) を
 * 新しい順に表示する。dead の行は「再送」で送信待ちに戻せる (POST /api/super-admin/email-outbox/[id]/requeue)。
 * 権限は layout.tsx (requireRoleForPage(['super_admin'], ...)) と API の両方で見ている。
 *
 * - 宛先は API がマスクした形 (t***@example.com) だけを表示する。件名・本文は API が返さない。
 * - 宛先を伏せた行 (退会した人宛・秘密を含む文面の送信後) は再送できない (ボタンを無効にして理由を出す)。
 * - 絞り込み: 状態 (既定は届けられなかったもの) と文面の名前 (完全一致)。「絞り込む」で反映する。
 * - ページ送り: 「さらに読み込む」で、API が返したカーソルを渡して続きを足す。
 * - 日時は日本時間で表示する。
 * - 「再送」の通信そのものが失敗した (fetch が reject した) ときは、サーバーが再送を済ませてから応答が切れたこともあるので、
 *   一覧を読み直して今の状態を見せ、「「<文面の名前>」の再送の応答を受け取れませんでした（通信エラー）」の文を出す (#2073)。
 *   読み直さないと、行は「届けられなかった」のまま残り、もう一度押すと、自分の再送が済んでいたのに 409
 *   「届けられなかったメールだけを再送できます」が出る。読み直しは一覧を外さずに行い (先頭の 1 ページを取り直す)、
 *   失敗したら「再試行」を出し、読み直せるまで「再送」を止める (一覧の状態が古いかもしれないため)。
 * - 再送は 1 行ずつ行い、一覧の読み込みと重ねない (#2073): 再送の応答 (reject のときは、そのあとの一覧の読み直しまで) を
 *   待つあいだは、すべての行の「再送」と「絞り込む」「再読み込み」「さらに読み込む」「再試行」を止め、一覧を読み込むあいだは
 *   すべての行の「再送」を止める。重ねると、再送の書き込みより先にサーバーが読んだ一覧 (その行がまだ「届けられなかった」) が
 *   あとから届いて、再送の成功の描き替えと知らせを上書きし、もう一度押すと、自分の再送が済んでいたのに 409
 *   「届けられなかったメールだけを再送できます」が出る (読み直しの最中にほかの行を再送したときなど)。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { forbiddenMessageForScreen } from '@/lib/admin/api-error-message';
import { rereadUnavailableMessage } from '@/lib/super-admin/detail-reread';
import {
  NO_RESPONSE_LIST_RELOADED_GUIDE,
  NO_RESPONSE_LIST_RELOAD_FAILED_GUIDE,
  statusChangeNoResponseMessage,
} from '@/lib/super-admin/status-change-no-response';
// 型だけを import する (値を import すると zod とメール送信のモジュールがブラウザ向けの bundle に入る)
import type {
  EmailOutboxListItem,
  EmailOutboxListResponse,
  EmailOutboxListStatus,
} from '@/lib/super-admin/email-outbox';

/** 1 回に読み込む行数 (API の既定と同じ) */
const PAGE_SIZE = 50;

/** 状態の選択肢 (画面の並び。既定は届けられなかったもの) */
const STATUS_OPTIONS: ReadonlyArray<{ value: EmailOutboxListStatus; label: string }> = [
  { value: 'dead', label: '届けられなかった' },
  { value: 'queued', label: '送信待ち' },
  { value: 'sent', label: '送信済み' },
];
const DEFAULT_STATUS: EmailOutboxListStatus = 'dead';

const STATUS_LABELS: Record<EmailOutboxListStatus, string> = {
  dead: '届けられなかった',
  queued: '送信待ち',
  sent: '送信済み',
};

const STATUS_STYLES: Record<EmailOutboxListStatus, string> = {
  dead: 'bg-red-100 text-red-700',
  queued: 'bg-amber-100 text-amber-800',
  sent: 'bg-green-100 text-green-700',
};

const REDACTED_REQUEUE_NOTE = '宛先を伏せた行は再送できません';
const REQUEUED_MESSAGE = '再送を受け付けました';
const LIST_NETWORK_FAILURE_MESSAGE = '通信に失敗しました。ネットワークを確認して、もう一度お試しください';

const INPUT_CLASS =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500';
const PRIMARY_BUTTON_CLASS =
  'px-4 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const SECONDARY_BUTTON_CLASS =
  'px-4 py-2 bg-white text-slate-700 border border-slate-300 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const NOTICE_RETRY_BUTTON_CLASS =
  'shrink-0 px-3 py-1.5 bg-amber-600 text-white rounded-lg text-sm font-semibold hover:bg-amber-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const ROW_BUTTON_CLASS =
  'px-3 py-1 bg-white text-orange-600 border border-orange-300 rounded-lg text-xs font-medium hover:bg-orange-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';

// ── 絞り込み条件 ──────────────────────────────────────────────────────────

interface Filters {
  status: EmailOutboxListStatus;
  template: string;
}

const DEFAULT_FILTERS: Filters = { status: DEFAULT_STATUS, template: '' };

function buildQuery(filters: Filters, cursor: string | null): string {
  const params = new URLSearchParams();
  params.set('status', filters.status);
  if (filters.template.trim()) params.set('template', filters.template.trim());
  if (cursor) params.set('cursor', cursor);
  params.set('limit', String(PAGE_SIZE));
  return params.toString();
}

// ── 表示 ──────────────────────────────────────────────────────────────────

const JST_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function formatJst(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : JST_FORMAT.format(date);
}

/** 状態に応じた「次の試行 / 送信 / 失敗」の日時と、その見出し */
function eventOf(item: EmailOutboxListItem): { label: string; at: string | null } {
  if (item.status === 'sent') return { label: '送信', at: item.sent_at };
  if (item.status === 'dead') return { label: '失敗', at: item.dead_at };
  return { label: '次の試行', at: item.next_attempt_at };
}

function StatusBadge({ status }: { status: EmailOutboxListStatus }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

// ── ページ ────────────────────────────────────────────────────────────────

type LoadStatus = 'loading' | 'loading-more' | 'idle';

interface ApiErrorBody {
  error?: { message?: string };
}

/**
 * 失敗した応答を、運用者に分かる説明にする。401 / 403 の API のメッセージは使わない。
 * ただし 403 の本文の文が理由の文 (二段階認証の確認が要る・凍結) なら、その文を出す (forbiddenMessageForScreen。#1917)
 */
function describeFailure(status: number, body: ApiErrorBody | null): string {
  if (status === 401) return 'ログインの有効期限が切れています。ログインし直してください';
  if (status === 403) return forbiddenMessageForScreen(body, 'この画面を見る権限がありません (super_admin のみ)');
  return body?.error?.message ?? `読み込みに失敗しました (HTTP ${status})`;
}

/**
 * 再送の結果の知らせ。
 *   - success / error: 応答を受け取れたときの結果
 *   - no-response    : 再送の通信が reject されたあとに一覧を読み直した (#2073)。template は押した行の文面の名前。
 *                      reload は一覧の読み直しの結果 (RereadOutcome)
 */
type Notice =
  | { kind: 'success' | 'error'; text: string }
  | { kind: 'no-response'; template: string; reload: RereadOutcome }
  | null;

/**
 * 再送の通信が reject されたあとの一覧の読み直しの結果 (#2073・#2101 X4)。
 *   - loaded     : 読み直せた
 *   - failed     : 読み直せなかった (500・通信の reject・本文が読めない)。「再試行」を出し、読み直せるまで「再送」を止める
 *   - unavailable: 401 / 403 で断られた。読み込み直しても変わらないので、理由の文 (message) を出し、「再試行」は出さず、止めない
 *                  (機能フラグの一覧の読み直しと同じ。#2093 W6)
 */
type RereadOutcome = { kind: 'loaded' } | { kind: 'failed' } | { kind: 'unavailable'; message: string };

function noResponseNoticeText(notice: { template: string; reload: RereadOutcome }): string {
  const guide =
    notice.reload.kind === 'loaded'
      ? NO_RESPONSE_LIST_RELOADED_GUIDE
      : notice.reload.kind === 'failed'
        ? NO_RESPONSE_LIST_RELOAD_FAILED_GUIDE
        : notice.reload.message;
  return statusChangeNoResponseMessage(`「${notice.template}」の再送`, guide);
}

/**
 * 一覧の読み込みの結果。superseded は、あとから出した読み込みに追い越された (画面はその読み込みが進める)。
 * unavailable は読み直し (reread) が 401 / 403 で断られた (読み込み直しても変わらない理由の文つき。#2101 X4)
 */
type LoadOutcome = RereadOutcome | { kind: 'superseded' };

/**
 * 一覧の読み込みの出し方。reread は、再送の通信が reject されたあとの読み直し (#2073):
 * 読み込むあいだも今の一覧と知らせを外さず、失敗しても一覧を残す (文は呼び出し側が知らせに出すので、一覧の失敗の文は出さない)
 */
interface LoadOptions {
  reread?: boolean;
}

export default function EmailOutboxPage() {
  /** 入力中の条件 */
  const [draft, setDraft] = useState<Filters>(DEFAULT_FILTERS);
  const [items, setItems] = useState<EmailOutboxListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  /** 一覧の読み込みの状態の写し (描画を待たずに handler で読むため。status と一緒に changeStatus で変える) */
  const statusRef = useRef<LoadStatus>('loading');
  const changeStatus = useCallback((next: LoadStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);
  // 再送の書き込み (POST の応答と、通信が reject されたあとの一覧の読み直しまで) を待っているか (#2073)。
  // 待つあいだは、すべての行の「再送」(二重に押させない・ほかの行も) と一覧の読み込みのボタンを止める (ファイルの冒頭の説明)。
  // ref は描画を待たずに handler で読むための写し (再描画の前に続けて押されたときの守り)
  const writeInFlightRef = useRef(false);
  const [isWriting, setIsWriting] = useState(false);
  /** 一覧の読み込み (先頭から・続き・読み直し) か再送の書き込みを待っているか (ref で見るので、再描画の前でも止まる) */
  const isBusyNow = useCallback(() => statusRef.current !== 'idle' || writeInFlightRef.current, []);
  /** 最後に出した一覧のリクエストの番号。遅れて返ってきた古い応答で画面を上書きしないために使う */
  const requestSeq = useRef(0);
  /**
   * 表示中の一覧を取るのに使った条件 (「絞り込む」で入れる)。「再読み込み」「さらに読み込む」と、再送の reject のあとの
   * 読み直しはこちらを使う (入力中の draft は使わない)。handler で描画を待たずに読むため ref で持つ
   */
  const appliedRef = useRef<Filters>(DEFAULT_FILTERS);
  // 再送の通信の reject のあとの一覧の読み直しが失敗し、まだ読み直せていないか (#2073)。そのあいだは「再送」を止める。
  // ref は描画を待たずに handler で読むための写し
  const listStaleRef = useRef(false);
  const [isListStale, setIsListStale] = useState(false);
  const markListStale = useCallback((stale: boolean) => {
    listStaleRef.current = stale;
    setIsListStale(stale);
  }, []);

  const load = useCallback(
    async (filters: Filters, cursor: string | null, options: LoadOptions = {}): Promise<LoadOutcome> => {
      const reread = options.reread === true;
      requestSeq.current += 1;
      const seq = requestSeq.current;
      changeStatus(cursor ? 'loading-more' : 'loading');
      setError(null);
      if (!cursor && !reread) {
        setItems([]);
        setNextCursor(null);
        setNotice(null);
      }
      try {
        const res = await fetch(`/api/super-admin/email-outbox?${buildQuery(filters, cursor)}`, { cache: 'no-store' });
        const body = (await res.json().catch(() => null)) as (Partial<EmailOutboxListResponse> & ApiErrorBody) | null;
        if (seq !== requestSeq.current) return { kind: 'superseded' };
        if (!res.ok || !body?.data || !body.meta) {
          if (!reread) setError(describeFailure(res.status, body));
          changeStatus('idle');
          // 読み直しが 401 / 403 なら、読み込み直しても変わらない理由を返す (一覧の 404 は行の消えたことを意味しないので failed。#2101 X4)
          const unavailableMessage = reread && !res.ok ? rereadUnavailableMessage(res.status, body, null) : null;
          return unavailableMessage === null ? { kind: 'failed' } : { kind: 'unavailable', message: unavailableMessage };
        }
        const rows = body.data;
        setItems((prev) => (cursor ? [...prev, ...rows] : rows));
        setNextCursor(body.meta.next_cursor ?? null);
        // 先頭から読み直せたので、一覧はもう古くない (#2073)
        if (!cursor) markListStale(false);
        changeStatus('idle');
        return { kind: 'loaded' };
      } catch {
        if (seq !== requestSeq.current) return { kind: 'superseded' };
        if (!reread) setError(LIST_NETWORK_FAILURE_MESSAGE);
        changeStatus('idle');
        return { kind: 'failed' };
      }
    },
    [markListStale, changeStatus],
  );

  useEffect(() => {
    void load(DEFAULT_FILTERS, null);
  }, [load]);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // 一覧の読み込み・再送の書き込みを待つあいだは読み込まない (再送より先に読まれた一覧で、再送の結果を上書きしうる。#2073)
    if (isBusyNow()) return;
    appliedRef.current = draft;
    void load(draft, null);
  };

  /** 「再読み込み」。一覧の読み込み・再送の書き込みを待つあいだは読み込まない (handleSubmit と同じ。#2073) */
  const reloadList = () => {
    if (isBusyNow()) return;
    void load(appliedRef.current, null);
  };

  /**
   * 再送の通信が reject されたあとの一覧の読み直しと知らせ (#2073)。表示中の一覧の条件で先頭から読み直す。
   * 読み直せなければ「再試行」を出し、読み直せるまで「再送」を止める。
   * 読み直しのあいだは、ほかの読み込みと再送を出さない (読み直しの status は 'loading'。requeue から呼ぶときは、読み直しが済むまで
   * 書き込みの待ち (writeInFlightRef) も外さない)。追い越されたとき (superseded) は、追い越した読み込みが一覧を今の状態にするので
   * 何もしない (load の戻り値の型に合わせた守り。読み直しのあいだはほかの読み込みを出さないので、いまの画面では起きない)
   */
  const rereadAfterNoResponse = async (template: string) => {
    const outcome = await load(appliedRef.current, null, { reread: true });
    if (outcome.kind === 'superseded') return;
    // 読み直せなかった (failed) ときだけ、読み直せるまで「再送」を止める。401 / 403 (unavailable) は読み込み直しても
    // 変わらないので止めない (機能フラグの一覧と同じ。#2093 W6・#2101 X4)。読み直せた (loaded) ときは load が外している
    markListStale(outcome.kind === 'failed');
    setNotice({ kind: 'no-response', template, reload: outcome });
  };

  /**
   * 「さらに読み込む」。一覧の読み込み (読み直しを含む) と再送の書き込みの最中は出さない: 再送の通信の reject のあとの
   * 読み直しの最中に続きを読むと、続きの読み込みが読み直しを追い越して読み直しの結果を捨て、古い「届けられなかった」の行と
   * 「再送」が知らせも無いまま残る (もう一度押すと、自分の再送が済んでいたのに 409 になる。#2073)
   */
  const loadMore = () => {
    if (isBusyNow() || !nextCursor) return;
    void load(appliedRef.current, nextCursor);
  };

  /** 「再試行」: 再送の通信の reject のあとの、失敗した一覧の読み直しをやり直す (#2073) */
  const retryReread = (template: string) => {
    if (isBusyNow()) return;
    void rereadAfterNoResponse(template);
  };

  const requeue = async (item: EmailOutboxListItem) => {
    // 送らないとき (#2073):
    //   - 一覧の読み込み (読み直しを含む) かほかの再送 (その reject のあとの読み直しを含む) を待つあいだ。重ねると、再送より先に
    //     サーバーが読んだ一覧が、あとから届いて再送の成功の描き替えを上書きする (ファイルの冒頭の説明)
    //   - 再送の通信の reject のあとの一覧の読み直しが失敗しているあいだ (一覧の状態が古いかもしれない)
    if (isBusyNow() || listStaleRef.current) return;
    writeInFlightRef.current = true;
    setIsWriting(true);
    setNotice(null);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/super-admin/email-outbox/${encodeURIComponent(item.id)}/requeue`, {
          method: 'POST',
          cache: 'no-store',
        });
      } catch {
        // 応答を受け取れなかった (オフライン・接続が切れたなど)。再送が済んだかは分からないので、一覧を読み直して今の状態を見せる (#2073)。
        // 読み直しの応答まで書き込みを待つ扱いにする (待たずにほかの行を再送すると、この読み直しの古い一覧で上書きされうる)
        await rereadAfterNoResponse(item.template);
        return;
      }
      const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
      if (!res.ok) {
        setNotice({ kind: 'error', text: describeFailure(res.status, body) });
        return;
      }
      const now = new Date().toISOString();
      setItems((prev) =>
        prev.map((row) =>
          row.id === item.id
            ? {
                ...row,
                status: 'queued',
                attempts: 0,
                requeue_count: row.requeue_count + 1,
                dead_at: null,
                next_attempt_at: now,
                requeued_at: now,
              }
            : row,
        ),
      );
      setNotice({ kind: 'success', text: REQUEUED_MESSAGE });
    } finally {
      writeInFlightRef.current = false;
      setIsWriting(false);
    }
  };

  const templates = Array.from(new Set(items.map((item) => item.template)));
  const isLoading = status === 'loading';
  const isLoadingMore = status === 'loading-more';
  /** 一覧の読み込みか再送の書き込みを待っているか (描画用。handler は isBusyNow で見る) */
  const isBusy = status !== 'idle' || isWriting;
  const columnCount = 8;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">メール送信</h1>
        <p className="text-sm text-slate-500 mt-1">
          アプリが送るメールの送信待ち・送信済み・届けられなかったもの (email_outbox)。宛先は伏せて表示します
        </p>
      </div>

      {/* 絞り込み */}
      <form
        onSubmit={handleSubmit}
        aria-label="メールの絞り込み"
        className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 mb-4"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <fieldset>
            <legend className="block text-xs font-medium text-slate-600 mb-1">状態</legend>
            <div className="flex flex-wrap gap-4 py-2">
              {STATUS_OPTIONS.map((option) => (
                <label key={option.value} className="flex items-center gap-1 text-sm text-slate-700">
                  <input
                    type="radio"
                    name="email-outbox-status"
                    id={`email-outbox-status-${option.value}`}
                    value={option.value}
                    checked={draft.status === option.value}
                    onChange={() => setDraft((prev) => ({ ...prev, status: option.value }))}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor="email-outbox-template" className="block text-xs font-medium text-slate-600 mb-1">
              文面の名前 (完全一致)
            </label>
            <input
              id="email-outbox-template"
              type="text"
              list="email-outbox-templates"
              value={draft.template}
              onChange={(e) => setDraft((prev) => ({ ...prev, template: e.target.value }))}
              placeholder="例: family_invite"
              className={INPUT_CLASS}
            />
            <datalist id="email-outbox-templates">
              {templates.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="submit" disabled={isBusy} className={PRIMARY_BUTTON_CLASS}>
            絞り込む
          </button>
        </div>
      </form>

      {/* 件数と再読み込み */}
      <div className="mb-2 flex items-center justify-between gap-3 text-sm text-slate-500">
        <p aria-live="polite">
          {isLoading ? '読み込み中…' : `${items.length} 件を表示中${nextCursor ? ' (続きあり)' : ''}`}
        </p>
        <button
          type="button"
          onClick={reloadList}
          disabled={isBusy}
          className={SECONDARY_BUTTON_CLASS}
        >
          再読み込み
        </button>
      </div>

      {notice?.kind === 'success' && (
        <div role="status" className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg mb-4 text-sm">
          {notice.text}
        </div>
      )}
      {notice?.kind === 'error' && (
        <div role="alert" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">
          {notice.text}
        </div>
      )}
      {notice?.kind === 'no-response' && (
        <div
          data-testid="email-outbox-reload-notice"
          className="flex items-start justify-between gap-4 bg-amber-50 border border-amber-300 text-amber-900 px-4 py-3 rounded-lg mb-4 text-sm"
        >
          <p role={notice.reload.kind === 'loaded' ? 'status' : 'alert'}>{noResponseNoticeText(notice)}</p>
          {notice.reload.kind === 'failed' && (
            <button
              type="button"
              onClick={() => retryReread(notice.template)}
              disabled={isBusy}
              className={NOTICE_RETRY_BUTTON_CLASS}
            >
              {isLoading ? '読み込み中…' : '再試行'}
            </button>
          )}
        </div>
      )}
      {error && (
        <div role="alert" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}

      {/* 一覧 */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">メールの一覧 (作成の新しい順)</caption>
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th scope="col" className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">
                  作成 (日本時間)
                </th>
                <th scope="col" className="text-left px-4 py-3 font-medium text-slate-600">
                  状態
                </th>
                <th scope="col" className="text-left px-4 py-3 font-medium text-slate-600">
                  文面の名前
                </th>
                <th scope="col" className="text-left px-4 py-3 font-medium text-slate-600">
                  宛先
                </th>
                <th scope="col" className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">
                  試行 / 再送
                </th>
                <th scope="col" className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">
                  次の試行・送信・失敗
                </th>
                <th scope="col" className="text-left px-4 py-3 font-medium text-slate-600">
                  失敗
                </th>
                <th scope="col" className="text-center px-4 py-3 font-medium text-slate-600">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((item) => {
                const event = eventOf(item);
                return (
                  <tr key={item.id} className="hover:bg-slate-50 transition-colors align-top">
                    <td className="px-4 py-2 text-slate-700 text-xs whitespace-nowrap font-mono">
                      {formatJst(item.created_at)}
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="px-4 py-2 text-slate-700 text-xs font-mono break-all">{item.template}</td>
                    <td className="px-4 py-2 text-slate-700 text-xs font-mono break-all">{item.recipient}</td>
                    <td className="px-4 py-2 text-slate-600 text-xs whitespace-nowrap">
                      {item.attempts} / {item.requeue_count}
                    </td>
                    <td className="px-4 py-2 text-slate-600 text-xs whitespace-nowrap">
                      <span className="text-slate-400">{event.label}: </span>
                      <span className="font-mono">{formatJst(event.at)}</span>
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {item.last_error_code ? (
                        <div className="max-w-xs">
                          <p className="font-mono text-red-700 break-all">
                            {item.last_error_code}
                            {item.last_status_code !== null ? ` (${item.last_status_code})` : ''}
                          </p>
                          {item.last_error_message && (
                            <p className="text-slate-600 break-words">{item.last_error_message}</p>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-center">
                      {item.status === 'dead' &&
                        (item.redacted ? (
                          <div>
                            <button type="button" disabled className={ROW_BUTTON_CLASS} aria-describedby={`redacted-${item.id}`}>
                              再送
                            </button>
                            <p id={`redacted-${item.id}`} className="mt-1 text-xs text-slate-400">
                              {REDACTED_REQUEUE_NOTE}
                            </p>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void requeue(item)}
                            disabled={isBusy || isListStale}
                            aria-label={`${formatJst(item.created_at)} の ${item.template} を再送`}
                            className={ROW_BUTTON_CLASS}
                          >
                            再送
                          </button>
                        ))}
                    </td>
                  </tr>
                );
              })}
              {!isLoading && !error && items.length === 0 && (
                <tr>
                  <td colSpan={columnCount} className="px-4 py-10 text-center text-slate-400">
                    条件に合うメールはありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {nextCursor && (
          <div className="border-t border-slate-200 p-3 text-center">
            <button
              type="button"
              onClick={loadMore}
              disabled={isBusy}
              className={SECONDARY_BUTTON_CLASS}
            >
              {isLoadingMore ? '読み込み中…' : 'さらに読み込む'}
            </button>
          </div>
        )}
      </div>

      <p className="mt-4 text-xs text-slate-400">
        再送すると、次の送信の処理 (1 分ごと) で送り直します。作成から 7 日を超えたメールは、再送しても期限切れ (expired)
        で届けられません。招待などは出し直してください。宛先を伏せた行 (退会した人宛など) は再送できません。
      </p>
    </div>
  );
}
