/**
 * 集計バッチ (Edge Functions) 向けの、PostgREST の読み書きの部品
 *
 * 集計は「全行を見ていること」と「失敗したら失敗と分かること」が前提になる。
 * supabase-js をそのまま使うと、次の 3 つで値が黙って狂う。
 *
 * 1. エラーが例外にならない
 *    失敗すると { data: null, error } が返るだけで、例外は出ない。`data ?? []` と書くと
 *    「行が無い」と区別できず、空の集計結果をそのまま保存してしまう
 *    (存在しない meal_plan_days を埋め込んだクエリが失敗し続けても、気づけなかった #1306)。
 *    → throwIfError で例外にする。
 * 2. 1 回の応答は最大 1000 行で打ち切られる
 *    Supabase の API 設定 (Max rows) の既定値。超えてもエラーは出ず、先頭の 1000 行だけが返る。
 *    → fetchAllRows が、上限に達したときだけページ送りで全件を取り直す。
 * 3. .in('col', ids) の ids は URL に載る
 *    UUID は 36 文字なので、約 200 件を超えると API ゲートウェイが 414 (URI too long) で拒否する
 *    (ローカルのスタックでは、200 件は通り、250 件は拒否された)。
 *    → chunkArray で分けて問い合わせる。
 */

/**
 * PostgREST が 1 回の応答で返す行数の上限。Supabase の API 設定 (Max rows) の既定値。
 * 設定でこれより小さくされている場合は、上限に達したことを検知できない。
 */
export const API_MAX_ROWS = 1000;

/** ページ送りの最大ページ数。サーバーが range を無視して同じ行を返し続けたときに、無限に回らないための上限 */
const DEFAULT_MAX_PAGES = 1000;

export interface QueryErrorLike {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

export interface QueryResult<T> {
  data: T[] | null;
  error: QueryErrorLike | null;
}

/** order / range を足せる PostgREST のクエリ。await すると { data, error } になる */
export interface PagedQuery<T> extends PromiseLike<QueryResult<T>> {
  order(column: string): PagedQuery<T>;
  range(from: number, to: number): PagedQuery<T>;
}

/** どのクエリが失敗したかが分かる例外。message に label と PostgREST のエラーコードを含める */
export class QueryError extends Error {
  readonly label: string;
  readonly code?: string;
  readonly details?: string;
  readonly hint?: string;

  constructor(label: string, cause: QueryErrorLike) {
    super(`${label}: ${cause.message}${cause.code ? ` (${cause.code})` : ''}`);
    this.name = 'QueryError';
    this.label = label;
    this.code = cause.code;
    this.details = cause.details;
    this.hint = cause.hint;
  }
}

/** supabase-js が返した error があれば例外にする。error が無ければ何もしない */
export function throwIfError(label: string, error: QueryErrorLike | null | undefined): void {
  if (error) throw new QueryError(label, error);
}

/**
 * 多対一で埋め込んだ行 (例: planned_meals → user_daily_meals!inner(...)) を 1 件取り出す。
 * PostgREST は多対一の埋め込みをオブジェクトで返す。一方、スキーマの型を渡していない supabase-js は
 * 型の上で配列と見なす。どちらの形でも同じ結果になるようにして、型と実際の応答のずれで
 * 所有者が読めなくなる (全行が黙って捨てられる) ことを防ぐ。
 */
export function embeddedOne<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** 配列を size 件ずつに分ける (.in() の ids を URL に載せすぎないため) */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`chunkArray: size は 1 以上の整数にしてください (${size})`);
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export interface FetchAllRowsOptions {
  /** ページ送りのときの並び替え列 (一意な列。既定は id) */
  orderColumn?: string;
  /** ページ送りの最大ページ数 */
  maxPages?: number;
}

/**
 * クエリの結果を全件取得する。エラーは例外 (QueryError) にする。
 *
 * まずクエリをそのまま 1 回だけ発行し、API の上限 (API_MAX_ROWS) 未満の件数なら、それが全件。
 * 上限に達していたら打ち切られた可能性があるので、同じクエリを order + range でページ送りして取り直す。
 * (大半のクエリは 1 回で終わるため、余計な往復は増えない。)
 *
 * buildQuery は呼ばれるたびに新しいクエリを返すこと (クエリは 1 回しか await できないため)。
 * ページ送りは offset 方式なので、取得の最中に行が増減すると重複や取りこぼしが起こり得る。
 * 夜間のバッチ集計では許容できる範囲として、keyset 方式にはしていない。
 */
export async function fetchAllRows<T>(
  label: string,
  buildQuery: () => PagedQuery<T>,
  options: FetchAllRowsOptions = {},
): Promise<T[]> {
  const { orderColumn = 'id', maxPages = DEFAULT_MAX_PAGES } = options;

  const first = await buildQuery();
  throwIfError(label, first.error);
  const firstRows = first.data ?? [];
  if (firstRows.length < API_MAX_ROWS) return firstRows;

  const all: T[] = [];
  let from = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const { data, error } = await buildQuery()
      .order(orderColumn)
      .range(from, from + API_MAX_ROWS - 1);
    throwIfError(label, error);
    const rows = data ?? [];
    // 空のページが終わりの印。次の取得位置は、実際に返ってきた件数だけ進める
    // (応答の上限が途中で変わっても、飛ばしも二重取りもしないように)
    if (rows.length === 0) return all;
    all.push(...rows);
    from += rows.length;
  }
  throw new QueryError(label, { message: `ページ送りが ${maxPages} ページを超えても終わりませんでした` });
}
