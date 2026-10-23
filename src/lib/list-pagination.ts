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
