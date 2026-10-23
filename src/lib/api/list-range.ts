/**
 * 一覧の API の「件数より後ろのページ」(PostgREST の 416 Range Not Satisfiable / PGRST103) の扱いを 1 か所にまとめる (#1917)
 *
 * 問題:
 *   `.range(from, to)` の from が件数以上だと、PostgREST は行を 0 件で返さずに 416 (PGRST103) の失敗を返す。
 *   最後のページの唯一の行が消えたあとに同じページで読み直したとき・URL のページ番号を大きくしたときに起こる。
 *   一覧の route がこれを他の DB の失敗と同じに扱うと、一覧が「処理中にエラー」(500) になる。
 *
 * 決まり:
 *   - 範囲外のページは失敗にも「0 件」(total 0) にもせず、空のページと本当の件数を返す
 *     (件数は一覧と同じ絞り込みで、行を取らずに数え直す。画面は件数から最後のページへ取り直せる)
 *   - 数え直しにも失敗したときは、元の失敗のまま返す (呼び出し側は 500 にする)
 *   - ローカルの Supabase では 416 の本文が途中で切れて error.code が取れないことがあるので、HTTP のステータスでも判定する
 *   - それ以外の DB の失敗は、200 の空の一覧にしない (呼び出し側が 500 にする。失敗と「0 件」を見分けられるように)
 *
 * 使い方 (route):
 *   const listed = await resolveBeyondLastPage(
 *     await selectRows(supabase, filters).order(...).range(from, to),
 *     () => selectRows(supabase, filters, { head: true }),
 *     ROUTE_NAME,
 *   );
 *   if (listed.error) return internalError(ROUTE_NAME, listed.error, ...);
 *   return NextResponse.json({ data: listed.data ?? [], meta: { total: listed.count ?? 0, page, per_page } });
 *
 * 一覧と数え直しは、同じ絞り込みの関数 (上の selectRows) から作る。絞り込みを 2 か所に書くと、片方だけ直したときに件数と一覧がずれるため。
 * 一覧の route がこの扱いを持つことは tests/api-list-range-scan.test.ts が src/app/api を走査して見張る。
 */
import { createLogger } from '@/lib/db-logger';
import { errorCodeOf, toLoggableError } from '@/lib/api/errors';

/** PostgREST が「件数より後ろのページ」で返す HTTP ステータス (Range Not Satisfiable) */
export const HTTP_RANGE_NOT_SATISFIABLE = 416;
/** 同じときに PostgREST が返す error.code */
export const POSTGREST_RANGE_NOT_SATISFIABLE_CODE = 'PGRST103';

/** 数え直しの失敗を構造化ログに残すときの文 */
const RECOUNT_FAILURE_LOG_MESSAGE = '件数より後ろのページの件数の数え直しに失敗しました';

/** 一覧の読み出しの結果 (supabase-js の応答のうち、ここで使う項目) */
export interface ListReadResult<TRow, TError> {
  data: TRow[] | null;
  error: TError | null;
  count: number | null;
  /** HTTP ステータス。テストの偽物などで無いときは error.code だけで判定する */
  status?: number;
}

/** 件数だけの読み出し (select(..., { count: 'exact', head: true })) の結果 */
export interface CountReadResult {
  count: number | null;
  error: unknown;
}

/** 読み出しの失敗が「件数より後ろのページ」(416 / PGRST103) か */
export function isBeyondLastPage(error: unknown, status: number | null | undefined): boolean {
  if (!error) return false;
  return status === HTTP_RANGE_NOT_SATISFIABLE || errorCodeOf(error) === POSTGREST_RANGE_NOT_SATISFIABLE_CODE;
}

/**
 * 一覧の読み出しの結果が「件数より後ろのページ」なら、同じ絞り込みの件数を数え直して
 * `{ data: [], error: null, count: 本当の件数 }` にする。それ以外の結果はそのまま返す。
 * 数え直しに失敗したとき (失敗・件数が null・例外) は、構造化ログに残して元の結果 (元の失敗) を返す。
 *
 * @param result    一覧の読み出しの結果 (`await query.range(from, to)`)
 * @param recount   同じ絞り込みで件数だけを数える読み出しを作る (範囲外のページのときだけ呼ぶ)
 * @param routeName 構造化ログの function_name (internalError に渡す名前と同じもの)
 */
export async function resolveBeyondLastPage<TRow, TError>(
  result: ListReadResult<TRow, TError>,
  recount: () => PromiseLike<CountReadResult>,
  routeName: string,
): Promise<{ data: TRow[] | null; error: TError | null; count: number | null }> {
  if (!isBeyondLastPage(result.error, result.status)) {
    return { data: result.data, error: result.error, count: result.count };
  }

  let failure: unknown;
  try {
    const counted = await recount();
    if (!counted.error && typeof counted.count === 'number') {
      return { data: [], error: null, count: counted.count };
    }
    failure = counted.error ?? new Error('count is null');
  } catch (err) {
    failure = err;
  }

  try {
    const errorCode = errorCodeOf(failure);
    createLogger(routeName).error(RECOUNT_FAILURE_LOG_MESSAGE, toLoggableError(failure), {
      ...(errorCode ? { error_code: errorCode } : {}),
    });
  } catch {
    // 記録の失敗で応答を変えない (呼び出し側は元の失敗で 500 を返す)
  }
  return { data: result.data, error: result.error, count: result.count };
}
