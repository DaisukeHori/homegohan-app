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
//   - verify_jwt = false の関数は、どれも関数のディレクトリがあり、先頭で自前の認証をする
//     (requireServiceRole / requireAuth / auth.getUser を、本文を読む前・DB に触る前に呼ぶ)
//   - DB から pg_net (net.http_post など) で呼ばれる関数は、どれも verify_jwt = false。
//     呼び出しは migration の全文から抜き出す (SQL 関数の本文だけでなく、関数で包まない
//     cron.schedule('job', '...', $$ SELECT net.http_post(...) $$)、DO ブロック、素の SELECT も)。
//     別のやり方で数え直した呼び出しの数と突き合わせ、拾えない呼び出し・呼び先が読めない呼び出しがあれば赤にする
//   - 先頭で requireServiceRole を呼ぶ関数 (CRON_SECRET を受け付ける関数) は、どれも verify_jwt = false
//   - GitHub Actions のデプロイは、名前を指定しない functions deploy で config.toml を読み (--no-verify-jwt を付けない)、
//     config.toml を変えただけでも動く
//
// supabase CLI 2.62.10 の functions deploy は、名前を指定しないとき supabase/functions/*/index.ts の全関数を配り、
// 関数ごとの verify_jwt を config.toml の [functions.<name>] から読む (--no-verify-jwt を付けたときだけ、全関数でそれが優先)。
// 出典: supabase/cli v2.62.10 の internal/functions/deploy/deploy.go (GetFunctionConfig) と pkg/config/config.go (load)。

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const CONFIG_TOML = 'supabase/config.toml';
const FUNCTIONS_DIR = 'supabase/functions';
const MIGRATIONS_DIR = 'supabase/migrations';
const DEPLOY_WORKFLOW = '.github/workflows/deploy-supabase-functions.yml';
/** pg_cron が Bearer に付ける Vault の秘密の名前 (JWT ではない) */
const VAULT_CRON_SECRET_NAME = 'app_cron_secret';
/** 整合ゲートが本番で 401 を確認した関数 (#1406)。DB からの呼び出し先の抜き出しが空振りしていないことの確かめに使う */
const SEGMENT_STATS_FUNCTION = 'calculate-segment-stats';

// ---------------------------------------------------------------------------
// supabase/config.toml の [functions.<name>] verify_jwt
// ---------------------------------------------------------------------------

/**
 * config.toml の [functions.<name>] ごとの verify_jwt を読む (指定が無ければ CLI の既定値 true)。
 * このリポジトリの config.toml は単純な形なので、行ごとに読む。読めない行が [functions.*] の中にあれば例外にする
 * (読み飛ばして緑にしない)。
 */
function functionVerifyJwt(toml: string): Map<string, boolean> {
  const result = new Map<string, boolean>();
  let current: string | null = null;
  for (const rawLine of toml.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      const fn = /^functions\.([a-z0-9-]+)$/.exec(section[1]);
      current = fn ? fn[1] : null;
      if (current !== null) {
        if (result.has(current)) throw new Error(`${CONFIG_TOML}: [functions.${current}] が 2 回ある`);
        result.set(current, true);
      }
      continue;
    }
    if (current === null) continue;
    const kv = /^([a-z_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) throw new Error(`${CONFIG_TOML}: [functions.${current}] の中の行を読めない: ${rawLine}`);
    if (kv[1] !== 'verify_jwt') continue;
    if (kv[2] !== 'true' && kv[2] !== 'false') {
      throw new Error(`${CONFIG_TOML}: [functions.${current}] の verify_jwt が true / false でない: ${kv[2]}`);
    }
    result.set(current, kv[2] === 'true');
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

/** TS のコメント (/* *\/ と //) を除く。URL の // (直前が :) は残す */
function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
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

/**
 * requireServiceRole で認証する関数 = CRON_SECRET (JWT ではない) を受け付ける関数。
 * 先頭で呼んでいるかは、verify_jwt = false の関数すべてについて別に確かめる。
 */
const SERVICE_ROLE_FUNCTIONS = DEPLOYED_FUNCTIONS.filter((name) =>
  // 引数の名前や await の有無を問わずに拾う (狭く拾うと、verify_jwt = false を求める対象から漏れる)。
  // 先頭で正しく呼んでいるか (await requireServiceRole(req)) は、verify_jwt = false の関数として別に確かめる
  /\brequireServiceRole\s*\(/.test(HANDLER_AUTH.get(name)?.source ?? ''),
);

// ---------------------------------------------------------------------------
// DB (pg_net) から呼ばれる関数
// ---------------------------------------------------------------------------

/**
 * DB から HTTP を送る呼び出し。pg_net の net.http_post / http_get / http_delete (スキーマ名は問わない。
 * extensions.http_post のような同期の http 拡張も同じく数える) と、Database Webhooks の supabase_functions.http_request。
 * 自前で包んだ関数 (my_http_post( のように前に文字が付く名前) は数えない (包んだ関数の本文の中の呼び出しを数える)。
 */
const HTTP_CALL = /\b(?:http_(?:post|get|delete)|http_request)"?\s*\(/gi;
/** 呼び出し元の名前に使う、文の先頭の語の数 (CREATE FUNCTION / cron.schedule / DO のどれでもない文のとき) */
const LABEL_WORDS = 6;

const countHttpCalls = (code: string) => [...code.matchAll(HTTP_CALL)].length;

type SqlScan = {
  /** コメント (-- と /* *\/) を空白に置き換えた SQL (位置と改行は元のまま) */
  code: string;
  /** 最上位の文 (ドル引用・' の外の ; で区切る)。[start, end) */
  statements: ReadonlyArray<{ start: number; end: number }>;
};

/**
 * migration を、コメントを除いた SQL と、最上位の文の範囲に分ける。
 * ドル引用 ($$ ... $$ / $tag$ ... $tag$) の中身は SQL / PL/pgSQL のコードとして読む (中の -- コメントも除く)。
 * ドル引用の中では、閉じる印がほかのどの状態 (' の中・コメントの中) よりも先に効く (PostgreSQL の字句解析と同じ)。
 */
function scanSql(sql: string): SqlScan {
  const out = sql.split('');
  const blank = (i: number) => {
    if (out[i] !== '\n') out[i] = ' ';
  };
  const statements: Array<{ start: number; end: number }> = [];
  const dollarTags: string[] = [];
  let mode: 'code' | 'single' | 'double' | 'line' | 'block' = 'code';
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
    } else if (mode === 'single' || mode === 'double') {
      const quote = mode === 'single' ? "'" : '"';
      if (ch === quote && sql[i + 1] === quote) i += 2;
      else {
        if (ch === quote) mode = 'code';
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
      mode = 'single';
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
  return { code: out.join(''), statements };
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

type DbCaller = {
  migration: string;
  /** 文の始まりの行 (1 から) */
  line: number;
  /** 「関数 public.x」「cron.schedule('job')」「DO ブロック」など */
  label: string;
  /** コメントを除いた文 */
  code: string;
  /** 文の中の HTTP の呼び出しの数 */
  calls: number;
  callees: string[];
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
 * 文の中の呼び先。'.../functions/v1/<name>' の直書きと、'.../functions/v1/' || 引数 の形なら、
 * 文の中に ' で書かれた、配られる関数の名前 (許可リスト)。
 */
function calleesOf(code: string, deployedFunctions: readonly string[]): string[] {
  const callees = new Set<string>();
  for (const m of code.matchAll(/\/functions\/v1\/([A-Za-z0-9_-]+)/g)) callees.add(m[1]);
  if (/\/functions\/v1\/'\s*\|\|/.test(code)) {
    for (const m of code.matchAll(/'([a-z0-9-]+)'/g)) {
      if (deployedFunctions.includes(m[1])) callees.add(m[1]);
    }
  }
  return [...callees].sort();
}

/**
 * 1 本の migration の中の、DB から HTTP で呼び出す文と、その呼び先。
 * SQL 関数の本文に限らず、最上位の文すべてを見る (関数で包まない cron.schedule('job', '...', $$ SELECT net.http_post(...) $$)、
 * DO ブロック、素の SELECT net.http_post(...) も拾う)。
 */
function dbCallersOf(migration: string, sql: string, deployedFunctions: readonly string[]): DbCaller[] {
  const { code, statements } = scanSql(sql);
  const callers: DbCaller[] = [];
  for (const { start, end } of statements) {
    const statement = code.slice(start, end);
    const calls = countHttpCalls(statement);
    if (calls === 0) continue;
    const firstToken = start + (statement.length - statement.trimStart().length);
    callers.push({
      migration,
      line: code.slice(0, firstToken).split('\n').length,
      label: callerLabel(statement),
      code: statement,
      calls,
      callees: calleesOf(statement, deployedFunctions),
    });
  }
  return callers;
}

/** ゲートウェイの JWT 検証で止められる呼び先 (verify_jwt = false でない。config.toml に無い名前も含む) */
const calleesStoppedByGateway = (callees: readonly string[], verifyJwt: ReadonlyMap<string, boolean>) =>
  callees.filter((name) => verifyJwt.get(name) !== false);

/** supabase/migrations の .sql すべて (名前で除外しない。除外した形の migration に書いた呼び出しを見落とさないため) */
const MIGRATION_FILES = fs
  .readdirSync(path.join(ROOT, MIGRATIONS_DIR))
  .filter((file) => file.endsWith('.sql'))
  .sort();
const MIGRATION_SQL = new Map(MIGRATION_FILES.map((file) => [file, read(path.join(MIGRATIONS_DIR, file))]));

const DB_CALLERS = MIGRATION_FILES.flatMap((file) => dbCallersOf(file, MIGRATION_SQL.get(file) ?? '', DEPLOYED_FUNCTIONS));
const DB_CALLEES = [...new Set(DB_CALLERS.flatMap((caller) => caller.callees))].sort();
const callerName = (caller: DbCaller) => `${caller.migration}:${caller.line} ${caller.label}`;

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

  it('config.toml の読み取り: [functions.*] があり、既定値 (指定なし) は true として扱う', () => {
    expect(VERIFY_JWT.size).toBeGreaterThan(0);
    expect(functionVerifyJwt('[functions.a]\nimport_map = "x"\n[functions.b]\nverify_jwt = false\n')).toEqual(
      new Map([
        ['a', true],
        ['b', false],
      ]),
    );
    expect(() => functionVerifyJwt('[functions.a]\nverify_jwt = no\n')).toThrow();
  });

  it(`DB からの呼び出し先を抜き出せている (${SEGMENT_STATS_FUNCTION} とカタログ取り込みを含む)`, () => {
    expect(DB_CALLEES).toContain(SEGMENT_STATS_FUNCTION);
    expect(DB_CALLEES.some((name) => /^import-.+-catalog$/.test(name))).toBe(true);
  });

  // 以下は合成した migration で、SQL 関数の本文以外に書いた呼び出しも拾えることを確かめる (#1406 のレビューの指摘)
  const SYNTHETIC_MIGRATION = 'synthetic.sql';
  const FUNCTION_URL = (name: string) => `'https://example.supabase.co/functions/v1/${name}'`;
  const BEARER = `'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = '${VAULT_CRON_SECRET_NAME}')`;
  const callersOf = (sql: string) => dbCallersOf(SYNTHETIC_MIGRATION, sql, DEPLOYED_FUNCTIONS);

  it('関数で包まない cron.schedule の中の net.http_post を拾い、呼び先と、ゲートウェイで止まることが分かる', () => {
    // Supabase の文書が標準として示す形。verify_jwt が既定 (true) の関数を呼ぶと、本番では関数に届かない
    const callee = 'backfill-ingredient-embeddings';
    expect(VERIFY_JWT.get(callee) ?? true).toBe(true);
    const sql = [
      '-- 毎時',
      `SELECT cron.schedule('x', '0 * * * *', $$ SELECT net.http_post(url := ${FUNCTION_URL(callee)}, headers := jsonb_build_object(${BEARER})); $$);`,
    ].join('\n');
    const callers = callersOf(sql);
    expect(callers.map(({ label, line, calls, callees }) => ({ label, line, calls, callees }))).toEqual([
      { label: "cron.schedule('x')", line: 2, calls: 1, callees: [callee] },
    ]);
    expect(calleesStoppedByGateway(callers[0].callees, VERIFY_JWT)).toEqual([callee]);
  });

  it('DO ブロック・素の SELECT・ドル引用に名前を付けた形・Database Webhooks の http_request も拾う', () => {
    const sql = [
      `DO $do$ BEGIN PERFORM net.http_post(url := ${FUNCTION_URL('a-fn')}, headers := jsonb_build_object(${BEARER})); END $do$;`,
      `SELECT "net"."http_get"(url := ${FUNCTION_URL('b-fn')});`,
      `SELECT cron.schedule('c', '5 * * * *', $job$ SELECT net.http_delete(${FUNCTION_URL('c-fn')}); $job$);`,
      `CREATE TRIGGER t AFTER INSERT ON public.x FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request(${FUNCTION_URL('d-fn')}, 'POST', '{}', '{}', '1000');`,
    ].join('\n');
    expect(callersOf(sql).map(({ label, line, callees }) => ({ label, line, callees }))).toEqual([
      { label: 'DO ブロック', line: 1, callees: ['a-fn'] },
      { label: 'SELECT "net"."http_get"(url := \'https://example.supabase.co/functions/v1/b-fn\');', line: 2, callees: ['b-fn'] },
      { label: "cron.schedule('c')", line: 3, callees: ['c-fn'] },
      { label: 'CREATE TRIGGER t AFTER INSERT ON', line: 4, callees: ['d-fn'] },
    ]);
  });

  it('SQL 関数の本文の呼び出しは関数ごとに拾い、許可リストの関数名も呼び先にする (本文の ; や -- では区切らない)', () => {
    const allowed = 'import-seven-eleven-catalog';
    const sql = [
      'CREATE OR REPLACE FUNCTION public.f(p text) RETURNS bigint LANGUAGE plpgsql AS $$',
      'DECLARE v bigint; -- 区切りではない ;',
      `BEGIN IF p NOT IN ('${allowed}') THEN RAISE EXCEPTION 'x;--'; END IF;`,
      `  SELECT net.http_post(url := 'https://example.supabase.co/functions/v1/' || p, headers := jsonb_build_object(${BEARER})) INTO v;`,
      '  RETURN v; END; $$;',
      // ドル引用の文字列の中の ' (it's) で、後ろの文の区切りを見失わない (閉じる $$ が先に効く)
      "COMMENT ON FUNCTION public.f(text) IS $$it's; not a call$$;",
      `CREATE FUNCTION public.g() RETURNS void LANGUAGE sql AS $fn$ SELECT net.http_post(${FUNCTION_URL('g-fn')}) $fn$;`,
    ].join('\n');
    expect(callersOf(sql).map(({ label, line, callees }) => ({ label, line, callees }))).toEqual([
      { label: '関数 public.f', line: 1, callees: [allowed] },
      { label: '関数 public.g', line: 7, callees: ['g-fn'] },
    ]);
  });

  it('コメントの中の呼び出しは数えず、呼び先が読めない呼び出しは呼び先なしで残す (下のテストで赤になる)', () => {
    const sql = [
      '-- SELECT net.http_post(url := \'https://example.supabase.co/functions/v1/commented\');',
      '/* SELECT net.http_post(url := \'https://example.supabase.co/functions/v1/block\'); */',
      "SELECT net.http_post(url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'some_url'));",
    ].join('\n');
    expect(callersOf(sql).map(({ line, calls, callees }) => ({ line, calls, callees }))).toEqual([
      { line: 3, calls: 1, callees: [] },
    ]);
    expect(countHttpCalls(stripSqlCommentsSimply(sql))).toBe(1);
  });

  it('数え直しは抜き出しと別のやり方で数える (抜き出しが取りこぼすと数が合わなくなる)', () => {
    const sql = `SELECT cron.schedule('x', '0 * * * *', $$ SELECT net.http_post(${FUNCTION_URL('a-fn')}); SELECT net.http_get(${FUNCTION_URL('b-fn')}); $$);`;
    expect(countHttpCalls(stripSqlCommentsSimply(sql))).toBe(2);
    expect(callersOf(sql).reduce((sum, caller) => sum + caller.calls, 0)).toBe(2);
  });

  it('requireServiceRole で認証する関数を見つけられている (要求を渡すだけの index.ts も、渡し先の関数を見る)', () => {
    expect(SERVICE_ROLE_FUNCTIONS).toContain(SEGMENT_STATS_FUNCTION);
    expect(SERVICE_ROLE_FUNCTIONS).toContain('import-seven-eleven-catalog');
  });
});

describe('verify_jwt = false の関数は、先頭で自前の認証をする', () => {
  it('verify_jwt = false の関数は、どれも配られる関数 (supabase/functions/<name>/index.ts) である', () => {
    // 関数が無い名前があると、CLI は config.toml の関数として配ろうとして失敗する
    expect(NO_VERIFY_JWT.filter((name) => !DEPLOYED_FUNCTIONS.includes(name))).toEqual([]);
  });

  it.each(NO_VERIFY_JWT)('%s: 本文を読む・DB に触る前に、requireServiceRole / requireAuth / auth.getUser を呼ぶ', (name) => {
    expect(HANDLER_AUTH.get(name)?.kind ?? null, `${name} はゲートウェイの検証を外しているのに、先頭で認証していない`).not.toBeNull();
  });
});

describe('JWT でない Bearer で呼ばれる関数は、verify_jwt = false', () => {
  it('migration の中の DB からの HTTP の呼び出しを、どれも呼び出し元として拾えている (数え直しと一致)', () => {
    // 抜き出し (文ごと) が取りこぼした呼び出しは、下の verify_jwt の検査から漏れる。別のやり方で数えた数と、migration ごとに突き合わせる
    const mismatched = MIGRATION_FILES.flatMap((file) => {
      const collected = DB_CALLERS.filter((caller) => caller.migration === file).reduce((sum, caller) => sum + caller.calls, 0);
      const recounted = countHttpCalls(stripSqlCommentsSimply(MIGRATION_SQL.get(file) ?? ''));
      return collected === recounted ? [] : [`${file}: 拾えた ${collected} / 数え直し ${recounted}`];
    });
    expect(mismatched).toEqual([]);
    // 空振りしていないこと (今の migration には、SQL 関数 2 つの中に呼び出しがある)
    expect(DB_CALLERS.length).toBeGreaterThan(0);
  });

  it.each(DB_CALLERS.map((caller) => [callerName(caller), caller] as const))('%s: 呼び先の Edge Function が読める', (_name, caller) => {
    // URL を変数や Vault から組み立てていて関数名が読めない呼び出しは、verify_jwt を確かめられないので赤にする
    // ('.../functions/v1/<name>' と直書きするか、'.../functions/v1/' || 引数 なら許可リストを同じ文に書く)
    expect(caller.callees).not.toHaveLength(0);
  });

  it.each(DB_CALLERS.map((caller) => [callerName(caller), caller] as const))(
    '%s: Vault の app_cron_secret を Bearer に付けて呼ぶ (JWT ではない)',
    (_name, caller) => {
      expect(caller.code).toContain(`'${VAULT_CRON_SECRET_NAME}'`);
      expect(caller.code).toMatch(/'Bearer '\s*\|\|/);
    },
  );

  it('DB (pg_cron → pg_net) から呼ばれる関数は、どれも verify_jwt = false', () => {
    // 外し忘れると、ゲートウェイが 401 (UNAUTHORIZED_INVALID_JWT_FORMAT) を返し、関数に届かない。
    // cron.job_run_details は succeeded のままなので、ここで止める
    expect(
      DB_CALLERS.flatMap((caller) =>
        calleesStoppedByGateway(caller.callees, VERIFY_JWT).map((name) => `${callerName(caller)} → ${name}`),
      ),
    ).toEqual([]);
  });

  it('DB から呼ばれる関数は、どれも先頭で requireServiceRole を呼ぶ (CRON_SECRET で認証する)', () => {
    expect(
      DB_CALLEES.filter((name) => !SERVICE_ROLE_FUNCTIONS.includes(name) || HANDLER_AUTH.get(name)?.kind !== 'service-role'),
    ).toEqual([]);
  });

  it('requireServiceRole で認証する関数 (CRON_SECRET を受け付ける) は、どれも verify_jwt = false', () => {
    // verify_jwt が有効なままだと、CRON_SECRET で呼んだときだけゲートウェイで止まり、関数の中の受け付け方と食い違う
    expect(SERVICE_ROLE_FUNCTIONS.filter((name) => VERIFY_JWT.get(name) !== false)).toEqual([]);
  });
});

describe('デプロイが config.toml の verify_jwt を反映する', () => {
  // YAML のコメント (# 以降) は読まない (コメントに書いただけで通る・落ちることを防ぐ)
  const workflow = read(DEPLOY_WORKFLOW)
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');
  const runLines = workflow
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /supabase@[\d.]+\s+functions\s+deploy\b/.test(line));

  it('functions deploy は名前を指定せず (全関数)、--no-verify-jwt を付けない', () => {
    expect(runLines).toHaveLength(1);
    const args = runLines[0].replace(/^.*functions\s+deploy\b/, '').trim();
    // 残る引数は --project-ref <ref> だけ (関数名を指定すると、それ以外の関数の verify_jwt が反映されない)
    expect(args).toMatch(/^--project-ref\s+(?:\$\{\{[^}]*\}\}|\S+)$/);
    expect(workflow).not.toMatch(/--no-verify-jwt/);
  });

  it('config.toml を変えただけでも、main への push でデプロイが動く', () => {
    const paths = [...workflow.matchAll(/^\s*-\s*'([^']+)'\s*$/gm)].map((m) => m[1]);
    expect(paths).toContain('supabase/functions/**');
    expect(paths).toContain(CONFIG_TOML);
  });
});
