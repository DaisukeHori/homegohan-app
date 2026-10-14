/**
 * 運用ログ (app_logs) 閲覧 API の入力検証・カーソル・型 (#1157)
 *
 * GET /api/super-admin/logs (src/app/api/super-admin/logs/route.ts) が使う。
 * 画面 (src/app/super-admin/logs/page.tsx) は、ここから「型」だけを import すること
 * (値を import すると zod までブラウザ向けの bundle に入るため)。
 *
 * ページ送りは「カーソル方式」にしている。app_logs は常に増え続けるので、ページ番号 (OFFSET) で送ると
 * 読んでいる間に新しい行が入るたびに、次のページに同じ行が出たり、行が飛んだりする。
 * 並びは created_at の新しい順 (同じ時刻の行は id の大きい順) で、カーソルは「最後に返した行の位置
 * (created_at と id)」を表す。次のページは、その位置より古い行だけを返す。
 */
import { z } from 'zod';
import { clampIntParam, isUuid } from '@/lib/http-params';
import type { Tables } from '@/types/database.types';

export const APP_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type AppLogLevel = (typeof APP_LOG_LEVELS)[number];

/** 1 回の応答で返す行数の既定値 */
export const APP_LOGS_DEFAULT_LIMIT = 50;
/** 1 回の応答で返す行数の上限 (これより大きい指定は、この値にそろえる) */
export const APP_LOGS_MAX_LIMIT = 200;

// ── レスポンスの型 ────────────────────────────────────────────────────────

/** app_logs の 1 行。API はこの形のまま返す (message などは保存されたまま。保存時にマスク済み: #1171) */
export type AppLogEntry = Tables<'app_logs'>;

export interface AppLogListResponse {
  data: AppLogEntry[];
  meta: {
    /** 今回の応答で上限にした行数 (指定が範囲外なら、直した後の値) */
    limit: number;
    /** この応答のあとに、まだ古い行が残っているか */
    has_more: boolean;
    /** 次のページを取るときに cursor= へそのまま渡す値。続きが無ければ null */
    next_cursor: string | null;
  };
}

// ── 日時の検証 ────────────────────────────────────────────────────────────

/**
 * ISO 8601 の日時 (タイムゾーン付き)。例: 2026-10-08T05:00:00Z / 2026-10-08T14:00:00+09:00 /
 * 2026-10-08T05:00:00.123456+00:00 (PostgREST が timestamptz を返すときの形)。
 * 小数秒は 6 桁 (マイクロ秒) まで。
 */
const ISO_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** この年より前の日時は受け付けない (ログに無い日付で、年 0 は PostgreSQL が拒否して 500 になるため) */
const MIN_YEAR = 1970;

function daysInMonth(year: number, month: number): number {
  // month は 1〜12。翌月の 0 日 = その月の最終日
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * ISO 8601 の日時として正しいか。形だけでなく、暦も見る。
 * `Date.parse` は 2 月 30 日を 3 月 2 日に直して通してしまい、PostgreSQL は 22008 で 500 になる。
 * そのため暦は自分で確かめる。
 */
export function isValidIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_DATETIME_PATTERN.exec(value);
  if (!match) return false;

  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (year < MIN_YEAR) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;

  const offset = match[7];
  if (offset !== 'Z') {
    const [offsetHour, offsetMinute] = offset.slice(1).split(':').map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return true;
}

// ── カーソル ──────────────────────────────────────────────────────────────

export interface AppLogCursor {
  /** 最後に返した行の created_at。DB が返した文字列のまま (マイクロ秒を落とすと、同じミリ秒の行が飛ぶ) */
  created_at: string;
  /** 最後に返した行の id */
  id: string;
}

/**
 * カーソルを文字列にする (クライアントには中身を意識させない不透明な値として渡す)。
 * created_at / id が decodeAppLogCursor を通らない形なら、次のページで必ず 400 になるので、ここで例外にする。
 */
export function encodeAppLogCursor(cursor: AppLogCursor): string {
  if (!isValidIsoDateTime(cursor.created_at) || !isUuid(cursor.id)) {
    throw new Error('app_logs のカーソルにできない行です (created_at / id の形式が想定と違います)');
  }
  return Buffer.from(JSON.stringify([cursor.created_at, cursor.id]), 'utf8').toString('base64url');
}

/**
 * カーソルの文字列を元に戻す。壊れている・形が違うときは null。
 * 中身は、そのまま PostgREST の絞り込み (or=(...)) の文字列に埋め込むので、日時と UUID の形に厳密に限る
 * (カンマや括弧を含む値で絞り込みの意味を変えられないようにする)。
 */
export function decodeAppLogCursor(raw: string): AppLogCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, id] = parsed as unknown[];
    if (!isValidIsoDateTime(createdAt) || !isUuid(id)) return null;
    return { created_at: createdAt, id };
  } catch {
    return null;
  }
}

/**
 * 「このカーソルより古い行」を表す PostgREST の絞り込み文字列 (.or() に渡す)。
 * 並びは created_at の新しい順、同時刻なら id の大きい順なので、
 *   created_at < c  または  (created_at = c かつ id < i)
 * の行が続きになる。cursor は decodeAppLogCursor を通ったものだけを渡すこと。
 */
export function olderThanCursorFilter(cursor: AppLogCursor): string {
  return `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`;
}

// ── クエリパラメータ ──────────────────────────────────────────────────────

const INVALID_DATETIME_MESSAGE = '日時は ISO 8601 (例: 2026-10-08T05:00:00Z) で指定してください';

const AppLogsFilterSchema = z
  .object({
    level: z.enum(APP_LOG_LEVELS).optional(),
    source: z.string().max(64).optional(),
    function_name: z.string().max(200).optional(),
    user_id: z.string().refine(isUuid, 'ユーザー ID は UUID で指定してください').optional(),
    request_id: z.string().max(200).optional(),
    from: z.string().refine(isValidIsoDateTime, INVALID_DATETIME_MESSAGE).optional(),
    to: z.string().refine(isValidIsoDateTime, INVALID_DATETIME_MESSAGE).optional(),
    cursor: z
      .string()
      .max(512)
      .refine((value) => decodeAppLogCursor(value) !== null, 'cursor が不正です')
      .optional(),
  })
  .refine(
    (v) => !(isValidIsoDateTime(v.from) && isValidIsoDateTime(v.to)) || Date.parse(v.from) <= Date.parse(v.to),
    { message: 'from は to 以前の日時にしてください', path: ['from'] },
  );

/** 絞り込みに使うクエリパラメータ名 (limit は別に扱う) */
const FILTER_KEYS = ['level', 'source', 'function_name', 'user_id', 'request_id', 'from', 'to', 'cursor'] as const;

export interface AppLogsQuery {
  level?: AppLogLevel;
  source?: string;
  function_name?: string;
  user_id?: string;
  request_id?: string;
  /** この日時以後 (含む) */
  from?: string;
  /** この日時以前 (含む) */
  to?: string;
  /** 指定すると、このカーソルより古い行を返す */
  cursor?: AppLogCursor;
  /** 1〜APP_LOGS_MAX_LIMIT */
  limit: number;
}

export type ParseAppLogsQueryResult =
  | { ok: true; query: AppLogsQuery }
  | { ok: false; details: { formErrors: string[]; fieldErrors: Record<string, string[] | undefined> } };

/**
 * GET /api/super-admin/logs のクエリパラメータを検証する。
 *  - 空文字・空白だけの値は「指定なし」として扱う (画面が空の入力欄をそのまま送っても 400 にしない)
 *  - 知らないパラメータは無視する
 *  - limit は不正な値でも 400 にせず、既定値または範囲内の値に直す (他の一覧 API と同じ: clampIntParam)
 */
export function parseAppLogsQuery(searchParams: URLSearchParams): ParseAppLogsQueryResult {
  const raw: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    const value = searchParams.get(key)?.trim();
    if (value) raw[key] = value;
  }

  const parsed = AppLogsFilterSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, details: parsed.error.flatten() };
  }

  const { cursor: rawCursor, ...filters } = parsed.data;
  // rawCursor は、上の検証で decode できると確かめてある
  const cursor = rawCursor === undefined ? undefined : (decodeAppLogCursor(rawCursor) ?? undefined);

  const limit = clampIntParam(searchParams.get('limit'), {
    min: 1,
    max: APP_LOGS_MAX_LIMIT,
    default: APP_LOGS_DEFAULT_LIMIT,
  });

  return { ok: true, query: { ...filters, cursor, limit } };
}
