'use client';

/**
 * /super-admin/logs — 運用ログ (app_logs) の閲覧 (#1157)
 *
 * GET /api/super-admin/logs を呼んで、API ルート・Edge Function・ブラウザが記録したログを新しい順に表示する。
 * 読み取り専用。権限は layout.tsx (requireRole(['super_admin'])) と API の両方で見ている。
 *
 * - 絞り込み: レベル / 発生元 / 関数名 / ユーザー ID / リクエスト ID / 期間。入力したあと「絞り込む」で反映する
 *   (1 文字ごとに検索を走らせない)。行の詳細にある「この値で絞り込む」で、その行の値をそのまま条件にできる。
 * - ページ送り: 「さらに読み込む」で、API が返したカーソルを渡して続きを足す (ページ番号は使わない)。
 * - 期間の入力は日本時間として扱い、表示も日本時間にそろえる (見ている人の端末の時差に左右されない)。
 * - ログの文面は保存されたまま表示する。秘密情報のマスクは書き込み時に済んでいる (#1171)。
 *   React が文字列として描画するので、ログに HTML が入っていても実行されない。
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
// 型だけを import する (値を import すると zod がブラウザ向けの bundle に入る)
import type { AppLogEntry, AppLogLevel, AppLogListResponse } from '@/lib/super-admin/app-logs';

/** 1 回に読み込む行数 (API の既定と同じ) */
const PAGE_SIZE = 50;

const LEVELS: readonly AppLogLevel[] = ['debug', 'info', 'warn', 'error'];

/** app_logs.source に入る値 (src/lib/db-logger.ts / supabase/functions/_shared/db-logger.ts / src/app/api/log/route.ts) */
const SOURCES = ['edge-function', 'api-route', 'client'] as const;

const LEVEL_STYLES: Record<string, string> = {
  debug: 'bg-slate-100 text-slate-600',
  info: 'bg-blue-100 text-blue-700',
  warn: 'bg-amber-100 text-amber-800',
  error: 'bg-red-100 text-red-700',
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INPUT_CLASS =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500';
const PRIMARY_BUTTON_CLASS =
  'px-4 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const SECONDARY_BUTTON_CLASS =
  'px-4 py-2 bg-white text-slate-700 border border-slate-300 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

// ── 絞り込み条件 ──────────────────────────────────────────────────────────

interface Filters {
  level: string;
  source: string;
  functionName: string;
  userId: string;
  requestId: string;
  /** <input type="datetime-local"> の値 (YYYY-MM-DDTHH:mm)。日本時間 */
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = {
  level: '',
  source: '',
  functionName: '',
  userId: '',
  requestId: '',
  from: '',
  to: '',
};

/**
 * 日本時間の datetime-local の値を、API に渡す ISO 8601 (UTC) にする。
 * 入力は分単位なので、終了日時はその分の終わり (59.999 秒) までを含める。形が違えば null。
 */
function localToIso(value: string, endOfMinute: boolean): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const seconds = match[2] ?? (endOfMinute ? '59' : '00');
  const date = new Date(`${match[1]}:${seconds}.${endOfMinute ? '999' : '000'}+09:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** 入力に誤りがあれば、その説明を返す (API に送る前に確かめる)。問題なければ null */
function validateFilters(filters: Filters): string | null {
  if (filters.userId.trim() && !UUID_PATTERN.test(filters.userId.trim())) {
    return 'ユーザー ID は UUID の形式で入力してください';
  }
  const from = filters.from ? localToIso(filters.from, false) : null;
  const to = filters.to ? localToIso(filters.to, true) : null;
  if (filters.from && !from) return '開始日時の形式が正しくありません';
  if (filters.to && !to) return '終了日時の形式が正しくありません';
  if (from && to && from > to) return '開始日時は終了日時より前にしてください';
  return null;
}

function buildQuery(filters: Filters, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filters.level) params.set('level', filters.level);
  if (filters.source) params.set('source', filters.source);
  if (filters.functionName.trim()) params.set('function_name', filters.functionName.trim());
  if (filters.userId.trim()) params.set('user_id', filters.userId.trim());
  if (filters.requestId.trim()) params.set('request_id', filters.requestId.trim());
  const from = filters.from ? localToIso(filters.from, false) : null;
  const to = filters.to ? localToIso(filters.to, true) : null;
  if (from) params.set('from', from);
  if (to) params.set('to', to);
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
  fractionalSecondDigits: 3,
  hourCycle: 'h23',
});

function formatJst(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : JST_FORMAT.format(date);
}

function hasMetadata(metadata: AppLogEntry['metadata']): boolean {
  if (metadata == null) return false;
  if (Array.isArray(metadata)) return metadata.length > 0;
  if (typeof metadata === 'object') return Object.keys(metadata).length > 0;
  return true;
}

function LevelBadge({ level }: { level: string }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${LEVEL_STYLES[level] ?? LEVEL_STYLES.debug}`}>
      {level}
    </span>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-slate-600 mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}

/** 詳細の「項目名: 値」。値があれば、その値で絞り込むボタンを付ける */
function Attribute({
  label,
  value,
  onFilter,
}: {
  label: string;
  value: string | null;
  onFilter?: () => void;
}) {
  return (
    <div>
      <dt className="text-xs font-semibold text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-all font-mono text-xs text-slate-800">
        {value ?? '—'}
        {value && onFilter && (
          <button
            type="button"
            onClick={onFilter}
            aria-label={`${label}「${value}」で絞り込む`}
            className="ml-2 font-sans text-xs text-orange-600 hover:underline"
          >
            この値で絞り込む
          </button>
        )}
      </dd>
    </div>
  );
}

function LogDetail({ log, onFilter }: { log: AppLogEntry; onFilter: (patch: Partial<Filters>) => void }) {
  return (
    <div className="space-y-4 text-sm">
      <section>
        <h3 className="text-xs font-semibold text-slate-500 mb-1">メッセージ</h3>
        <p className="whitespace-pre-wrap break-words text-slate-900">{log.message}</p>
      </section>

      {log.error_message && (
        <section>
          <h3 className="text-xs font-semibold text-slate-500 mb-1">エラー内容</h3>
          <p className="whitespace-pre-wrap break-words text-red-700">{log.error_message}</p>
        </section>
      )}

      {log.error_stack && (
        <section>
          <h3 className="text-xs font-semibold text-slate-500 mb-1">スタックトレース</h3>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
            {log.error_stack}
          </pre>
        </section>
      )}

      {hasMetadata(log.metadata) && (
        <section>
          <h3 className="text-xs font-semibold text-slate-500 mb-1">付随情報 (metadata)</h3>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-slate-100 p-3 text-xs text-slate-800">
            {JSON.stringify(log.metadata, null, 2)}
          </pre>
        </section>
      )}

      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        <Attribute label="ログ ID" value={log.id} />
        <Attribute
          label="関数"
          value={log.function_name}
          onFilter={log.function_name ? () => onFilter({ functionName: log.function_name ?? '' }) : undefined}
        />
        <Attribute
          label="ユーザー ID"
          value={log.user_id}
          onFilter={log.user_id ? () => onFilter({ userId: log.user_id ?? '' }) : undefined}
        />
        <Attribute
          label="リクエスト ID"
          value={log.request_id}
          onFilter={log.request_id ? () => onFilter({ requestId: log.request_id ?? '' }) : undefined}
        />
      </dl>
    </div>
  );
}

// ── ページ ────────────────────────────────────────────────────────────────

type LoadStatus = 'loading' | 'loading-more' | 'idle';

interface ApiErrorBody {
  error?: { message?: string };
}

/** 失敗した応答を、運用者に分かる説明にする。401 / 403 の API のメッセージは英語のコードなので使わない */
function describeFailure(status: number, body: ApiErrorBody | null): string {
  if (status === 401) return 'ログインの有効期限が切れています。ログインし直してください';
  if (status === 403) return 'このログを見る権限がありません (super_admin のみ)';
  return body?.error?.message ?? `読み込みに失敗しました (HTTP ${status})`;
}

export default function AppLogsPage() {
  /** 入力中の条件 */
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  /** 表示中の一覧を取るのに使った条件 (「さらに読み込む」はこちらを使う。入力途中の条件は使わない) */
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [entries, setEntries] = useState<AppLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  /** 最後に出したリクエストの番号。遅れて返ってきた古いリクエストの結果で画面を上書きしないために使う */
  const requestSeq = useRef(0);

  const load = useCallback(async (filters: Filters, cursor: string | null) => {
    requestSeq.current += 1;
    const seq = requestSeq.current;
    setStatus(cursor ? 'loading-more' : 'loading');
    setError(null);
    if (!cursor) {
      setEntries([]);
      setNextCursor(null);
      setExpanded(new Set());
    }
    try {
      const res = await fetch(`/api/super-admin/logs?${buildQuery(filters, cursor)}`, { cache: 'no-store' });
      const body = (await res.json().catch(() => null)) as (Partial<AppLogListResponse> & ApiErrorBody) | null;
      if (seq !== requestSeq.current) return;
      if (!res.ok || !body?.data || !body.meta) {
        setError(describeFailure(res.status, body));
        setStatus('idle');
        return;
      }
      const rows = body.data;
      setEntries((prev) => (cursor ? [...prev, ...rows] : rows));
      setNextCursor(body.meta.next_cursor ?? null);
      setStatus('idle');
    } catch {
      if (seq !== requestSeq.current) return;
      setError('通信に失敗しました。ネットワークを確認して、もう一度お試しください');
      setStatus('idle');
    }
  }, []);

  useEffect(() => {
    void load(EMPTY_FILTERS, null);
  }, [load]);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const message = validateFilters(draft);
    setFormError(message);
    if (message) return;
    setApplied(draft);
    void load(draft, null);
  };

  const handleClear = () => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setFormError(null);
    void load(EMPTY_FILTERS, null);
  };

  /** 行の詳細から、その行の値を条件に足して検索し直す */
  const filterBy = (patch: Partial<Filters>) => {
    const next = { ...applied, ...patch };
    setDraft(next);
    setApplied(next);
    setFormError(null);
    void load(next, null);
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const setField = (patch: Partial<Filters>) => setDraft((prev) => ({ ...prev, ...patch }));

  const functionNames = Array.from(
    new Set(entries.map((e) => e.function_name).filter((name): name is string => Boolean(name))),
  );
  const isLoading = status === 'loading';
  const isLoadingMore = status === 'loading-more';

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">アプリログ</h1>
        <p className="text-sm text-slate-500 mt-1">
          API・Edge Function・ブラウザが記録したログ (app_logs) を、新しい順に表示します。読み取り専用です。
        </p>
      </div>

      {/* 絞り込み */}
      <form
        onSubmit={handleSubmit}
        aria-label="ログの絞り込み"
        className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 mb-4"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="log-level" label="レベル">
            <select
              id="log-level"
              value={draft.level}
              onChange={(e) => setField({ level: e.target.value })}
              className={INPUT_CLASS}
            >
              <option value="">すべて</option>
              {LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </Field>
          <Field id="log-source" label="発生元">
            <select
              id="log-source"
              value={draft.source}
              onChange={(e) => setField({ source: e.target.value })}
              className={INPUT_CLASS}
            >
              <option value="">すべて</option>
              {SOURCES.map((source) => (
                <option key={source} value={source}>
                  {source}
                </option>
              ))}
            </select>
          </Field>
          <Field id="log-function-name" label="関数名 (完全一致)">
            <input
              id="log-function-name"
              type="text"
              list="log-function-names"
              value={draft.functionName}
              onChange={(e) => setField({ functionName: e.target.value })}
              placeholder="例: GET /api/health/insights"
              className={INPUT_CLASS}
            />
            <datalist id="log-function-names">
              {functionNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </Field>
          <Field id="log-user-id" label="ユーザー ID">
            <input
              id="log-user-id"
              type="text"
              value={draft.userId}
              onChange={(e) => setField({ userId: e.target.value })}
              placeholder="UUID"
              className={INPUT_CLASS}
            />
          </Field>
          <Field id="log-request-id" label="リクエスト ID (完全一致)">
            <input
              id="log-request-id"
              type="text"
              value={draft.requestId}
              onChange={(e) => setField({ requestId: e.target.value })}
              placeholder="例: req_1728360000000_ab12cd3"
              className={INPUT_CLASS}
            />
          </Field>
          <Field id="log-from" label="開始日時 (日本時間)">
            <input
              id="log-from"
              type="datetime-local"
              value={draft.from}
              onChange={(e) => setField({ from: e.target.value })}
              className={INPUT_CLASS}
            />
          </Field>
          <Field id="log-to" label="終了日時 (日本時間)">
            <input
              id="log-to"
              type="datetime-local"
              value={draft.to}
              onChange={(e) => setField({ to: e.target.value })}
              className={INPUT_CLASS}
            />
          </Field>
        </div>

        {formError && (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {formError}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="submit" disabled={isLoading || isLoadingMore} className={PRIMARY_BUTTON_CLASS}>
            絞り込む
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={isLoading || isLoadingMore}
            className={SECONDARY_BUTTON_CLASS}
          >
            条件をクリア
          </button>
        </div>
      </form>

      {/* 件数と再読み込み */}
      <div className="mb-2 flex items-center justify-between gap-3 text-sm text-slate-500">
        <p role="status" aria-live="polite">
          {isLoading ? '読み込み中…' : `${entries.length} 件を表示中${nextCursor ? ' (続きあり)' : ''}`}
        </p>
        <button
          type="button"
          onClick={() => void load(applied, null)}
          disabled={isLoading || isLoadingMore}
          className={SECONDARY_BUTTON_CLASS}
        >
          再読み込み
        </button>
      </div>

      {error && (
        <div role="alert" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}

      {/* 一覧 */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">アプリログの一覧 (新しい順)</caption>
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th scope="col" className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">
                  日時 (日本時間)
                </th>
                <th scope="col" className="text-left px-4 py-3 font-medium text-slate-600">
                  レベル
                </th>
                <th scope="col" className="text-left px-4 py-3 font-medium text-slate-600">
                  発生元
                </th>
                <th scope="col" className="text-left px-4 py-3 font-medium text-slate-600">
                  関数
                </th>
                <th scope="col" className="text-left px-4 py-3 font-medium text-slate-600">
                  メッセージ
                </th>
                <th scope="col" className="text-center px-4 py-3 font-medium text-slate-600">
                  詳細
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {entries.map((log) => {
                const isOpen = expanded.has(log.id);
                const detailId = `log-detail-${log.id}`;
                return (
                  <Fragment key={log.id}>
                    <tr className="hover:bg-slate-50 transition-colors align-top">
                      <td className="px-4 py-2 text-slate-700 text-xs whitespace-nowrap font-mono">
                        {formatJst(log.created_at)}
                      </td>
                      <td className="px-4 py-2">
                        <LevelBadge level={log.level} />
                      </td>
                      <td className="px-4 py-2 text-slate-600 text-xs whitespace-nowrap">{log.source}</td>
                      <td className="px-4 py-2 text-slate-600 text-xs">
                        <div className="max-w-[16rem] truncate" title={log.function_name ?? undefined}>
                          {log.function_name ?? '—'}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-slate-800">
                        <div className="max-w-xl truncate" title={log.message}>
                          {log.message}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-center">
                        <button
                          type="button"
                          onClick={() => toggle(log.id)}
                          aria-expanded={isOpen}
                          aria-controls={detailId}
                          // 行ごとに「開く」が並ぶので、どの行か分かる名前にする (見える文字「開く」「閉じる」を含める)
                          aria-label={`${formatJst(log.created_at)} のログの詳細を${isOpen ? '閉じる' : '開く'}`}
                          className="text-orange-500 hover:text-orange-600 font-medium text-xs whitespace-nowrap"
                        >
                          {isOpen ? '閉じる' : '開く'}
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr id={detailId} className="bg-slate-50">
                        <td colSpan={6} className="px-4 py-4">
                          <LogDetail log={log} onFilter={filterBy} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {!isLoading && !error && entries.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                    条件に合うログはありません
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
              onClick={() => void load(applied, nextCursor)}
              disabled={isLoadingMore}
              className={SECONDARY_BUTTON_CLASS}
            >
              {isLoadingMore ? '読み込み中…' : 'さらに読み込む'}
            </button>
          </div>
        )}
        {!nextCursor && !isLoading && entries.length > 0 && (
          <p className="border-t border-slate-200 p-3 text-center text-xs text-slate-400">これ以上ログはありません</p>
        )}
      </div>

      <p className="mt-4 text-xs text-slate-400">
        ログの文面は保存されたまま表示します。トークンやメールアドレスなどは保存するときに伏せ字にしていますが、
        伏せ字処理を入れる前に保存された古い行には、伏せ字になっていないものが残っている場合があります。
      </p>
    </div>
  );
}
