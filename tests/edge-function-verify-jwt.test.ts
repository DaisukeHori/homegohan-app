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
//   - DB から pg_net (net.http_post) で呼ばれる関数 (migration から抜き出す) は、どれも verify_jwt = false
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
  /await\s+requireServiceRole\(\s*req\s*\)/.test(HANDLER_AUTH.get(name)?.source ?? ''),
);

// ---------------------------------------------------------------------------
// DB (pg_net) から呼ばれる関数
// ---------------------------------------------------------------------------

/** SQL の -- コメントを除く (' の中の -- は残す) */
function stripSqlComments(sql: string): string {
  return sql
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

type DbCaller = { migration: string; sqlFunction: string; body: string; callees: string[] };

/**
 * migration の中の、net.http_post で Edge Function を呼ぶ SQL 関数と、その呼び先。
 * 呼び先は、本文の '.../functions/v1/<name>' の直書きと、'.../functions/v1/' || 引数 の形なら本文の許可リストの関数名。
 */
function dbCallers(): DbCaller[] {
  const callers: DbCaller[] = [];
  const files = fs
    .readdirSync(path.join(ROOT, MIGRATIONS_DIR))
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort();
  for (const file of files) {
    const sql = stripSqlComments(read(path.join(MIGRATIONS_DIR, file)));
    const definitions = sql.matchAll(
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([^\s(]+)\s*\([\s\S]*?\bAS\s+\$([A-Za-z_]*)\$([\s\S]*?)\$\2\$/gi,
    );
    for (const [, sqlFunction, , body] of definitions) {
      if (!/net\.http_post\s*\(/i.test(body)) continue;
      const callees = new Set<string>();
      for (const m of body.matchAll(/\/functions\/v1\/([a-z0-9-]+)'/g)) callees.add(m[1]);
      if (/\/functions\/v1\/'\s*\|\|/.test(body)) {
        for (const m of body.matchAll(/'([a-z0-9-]+)'/g)) {
          if (DEPLOYED_FUNCTIONS.includes(m[1])) callees.add(m[1]);
        }
      }
      callers.push({ migration: file, sqlFunction: sqlFunction.replace(/"/g, ''), body, callees: [...callees].sort() });
    }
  }
  return callers;
}

const DB_CALLERS = dbCallers();
const DB_CALLEES = [...new Set(DB_CALLERS.flatMap((caller) => caller.callees))].sort();

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
    for (const caller of DB_CALLERS) {
      expect(caller.callees, `${caller.migration} の ${caller.sqlFunction} の呼び先が取れない`).not.toHaveLength(0);
    }
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
  it.each(DB_CALLERS.map((caller) => [caller.sqlFunction, caller] as const))(
    '%s: Vault の app_cron_secret を Bearer に付けて呼ぶ (JWT ではない)',
    (_name, caller) => {
      expect(caller.body).toContain(`'${VAULT_CRON_SECRET_NAME}'`);
      expect(caller.body).toMatch(/'Bearer '\s*\|\|/);
    },
  );

  it('DB (pg_cron → pg_net) から呼ばれる関数は、どれも verify_jwt = false', () => {
    // 外し忘れると、ゲートウェイが 401 (UNAUTHORIZED_INVALID_JWT_FORMAT) を返し、関数に届かない。
    // cron.job_run_details は succeeded のままなので、ここで止める
    expect(DB_CALLEES.filter((name) => VERIFY_JWT.get(name) !== false)).toEqual([]);
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
