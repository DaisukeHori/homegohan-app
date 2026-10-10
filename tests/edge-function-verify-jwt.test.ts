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
//   - DB から pg_net (net.http_post など) で呼ばれる関数は、どれも verify_jwt = false。
//     呼び出しは DB に入る SQL (supabase/migrations と、本番のスキーマの写し supabase/baseline) の全文から抜き出す
//     (SQL 関数の本文だけでなく、関数で包まない cron.schedule('job', '...', $$ SELECT net.http_post(...) $$)、
//     DO ブロック、素の SELECT も)。抜き出した数は、別のやり方で数え直した数とファイルごとに突き合わせる。
//     呼び先は呼び出し 1 件ごとに、URL の引数を許した形 (直書きの URL・許可リストで絞った引数を足した URL・
//     そのどちらかを 1 回だけ代入した変数) で読み、読めない呼び出しが 1 件でもあれば赤にする
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
// DB (pg_net) から呼ばれる関数
// ---------------------------------------------------------------------------

/**
 * DB から HTTP を送る呼び出し。pg_net の net.http_post / http_get / http_delete (スキーマ名は問わない)、
 * 同期の http 拡張 (pgsql-http) の http_post / http_get / http_put / http_patch / http_delete / http_head と http(...)、
 * Database Webhooks の supabase_functions.http_request。
 * 自前で包んだ関数 (my_http_post( のように前に文字が付く名前) は数えない (包んだ関数の本文の中の呼び出しを数える)。
 * 型の http_request (::http_request) のように後ろが ( でないものは数えない。
 */
const HTTP_CALL = /\b(?:http|http_(?:post|get|put|patch|delete|head)|http_request)"?\s*\(/gi;
/** pgsql-http の http(...)。要求を行 ('POST', url, ...)::http_request で渡すので、URL は行の 2 番目 */
const GENERIC_HTTP_CALL = /^http"?\s*\($/i;
/** 呼び出し元の名前に使う、文の先頭の語の数 (CREATE FUNCTION / cron.schedule / DO のどれでもない文のとき) */
const LABEL_WORDS = 6;

const countHttpCalls = (code: string) => [...code.matchAll(HTTP_CALL)].length;

/*
 * 呼び出しの URL の引数として読む形 (引数の式全体との完全一致。どれにも当たらなければ、その呼び出しの呼び先は読めない = 赤)。
 *   - 直書きの URL '<https://ホスト>/functions/v1/<name>' (<name> の後ろに / ? # からの続きがあってもよい)
 *   - '<https://ホスト>/functions/v1/' || <引数>: 呼び先は、同じ文で前もって <引数> を絞る許可リスト (allowlistOf)
 *   - 変数 1 つ: 同じ文の中で、上の 2 つのどちらかを 1 回だけ代入した変数 (variableUrlCallees)
 * 文字列を足し合わせる・Vault や表から読む・変数から変数へ渡す、などのほかの形は読まない (書き方ごとに見つけて拒否するのではなく、
 * 許した形のほかは読まない)。読めない呼び出しが要るようになったら、ここが赤になる。そのときは許した形を意識して広げる。
 */
const URL_LITERAL = /^'https?:\/\/[^/'?#\s]+\/functions\/v1\/([A-Za-z0-9_-]+)(?:[/?#][^'\s]*)?'$/;
const URL_PREFIX_CONCAT = /^'https?:\/\/[^/'?#\s]+\/functions\/v1\/'\s*\|\|\s*([A-Za-z_][A-Za-z0-9_]*)$/;
const SQL_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 名前付きの引数 (name := 値 / name => 値) の、名前から := / => と後ろの空白まで */
const NAMED_ARGUMENT = /^"?([A-Za-z_][A-Za-z0-9_]*)"?\s*(?::=|=>)\s*/;
/** URL を渡す引数の名前 (pg_net は url、pgsql-http は uri) */
const URL_ARGUMENT_NAME = /^(?:url|uri)$/i;
/** 許可リストの 1 項目 (' で囲んだ関数名だけ) */
const ALLOWLIST_ITEM = /^'([A-Za-z0-9_-]+)'$/;
/** 許可リストで絞った引数の、値を読むだけの出現の前: '...' || <引数> */
const CONCAT_OPERAND_BEFORE = /'[^']*'\s*\|\|\s*$/;
/** 同じく、RAISE EXCEPTION '...', a, <引数> (例外で止まる) */
const RAISE_ARGUMENT_BEFORE = /\bRAISE\s+EXCEPTION\s+'[^']*'\s*(?:,\s*"?[A-Za-z_][A-Za-z0-9_]*"?\s*)*,\s*$/i;
/** 関数の引数の宣言 f(<引数> text, ...) の、引数の前 */
const PARAMETER_BEFORE = /[(,]\s*$/;
/** 許可リスト IF <引数> NOT IN (...) THEN RAISE EXCEPTION の、引数の前と、( ) の後ろ */
const GUARD_BEFORE = /\bIF\s+$/i;
const GUARD_AFTER = /^\s*THEN\s+RAISE\s+EXCEPTION\b/i;

type SqlScan = {
  /** コメント (-- と /* *\/) を空白に置き換えた SQL (位置と改行は元のまま) */
  code: string;
  /**
   * code の、' の文字列の中身も空白に置き換えたもの (位置は code と同じ)。括弧・, ・; ・識別子を、
   * 文字列の中のものと取り違えずに探すために使う ("..." で囲んだ識別子は、そのまま残す)
   */
  bare: string;
  /** 最上位の文 (ドル引用・' の外の ; で区切る)。[start, end) */
  statements: ReadonlyArray<{ start: number; end: number }>;
};

/**
 * SQL ファイル (migration など) を、コメントを除いた SQL と、最上位の文の範囲に分ける。
 * ドル引用 ($$ ... $$ / $tag$ ... $tag$) の中身は SQL / PL/pgSQL のコードとして読む (中の -- コメントも除く)。
 * ドル引用の中では、閉じる印がほかのどの状態 (' の中・コメントの中) よりも先に効く (PostgreSQL の字句解析と同じ)。
 */
function scanSql(sql: string): SqlScan {
  const out = sql.split('');
  const bare = sql.split('');
  const blank = (i: number) => {
    if (out[i] !== '\n') {
      out[i] = ' ';
      bare[i] = ' ';
    }
  };
  /** 文字列の中身を bare からだけ消す */
  const hide = (i: number) => {
    if (i < bare.length && bare[i] !== '\n') bare[i] = ' ';
  };
  const statements: Array<{ start: number; end: number }> = [];
  const dollarTags: string[] = [];
  // escape: E'...' の文字列 (\ が次の 1 文字を逃がす。E'it\'s' の \' で文字列を閉じない)
  let mode: 'code' | 'single' | 'escape' | 'double' | 'line' | 'block' = 'code';
  let blockDepth = 0;
  let statementStart = 0;
  let i = 0;
  while (i < sql.length) {
    if (dollarTags.length > 0 && sql[i] === '$') {
      const closing = dollarTags.findLastIndex((tag) => sql.startsWith(tag, i));
      if (closing >= 0) {
        const tag = dollarTags[closing];
        dollarTags.length = closing;
        mode = 'code';
        i += tag.length;
        continue;
      }
    }
    const ch = sql[i];
    if (mode === 'line') {
      if (ch === '\n') mode = 'code';
      else blank(i);
      i += 1;
    } else if (mode === 'block') {
      if (sql.startsWith('/*', i)) {
        blockDepth += 1;
        blank(i);
        blank(i + 1);
        i += 2;
      } else if (sql.startsWith('*/', i)) {
        blockDepth -= 1;
        blank(i);
        blank(i + 1);
        i += 2;
        if (blockDepth === 0) mode = 'code';
      } else {
        blank(i);
        i += 1;
      }
    } else if (mode === 'single' || mode === 'escape' || mode === 'double') {
      const quote = mode === 'double' ? '"' : "'";
      // ' の文字列の中身は bare から消す ("..." の識別子は残す)
      const isString = mode !== 'double';
      if ((mode === 'escape' && ch === '\\') || (ch === quote && sql[i + 1] === quote)) {
        if (isString) {
          hide(i);
          hide(i + 1);
        }
        i += 2;
      } else {
        if (ch === quote) mode = 'code';
        else if (isString) hide(i);
        i += 1;
      }
    } else if (sql.startsWith('--', i)) {
      mode = 'line';
    } else if (sql.startsWith('/*', i)) {
      mode = 'block';
      blockDepth = 1;
      blank(i);
      blank(i + 1);
      i += 2;
    } else if (ch === "'") {
      // E'...' / e'...' (直前の E の前が語の文字でない) なら、\ で逃がす文字列
      const escapeString = /[Ee]/.test(sql[i - 1] ?? '') && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? '');
      mode = escapeString ? 'escape' : 'single';
      i += 1;
    } else if (ch === '"') {
      mode = 'double';
      i += 1;
    } else if (ch === '$' && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '')) {
      const opening = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (opening) {
        dollarTags.push(opening[0]);
        i += opening[0].length;
      } else i += 1;
    } else if (ch === ';' && dollarTags.length === 0) {
      statements.push({ start: statementStart, end: i + 1 });
      statementStart = i + 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  if (statementStart < sql.length) statements.push({ start: statementStart, end: sql.length });
  return { code: out.join(''), bare: bare.join(''), statements };
}

/**
 * scanSql とは別の、単純な数え直し用のコメント除き (行ごとの -- と、/* *\/)。
 * 抜き出し (scanSql) が呼び出しを取りこぼしていないかを、別のやり方で数えた数と突き合わせるために使う。
 */
function stripSqlCommentsSimply(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      let inQuote = false;
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === "'") inQuote = !inQuote;
        else if (!inQuote && line.startsWith('--', i)) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** 最上位の文 1 つ (scanSql の code と bare の同じ範囲) */
type SqlStatement = { code: string; bare: string };
/** 式 1 つ (文の中の始まりの位置と、前後の空白を除いた式) */
type SqlExpression = { at: number; expr: string };

/** open の ( から対応する ) までの、最上位の , で区切った引数と、閉じる ) の位置。閉じなければ null */
function argumentsOf({ code, bare }: SqlStatement, open: number): { args: SqlExpression[]; close: number } | null {
  const args: SqlExpression[] = [];
  const push = (start: number, end: number) => {
    const text = code.slice(start, end);
    args.push({ at: start + (text.length - text.trimStart().length), expr: text.trim() });
  };
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < bare.length; i += 1) {
    const ch = bare[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if ((ch === ')' || ch === ']') && depth > 0) depth -= 1;
    else if (ch === ']') return null;
    else if (ch === ')') {
      push(start, i);
      return { args, close: i };
    } else if (ch === ',' && depth === 0) {
      push(start, i);
      start = i + 1;
    }
  }
  return null;
}

/** 識別子の出現 (大文字小文字・前後の " を問わず広めに拾う。許した形のほかの出現が 1 つでもあれば、その識別子は読まない) */
const identOccurrences = (bare: string, ident: string) =>
  [...bare.matchAll(new RegExp(`(?<![A-Za-z0-9_$])"?${ident}"?(?![A-Za-z0-9_$])`, 'gi'))].map((m) => m.index);

/** at より前の、同じ PL/pgSQL の文の部分 (直前の ; の後ろから at まで) */
const partBefore = (bare: string, at: number) => bare.slice(bare.lastIndexOf(';', at - 1) + 1, at);

/**
 * '<https://ホスト>/functions/v1/' || <ident> の <ident> を絞る許可リスト (use は、その URL の中の <ident> の位置)。
 * 次をすべて満たすときだけ、その一覧を返す (ほかは null):
 *   - 同じ文に IF <ident> NOT IN ('a', 'b', ...) THEN RAISE EXCEPTION がちょうど 1 つあり、use より前にある
 *     (IN (...) THEN RAISE は拒否リストなので当たらない)
 *   - <ident> のほかの出現は、値を読むだけの形 ('...' || <ident>、RAISE EXCEPTION '...', <ident>) と、
 *     関数の引数の宣言 (<ident> text) だけ (:= や INTO や FOR で書き換えられる形が 1 つでもあれば、絞った値と言えない)
 */
function allowlistOf(statement: SqlStatement, ident: string, use: number): string[] | null {
  const { bare } = statement;
  let guard: { at: number; names: string[] } | null = null;
  for (const at of identOccurrences(bare, ident)) {
    const before = partBefore(bare, at);
    const head = bare.slice(at);
    if (CONCAT_OPERAND_BEFORE.test(before) || RAISE_ARGUMENT_BEFORE.test(before)) continue;
    if (PARAMETER_BEFORE.test(before) && new RegExp(`^"?${ident}"?\\s+"?text"?\\s*[,)]`, 'i').test(head)) continue;
    const guardHead = new RegExp(`^${ident}\\s+NOT\\s+IN\\s*\\(`, 'i').exec(head);
    if (guard !== null || guardHead === null || !GUARD_BEFORE.test(before)) return null;
    const list = argumentsOf(statement, at + guardHead[0].length - 1);
    if (list === null || !GUARD_AFTER.test(bare.slice(list.close + 1))) return null;
    const names = list.args.flatMap(({ expr }) => {
      const item = ALLOWLIST_ITEM.exec(expr);
      return item === null ? [] : [item[1]];
    });
    // 関数名でない項目 (変数・式) が 1 つでもあれば、絞った値と言えない
    if (names.length !== list.args.length) return null;
    guard = { at, names };
  }
  return guard !== null && guard.at < use ? [...guard.names].sort() : null;
}

/**
 * URL の引数が変数 1 つ (ident) のときの呼び先。同じ文の中で、その変数に直書きの URL か、
 * '<https://ホスト>/functions/v1/' || <許可リストで絞った引数> をちょうど 1 回だけ代入し (宣言の := か、本文の :=)、
 * ほかの出現が、値の無い宣言 (<ident> text;) と呼び出しの URL の引数 (urlVariableUses) だけのとき。ほかは null
 */
function variableUrlCallees(statement: SqlStatement, ident: string, urlVariableUses: ReadonlySet<number>): string[] | null {
  const { code, bare } = statement;
  let declarations = 0;
  const definitions: SqlExpression[] = [];
  for (const at of identOccurrences(bare, ident)) {
    if (urlVariableUses.has(at)) continue;
    const head = bare.slice(at);
    if (new RegExp(`^${ident}\\s+text\\s*;`, 'i').test(head)) {
      declarations += 1;
      continue;
    }
    const assign = new RegExp(`^${ident}\\s+(?:CONSTANT\\s+)?text\\s*:=|^${ident}\\s*:=`, 'i').exec(head);
    const end = bare.indexOf(';', at);
    if (assign === null || end < 0) return null;
    const text = code.slice(at + assign[0].length, end);
    definitions.push({ at: at + assign[0].length + (text.length - text.trimStart().length), expr: text.trim() });
  }
  if (declarations > 1 || definitions.length !== 1) return null;
  const [definition] = definitions;
  const literal = URL_LITERAL.exec(definition.expr);
  if (literal !== null) return [literal[1]];
  const concat = URL_PREFIX_CONCAT.exec(definition.expr);
  return concat === null ? null : allowlistOf(statement, concat[1], definition.at + definition.expr.length - concat[1].length);
}

/**
 * 呼び出し (HTTP_CALL に当たった位置) の URL の引数。名前付きの url / uri があればそれ、無ければ最初の引数
 * (pgsql-http の http(...) は、行の 2 番目)。読めなければ null (文字列の中に書いた呼び出しも)
 */
function urlArgumentOf(statement: SqlStatement, call: RegExpExecArray): SqlExpression | null {
  const { code, bare } = statement;
  const open = call.index + call[0].length - 1;
  // 文字列の中に書いた呼び出し (EXECUTE 'SELECT net.http_post(...)' など) は、引数を読まない
  if (bare.slice(call.index, open + 1) !== code.slice(call.index, open + 1)) return null;
  let args = argumentsOf(statement, open)?.args ?? null;
  if (args !== null && GENERIC_HTTP_CALL.test(call[0])) {
    const [request] = args;
    const row = request !== undefined && bare[request.at] === '(' ? argumentsOf(statement, request.at) : null;
    args = row === null ? null : row.args.slice(1);
  }
  if (args === null || args.length === 0) return null;
  const named = args.flatMap((arg) => {
    const m = NAMED_ARGUMENT.exec(arg.expr);
    return m !== null && URL_ARGUMENT_NAME.test(m[1]) ? [{ at: arg.at + m[0].length, expr: arg.expr.slice(m[0].length) }] : [];
  });
  if (named.length > 0) return named.length === 1 ? named[0] : null;
  return NAMED_ARGUMENT.test(args[0].expr) ? null : args[0];
}

/** URL の引数から読んだ呼び先。許した形 (URL_LITERAL / URL_PREFIX_CONCAT / 変数 1 つ) でなければ null */
function urlCallees(statement: SqlStatement, url: SqlExpression, urlVariableUses: ReadonlySet<number>): string[] | null {
  const literal = URL_LITERAL.exec(url.expr);
  if (literal !== null) return [literal[1]];
  const concat = URL_PREFIX_CONCAT.exec(url.expr);
  if (concat !== null) return allowlistOf(statement, concat[1], url.at + url.expr.length - concat[1].length);
  return SQL_IDENT.test(url.expr) ? variableUrlCallees(statement, url.expr, urlVariableUses) : null;
}

/** 文の中の HTTP の呼び出しごとの、文の中の位置と呼び先 (読めなければ null) */
function httpCallsOf(statement: SqlStatement): Array<{ at: number; callees: string[] | null }> {
  const calls = [...statement.code.matchAll(HTTP_CALL)].map((call) => ({ at: call.index, url: urlArgumentOf(statement, call) }));
  /** URL の引数が変数 1 つの呼び出しの、その変数の位置 (変数のほかの出現と見分ける) */
  const urlVariableUses = new Set(calls.flatMap(({ url }) => (url !== null && SQL_IDENT.test(url.expr) ? [url.at] : [])));
  return calls.map(({ at, url }) => ({ at, callees: url === null ? null : urlCallees(statement, url, urlVariableUses) }));
}

type DbCall = {
  /** 呼び出しの行 (1 から) */
  line: number;
  /** 呼び先の Edge Function。URL の引数を許した形で読めなければ null (下のテストで赤にする) */
  callees: string[] | null;
};

type DbCaller = {
  /** リポジトリからの相対パス (supabase/migrations/... / supabase/baseline/...) */
  file: string;
  /** 文の始まりの行 (1 から) */
  line: number;
  /** 「関数 public.x」「cron.schedule('job')」「DO ブロック」など */
  label: string;
  /** コメントを除いた文 */
  code: string;
  /** 文の中の HTTP の呼び出し (1 件ごと) */
  calls: DbCall[];
};

/** 文の名前。CREATE FUNCTION なら関数名、関数で包まない cron.schedule ならジョブ名、DO ブロックならそう書く */
function callerLabel(code: string): string {
  const fn = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([^\s(]+)/i.exec(code);
  if (fn) return `関数 ${fn[1].replace(/"/g, '')}`;
  const job = /cron\s*\.\s*schedule\s*\(\s*'([^']*)'/i.exec(code);
  if (job) return `cron.schedule('${job[1]}')`;
  if (/^\s*DO\b/i.test(code)) return 'DO ブロック';
  return code.trim().split(/\s+/).slice(0, LABEL_WORDS).join(' ');
}

/**
 * 1 本の SQL ファイル (migration など) の中の、DB から HTTP で呼び出す文と、呼び出し 1 件ごとの呼び先。
 * SQL 関数の本文に限らず、最上位の文すべてを見る (関数で包まない cron.schedule('job', '...', $$ SELECT net.http_post(...) $$)、
 * DO ブロック、素の SELECT net.http_post(...) も拾う)。
 */
function dbCallersOf(file: string, sql: string): DbCaller[] {
  const { code, bare, statements } = scanSql(sql);
  const lineAt = (at: number) => code.slice(0, at).split('\n').length;
  const callers: DbCaller[] = [];
  for (const { start, end } of statements) {
    const statement = { code: code.slice(start, end), bare: bare.slice(start, end) };
    const calls = httpCallsOf(statement);
    if (calls.length === 0) continue;
    const firstToken = start + (statement.code.length - statement.code.trimStart().length);
    callers.push({
      file,
      line: lineAt(firstToken),
      label: callerLabel(statement.code),
      code: statement.code,
      calls: calls.map(({ at, callees }) => ({ line: lineAt(start + at), callees })),
    });
  }
  return callers;
}

/** ゲートウェイの JWT 検証で止められる呼び先 (verify_jwt = false でない。config.toml に無い名前も含む) */
const calleesStoppedByGateway = (callees: readonly string[], verifyJwt: ReadonlyMap<string, boolean>) =>
  callees.filter((name) => verifyJwt.get(name) !== false);

/**
 * 抜き出し (文ごと) が拾えた呼び出しの数と、別のやり方 (stripSqlCommentsSimply) で数え直した数が食い違えば、その数を返す。
 * 食い違いは、抜き出しが取りこぼした呼び出し (verify_jwt の検査から漏れる呼び出し) があることを意味する。
 */
function callCountMismatch(sql: string, callers: readonly DbCaller[]): { collected: number; recounted: number } | null {
  const collected = callers.reduce((sum, caller) => sum + caller.calls.length, 0);
  const recounted = countHttpCalls(stripSqlCommentsSimply(sql));
  return collected === recounted ? null : { collected, recounted };
}

/**
 * DB に入る SQL のファイル (リポジトリからの相対パス)。名前で除外しない (除外した形のファイルに書いた呼び出しを見落とさないため)。
 *   - supabase/migrations の .sql すべて (戻しの .down.sql は supabase/rollbacks に置く。本番へは直接流さず、
 *     その内容を新しい migration として supabase/migrations に足して入れるので、ここで拾える)
 *   - supabase/baseline の .sql すべて (本番のスキーマの写し。ローカルの DB は、これを migration より先に入れる)
 */
const SQL_DIRS = [MIGRATIONS_DIR, BASELINE_DIR];
const SQL_FILES = SQL_DIRS.flatMap((dir) =>
  fs
    .readdirSync(path.join(ROOT, dir))
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => path.posix.join(dir, file)),
);
const SQL_TEXT = new Map(SQL_FILES.map((file) => [file, read(file)]));

const DB_CALLERS = SQL_FILES.flatMap((file) => dbCallersOf(file, SQL_TEXT.get(file) ?? ''));
const DB_CALLEES = [...new Set(DB_CALLERS.flatMap((caller) => caller.calls.flatMap((call) => call.callees ?? [])))].sort();
const callerName = (caller: DbCaller) => `${caller.file}:${caller.line} ${caller.label}`;

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

  it(`DB からの呼び出し先を抜き出せている (${SEGMENT_STATS_FUNCTION} とカタログ取り込みを含む)`, () => {
    expect(DB_CALLEES).toContain(SEGMENT_STATS_FUNCTION);
    expect(DB_CALLEES.some((name) => /^import-.+-catalog$/.test(name))).toBe(true);
  });

  it('実物の呼び出し元は、呼び出しごとに呼び先を読めている (許可リストの引数・定数の URL)', () => {
    const callsOfFunction = (name: string) =>
      DB_CALLERS.filter((caller) => caller.label === `関数 ${name}`).flatMap((caller) => caller.calls.map((call) => call.callees));
    expect(callsOfFunction('public.invoke_calculate_segment_stats')).toEqual([[SEGMENT_STATS_FUNCTION]]);
    // migration と本番のスキーマの写しの 2 か所。どちらも IF p_function_name NOT IN (...) THEN RAISE EXCEPTION で絞った 5 本
    const catalog = [
      'import-familymart-catalog',
      'import-lawson-catalog',
      'import-ministop-catalog',
      'import-natural-lawson-catalog',
      'import-seven-eleven-catalog',
    ];
    expect(callsOfFunction('public.invoke_catalog_import')).toEqual([catalog, catalog]);
  });

  // 以下は合成した SQL で、SQL 関数の本文以外に書いた呼び出しも拾えることを確かめる (#1406 のレビューの指摘)
  const SYNTHETIC_FILE = 'supabase/migrations/synthetic.sql';
  const FUNCTION_URL = (name: string) => `'https://example.supabase.co/functions/v1/${name}'`;
  const URL_PREFIX = `'https://example.supabase.co/functions/v1/'`;
  const BEARER = `'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = '${VAULT_CRON_SECRET_NAME}')`;
  const callersOf = (sql: string) => dbCallersOf(SYNTHETIC_FILE, sql);
  /** 合成した SQL の、呼び出し 1 件ごとの呼び先 (読めなければ null) */
  const calleesPerCall = (sql: string) => callersOf(sql).flatMap((caller) => caller.calls.map((call) => call.callees));

  it('関数で包まない cron.schedule の中の net.http_post を拾い、呼び先と、ゲートウェイで止まることが分かる', () => {
    // Supabase の文書が標準として示す形。verify_jwt が既定 (true) の関数を呼ぶと、本番では関数に届かない
    const callee = 'backfill-ingredient-embeddings';
    expect(VERIFY_JWT.get(callee) ?? true).toBe(true);
    const sql = [
      '-- 毎時',
      `SELECT cron.schedule('x', '0 * * * *', $$ SELECT net.http_post(url := ${FUNCTION_URL(callee)}, headers := jsonb_build_object(${BEARER})); $$);`,
    ].join('\n');
    const callers = callersOf(sql);
    expect(callers.map(({ label, line, calls }) => ({ label, line, calls }))).toEqual([
      { label: "cron.schedule('x')", line: 2, calls: [{ line: 2, callees: [callee] }] },
    ]);
    expect(calleesStoppedByGateway(callers[0].calls[0].callees ?? [], VERIFY_JWT)).toEqual([callee]);
  });

  it('DO ブロック・素の SELECT・ドル引用に名前を付けた形・Database Webhooks の http_request も拾う', () => {
    const sql = [
      `DO $do$ BEGIN PERFORM net.http_post(url := ${FUNCTION_URL('a-fn')}, headers := jsonb_build_object(${BEARER})); END $do$;`,
      `SELECT "net"."http_get"(url := ${FUNCTION_URL('b-fn')});`,
      `SELECT cron.schedule('c', '5 * * * *', $job$ SELECT net.http_delete(${FUNCTION_URL('c-fn')}); $job$);`,
      `CREATE TRIGGER t AFTER INSERT ON public.x FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request(${FUNCTION_URL('d-fn')}, 'POST', '{}', '{}', '1000');`,
    ].join('\n');
    expect(callersOf(sql).map(({ label, line, calls }) => ({ label, line, callees: calls.map((call) => call.callees) }))).toEqual([
      { label: 'DO ブロック', line: 1, callees: [['a-fn']] },
      { label: 'SELECT "net"."http_get"(url := \'https://example.supabase.co/functions/v1/b-fn\');', line: 2, callees: [['b-fn']] },
      { label: "cron.schedule('c')", line: 3, callees: [['c-fn']] },
      { label: 'CREATE TRIGGER t AFTER INSERT ON', line: 4, callees: [['d-fn']] },
    ]);
  });

  it('SQL 関数の本文の呼び出しは関数ごとに拾い、許可リストの関数名も呼び先にする (本文の ; や -- では区切らない)', () => {
    const allowed = 'import-seven-eleven-catalog';
    const sql = [
      'CREATE OR REPLACE FUNCTION public.f(p text) RETURNS bigint LANGUAGE plpgsql AS $$',
      'DECLARE v bigint; -- 区切りではない ;',
      `BEGIN IF p NOT IN ('${allowed}') THEN RAISE EXCEPTION 'x;--'; END IF;`,
      `  SELECT net.http_post(url := ${URL_PREFIX} || p, headers := jsonb_build_object(${BEARER})) INTO v;`,
      '  RETURN v; END; $$;',
      // ドル引用の文字列の中の ' (it's) で、後ろの文の区切りを見失わない (閉じる $$ が先に効く)
      "COMMENT ON FUNCTION public.f(text) IS $$it's; not a call$$;",
      `CREATE FUNCTION public.g() RETURNS void LANGUAGE sql AS $fn$ SELECT net.http_post(${FUNCTION_URL('g-fn')}) $fn$;`,
    ].join('\n');
    expect(callersOf(sql).map(({ label, line, calls }) => ({ label, line, calls }))).toEqual([
      { label: '関数 public.f', line: 1, calls: [{ line: 4, callees: [allowed] }] },
      { label: '関数 public.g', line: 7, calls: [{ line: 7, callees: ['g-fn'] }] },
    ]);
  });

  it('コメントの中の呼び出しは数えず、呼び先が読めない呼び出しは呼び先なしで残す (下のテストで赤になる)', () => {
    const sql = [
      '-- SELECT net.http_post(url := \'https://example.supabase.co/functions/v1/commented\');',
      '/* SELECT net.http_post(url := \'https://example.supabase.co/functions/v1/block\'); */',
      "SELECT net.http_post(url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'some_url'));",
    ].join('\n');
    expect(callersOf(sql).map(({ line, calls }) => ({ line, calls }))).toEqual([{ line: 3, calls: [{ line: 3, callees: null }] }]);
    expect(countHttpCalls(stripSqlCommentsSimply(sql))).toBe(1);
  });

  it('同期の http 拡張 (pgsql-http) の呼び出しも拾い、型の ::http_request は呼び出しとして数えない', () => {
    const sql = [
      `SELECT http(('POST', ${FUNCTION_URL('a-fn')}, ARRAY[http_header('Authorization', 'x')], 'application/json', '{}')::http_request);`,
      `SELECT extensions.http_put(${FUNCTION_URL('b-fn')}, '{}', 'application/json');`,
    ].join('\n');
    expect(calleesPerCall(sql)).toEqual([['a-fn'], ['b-fn']]);
  });

  it("E'...' の文字列の \\' で文字列の終わりを見失わず、後ろの -- コメントの中の呼び出しを数えない", () => {
    const sql = [
      "SELECT E'it\\'s -- not a comment';",
      `-- SELECT net.http_post(${FUNCTION_URL('commented')});`,
      `SELECT net.http_post(${FUNCTION_URL('a-fn')});`,
    ].join('\n');
    expect(callersOf(sql).map(({ line, calls }) => ({ line, calls }))).toEqual([{ line: 3, calls: [{ line: 3, callees: ['a-fn'] }] }]);
  });

  it('数え直しは抜き出しと別のやり方で数え、抜き出しが呼び出しを取りこぼすと食い違いになる', () => {
    // 関数で包まない cron.schedule の中の呼び出し 2 つ (#1406 のレビューで、SQL 関数の本文だけを見る抜き出しが取りこぼした形)
    const sql = `SELECT cron.schedule('x', '0 * * * *', $$ SELECT net.http_post(${FUNCTION_URL('a-fn')}); SELECT net.http_get(${FUNCTION_URL('b-fn')}); $$);`;
    expect(callCountMismatch(sql, callersOf(sql))).toBeNull();
    // 取りこぼした抜き出し (SQL 関数の本文だけを見ると、この形は 1 つも拾えない) は、数え直しと合わず赤になる
    const functionBodiesOnly = callersOf(sql).filter((caller) => caller.label.startsWith('関数 '));
    expect(callCountMismatch(sql, functionBodiesOnly)).toEqual({ collected: 0, recounted: 2 });
  });

  // 呼び先は文ごとにまとめず、呼び出し 1 件ごとに URL の引数から読む (#1406 R3 のレビューの指摘。
  // 文ごとにまとめると、呼び先が読める呼び出しと読めない呼び出しが同じ関数にあるとき、読めない方が検査から漏れる)
  describe('呼び先は呼び出し 1 件ごとに、URL の引数を許した形で読む', () => {
    const plpgsql = (params: string, body: readonly string[]) =>
      [`CREATE OR REPLACE FUNCTION public.f(${params}) RETURNS void LANGUAGE plpgsql AS $$`, ...body, '$$;'].join('\n');
    const post = (url: string) => `  PERFORM net.http_post(url := ${url}, headers := jsonb_build_object(${BEARER}));`;

    it('R3 のレビューの変異: 直書きの呼び出しと、文字列を足し合わせた呼び出しが同じ関数にあれば、後ろの呼び出しは読めない', () => {
      const sql = plpgsql('', [
        'BEGIN',
        post(FUNCTION_URL(SEGMENT_STATS_FUNCTION)),
        post(`${URL_PREFIX} || 'backfill-ingredient' || '-embeddings'`),
        'END;',
      ]);
      expect(callersOf(sql).map(({ calls }) => calls)).toEqual([
        [
          { line: 3, callees: [SEGMENT_STATS_FUNCTION] },
          { line: 4, callees: null },
        ],
      ]);
    });

    it('定数の URL・許可リストで絞った引数を足した変数・後ろに書いた名前付きの url は読む', () => {
      const sql = plpgsql('p text', [
        'DECLARE',
        `  c_url CONSTANT text := ${FUNCTION_URL('a-fn')};`,
        '  v_url text;',
        'BEGIN',
        "  IF p NOT IN ('c-fn', 'b-fn') THEN RAISE EXCEPTION 'not allowed: %', p; END IF;",
        `  v_url := ${URL_PREFIX} || p;`,
        post('c_url'),
        post('v_url'),
        `  PERFORM net.http_post(body := '{}'::jsonb, url := ${FUNCTION_URL('d-fn')});`,
        'END;',
      ]);
      expect(calleesPerCall(sql)).toEqual([['a-fn'], ['b-fn', 'c-fn'], ['d-fn']]);
    });

    it.each([
      ['表から引いた名前を足す (FOR の変数の列)', plpgsql('', ['DECLARE r record;', 'BEGIN', '  FOR r IN SELECT name FROM public.t LOOP', post(`${URL_PREFIX} || r.name`), '  END LOOP;', 'END;'])],
      ['表から引いた名前を足す (FOR の変数)', plpgsql('', ['DECLARE v_name text;', 'BEGIN', '  FOR v_name IN SELECT name FROM public.t LOOP', post(`${URL_PREFIX} || v_name`), '  END LOOP;', 'END;'])],
      [
        '使わない変数に URL を書き、呼び出しは Vault の URL',
        plpgsql('', [`DECLARE v_unused text := ${FUNCTION_URL('a-fn')};`, 'BEGIN', post("(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'u')"), 'END;']),
      ],
      [
        '変数に 2 回代入する',
        plpgsql('', [`DECLARE v_url text := ${FUNCTION_URL('a-fn')};`, 'BEGIN', "  v_url := (SELECT url FROM public.t LIMIT 1);", post('v_url'), 'END;']),
      ],
      ['変数に INTO で入れる', plpgsql('', [`DECLARE v_url text := ${FUNCTION_URL('a-fn')};`, 'BEGIN', '  SELECT url INTO v_url FROM public.t;', post('v_url'), 'END;'])],
      ['変数から変数へ渡す', plpgsql('', [`DECLARE a text := ${FUNCTION_URL('a-fn')}; v_url text;`, 'BEGIN', '  v_url := a;', post('v_url'), 'END;'])],
      ['許可リストが無い引数', plpgsql('p text', ['BEGIN', post(`${URL_PREFIX} || p`), 'END;'])],
      [
        '許可リストの後で引数を書き換える',
        plpgsql('p text', ['BEGIN', "  IF p NOT IN ('a-fn') THEN RAISE EXCEPTION 'x'; END IF;", "  p := 'backfill-ingredient-embeddings';", post(`${URL_PREFIX} || p`), 'END;']),
      ],
      ['拒否リスト (IN (...) THEN RAISE)', plpgsql('p text', ['BEGIN', "  IF p IN ('a-fn') THEN RAISE EXCEPTION 'x'; END IF;", post(`${URL_PREFIX} || p`), 'END;'])],
      ['呼び出しより後ろの許可リスト', plpgsql('p text', ['BEGIN', post(`${URL_PREFIX} || p`), "  IF p NOT IN ('a-fn') THEN RAISE EXCEPTION 'x'; END IF;", 'END;'])],
      ['関数名でない項目のある許可リスト', plpgsql('p text, q text', ['BEGIN', "  IF p NOT IN ('a-fn', q) THEN RAISE EXCEPTION 'x'; END IF;", post(`${URL_PREFIX} || p`), 'END;'])],
      ['許可リストを外れても止めない', plpgsql('p text', ['BEGIN', "  IF p NOT IN ('a-fn') THEN RETURN; END IF;", post(`${URL_PREFIX} || p`), 'END;'])],
      ['文字列の中に書いた呼び出し (EXECUTE)', "DO $$ BEGIN EXECUTE 'SELECT net.http_post(url := ''https://example.supabase.co/functions/v1/a-fn'')'; END $$;"],
      ['URL を表から読む素の SELECT', 'SELECT net.http_post(url := t.url) FROM public.t;'],
    ])('%s は読めない (null)', (_form, sql) => {
      expect(calleesPerCall(sql)).toEqual([null]);
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
  it('DB に入る SQL (migration と本番のスキーマの写し) の HTTP の呼び出しを、どれも呼び出し元として拾えている (数え直しと一致)', () => {
    // 抜き出し (文ごと) が取りこぼした呼び出しは、下の verify_jwt の検査から漏れる。別のやり方で数えた数と、ファイルごとに突き合わせる
    const mismatched = SQL_FILES.flatMap((file) => {
      const mismatch = callCountMismatch(
        SQL_TEXT.get(file) ?? '',
        DB_CALLERS.filter((caller) => caller.file === file),
      );
      return mismatch === null ? [] : [`${file}: 拾えた ${mismatch.collected} / 数え直し ${mismatch.recounted}`];
    });
    expect(mismatched).toEqual([]);
    // 空振りしていないこと (両方のディレクトリを読み、どちらにも呼び出しがある。
    // migration には SQL 関数 2 つ、本番のスキーマの写しには invoke_catalog_import がある)
    for (const dir of SQL_DIRS) {
      expect(SQL_FILES.some((file) => file.startsWith(`${dir}/`)), `${dir} の .sql を読めていない`).toBe(true);
      expect(DB_CALLERS.some((caller) => caller.file.startsWith(`${dir}/`)), `${dir} の呼び出しを拾えていない`).toBe(true);
    }
  });

  it.each(DB_CALLERS.map((caller) => [callerName(caller), caller] as const))(
    '%s: どの呼び出しも、呼び先の Edge Function が読める',
    (_name, caller) => {
      // URL を Vault や表から読む・文字列を足し合わせる・許可リストで絞らない引数を足す・変数を書き換える呼び出しは、
      // verify_jwt を確かめられないので赤にする ('.../functions/v1/<name>' と直書きするか、'.../functions/v1/' || 引数 なら、
      // 同じ文で前もって IF 引数 NOT IN ('a', ...) THEN RAISE EXCEPTION で絞る。そのどちらかを 1 回だけ代入した変数でもよい)
      expect(caller.calls.filter((call) => call.callees === null).map((call) => `${caller.file}:${call.line}`)).toEqual([]);
    },
  );

  it.each(DB_CALLERS.map((caller) => [callerName(caller), caller] as const))(
    '%s: Vault の app_cron_secret を Bearer に付けて呼ぶ (JWT ではない)',
    (_name, caller) => {
      // 呼び出しの前提 (JWT でない Bearer で呼ぶ) の確かめ。下の verify_jwt = false の検査は、Bearer にかかわらず
      // DB から呼ぶすべての呼び先に掛かる (ここが緩くても、verify_jwt の検査から漏れる呼び先は無い)
      expect(caller.code).toContain(`'${VAULT_CRON_SECRET_NAME}'`);
      expect(caller.code).toMatch(/'Bearer '\s*\|\|/);
    },
  );

  it('DB から呼ばれる関数は、どれも配られる関数 (supabase/functions/<name>/index.ts) である', () => {
    // 許可リストに配っていない名前があると、その呼び出しは本番で 404 になる
    expect(DB_CALLEES.filter((name) => !DEPLOYED_FUNCTIONS.includes(name))).toEqual([]);
  });

  it('DB (pg_cron → pg_net) から呼ばれる関数は、どれも verify_jwt = false', () => {
    // 外し忘れると、ゲートウェイが 401 (UNAUTHORIZED_INVALID_JWT_FORMAT) を返し、関数に届かない。
    // cron.job_run_details は succeeded のままなので、ここで止める
    expect(
      DB_CALLERS.flatMap((caller) =>
        caller.calls.flatMap((call) =>
          calleesStoppedByGateway(call.callees ?? [], VERIFY_JWT).map((name) => `${caller.file}:${call.line} ${caller.label} → ${name}`),
        ),
      ),
    ).toEqual([]);
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
