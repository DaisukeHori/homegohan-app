// @vitest-environment node
//
// #1406: Edge Function のゲートウェイの JWT 検証 (supabase/config.toml の verify_jwt) と、関数の中の認証の突き合わせ
//
// 背景: pg_cron は Vault の app_cron_secret (ランダムな文字列で、JWT ではない) を Authorization: Bearer に付けて
// Edge Function を呼ぶ (public.invoke_calculate_segment_stats / public.invoke_catalog_import)。
// ゲートウェイの JWT 検証が有効な関数は、関数に届く前に 401 (UNAUTHORIZED_INVALID_JWT_FORMAT) で止められる。
// pg_net は非同期なので cron.job_run_details は succeeded のままになり、失敗が見えない
// (本番の calculate-segment-stats で整合ゲートが確認した)。
//
// そこで、CRON_SECRET を受け付ける関数 (先頭で requireServiceRole を呼ぶ関数) は verify_jwt = false にして、
// 認証を関数の中に任せる。逆に、verify_jwt = false にした関数は、先頭で自前の認証をしていなければならない
// (ゲートウェイの検証を外したのに関数の中でも確かめないと、誰でも呼べてしまう)。
//
// ここで確かめること (DB もネットワークも使わず、ソースだけを見る):
//   - supabase/config.toml は、許した形の行 (空行・行全体のコメント・[functions.<name>] の見出し・その中の
//     verify_jwt = true / false) だけで書かれている。ほかの行が 1 行でもあれば例外にする
//     (TOML として正しい別の書き方 — インラインテーブル・引用符で囲んだキー・ドット付きのキー・[remotes.*] での上書き・
//     大文字の VERIFY_JWT など — を、書き方ごとに見つけて拒否するのではなく、許した形のほかは読まない)
//   - verify_jwt = false の関数は、どれも関数のディレクトリがあり、先頭で自前の認証をする
//     (requireServiceRole / requireAuth / auth.getUser を、本文を読む前・DB に触る前に呼ぶ)
//   - DB から HTTP (pg_net の net.http_post など) で呼ばれる関数は、どれも verify_jwt = false。
//     呼び先は SQL を読んで推し量らず、DB_HTTP_CALL_SITES に SQL のファイルごとに人が宣言する。宣言の漏れは、
//     DB に入る SQL (supabase/migrations と、本番のスキーマの写し supabase/baseline) の生の文字列で、HTTP の呼び出しらしい箇所
//     (net.http_post( などと、URL の /functions/v1/。コメントや文字列の中も数える) をファイルごとに数え、宣言の数と突き合わせて止める
//     (新しい呼び出しは、どう書いても、呼び先を宣言するまで赤になる)
//   - CRON_SECRET を受け付ける関数 (requireServiceRole / checkCronSecret を呼ぶか、'CRON_SECRET' を読む関数。
//     index.ts の全体と、そこから相対パスの import でたどれるモジュールから拾う) は、どれも verify_jwt = false
//   - GitHub Actions のデプロイは、名前を指定しない functions deploy で config.toml を読み (--no-verify-jwt を付けない)、
//     verify_jwt を環境変数 (SUPABASE_FUNCTIONS_*) で上書きせず、config.toml を変えただけでも動く
//
// supabase CLI 2.62.10 の functions deploy は、名前を指定しないとき supabase/functions/*/index.ts の全関数を配り、
// 関数ごとの verify_jwt を config.toml の [functions.<name>] から読む (--no-verify-jwt を付けたときだけ、全関数でそれが優先)。
// 出典: supabase/cli v2.62.10 の internal/functions/deploy/deploy.go (GetFunctionConfig) と pkg/config/config.go (load)。

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const CONFIG_TOML = 'supabase/config.toml';
const FUNCTIONS_DIR = 'supabase/functions';
const MIGRATIONS_DIR = 'supabase/migrations';
/** 本番のスキーマの写し (scripts/supabase-local.sh が migration より先に入れる) */
const BASELINE_DIR = 'supabase/baseline';
const DEPLOY_WORKFLOW = '.github/workflows/deploy-supabase-functions.yml';
/** pg_cron が Bearer に付ける Vault の秘密の名前 (JWT ではない) */
const VAULT_CRON_SECRET_NAME = 'app_cron_secret';
/** 整合ゲートが本番で 401 を確認した関数 (#1406)。DB からの呼び出し先の抜き出しが空振りしていないことの確かめに使う */
const SEGMENT_STATS_FUNCTION = 'calculate-segment-stats';

// ---------------------------------------------------------------------------
// supabase/config.toml の [functions.<name>] verify_jwt
// ---------------------------------------------------------------------------

/*
 * config.toml に書いてよい行 (許した形。行ごとの完全一致で、どれにも当たらない行が 1 行でもあれば例外にする)。
 *   - 空行と、行全体のコメント (空白のあと # で始まる行)
 *   - 関数の表の見出し [functions.<name>] (<name> は小文字・数字・_ -。同じ名前の 2 回目は例外)
 *   - その表の中の verify_jwt = true / verify_jwt = false (表ごとに 1 回。見出しより前は例外)
 * 引用符・{ } ・ほかの見出し・ほかのキー・行末のコメントを含む行はどれにも当たらないので、TOML として正しい別の書き方で
 * 書いた verify_jwt (インラインテーブル・引用符で囲んだキー・ドット付きのキー・[remotes.*] での上書き・複数行の文字列・
 * 大文字の VERIFY_JWT) は、どれも読み飛ばされずに例外になる。複数行の値も、開く行が許した形に当たらないので始まらない。
 * ほかの表やキーが要るようになったら (例えば [auth.email])、ここが赤になる。そのときは、その行が関数の verify_jwt に
 * 触れないことを確かめてから、この許した形を広げる。
 */
const TOML_BLANK_OR_COMMENT_LINE = /^[ \t]*(?:#.*)?$/;
const TOML_FUNCTION_HEADER_LINE = /^\[functions\.([a-z][a-z0-9_-]*)\]$/;
const TOML_VERIFY_JWT_LINE = /^verify_jwt = (true|false)$/;

/** config.toml の [functions.<name>] ごとの verify_jwt (指定が無ければ CLI の既定値 true)。許した形でない行があれば例外 */
function functionVerifyJwt(toml: string): Map<string, boolean> {
  const result = new Map<string, boolean>();
  /** いま読んでいる [functions.<name>] と、その中の verify_jwt を読んだか */
  let table: { name: string; verifyJwtRead: boolean } | null = null;
  for (const [index, line] of toml.split('\n').entries()) {
    if (TOML_BLANK_OR_COMMENT_LINE.test(line)) continue;
    const header = TOML_FUNCTION_HEADER_LINE.exec(line);
    if (header !== null && !result.has(header[1])) {
      result.set(header[1], true);
      table = { name: header[1], verifyJwtRead: false };
      continue;
    }
    const verifyJwt = TOML_VERIFY_JWT_LINE.exec(line);
    if (verifyJwt !== null && table !== null && !table.verifyJwtRead) {
      result.set(table.name, verifyJwt[1] === 'true');
      table.verifyJwtRead = true;
      continue;
    }
    throw new Error(
      `${CONFIG_TOML}:${index + 1}: 許した形 (空行・行全体のコメント・[functions.<name>] の 1 回目・その中の 1 回目の verify_jwt = true / false) でない行: ${JSON.stringify(line)}`,
    );
  }
  return result;
}

const VERIFY_JWT = functionVerifyJwt(read(CONFIG_TOML));
const NO_VERIFY_JWT = [...VERIFY_JWT].filter(([, verify]) => !verify).map(([name]) => name).sort();

/** CLI の functions deploy が配る関数 (supabase/functions/<name>/index.ts。_shared のように index.ts が無いものは配らない) */
const DEPLOYED_FUNCTIONS = fs
  .readdirSync(path.join(ROOT, FUNCTIONS_DIR), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(ROOT, FUNCTIONS_DIR, entry.name, 'index.ts')))
  .map((entry) => entry.name)
  .sort();

// ---------------------------------------------------------------------------
// 関数の先頭の認証
// ---------------------------------------------------------------------------

const TS_PRINTER = ts.createPrinter({ removeComments: true });
const strippedTsSources = new Map<string, string>();

/**
 * TS のコメントを除いたソース。TypeScript の構文解析で読んで印字し直す
 * (文字列・正規表現・テンプレートの中の // や /* をコメントと取り違えて、後ろのコードを隠さない。#1406 R3 の同型の掃除)。
 * 印字し直すので、空白や引用符の種類は元と変わる (下の正規表現は、どちらでも当たるように書く)。
 */
function stripTsComments(source: string): string {
  const cached = strippedTsSources.get(source);
  if (cached !== undefined) return cached;
  const stripped = TS_PRINTER.printFile(ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS));
  strippedTsSources.set(source, stripped);
  return stripped;
}

/** 自前の認証の呼び出し (どれかを本文を読む前に呼べば、先頭で認証しているとみなす) */
const AUTH_CALLS: ReadonlyArray<{ kind: AuthKind; pattern: RegExp }> = [
  { kind: 'service-role', pattern: /await\s+requireServiceRole\(\s*req\s*\)/ },
  { kind: 'user', pattern: /await\s+requireAuth\(\s*req\s*\)/ },
  { kind: 'user', pattern: /\.auth\.getUser\(/ },
];
type AuthKind = 'service-role' | 'user';

/** 認証より前にあってはいけない処理 (要求の本文を読む・DB に触る) */
const WORK_BEFORE_AUTH = /\breq\.(?:json|text|formData|arrayBuffer|blob)\(|\.from\(\s*['"`]|\.rpc\(\s*['"`]/;

type HandlerAuth = { kind: AuthKind | null; source: string };

/**
 * 要求を受ける処理 (handler 以降のコード) の、先頭の認証の種類を返す。
 * handler の中で、本文を読む・DB に触るより前に認証を呼んでいなければ null。
 */
function leadingAuth(handlerCode: string): AuthKind | null {
  const work = WORK_BEFORE_AUTH.exec(handlerCode);
  const workAt = work ? work.index : Number.POSITIVE_INFINITY;
  let first: { kind: AuthKind; at: number } | null = null;
  for (const { kind, pattern } of AUTH_CALLS) {
    const match = pattern.exec(handlerCode);
    if (match && (first === null || match.index < first.at)) first = { kind, at: match.index };
  }
  return first !== null && first.at < workAt ? first.kind : null;
}

/**
 * 関数の handler のコードを返す。index.ts の Deno.serve( 以降。
 * index.ts が、相対パスで import した関数に要求をそのまま渡すだけ (例: handleCatalogImportRequest) なら、その関数の定義以降。
 */
function handlerCodeOf(functionName: string): string {
  const indexPath = path.join(FUNCTIONS_DIR, functionName, 'index.ts');
  const index = stripTsComments(read(indexPath));
  const serveAt = index.indexOf('Deno.serve(');
  if (serveAt < 0) throw new Error(`${indexPath} に Deno.serve( が無い`);
  const handler = index.slice(serveAt);
  if (AUTH_CALLS.some(({ pattern }) => pattern.test(handler))) return handler;

  for (const imported of index.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'](\.[^"']+)["']/g)) {
    for (const name of imported[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!new RegExp(`\\b${name}\\(\\s*req\\b`).test(handler)) continue;
      const modulePath = path.join(path.dirname(indexPath), imported[2]);
      const moduleCode = stripTsComments(read(modulePath));
      const defAt = moduleCode.search(new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\(`));
      if (defAt >= 0) return moduleCode.slice(defAt);
    }
  }
  return handler;
}

const HANDLER_AUTH = new Map<string, HandlerAuth>(
  DEPLOYED_FUNCTIONS.map((name) => {
    const source = handlerCodeOf(name);
    return [name, { kind: leadingAuth(source), source }];
  }),
);

/** 先頭で自前の認証をしない (関数のディレクトリが無い名前も含む) */
const lacksLeadingAuth = (name: string) => (HANDLER_AUTH.get(name)?.kind ?? null) === null;

/** verify_jwt = false なのに、先頭で自前の認証をしない関数 (ゲートウェイの検証を外したのに、誰でも呼べてしまう関数) */
const noVerifyJwtWithoutLeadingAuth = (verifyJwt: ReadonlyMap<string, boolean>) =>
  [...verifyJwt].filter(([name, verify]) => !verify && lacksLeadingAuth(name)).map(([name]) => name).sort();

/**
 * CRON_SECRET (JWT ではない) を受け付ける印: requireServiceRole か、その中で照合する checkCronSecret
 * (_shared/cron-secret.ts) の呼び出し、または環境変数の名前 'CRON_SECRET' の直書き
 */
const CRON_SECRET_ACCEPTANCE = /\brequireServiceRole\s*\(|\bcheckCronSecret\s*\(|['"`]CRON_SECRET['"`]/;

/** CRON_SECRET を照合する側の定義 (この中の呼び出しや名前は、関数が受け付ける印にしない) */
const CRON_SECRET_DEFINITIONS = ['_shared/auth.ts', '_shared/cron-secret.ts'].map((file) => path.posix.join(FUNCTIONS_DIR, file));

/** 相対パスの import / export ... from / 動的 import( の行き先 */
const RELATIVE_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

/** entry (リポジトリからの相対パス) と、そこから相対パスの import でたどれるモジュールすべて */
function relativeModulesOf(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of stripTsComments(read(file)).matchAll(RELATIVE_IMPORT)) {
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])));
    }
  }
  return [...seen].sort();
}

/** コメントを除いたソースのどれかに、CRON_SECRET を受け付ける印がある */
const acceptsCronSecret = (sources: readonly string[]) => sources.some((source) => CRON_SECRET_ACCEPTANCE.test(source));

/**
 * CRON_SECRET (JWT ではない) を受け付ける関数。index.ts の全体 (Deno.serve( より前に定義した handler も) と、
 * そこから相対パスの import でたどれるモジュールすべて (定義側の CRON_SECRET_DEFINITIONS を除く) から探す
 * (狭く拾うと、verify_jwt = false を求める対象から漏れる)。引数の名前や await の有無も問わない。
 * 先頭で正しく呼んでいるか (await requireServiceRole(req)) は、verify_jwt = false の関数として別に確かめる。
 */
const SERVICE_ROLE_FUNCTIONS = DEPLOYED_FUNCTIONS.filter((name) =>
  acceptsCronSecret(
    relativeModulesOf(path.posix.join(FUNCTIONS_DIR, name, 'index.ts'))
      .filter((file) => !CRON_SECRET_DEFINITIONS.includes(file))
      .map((file) => stripTsComments(read(file))),
  ),
);

// ---------------------------------------------------------------------------
// DB (pg_net など) から HTTP で呼ばれる関数
// ---------------------------------------------------------------------------

/*
 * DB から Edge Function を HTTP で呼ぶ箇所の呼び先は、SQL を読んで推し量らず、下の DB_HTTP_CALL_SITES に人が宣言する。
 * テストは、DB に入る SQL のファイルすべてについて、生の文字列 (コメントも文字列の中も含む) で DB_HTTP_FENCE に当たる数を数え、
 * ファイルごとに宣言の count と合うこと (宣言の無いファイルは 0) を確かめる。
 *
 * そのため、新しい呼び出しは、どう書いても (Supabase の文書が示す、Vault の project_url に '/functions/v1/<name>' を足す形・
 * EXECUTE の文字列の中・条件の中の許可リスト・コメントアウトしたものも) 数が変わり、呼び先を宣言するまで赤になる。
 * 残る危険は宣言の誤り (呼び先を書き漏らす・偽る) で、これは PR の diff に、この宣言の行として見える。
 * 宣言がファイルと食い違わないよう、宣言した呼び先は、そのファイルに '<name>' か /functions/v1/<name>' と書いてあること、
 * 宣言したファイルには Vault の 'app_cron_secret' と 'Bearer ' があることも確かめる。
 *
 * SQL を字句解析して呼び先を推し量る形は、書き方が 1 つ増えるたびに読み落としが出て、読み方を足し続けることになる
 * (#1406 の R1〜R3 で、どの周にも新しい書き方の穴が見つかった)。DB からの呼び出しは少ないので、人の宣言と数の囲いにした。
 *
 * 呼び先を引数で受けて URL を組み立てる包み関数を足すときは、public.invoke_catalog_import のように許可リストで呼び先を固定する
 * (包み関数を呼ぶ側の文は数に入らない。呼び先を宣言できる形にしておく)。
 */

/** DB から HTTP で Edge Function を呼ぶ SQL のファイル 1 本の宣言 */
type DbHttpCallSite = {
  /**
   * そのファイルの生の文字列 (コメントも含む) で DB_HTTP_FENCE に当たる数。呼び出しの数ではない
   * (URL の /functions/v1/ と net.http_post( は、同じ呼び出しのものでもそれぞれ 1 と数える)。合わないと、実際の数がテストの失敗に出る
   */
  count: number;
  /**
   * そのファイルから呼ぶ Edge Function すべて (1 つ以上)。宣言は Edge Function を呼ぶファイルだけにする
   * (当たった箇所が呼び出しでない — コメントの中の語など — なら、宣言せずに書き方を変える。宣言で数を合わせて囲いを緩めない)
   */
  callees: readonly string[];
};

/** public.invoke_catalog_import が IF p_function_name NOT IN (...) THEN RAISE EXCEPTION で絞る 5 本 */
const CATALOG_IMPORT_FUNCTIONS = [
  'import-familymart-catalog',
  'import-lawson-catalog',
  'import-ministop-catalog',
  'import-natural-lawson-catalog',
  'import-seven-eleven-catalog',
];
/** public.invoke_calculate_segment_stats と、そのジョブを足した migration */
const SEGMENT_STATS_MIGRATION = path.posix.join(MIGRATIONS_DIR, '20261009100000_schedule_calculate_segment_stats.sql');

const DB_HTTP_CALL_SITES: ReadonlyMap<string, DbHttpCallSite> = new Map<string, DbHttpCallSite>([
  // public.invoke_catalog_import: '.../functions/v1/' || p_function_name を v_url に入れ、net.http_post で呼ぶ
  [path.posix.join(MIGRATIONS_DIR, '20251126124224_create_meal_planner_tables.sql'), { count: 2, callees: CATALOG_IMPORT_FUNCTIONS }],
  // 本番のスキーマの写し。上と同じ public.invoke_catalog_import
  [path.posix.join(BASELINE_DIR, 'prod_schema.sql'), { count: 2, callees: CATALOG_IMPORT_FUNCTIONS }],
  // public.invoke_calculate_segment_stats: 定数 c_url の '.../functions/v1/calculate-segment-stats' を net.http_post で呼ぶ
  [SEGMENT_STATS_MIGRATION, { count: 2, callees: [SEGMENT_STATS_FUNCTION] }],
]);

/**
 * DB から HTTP を送る呼び出しらしい箇所 (取りこぼすより多めに当てる。コメントや文字列の中も数える):
 *   - pg_net の net.http_post / http_get / http_delete、同期の http 拡張 (pgsql-http) の http_post / http_get / http_put /
 *     http_patch / http_delete / http_head と http(...)、Database Webhooks の supabase_functions.http_request の呼び出し
 *     (スキーマ名・" で囲んだ名前・( の前の空白や改行を問わない)
 *   - Edge Function の URL の一部 /functions/v1/ (URL を呼び出しと別の文で組み立てる形・Vault の project_url に足す形も当たる)
 * 自前で包んだ関数 (my_http_post( のように前に語の文字が付く名前) の呼び出しと、型の ::http_request は当たらない
 * (包んだ関数の本文の中の呼び出しが当たる)。
 */
const DB_HTTP_FENCE = /\bhttp(?:_(?:post|get|put|patch|delete|head|request))?"?\s*\(|\/functions\/v1\//gi;

/** SQL の生の文字列で DB_HTTP_FENCE に当たる数 */
const countDbHttpFence = (sql: string) => [...sql.matchAll(DB_HTTP_FENCE)].length;

/** 宣言したファイルに書いてあるはずの、JWT でない Bearer で呼ぶ印 (Vault の秘密の名前と、Bearer の前置き) */
const NON_JWT_BEARER_MARKERS = [`'${VAULT_CRON_SECRET_NAME}'`, `'Bearer '`];

/**
 * 宣言 (sites) と SQL のファイル (sqlTexts: リポジトリからの相対パス → 生の文字列) の食い違い (無ければ空):
 *   - ファイルごとの DB_HTTP_FENCE の数が、宣言の count と違う (宣言の無いファイルは 0)
 *   - 宣言したファイルが無い・宣言の count が 0・宣言の callees が空
 *   - 宣言した呼び先が、そのファイルに '<name>' とも /functions/v1/<name>' とも書かれていない
 *   - 宣言したファイルに、'app_cron_secret' か 'Bearer ' が無い
 */
function dbHttpCallSiteProblems(sqlTexts: ReadonlyMap<string, string>, sites: ReadonlyMap<string, DbHttpCallSite>): string[] {
  const problems: string[] = [];
  for (const [file, sql] of sqlTexts) {
    const found = countDbHttpFence(sql);
    const declared = sites.get(file)?.count ?? 0;
    if (found !== declared) {
      problems.push(`${file}: HTTP の呼び出しらしい箇所が ${found} (宣言は ${declared})。呼び先と数を DB_HTTP_CALL_SITES に宣言する`);
    }
  }
  for (const [file, { count, callees }] of sites) {
    const sql = sqlTexts.get(file);
    if (sql === undefined) {
      problems.push(`${file}: 宣言したファイルが無い`);
      continue;
    }
    if (count === 0) problems.push(`${file}: 宣言の count が 0 (当たる箇所の無いファイルは宣言しない)`);
    if (callees.length === 0) problems.push(`${file}: 宣言の callees が空 (Edge Function を呼ばないファイルは宣言しない)`);
    for (const name of callees.filter((callee) => !sql.includes(`'${callee}'`) && !sql.includes(`/functions/v1/${callee}'`))) {
      problems.push(`${file}: 宣言した呼び先 ${name} が、ファイルに '${name}' とも /functions/v1/${name}' とも書かれていない`);
    }
    for (const marker of NON_JWT_BEARER_MARKERS.filter((needle) => !sql.includes(needle))) {
      problems.push(`${file}: ${marker} が無い (JWT でない Bearer で呼ぶ前提が崩れている。宣言を見直す)`);
    }
  }
  return problems;
}

/** 宣言の呼び先すべて (DB から呼ばれる Edge Function) */
const dbCalleesOf = (sites: ReadonlyMap<string, DbHttpCallSite>) =>
  [...new Set([...sites.values()].flatMap(({ callees }) => callees))].sort();

/** ゲートウェイの JWT 検証で止められる呼び先 (verify_jwt = false でない。config.toml に無い名前も含む) */
const calleesStoppedByGateway = (callees: readonly string[], verifyJwt: ReadonlyMap<string, boolean>) =>
  callees.filter((name) => verifyJwt.get(name) !== false);

/**
 * DB に入る SQL のファイル (リポジトリからの相対パス)。名前で除外せず、下のディレクトリまでたどる
 * (除外した形のファイルや、下のディレクトリに書いた呼び出しを見落とさないため)。
 *   - supabase/migrations の .sql すべて (戻しの .down.sql は supabase/rollbacks に置く。本番へは直接流さず、
 *     その内容を新しい migration として supabase/migrations に足して入れるので、ここで数えられる)
 *   - supabase/baseline の .sql すべて (本番のスキーマの写し。ローカルの DB は、これを migration より先に入れる)
 */
const SQL_DIRS = [MIGRATIONS_DIR, BASELINE_DIR];
const SQL_FILES = SQL_DIRS.flatMap((dir) =>
  fs
    .readdirSync(path.join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.sql'))
    .map((file) => path.posix.join(dir, file.split(path.sep).join(path.posix.sep))),
).sort();
const SQL_TEXT: ReadonlyMap<string, string> = new Map(SQL_FILES.map((file) => [file, read(file)]));

const DB_CALLEES = dbCalleesOf(DB_HTTP_CALL_SITES);

// ---------------------------------------------------------------------------
// デプロイのワークフロー
// ---------------------------------------------------------------------------

/** 名前を指定しない (全関数の) functions deploy の行 (許した形。引数は --project-ref だけ) */
const DEPLOY_ALL_LINE =
  /^npx --yes supabase@\d+\.\d+\.\d+ functions deploy --project-ref (?:\$\{\{ env\.SUPABASE_PROJECT_ID \}\}|[a-z0-9]+)$/;

/**
 * デプロイのワークフローが、config.toml の verify_jwt をそのまま関数ごとに反映しない理由 (無ければ空)。
 * コメントも含めた全文を見る (# の手前で切ると、文字列の中の # の後ろに書いたフラグや環境変数を見落とす。#1406 R3 の同型の掃除)。
 * そのため、ワークフローのコメントにも --no-verify-jwt や SUPABASE_FUNCTIONS を書かない。
 */
function deployWorkflowProblems(yaml: string): string[] {
  const problems: string[] = [];
  const deployLines = yaml
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\bfunctions\s+deploy\b/.test(line));
  // 関数名を指定すると、それ以外の関数の verify_jwt が反映されない
  if (deployLines.length !== 1) problems.push(`functions deploy の行が ${deployLines.length} 行ある (名前を指定しない 1 行だけにする)`);
  for (const line of deployLines.filter((deployLine) => !DEPLOY_ALL_LINE.test(deployLine))) {
    problems.push(`名前を指定しない形 (引数は --project-ref だけ) でない functions deploy: ${line}`);
  }
  if (/--no-verify-jwt/.test(yaml)) problems.push('--no-verify-jwt がある (全関数のゲートウェイの JWT 検証を外す)');
  // CLI は config.toml を viper で読み、SUPABASE_ + キーの . を _ にした環境変数 (SUPABASE_FUNCTIONS_<NAME>_VERIFY_JWT) で
  // 上書きする (pkg/config/config.go の loadFromFile)。.env ファイル (SUPABASE_ENV で選ぶものも) からも読むが、
  // .env* は .gitignore で除いてあり (.env.example は CLI が読まない)、Actions のチェックアウトには無い。
  // 残る経路はワークフローの env なので、ここで止める
  if (/SUPABASE_FUNCTIONS|SUPABASE_ENV\b/i.test(yaml)) problems.push('verify_jwt を環境変数 (SUPABASE_FUNCTIONS_* / SUPABASE_ENV) で上書きしている');
  const paths = [...yaml.matchAll(/^\s*-\s*'([^']+)'\s*$/gm)].map((m) => m[1]);
  for (const required of ['supabase/functions/**', CONFIG_TOML]) {
    if (!paths.includes(required)) problems.push(`push の paths に ${required} が無い (変えただけでデプロイが動かない)`);
  }
  return problems;
}

// ---------------------------------------------------------------------------

describe('検査の道具が空振りしない', () => {
  it('先頭の認証の判定: 本文を読んだ後の認証・認証なし・コメントの中の認証は、先頭の認証とみなさない', () => {
    expect(leadingAuth('Deno.serve(async (req) => { const authErr = await requireServiceRole(req); await req.json(); })')).toBe(
      'service-role',
    );
    expect(leadingAuth('Deno.serve(async (req) => { const r = await requireAuth(req); await req.json(); })')).toBe('user');
    expect(leadingAuth('Deno.serve(async (req) => { const b = await req.json(); await requireServiceRole(req); })')).toBeNull();
    expect(leadingAuth("Deno.serve(async (req) => { await supabase.from('t').select(); await requireAuth(req); })")).toBeNull();
    expect(leadingAuth('Deno.serve(async (req) => { return new Response("ok"); })')).toBeNull();
    expect(leadingAuth(stripTsComments('Deno.serve(async (req) => {\n// await requireServiceRole(req)\n await req.json(); })'))).toBeNull();
  });

  it('TS のコメントは構文解析で除き、文字列の中の /* や // で後ろのコードを隠さない (#1406 R3 の同型の掃除)', () => {
    // 文字列の中の /* から後ろの本当のコメントの */ までを除くと、認証より前に本文を読む処理が隠れ、先頭で認証していると見なしてしまう
    const readsBodyFirst = [
      'Deno.serve(async (req) => {',
      "  const glob = 'assets/*';",
      '  const body = await req.json();',
      '  /* ここから認証 */',
      '  await requireServiceRole(req);',
      '});',
    ].join('\n');
    expect(leadingAuth(stripTsComments(readsBodyFirst))).toBeNull();
    // 同じく、requireServiceRole の呼び出しが隠れると、CRON_SECRET を受け付ける関数から漏れる (verify_jwt = false を求めなくなる)
    expect(acceptsCronSecret([stripTsComments('const glob = "assets/*";\nawait requireServiceRole(req);\n/* x */\n')])).toBe(true);
    expect(stripTsComments('const u = "a//b"; await req.json();')).toContain('req.json()');
    // コメントの中だけの呼び出しは数えない
    expect(acceptsCronSecret([stripTsComments('/* await requireServiceRole(req) */\n// checkCronSecret(x)\nconst a = 1;\n')])).toBe(false);
  });

  it('config.toml の読み取り: [functions.*] があり、既定値 (指定なし) は true として扱う', () => {
    expect(VERIFY_JWT.size).toBeGreaterThan(0);
    expect(functionVerifyJwt('# c\n\n[functions.a]\n  # d\n[functions.b_c]\nverify_jwt = false\n')).toEqual(
      new Map([
        ['a', true],
        ['b_c', false],
      ]),
    );
  });

  // config.toml は許した形の行だけを読む (#1406 R2・R3 のレビューの指摘。TOML として正しい別の書き方の verify_jwt を読み飛ばして緑にしない)
  describe('config.toml の許した形でない行は、1 行でも例外にする', () => {
    /** 先頭で自前の認証をしない、配られる関数 (verify_jwt = false にすると下の検査で赤になるはずの関数) */
    const withoutAuth = DEPLOYED_FUNCTIONS.filter(lacksLeadingAuth);
    const target = withoutAuth[0];

    it('先頭で自前の認証をしない関数がある (下の確かめの前提)', () => {
      expect(target).toBeDefined();
    });

    it('許した形の verify_jwt = false は読み、先頭の認証が無ければ赤になる', () => {
      const verifyJwt = functionVerifyJwt(`[functions.${target}]\nverify_jwt = false\n`);
      expect(verifyJwt).toEqual(new Map([[target, false]]));
      expect(noVerifyJwtWithoutLeadingAuth(verifyJwt)).toEqual([target]);
    });

    it('R3 のレビューの変異: 実物の config.toml の末尾に、# を含む文字列の後ろの引用符付きのキーで verify_jwt を書くと例外になる', () => {
      const appended = `[remotes]\nprod = { a = "#", "functions" = { "${target}" = { "verify_jwt" = false } } }\n`;
      expect(() => functionVerifyJwt(read(CONFIG_TOML))).not.toThrow();
      expect(() => functionVerifyJwt(`${read(CONFIG_TOML)}\n${appended}`)).toThrow(/許した形/);
    });

    it.each([
      // R2 のレビューで見つかった、CLI が関数の設定として読む別の書き方
      ['[functions] の下のインラインテーブル', (name: string) => `[functions]\n${name} = { verify_jwt = false }\n`],
      ['最上位のドット付きのキー', (name: string) => `functions.${name}.verify_jwt = false\n`],
      ['最上位のインラインテーブル', (name: string) => `functions = { ${name} = { verify_jwt = false } }\n`],
      ['ほかの表の中のドット付きのキー', (name: string) => `[remotes.prod]\nfunctions.${name}.verify_jwt = false\n`],
      ['[remotes.*] の中の [functions.<name>]', (name: string) => `[remotes.prod.functions.${name}]\nverify_jwt = false\n`],
      ['ほかの表の値のインラインテーブル', (name: string) => `[remotes]\nprod = { functions = { ${name} = { verify_jwt = false } } }\n`],
      ['関数の下の表 [functions.<name>.<sub>]', (name: string) => `[functions.${name}.sub]\nverify_jwt = false\n`],
      ['表の配列 [[functions.<name>]]', (name: string) => `[[functions.${name}]]\nverify_jwt = false\n`],
      ['大文字のキー VERIFY_JWT (CLI は大文字小文字を区別しない)', (name: string) => `[functions.${name}]\nVERIFY_JWT = false\n`],
      ['大文字の関数名', (name: string) => `[functions.${name.toUpperCase()}]\nverify_jwt = false\n`],
      ['同じ関数の見出しの 2 回目', (name: string) => `[functions.${name}]\nverify_jwt = true\n[functions.${name}]\nverify_jwt = false\n`],
      ['verify_jwt の 2 回目', (name: string) => `[functions.${name}]\nverify_jwt = true\nverify_jwt = false\n`],
      [
        '複数行の文字列の中に書いた見出し',
        (name: string) => `[functions.${name}]\nimport_map = """\n[functions.${SEGMENT_STATS_FUNCTION}]\nverify_jwt = false\n"""\n`,
      ],
      ['複数行の配列の中に書いた設定', (name: string) => `[remotes.prod]\nx = [\n  { functions = { ${name} = { verify_jwt = false } } },\n]\n`],
      ['読めない行', (name: string) => `[functions.${name}]\nverify_jwt false\n`],
      // R2 では同じ名前として読んでいた書き方 (許した形でないので、いまは例外)
      ['引用符で囲んだ名前 [functions."<name>"]', (name: string) => `[functions."${name}"]\nverify_jwt = false\n`],
      ["' で囲んだ名前 [functions.'<name>']", (name: string) => `[functions.'${name}']\nverify_jwt = false\n`],
      ['空白を挟んだ見出し [ functions . <name> ]', (name: string) => `[ functions . ${name} ]\nverify_jwt = false\n`],
      ['引用符で囲んだキー "verify_jwt"', (name: string) => `[functions.${name}]\n"verify_jwt" = false\n`],
      ['見出しの後ろのコメント', (name: string) => `[functions.${name}] # x\nverify_jwt = false\n`],
      ['verify_jwt の後ろのコメント', (name: string) => `[functions.${name}]\nverify_jwt = false # y\n`],
      // 許した形からのずれ
      ['行頭の空白', (name: string) => `[functions.${name}]\n  verify_jwt = false\n`],
      ['= の前後の空白が無い', (name: string) => `[functions.${name}]\nverify_jwt=false\n`],
      ['値の大文字', (name: string) => `[functions.${name}]\nverify_jwt = False\n`],
      ['見出しより前の verify_jwt', (name: string) => `verify_jwt = false\n[functions.${name}]\n`],
      ['関数の表のほかのキー', (name: string) => `[functions.${name}]\nenabled = true\n`],
      ['ほかの表', () => `[auth.email]\ndouble_confirm_changes = false\n`],
      ['CRLF の改行', (name: string) => `[functions.${name}]\r\nverify_jwt = false\r\n`],
    ])('%s は例外にする', (_form, toml) => {
      expect(() => functionVerifyJwt(toml(target))).toThrow(/許した形/);
    });
  });

  it(`DB から呼ばれる関数の宣言に、${SEGMENT_STATS_FUNCTION} とカタログ取り込みの 5 本がある`, () => {
    expect(DB_CALLEES).toEqual([...CATALOG_IMPORT_FUNCTIONS, SEGMENT_STATS_FUNCTION].sort());
  });

  // DB からの HTTP の呼び出しは、SQL を読まず、宣言と、生の文字列で数えた数の突き合わせで囲う (#1406 R4 のレビューの指摘。
  // R1〜R3 で SQL の字句解析が読み落とした書き方も、Supabase の文書の形も、宣言するまで赤になる)
  describe('DB からの HTTP の呼び出しは、宣言の無いものがあれば赤にする', () => {
    /** 宣言の無い、新しい migration */
    const NEW_MIGRATION = path.posix.join(MIGRATIONS_DIR, '99999999999999_synthetic.sql');
    /** verify_jwt が既定 (true) の関数 (DB から呼ぶと、本番では関数に届かない) */
    const CALLEE = 'backfill-ingredient-embeddings';
    const BEARER = `'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = '${VAULT_CRON_SECRET_NAME}')`;
    /** Supabase の文書が示す、Vault に入れたプロジェクトの URL */
    const VAULT_PROJECT_URL = "(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url')";
    /** Supabase の文書が示す形: 関数で包まない cron.schedule で、Vault の project_url に /functions/v1/<name> を足して呼ぶ */
    const DOCUMENTED_FORM = `SELECT cron.schedule('x', '0 * * * *', $$ SELECT net.http_post(url := ${VAULT_PROJECT_URL} || '/functions/v1/${CALLEE}', headers := jsonb_build_object(${BEARER})); $$);`;
    /** 実物の SQL に、file を足した (同じ名前なら差し替えた) もの */
    const withFile = (file: string, sql: string) => new Map([...SQL_TEXT, [file, sql]]);
    /** 実物の宣言に、file の宣言を足した (同じ名前なら差し替えた) もの */
    const withSite = (file: string, site: DbHttpCallSite) => new Map([...DB_HTTP_CALL_SITES, [file, site]]);
    const countProblemOf = (file: string) => expect.stringContaining(`${file}: HTTP の呼び出しらしい箇所が`);

    it.each([
      ['Supabase の文書の形 (Vault の project_url に /functions/v1/<name> を足す)', DOCUMENTED_FORM],
      ['EXECUTE の文字列の中の呼び出し', `DO $$ BEGIN EXECUTE 'SELECT net.http_post(url := ''https://example.supabase.co/functions/v1/${CALLEE}'')'; END $$;`],
      [
        '通らない条件の中に入れた許可リスト',
        [
          'CREATE FUNCTION public.f(p text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN',
          "  IF false THEN IF p NOT IN ('a-fn') THEN RAISE EXCEPTION 'x'; END IF; END IF;",
          "  PERFORM net.http_post(url := 'https://example.supabase.co/functions/v1/' || p);",
          'END $$;',
        ].join('\n'),
      ],
      ['URL を表から読む呼び出し', 'SELECT net.http_post(url := t.url) FROM public.t;'],
      ['コメントアウトした呼び出し (数える側に倒す)', `-- SELECT net.http_post(url := 'https://example.supabase.co/functions/v1/${CALLEE}');`],
      ['同期の http 拡張 (pgsql-http) の http(...)', "SELECT http(('POST', t.url, ARRAY[]::http_header[], 'application/json', '{}')::http_request) FROM public.t;"],
      [
        'Database Webhooks の supabase_functions.http_request',
        "CREATE TRIGGER t AFTER INSERT ON public.x FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request(t.url, 'POST', '{}', '{}', '1000');",
      ],
      ['" で囲んだ名前と、( の前の改行', 'SELECT "net"."http_post"\n  (url := t.url) FROM public.t;'],
      ['呼び出しと別の文で URL だけを組み立てる', `UPDATE public.settings SET url = ${VAULT_PROJECT_URL} || '/functions/v1/${CALLEE}';`],
    ])('%s を新しい migration に書くと赤', (_form, sql) => {
      expect(dbHttpCallSiteProblems(withFile(NEW_MIGRATION, sql), DB_HTTP_CALL_SITES)).toEqual([countProblemOf(NEW_MIGRATION)]);
    });

    it('宣言したファイルに呼び出しを 1 つ足しても、数が合わず赤', () => {
      const sql = `${SQL_TEXT.get(SEGMENT_STATS_MIGRATION) ?? ''}\n${DOCUMENTED_FORM}\n`;
      expect(dbHttpCallSiteProblems(withFile(SEGMENT_STATS_MIGRATION, sql), DB_HTTP_CALL_SITES)).toEqual([
        countProblemOf(SEGMENT_STATS_MIGRATION),
      ]);
    });

    it('包んだ関数の呼び出し・型の ::http_request・http_header(...) は数えない (包んだ関数の本文の中の呼び出しが当たる)', () => {
      expect(countDbHttpFence("SELECT public.my_http_post('x'); SELECT ('POST', 'u')::http_request; SELECT http_header('a', 'b');")).toBe(0);
      expect(countDbHttpFence("CREATE FUNCTION public.my_http_post(u text) RETURNS bigint LANGUAGE sql AS $$ SELECT net.http_post(u) $$;")).toBe(1);
    });

    it('宣言がファイルと食い違えば赤 (呼び先がファイルに無い・ファイルが無い・count が 0・callees が空・Bearer の印が無い)', () => {
      const segment = DB_HTTP_CALL_SITES.get(SEGMENT_STATS_MIGRATION);
      expect(segment).toBeDefined();
      const count = segment?.count ?? 0;
      const problemsOf = (sql: string, site: DbHttpCallSite) => dbHttpCallSiteProblems(withFile(NEW_MIGRATION, sql), withSite(NEW_MIGRATION, site));
      expect(dbHttpCallSiteProblems(SQL_TEXT, withSite(SEGMENT_STATS_MIGRATION, { count, callees: [CALLEE] }))).toEqual([
        expect.stringContaining(`${SEGMENT_STATS_MIGRATION}: 宣言した呼び先 ${CALLEE} が`),
      ]);
      expect(dbHttpCallSiteProblems(SQL_TEXT, withSite(NEW_MIGRATION, { count: 1, callees: [CALLEE] }))).toEqual([
        `${NEW_MIGRATION}: 宣言したファイルが無い`,
      ]);
      // 当たる箇所の無いファイル (呼び先と Bearer の印はコメントにだけある)
      expect(problemsOf(`-- '${CALLEE}' ${BEARER}`, { count: 0, callees: [CALLEE] })).toEqual([
        expect.stringContaining(`${NEW_MIGRATION}: 宣言の count が 0`),
      ]);
      // 呼び先を宣言せずに数だけ合わせる
      expect(problemsOf(DOCUMENTED_FORM, { count: countDbHttpFence(DOCUMENTED_FORM), callees: [] })).toEqual([
        expect.stringContaining(`${NEW_MIGRATION}: 宣言の callees が空`),
      ]);
      const plain = "SELECT net.http_post(url := 'https://example.supabase.co/functions/v1/a-fn');";
      expect(problemsOf(plain, { count: countDbHttpFence(plain), callees: ['a-fn'] })).toEqual(
        NON_JWT_BEARER_MARKERS.map((marker) => expect.stringContaining(`${NEW_MIGRATION}: ${marker} が無い`)),
      );
    });

    it('正しく宣言しても、呼び先が verify_jwt = false でなければ、下の verify_jwt の検査で赤', () => {
      expect(VERIFY_JWT.get(CALLEE) ?? true).toBe(true);
      const sites = withSite(NEW_MIGRATION, { count: countDbHttpFence(DOCUMENTED_FORM), callees: [CALLEE] });
      expect(dbHttpCallSiteProblems(withFile(NEW_MIGRATION, DOCUMENTED_FORM), sites)).toEqual([]);
      expect(calleesStoppedByGateway(dbCalleesOf(sites), VERIFY_JWT)).toEqual([CALLEE]);
    });
  });

  it('requireServiceRole で認証する関数を見つけられている (要求を渡すだけの index.ts も、渡し先の関数を見る)', () => {
    expect(SERVICE_ROLE_FUNCTIONS).toContain(SEGMENT_STATS_FUNCTION);
    expect(SERVICE_ROLE_FUNCTIONS).toContain('import-seven-eleven-catalog');
  });

  it('CRON_SECRET を受け付ける関数は、Deno.serve( より前に定義した handler の中の呼び出しも拾う (#1406 R2 の同型の掃除)', () => {
    const index = (body: string) =>
      stripTsComments(`async function handler(req: Request) {\n  ${body}\n  return new Response('ok');\n}\nDeno.serve(handler);\n`);
    for (const body of [
      'const authErr = await requireServiceRole(req);',
      "const check = await checkCronSecret(req.headers.get('Authorization'), { current: Deno.env.get('CRON_SECRET') });",
      'const secret = Deno.env.get("CRON_SECRET");',
    ]) {
      const code = index(body);
      // handler の本体は Deno.serve( より前にあるので、Deno.serve( 以降だけを見ると拾えない
      expect(acceptsCronSecret([code.slice(code.indexOf('Deno.serve('))])).toBe(false);
      expect(acceptsCronSecret([code])).toBe(true);
    }
    // コメントの中だけの CRON_SECRET は数えない
    expect(acceptsCronSecret([index("// Deno.env.get('CRON_SECRET'); await requireServiceRole(req)")])).toBe(false);
  });

  it('CRON_SECRET を受け付けるかは、index.ts から相対パスの import でたどれるモジュールも見る (照合する側の定義は除く)', () => {
    const modules = relativeModulesOf(path.posix.join(FUNCTIONS_DIR, 'import-seven-eleven-catalog', 'index.ts'));
    expect(modules).toContain(path.posix.join(FUNCTIONS_DIR, '_shared/catalog/import-runner.ts'));
    // requireAuth だけを使う関数も _shared/auth.ts (requireServiceRole の定義) を import するので、定義は印にしない
    const [authModule] = CRON_SECRET_DEFINITIONS;
    const importsAuthOnly = DEPLOYED_FUNCTIONS.filter(
      (name) =>
        relativeModulesOf(path.posix.join(FUNCTIONS_DIR, name, 'index.ts')).includes(authModule) &&
        !SERVICE_ROLE_FUNCTIONS.includes(name),
    );
    expect(importsAuthOnly.length).toBeGreaterThan(0);
  });
});

describe('verify_jwt = false の関数は、先頭で自前の認証をする', () => {
  it('verify_jwt = false の関数は、どれも配られる関数 (supabase/functions/<name>/index.ts) である', () => {
    // 関数が無い名前があると、CLI は config.toml の関数として配ろうとして失敗する
    expect(NO_VERIFY_JWT.filter((name) => !DEPLOYED_FUNCTIONS.includes(name))).toEqual([]);
  });

  it.each(NO_VERIFY_JWT)('%s: 本文を読む・DB に触る前に、requireServiceRole / requireAuth / auth.getUser を呼ぶ', (name) => {
    expect(lacksLeadingAuth(name), `${name} はゲートウェイの検証を外しているのに、先頭で認証していない`).toBe(false);
  });

  it('verify_jwt = false なのに先頭で自前の認証をしない関数は無い (上の合成した config.toml の確かめと同じ判定)', () => {
    expect(noVerifyJwtWithoutLeadingAuth(VERIFY_JWT)).toEqual([]);
  });
});

describe('JWT でない Bearer で呼ばれる関数は、verify_jwt = false', () => {
  it('DB に入る SQL (migration と本番のスキーマの写し) の HTTP の呼び出しらしい箇所は、どのファイルも DB_HTTP_CALL_SITES の宣言と合う', () => {
    // 宣言の無い呼び出しは、下の verify_jwt の検査から漏れる。生の文字列で数えた数と、ファイルごとに突き合わせる
    expect(dbHttpCallSiteProblems(SQL_TEXT, DB_HTTP_CALL_SITES)).toEqual([]);
    // 空振りしていないこと (両方のディレクトリを読み、どちらにも当たる箇所がある。
    // migration には SQL 関数 2 つ、本番のスキーマの写しには invoke_catalog_import がある)
    for (const dir of SQL_DIRS) {
      const files = SQL_FILES.filter((file) => file.startsWith(`${dir}/`));
      expect(files.length, `${dir} の .sql を読めていない`).toBeGreaterThan(0);
      expect(
        files.some((file) => countDbHttpFence(SQL_TEXT.get(file) ?? '') > 0),
        `${dir} に HTTP の呼び出しらしい箇所が無い`,
      ).toBe(true);
    }
  });

  it('DB から呼ばれる関数は、どれも配られる関数 (supabase/functions/<name>/index.ts) である', () => {
    // 宣言に配っていない名前があると、その呼び出しは本番で 404 になる
    expect(DB_CALLEES.filter((name) => !DEPLOYED_FUNCTIONS.includes(name))).toEqual([]);
  });

  it('DB (pg_cron → pg_net) から呼ばれる関数は、どれも verify_jwt = false', () => {
    // 外し忘れると、ゲートウェイが 401 (UNAUTHORIZED_INVALID_JWT_FORMAT) を返し、関数に届かない。
    // cron.job_run_details は succeeded のままなので、ここで止める
    expect(calleesStoppedByGateway(DB_CALLEES, VERIFY_JWT)).toEqual([]);
  });

  it('DB から呼ばれる関数は、どれも先頭で requireServiceRole を呼ぶ (CRON_SECRET で認証する)', () => {
    expect(
      DB_CALLEES.filter((name) => !SERVICE_ROLE_FUNCTIONS.includes(name) || HANDLER_AUTH.get(name)?.kind !== 'service-role'),
    ).toEqual([]);
  });

  it('CRON_SECRET を受け付ける関数 (requireServiceRole / checkCronSecret / CRON_SECRET) は、どれも verify_jwt = false', () => {
    // verify_jwt が有効なままだと、CRON_SECRET で呼んだときだけゲートウェイで止まり、関数の中の受け付け方と食い違う
    expect(SERVICE_ROLE_FUNCTIONS.filter((name) => VERIFY_JWT.get(name) !== false)).toEqual([]);
  });
});

describe('デプロイが config.toml の verify_jwt を反映する', () => {
  it('functions deploy は名前を指定せず (全関数)、--no-verify-jwt を付けず、環境変数で上書きせず、config.toml を変えただけでも動く', () => {
    expect(deployWorkflowProblems(read(DEPLOY_WORKFLOW))).toEqual([]);
  });

  const deployLine = 'npx --yes supabase@2.62.10 functions deploy --project-ref ${{ env.SUPABASE_PROJECT_ID }}';
  it.each([
    ['関数名を指定する', (yaml: string) => yaml.replace(deployLine, deployLine.replace('deploy', `deploy ${SEGMENT_STATS_FUNCTION}`))],
    ['--no-verify-jwt を付ける', (yaml: string) => yaml.replace(deployLine, `${deployLine} --no-verify-jwt`)],
    // 文字列の中の # の後ろに書いたもの (YAML のコメントとして読み飛ばすと見落とす。#1406 R3 の同型の掃除)
    [
      '文字列の中の # の後ろで、ほかの関数を --no-verify-jwt で配る',
      (yaml: string) => yaml.replace(deployLine, `${deployLine}\n          echo " #" && npx --yes supabase@2.62.10 functions deploy x --no-verify-jwt`),
    ],
    [
      '文字列の中の # の後ろで、verify_jwt を環境変数で上書きする',
      (yaml: string) => yaml.replace(deployLine, `echo " #"; export SUPABASE_FUNCTIONS_X_VERIFY_JWT=false\n          ${deployLine}`),
    ],
    ['config.toml を push の paths から外す', (yaml: string) => yaml.replace(`      - '${CONFIG_TOML}'\n`, '')],
  ])('%s と、問題として見つける', (_form, mutate) => {
    const yaml = read(DEPLOY_WORKFLOW);
    expect(yaml).toContain(deployLine);
    const mutated = mutate(yaml);
    expect(mutated).not.toBe(yaml);
    expect(deployWorkflowProblems(mutated)).not.toEqual([]);
  });
});
