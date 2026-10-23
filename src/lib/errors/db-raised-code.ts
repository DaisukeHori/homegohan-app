/**
 * DB の関数・トリガーが `RAISE EXCEPTION '<コード>'` で止めたエラー (supabase-js の PostgrestError など) が、
 * 指定のコードかを判定する (#1917)。
 *
 * route はエラーの `.message` を自分で読まず、この関数でコードを判定して分岐する。
 * route のソースで `.message` を読むのをログと new Error の引数の中だけにしておくと、
 * エラーの文面を応答の本文に入れる形を見張り (tests/super-admin-operator-api-error-japanese-1917.test.ts の
 * 「`.message` を読むのは、ログと new Error の引数の中だけ」) が拾える。
 * この関数は文面を判定に使うだけで、返すのは真偽値 (文面を外へ出さない)。
 */

/** 判定に使うエラーの形 (supabase-js の PostgrestError・DB のドライバのエラーなど) */
export interface DbRaisedErrorLike {
  /** SQLSTATE (RAISE EXCEPTION ... USING ERRCODE = 'P0001' なら 'P0001') */
  code?: string | null;
  /** RAISE EXCEPTION の文面 (業務のコードの語。例: 'NOT_OPERATOR') */
  message?: string | null;
}

/** DB 関数・トリガーが RAISE EXCEPTION ... USING ERRCODE = 'P0001' で止めたときの SQLSTATE */
export const PG_RAISE_EXCEPTION_SQLSTATE = 'P0001';

/** 文面を語 (英数字と _ の並び) に分ける区切り。コードは `[A-Z0-9_]+` の語なので、語の境界で照合する */
const NON_WORD_SEPARATOR = /\W+/;

/**
 * SQLSTATE が P0001 で、文面がちょうどそのコードか。
 * トリガーが `RAISE EXCEPTION '<コード>' USING ERRCODE = 'P0001'` で止めた形だけを拾う
 * (ほかの SQLSTATE・コードを含むだけの文面は拾わない)
 */
export function isRaisedExceptionWithCode(error: DbRaisedErrorLike | null | undefined, code: string): boolean {
  return error?.code === PG_RAISE_EXCEPTION_SQLSTATE && error.message === code;
}

/**
 * 文面がそのコードを語として含むか (SQLSTATE は見ない)。
 * RPC が `RAISE EXCEPTION '<コード>'` で止めたかを、文面の前後に何かが付いていても拾う。
 * 部分文字列ではなく語の境界で照合する (例: 'USER_NOT_FOUND' の文面で 'NOT_FOUND' を拾わない。
 * 部分一致で短いコードが誤って当たる不具合は mapPgErrorToHttp の #1045 と同じ)
 */
export function dbErrorMentionsCode(error: DbRaisedErrorLike | null | undefined, code: string): boolean {
  const message = error?.message;
  if (typeof message !== 'string') return false;
  return message.split(NON_WORD_SEPARATOR).includes(code);
}
