/**
 * 機能パッケージ (feature_packages) のフラグキーの一覧 (feature_flags) に、フラグキーを 1 つ足す DB の関数の名前と、
 * 関数が返す結果の値 (#2189 W4)。
 *
 * 足す所 (運営最上位の機能フラグの作成。src/app/api/super-admin/flags/route.ts の POST) は、feature_flags を読んでから
 * `[...読んだ値, key]` で書くのをやめ、この関数を呼ぶ (supabase/migrations の *_feature_packages_append_flag_rpc.sql)。
 * 関数の中身は 1 文の条件つき UPDATE (array_append。まだ入っていないときだけ書く) なので、運営最上位が 2 人ほぼ同時に
 * フラグを作っても、後から書いた方が先のキーを上書きしない (行のロックを待った方が、相手の書いた後の値に足す)。
 * キーが一覧から消えないので、フラグの削除 (DELETE /api/super-admin/flags/[key]) の「使用中か」の検査も素通りしない。
 * 関数の名前・引数の名前・結果の値は tests/feature-packages-append-flag-rpc-migration-contract.test.ts が migration と突き合わせる。
 */

/** DB の関数の名前 (supabase.rpc に渡す) */
export const FEATURE_PACKAGES_APPEND_FLAG_RPC = 'append_flag_to_feature_package';

/** DB の関数の引数の名前 (並びは関数の定義と同じ: パッケージの鍵・フラグキー) */
export const FEATURE_PACKAGES_APPEND_FLAG_RPC_ARGS = ['p_package_key', 'p_flag_key'] as const;

/**
 * 作ったフラグのキーを足す機能パッケージの鍵 (package_key)。
 * フラグを作ると、このパッケージのフラグキーの一覧に入る (#1029 から変えていない)
 */
export const NEW_FLAG_DEFAULT_PACKAGE_KEY = 'basic';

/**
 * DB の関数が返す結果の値。
 *   - added: フラグキーを feature_flags の末尾に足した (updated_at も今の時刻にした)
 *   - already_present: このパッケージに、このフラグキーが既に入っていた (何も書かない)
 *   - not_found: この鍵 (package_key) のパッケージが無い (何も書かない)
 * 引数に NULL を渡すと、関数は STRICT なので NULL を返す (どの値でもない = 失敗として扱う)。
 */
export const FEATURE_PACKAGE_FLAG_APPEND_OUTCOME = {
  added: 'added',
  alreadyPresent: 'already_present',
  notFound: 'not_found',
} as const;

export type FeaturePackageFlagAppendOutcome =
  (typeof FEATURE_PACKAGE_FLAG_APPEND_OUTCOME)[keyof typeof FEATURE_PACKAGE_FLAG_APPEND_OUTCOME];

const APPEND_OUTCOME_VALUES: ReadonlySet<string> = new Set(Object.values(FEATURE_PACKAGE_FLAG_APPEND_OUTCOME));

/** DB の関数の戻り値が、結果の値のどれかか (NULL・想定外の値は false) */
export function isFeaturePackageFlagAppendOutcome(value: unknown): value is FeaturePackageFlagAppendOutcome {
  return typeof value === 'string' && APPEND_OUTCOME_VALUES.has(value);
}
