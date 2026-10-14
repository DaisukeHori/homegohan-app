/**
 * #1048 F2-16: クエリパラメータの数値検証を共通化する。
 *
 * `parseInt` は不正な文字列 (例: "abc") に対して NaN を返し、それを
 * そのまま日付演算等に渡すと RangeError 等の未処理例外→500 につながる。
 * また limit 系パラメータは DoS 防止のため必ず上限でクランプする。
 *
 * この関数は不正な入力（NaN・空文字・非数値文字列）を例外にせず、
 * 安全に `opts.default` へフォールバックさせた上で [min, max] にクランプする。
 */
export function clampIntParam(
  raw: string | null | undefined,
  opts: { min: number; max: number; default: number },
): number {
  if (raw == null || raw.trim() === '') {
    return opts.default;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return opts.default;
  }

  const rounded = Math.trunc(parsed);
  return Math.min(Math.max(rounded, opts.min), opts.max);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * パスパラメータなどの文字列が UUID の形式かどうか。
 *
 * uuid 型の列に UUID でない文字列を渡して `.eq('id', value)` すると PostgREST が 22P02 で失敗し、
 * 「存在しない id」(404) のはずが 500 になる。DB に渡す前にこれで弾く。
 * バージョン・バリアントのビットは見ない (形式だけの確認)。
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * リクエストボディの JSON を読む。壊れた JSON は例外にせず { ok: false } を返す。
 *
 * `await request.json()` の例外をそのまま route 全体の catch に流すと、クライアントの入力ミスが
 * 500 になる (生のエラー文を返さない方針 (#1172) では、原因も分からなくなる)。
 * 呼び出し側で { ok: false } を 400 にすること。
 */
export async function readJsonBody(
  request: { json(): Promise<unknown> },
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false };
  }
}
