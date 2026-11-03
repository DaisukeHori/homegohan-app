/**
 * #2189 W4: 機能パッケージのフラグキーの一覧にキーを 1 つ足す関数 append_flag_to_feature_package を足す migration の値。
 * tests/feature-packages-append-flag-rpc-migration-contract.test.ts (静的) と
 * tests/integration/rls/feature-packages-append-flag-rpc.test.ts (実 DB) が同じ値を見る。
 * 関数の名前・引数・結果の値はアプリのコードと同じ定数 (src/lib/super-admin/feature-package-flag-append.ts) から作る。
 */
import {
  FEATURE_PACKAGES_APPEND_FLAG_RPC,
  FEATURE_PACKAGES_APPEND_FLAG_RPC_ARGS,
} from '@/lib/super-admin/feature-package-flag-append';

/** 対象の表 */
export const FEATURE_PACKAGES_TABLE = 'feature_packages';
/** migration のファイル名の、番号の後ろの名前 */
export const FEATURE_PACKAGES_APPEND_FLAG_RPC_MIGRATION_NAME = 'feature_packages_append_flag_rpc';
/** 本冊の直前に main に入っていた migration の番号 (本冊の番号はこれより大きい) */
export const PRECEDING_MIGRATION_VERSION = '20261101120000';
/** 関数の引数の型 (どちらも text。並びは FEATURE_PACKAGES_APPEND_FLAG_RPC_ARGS と同じ) */
export const APPEND_FLAG_RPC_ARG_TYPES = ['text', 'text'] as const;
/** カタログ (regprocedure) での関数の署名 (schema を除いた形) */
export const APPEND_FLAG_RPC_SIGNATURE = `${FEATURE_PACKAGES_APPEND_FLAG_RPC}(${APPEND_FLAG_RPC_ARG_TYPES.join(',')})`;
/** migration・戻し口の文で使う、schema つきで引数の型まで書いた関数の名前 */
export const APPEND_FLAG_RPC_QUALIFIED = `public.${FEATURE_PACKAGES_APPEND_FLAG_RPC}(${APPEND_FLAG_RPC_ARG_TYPES.join(', ')})`;
/** CREATE FUNCTION の引数の並び (名前 型) */
export const APPEND_FLAG_RPC_PARAMS = FEATURE_PACKAGES_APPEND_FLAG_RPC_ARGS.map(
  (name, i) => `${name} ${APPEND_FLAG_RPC_ARG_TYPES[i]}`,
).join(', ');
/** EXECUTE を外す文 (逐語) */
export const APPEND_FLAG_RPC_REVOKE_STATEMENT = `REVOKE ALL ON FUNCTION ${APPEND_FLAG_RPC_QUALIFIED} FROM PUBLIC, anon, authenticated, service_role;`;
/** EXECUTE を付ける文 (逐語。service_role だけ) */
export const APPEND_FLAG_RPC_GRANT_STATEMENT = `GRANT EXECUTE ON FUNCTION ${APPEND_FLAG_RPC_QUALIFIED} TO service_role;`;
/** 戻し口の DROP FUNCTION の文 (逐語) */
export const APPEND_FLAG_RPC_DROP_STATEMENT = `DROP FUNCTION IF EXISTS ${APPEND_FLAG_RPC_QUALIFIED};`;
