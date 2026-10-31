/**
 * 一覧の画面のページ送りの小物 (#1917)
 *
 * 一覧の API は、件数より後ろのページ (最後のページの唯一の行が消えたあとの読み直し・URL のページ番号) を、
 * 失敗にせず空のページと本当の件数で返す (src/lib/api/list-range.ts)。画面はそれを「0 件です」と見せずに、
 * 件数から最後のページへ取り直す (運営の組織の一覧 src/app/admin/organizations/OrganizationsManager.tsx と同じ扱い)。
 */

/** 件数と 1 ページの件数から、最後のページの番号 (0 件でも 1) */
export function lastPageOf(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(total / perPage));
}

/**
 * 読んだページが件数より後ろなら、取り直す先の最後のページの番号。取り直さなくてよければ null。
 * 行が 1 件でもあるページ・最後のページ以内のページは取り直さない。取り直す先は今のページより必ず小さいので、取り直しは必ず止まる
 */
export function lastPageToRefetch(params: { rows: number; page: number; total: number; perPage: number }): number | null {
  if (params.rows > 0) return null;
  const lastPage = lastPageOf(params.total, params.perPage);
  return params.page > lastPage ? lastPage : null;
}

/** 一覧の最初のページの番号 (URL の page が無い・読めないときに読むページ) */
export const FIRST_PAGE = 1;

/** URL の page として受ける形 (先頭が 0 でない 10 進の整数。符号・小数・指数・空白を含まない) */
const PAGE_PARAM_PATTERN = /^[1-9][0-9]*$/;

/**
 * URL の page (searchParams.page) を、一覧の API に渡すページの番号に読む (#2093 W8)。
 * 1 以上の整数 (Number.MAX_SAFE_INTEGER まで) でなければ最初のページ (1) にする。
 * 以前の `Math.max(1, parseInt(page, 10))` は、?page=abc の NaN をそのまま通して API に page=NaN を送り (400)、
 * 何度読み直しても直らない読み込みの失敗にしていた。?page=2abc も parseInt が 2 と読んでいた
 */
export function parsePageParam(raw: string | undefined): number {
  if (raw === undefined || !PAGE_PARAM_PATTERN.test(raw)) return FIRST_PAGE;
  const page = Number(raw);
  return Number.isSafeInteger(page) ? page : FIRST_PAGE;
}
