/**
 * #1177 (T26) / #1149 (T40) AI 利用回数の上限の判定と記録 (consumeAiUsage / consumeEdgeAiUsage) の contract テスト
 *
 * AI 事業者へ送る入口の一覧は 1 つだけ (tests/helpers/ai-consent-enforced-paths.ts。外国の AI 事業者への提供の同意の判定 #1154 と共用)。
 * 入口の棚卸し (AI に届く入口は、すべて一覧にある) は tests/ai-consent-enforcement.test.ts が、同じ検出器 (tests/helpers/ai-reach.ts) で行う。
 * このテストは、一覧の usage の列 (記録の扱い) と、ソースの実際が一致することだけを確かめる。
 *
 *   1. 判定と記録 (consumeAiUsage) を呼ぶファイルの全数・機能名 = 一覧の usage の列 (record) と LIBRARY_RECORDERS。
 *      呼んだ結果は、どれも変数で受けて .allowed を読む (結果を捨てて上限で止めない書き方を落とす)
 *   2. 一覧の route の公開ハンドラ (GET / POST ...) の全数 = 一覧の handlers (ハンドラを足したら、記録の扱いを決めて一覧に足す)
 *   3. 記録する route のハンドラは、どれも実際に呼ぶ表 (tests/ai-consent-enforcement-routes.test.ts など) に行がある
 *   4. Edge Function: 記録を呼ぶ関数の全数・機能名 = 一覧。ユーザーの JWT を確かめて AI へ送る関数は、どれも記録する。
 *      記録しない AI の関数は、service role (または cron のシークレット) でしか呼べない
 *   5. Next.js が Edge Function を呼ぶときは、記録済みの印 (aiUsageRecordedHeaders) を付ける (二重に記録しない)
 *   6. 定期実行 (vercel.json の crons・migration の pg_cron / pg_net) は記録しない
 *   7. AI のキュー (weekly_menu_requests / meal_image_jobs) は、利用者 (authenticated) から書けない (#1465。書けるようになったら落ちる)
 *   8. 機能名は DB の形式どおりで、どれもどこかで使われている
 *   9. (#1149) 上限に数えない機能・既定のプランは migration の consume_ai_usage_at と同じ。上限に達したときの止め方 (onLimit) は一覧に必ずある。
 *      記録・判定・数え戻しの DB 関数 (record_ai_usage / consume_ai_usage / refund_ai_usage) を直接呼ぶのは、
 *      src/lib/plan/entitlements.ts と supabase/functions/_shared/ai-usage.ts だけ
 *
 * 【このテストの限界 (見張り)】ソースの文字と構文木で見るので、次は見つけられない (実際に動かすテストが受け持つ):
 *   - .allowed を読んでいても、その結果で止めていない (if の中身が空・条件が逆)。→ tests/ai-consent-enforcement-routes.test.ts が、
 *     上限に達した結果を返して、AI へ送らないこと・止め方 (429 / 保存だけ / 画像だけ見送る) を実際に route を呼んで確かめる。
 *     Edge Function は tests/ai-consent-enforcement-edge.test.ts が、止める if が送る呼び出しより前にあることを構文木で確かめる
 *   - AI のクライアント (OpenAI / Gemini / fetch) を、判定を通らずに直接呼ぶ新しい入口。→ AI へ届く入口の棚卸し
 *     (tests/ai-consent-enforcement.test.ts。検出器は tests/helpers/ai-reach.ts) が、一覧に無い入口を落とす。
 *     AI のクライアントの直接の呼び出しを lint で禁じることはしない (送り口がライブラリ・Edge Function に 30 か所以上あり、
 *     送り口の側で禁じると、判定を通ったあとの正しい呼び出しまで止まる。入口の棚卸しのほうが確実なため)
 *
 * 「同意の判定 → 記録 → AI への送信」の順は、ここ (ソースの文字) では見ない。実際にハンドラを動かして、呼ばれた順で確かめる
 * (Next.js: tests/ai-consent-enforcement-routes.test.ts の表・tests/meal-image-route-contracts.test.ts・
 *  tests/consultation-action-usage.test.ts / Edge Functions: tests/ai-consent-enforcement-edge.test.ts の代表の関数)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_FEATURES } from '../supabase/functions/_shared/ai-usage-core';
import {
  ENFORCED_EDGE,
  ENFORCED_ROUTES,
  EXEMPT_EDGE,
  EXEMPT_ROUTES,
  LIBRARY_RECORDERS,
  type AiRouteEntry,
  type AiUsage,
} from './helpers/ai-consent-enforced-paths';
import { ROOT, exportedHandlers, listEdgeFunctions, listFiles, reachesAi, rel, stripComments } from './helpers/ai-reach';
import { AI_QUEUE_TABLES, type AiQueueTable } from '../src/lib/ai/ai-queue-tables';
import { AI_UNMETERED_FEATURES } from '../supabase/functions/_shared/ai-usage-core';
import { AI_DAILY_LIMIT_DEFAULT_PLAN_KEY } from '../src/lib/super-admin/llm-schemas';
import ts from 'typescript';

const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const recordedFeatures = (usage: AiUsage | undefined) => (usage && 'record' in usage ? [...usage.record] : []);

const ALL_ROUTES: Record<string, AiRouteEntry> = { ...ENFORCED_ROUTES, ...EXEMPT_ROUTES };
const ALL_EDGE = { ...ENFORCED_EDGE, ...EXEMPT_EDGE };

/** 判定と記録の関数の呼び出し (コメントを除いた本文で数える)。第 2 引数 (機能名) は文字列で書く */
function recordCalls(source: string, fn: 'consumeAiUsage' | 'consumeEdgeAiUsage'): { total: number; features: string[] } {
  const text = stripComments(source);
  const total = [...text.matchAll(new RegExp(`\\b${fn}\\(`, 'g'))].length;
  const literal =
    fn === 'consumeAiUsage'
      ? /\bconsumeAiUsage\(\s*[\w.]+\s*,\s*['"]([a-z_]+)['"]\s*\)/g
      : /\bconsumeEdgeAiUsage\(\s*\w+\s*,\s*[\w.]+\s*,\s*['"]([a-z_]+)['"]\s*\)/g;
  return { total, features: [...text.matchAll(literal)].map((m) => m[1]) };
}

/**
 * 判定と記録の呼び出しのうち、結果を見ていないもの (#1149)。
 * 呼び出しの結果を変数で受け (const x = await f(...) / x = await f(...) / 三項演算子の枝の中)、同じ関数の中の呼び出しより後で
 * x.allowed (x?.allowed) を読んでいれば「見ている」とする。結果を捨てる・別の名前を読む書き方を返す (行番号)
 */
function unguardedConsumeCalls(file: string, source: string, fn: 'consumeAiUsage' | 'consumeEdgeAiUsage'): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const missing: string[] = [];
  const enclosingFunction = (node: ts.Node): ts.Node => {
    let current: ts.Node | undefined = node.parent;
    while (current && !ts.isFunctionLike(current)) current = current.parent;
    return current ?? sf;
  };
  const resultName = (call: ts.CallExpression): string | null => {
    let node: ts.Node = call.parent;
    while (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node) || ts.isConditionalExpression(node)) node = node.parent;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) return node.left.text;
    return null;
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === fn) {
      const name = resultName(node);
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      let read = false;
      const findRead = (n: ts.Node) => {
        if (read) return;
        if (
          ts.isPropertyAccessExpression(n) &&
          n.name.text === 'allowed' &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === name &&
          n.getStart() > node.getStart()
        ) {
          read = true;
          return;
        }
        ts.forEachChild(n, findRead);
      };
      if (name) findRead(enclosingFunction(node));
      if (!read) missing.push(`${file}:${line}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return missing;
}

/** 記録する route のハンドラのうち、実際に呼ぶ表が tests/ai-consent-enforcement-routes.test.ts の外にあるもの */
const RUNTIME_TESTS_ELSEWHERE: Record<string, string> = {
  // 同意の判定をしない (処理する Edge Function が判定する) ので、同意の表 (ROUTE_CASES) の外で、
  // 「同意済みなら積む前に 1 回記録・未同意なら記録せずに積む」を確かめる
  'src/app/api/meals/route.ts': 'tests/meal-image-route-contracts.test.ts',
  'src/app/api/meals/[id]/route.ts': 'tests/meal-image-route-contracts.test.ts',
  'src/app/api/meal-plans/meals/route.ts': 'tests/meal-image-route-contracts.test.ts',
  'src/app/api/meal-plans/meals/[id]/route.ts': 'tests/meal-image-route-contracts.test.ts',
  'src/lib/ai/consultation-action-executor.ts': 'tests/consultation-action-usage.test.ts',
};

// ─────────────────────────────────────────────
// 1〜3. Next.js
// ─────────────────────────────────────────────
describe('AI 利用回数の記録 (#1177): Next.js', () => {
  const sourceFiles = [
    ...listFiles(path.join(ROOT, 'src'), (name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)),
    ...['lib', 'shared'].flatMap((dir) =>
      fs.existsSync(path.join(ROOT, dir)) ? listFiles(path.join(ROOT, dir), (name) => /\.(ts|tsx|mjs)$/.test(name)) : [],
    ),
  ]
    .map(rel)
    .filter((file) => !file.startsWith('src/__tests__/') && file !== 'src/lib/plan/entitlements.ts');
  const recorders = new Map(
    sourceFiles.map((file) => [file, recordCalls(read(file), 'consumeAiUsage')] as const).filter(([, calls]) => calls.total > 0),
  );

  it('記録を呼ぶファイルの全数 = 一覧で record のハンドラがある route + LIBRARY_RECORDERS', () => {
    const expected = [
      ...Object.entries(ALL_ROUTES)
        .filter(([, entry]) => Object.values(entry.handlers).some((usage) => recordedFeatures(usage).length > 0))
        .map(([file]) => file),
      ...Object.keys(LIBRARY_RECORDERS),
    ];
    expect(sorted(recorders.keys())).toEqual(sorted(expected));
  });

  it.each([...Object.keys(ALL_ROUTES), ...Object.keys(LIBRARY_RECORDERS)])('%s: 記録する機能名は一覧どおりで、どの呼び出しも機能名を文字列で書く', (file) => {
    const calls = recorders.get(file) ?? { total: 0, features: [] };
    expect(calls.features.length, '機能名を文字列で書いていない呼び出しがある').toBe(calls.total);
    const expected =
      file in LIBRARY_RECORDERS
        ? LIBRARY_RECORDERS[file].record
        : Object.values(ALL_ROUTES[file].handlers).flatMap((usage) => recordedFeatures(usage));
    expect(sorted(calls.features)).toEqual(sorted(expected));
    if (calls.total > 0) expect(read(file)).toMatch(/import \{[^}]*\bconsumeAiUsage\b[^}]*\} from '@\/lib\/plan\/entitlements'/);
  });

  it('(#1149) 判定と記録 (consumeAiUsage) の結果は、どの呼び出しも変数で受けて .allowed を読む (結果を捨てて上限で止めない書き方が無い)', () => {
    const missing = [...recorders.keys()].flatMap((file) => unguardedConsumeCalls(file, read(file), 'consumeAiUsage'));
    expect(recorders.size, '走査が呼び出しを見つけていない').toBeGreaterThan(0);
    expect(missing, 'const aiUsage = await consumeAiUsage(...); if (!aiUsage.allowed) ... の形で、結果で止めること').toEqual([]);
  });

  it.each(Object.keys(ALL_ROUTES))('%s: 公開ハンドラの全数 = 一覧の handlers (ハンドラを足したら、記録の扱いを決めて一覧に足す)', (file) => {
    expect(sorted(exportedHandlers(read(file)))).toEqual(sorted(Object.keys(ALL_ROUTES[file].handlers)));
  });

  it('記録する route のハンドラ (と記録するライブラリ) は、どれも実際に呼んで順番を確かめる表に行がある', () => {
    const routesTable = read('tests/ai-consent-enforcement-routes.test.ts');
    const missing: string[] = [];
    for (const [file, entry] of Object.entries(ALL_ROUTES)) {
      for (const [method, usage] of Object.entries(entry.handlers)) {
        if (!usage || 'noAi' in usage || 'notRecorded' in usage) continue;
        if (file in ENFORCED_ROUTES) continue; // ROUTE_CASES の網羅は tests/ai-consent-enforcement-routes.test.ts 自身が確かめる
        // 表の行の名前は「メソッド + ファイル (拡張子なし)」 (例: 'POST src/app/api/meals/route')
        const testFile = RUNTIME_TESTS_ELSEWHERE[file];
        if (!testFile || !read(testFile).includes(`'${method} ${file.replace(/\.ts$/, '')}'`)) missing.push(`${method} ${file}`);
      }
    }
    for (const file of Object.keys(LIBRARY_RECORDERS)) {
      const testFile = RUNTIME_TESTS_ELSEWHERE[file];
      if (!testFile || !read(testFile).includes(file.replace(/^src\//, '@/').replace(/\.ts$/, ''))) missing.push(file);
    }
    expect(missing).toEqual([]);
    // 同意を判定する route のハンドラは、tests/ai-consent-enforcement-routes.test.ts の表 (ROUTE_CASES) が同じ一覧から網羅を確かめる
    expect(routesTable).toMatch(/import \{ ENFORCED_ROUTES \} from '\.\/helpers\/ai-consent-enforced-paths'/);
  });

  it('Edge Function を呼ぶ処理 (supabase.functions.invoke) は、どれも記録済みの印 (aiUsageRecordedHeaders) を付ける', () => {
    const missing: string[] = [];
    let invokes = 0;
    for (const file of sourceFiles) {
      const text = stripComments(read(file));
      for (const match of text.matchAll(/\.functions\.invoke\(/g)) {
        invokes += 1;
        // 呼び出しの括弧の中 (対応する閉じ括弧まで)
        let depth = 0;
        let end = match.index! + match[0].length - 1;
        for (; end < text.length; end++) {
          if (text[end] === '(') depth += 1;
          else if (text[end] === ')' && --depth === 0) break;
        }
        if (!text.slice(match.index!, end).includes('aiUsageRecordedHeaders(')) missing.push(`${file} (${match.index})`);
      }
    }
    expect(invokes, '走査が呼び出しを見つけていない').toBeGreaterThan(0);
    expect(
      missing,
      'Edge Function をユーザーの JWT で呼ぶときは headers: await aiUsageRecordedHeaders(user.id) を付けること (付けないと Edge Function 側でも記録して二重になる)',
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// 4. Edge Functions
// ─────────────────────────────────────────────

/** ユーザーの JWT を確かめる書き方 */
const USER_JWT_CHECK = /\brequireAuth\(|\.auth\.getUser\(/;
/** service role (または cron のシークレット) でしか呼べないことを確かめる書き方 */
const SERVICE_ONLY_GUARD = /requireServiceRole\(|[!=]==\s*(?:SERVICE_ROLE_KEY|SUPABASE_SERVICE_KEY|SUPABASE_SERVICE_ROLE_KEY)\b/;

/** index.ts から相対 import でたどれるファイル (共通の部品 _shared/auth.ts の中身は除く) のどれかの本文が、条件に合うか */
function edgeSourcesMatch(name: string, pattern: RegExp): boolean {
  const seen = new Set<string>();
  const stack = [path.join(ROOT, 'supabase/functions', name, 'index.ts')];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    if (pattern.test(text)) return true;
    for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      if (!m[1].endsWith('/auth.ts')) stack.push(path.resolve(path.dirname(file), m[1]));
    }
  }
  return false;
}

describe('AI 利用回数の記録 (#1177): Edge Functions', () => {
  const edgeFunctions = listEdgeFunctions();
  const index = (name: string) => read(`supabase/functions/${name}/index.ts`);

  it('記録を呼ぶ関数の全数 = 一覧で record の関数。機能名も一覧どおり', () => {
    const actual = Object.fromEntries(
      edgeFunctions
        .map((name) => [name, recordCalls(index(name), 'consumeEdgeAiUsage')] as const)
        .filter(([, calls]) => calls.total > 0)
        .map(([name, calls]) => {
          expect(calls.features.length, `${name}: 機能名を文字列で書いていない呼び出しがある`).toBe(calls.total);
          return [name, sorted(calls.features)];
        }),
    );
    const expected = Object.fromEntries(
      Object.entries(ALL_EDGE)
        .filter(([, entry]) => recordedFeatures(entry.usage).length > 0)
        .map(([name, entry]) => [name, sorted(recordedFeatures(entry.usage))]),
    );
    expect(actual).toEqual(expected);
    // (#1149) 結果は、どの呼び出しも変数で受けて .allowed を読む
    const missing = Object.keys(actual).flatMap((name) =>
      unguardedConsumeCalls(`supabase/functions/${name}/index.ts`, index(name), 'consumeEdgeAiUsage'),
    );
    expect(missing).toEqual([]);
  });

  it('ユーザーの JWT を確かめて AI へ送る関数は、どれも記録する (一覧で record)。記録する関数は、どれもユーザーの JWT を確かめる', () => {
    const jwtAi = edgeFunctions.filter(
      (name) => USER_JWT_CHECK.test(stripComments(index(name))) && reachesAi(path.join(ROOT, 'supabase/functions', name, 'index.ts')),
    );
    const recording = Object.entries(ALL_EDGE)
      .filter(([, entry]) => recordedFeatures(entry.usage).length > 0)
      .map(([name]) => name);
    expect(sorted(jwtAi)).toEqual(sorted(recording));
  });

  it('記録しない AI の関数は、service role (または cron のシークレット) でしか呼べない (ユーザーの JWT で直接呼んで、記録せずに AI を使えない)', () => {
    const unguarded = Object.entries(ALL_EDGE)
      .filter(([, entry]) => 'notRecorded' in entry.usage || 'recordedBy' in entry.usage)
      .map(([name]) => name)
      .filter((name) => !edgeSourcesMatch(name, SERVICE_ONLY_GUARD));
    expect(unguarded, 'requireServiceRole を使うか、ユーザーの JWT で呼べるなら consumeEdgeAiUsage で数えること').toEqual([]);
  });
});

// ─────────────────────────────────────────────
// 6. 定期実行
// ─────────────────────────────────────────────

/** 定期実行 (vercel.json の crons / migration の pg_cron・pg_net) の入口の全数。どれも service role / cron のシークレットで呼ぶので記録しない */
const CRON_ENTRYPOINTS: Record<string, string> = {
  'vercel:/api/cron/process-menu-queue': 'キューに積まれた献立生成を実行する (積む時点で記録済み。キューは利用者から書けない: AI_QUEUE_TABLES / #1465)',
  // #1157 本番のエラーの急増 (app_logs の件数) を運用メールで知らせる。import は cron の認証・ログ・Supabase・メールだけ
  'vercel:/api/cron/app-log-alerts': 'アプリのエラーの急増を運用メールで知らせる (AI を使わない)',
  'pg_cron:calculate-segment-stats': 'セグメント統計の集計 (AI を使わない)',
  // DB の関数が、名前を引数で受け取って Edge Function を呼ぶもの。呼び得る関数は PG_NET_CALLEES
  'pg_net:invoke_catalog_import': 'コンビニ商品カタログの取り込み (運営の処理で、利用者の AI 利用ではない)',
};

/** pg_net の入口 (DB の関数) が呼び得る Edge Function (migration の許可リスト) */
const PG_NET_CALLEES: Record<string, readonly string[]> = {
  'pg_net:invoke_catalog_import': [
    'import-familymart-catalog',
    'import-lawson-catalog',
    'import-ministop-catalog',
    'import-natural-lawson-catalog',
    'import-seven-eleven-catalog',
  ],
};

function migrationSqls(): Array<{ name: string; sql: string }> {
  const dir = path.join(ROOT, 'supabase/migrations');
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

function scanCronEntrypoints(): string[] {
  const entries = new Set<string>();
  const vercel = JSON.parse(read('vercel.json')) as { crons?: Array<{ path: string }> };
  for (const cron of vercel.crons ?? []) entries.add(`vercel:${cron.path}`);
  for (const { sql: raw } of migrationSqls()) {
    const sql = raw.replace(/--.*$/gm, '');
    for (const match of sql.matchAll(/functions\/v1\/([a-z0-9-]+)/g)) entries.add(`pg_cron:${match[1]}`);
    // 名前を文字列の連結で決める呼び出し ('.../functions/v1/' || p_function_name) は、それを含む DB の関数の名前で突き合わせる
    for (const match of sql.matchAll(/functions\/v1\/'\s*\|\|/g)) {
      const fnNames = [...sql.slice(0, match.index).matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?public"?\."?([a-z0-9_]+)"?/gi)];
      entries.add(`pg_net:${fnNames.length > 0 ? fnNames[fnNames.length - 1][1] : '?'}`);
    }
  }
  return [...entries].sort();
}

/** DB の関数の本文のうち、呼び先の許可リスト (NOT IN (...)) にある名前。最後の定義を正とする */
function pgNetAllowedCallees(sqlFunctionName: string): string[] {
  let latest: string[] = [];
  for (const { sql: raw } of migrationSqls()) {
    const sql = raw.replace(/--.*$/gm, '');
    const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+"?public"?\\."?${sqlFunctionName}"?[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`, 'gi');
    for (const match of sql.matchAll(pattern)) {
      const allowList = match[1].match(/NOT\s+IN\s*\(([^)]*)\)/i);
      latest = allowList ? [...allowList[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]) : ['?'];
    }
  }
  return latest.sort();
}

describe('AI 利用回数の記録 (#1177): 定期実行 (cron) の入口', () => {
  it('定期実行の入口の全数は CRON_ENTRYPOINTS の一覧どおり。pg_net の入口が呼び得る関数は migration の許可リストどおり', () => {
    expect(scanCronEntrypoints()).toEqual(Object.keys(CRON_ENTRYPOINTS).sort());
    for (const [entry, callees] of Object.entries(PG_NET_CALLEES)) {
      expect(pgNetAllowedCallees(entry.slice('pg_net:'.length)), entry).toEqual([...callees].sort());
    }
  });

  it('定期実行は記録しない: Vercel Cron の route のハンドラも、pg_cron / pg_net が呼ぶ Edge Function も、一覧で record ではない', () => {
    for (const entry of Object.keys(CRON_ENTRYPOINTS)) {
      if (entry.startsWith('vercel:')) {
        const file = `src/app${entry.slice('vercel:'.length)}/route.ts`;
        expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
        for (const usage of Object.values(ALL_ROUTES[file]?.handlers ?? {})) expect(recordedFeatures(usage), file).toEqual([]);
        expect(recordCalls(read(file), 'consumeAiUsage').total, file).toBe(0);
        continue;
      }
      const callees = entry.startsWith('pg_net:') ? PG_NET_CALLEES[entry] : [entry.slice('pg_cron:'.length)];
      expect(callees, `${entry}: 呼び得る Edge Function を PG_NET_CALLEES に書くこと`).toBeDefined();
      for (const name of callees) {
        expect(listEdgeFunctions(), name).toContain(name);
        expect(recordedFeatures(ALL_EDGE[name]?.usage), `${name} は service role で呼ばれるので記録しない`).toEqual([]);
      }
    }
  });

  it('Vercel Cron の route のうち、AI の入口の一覧 (ENFORCED_ROUTES / EXEMPT_ROUTES) に無いものは、AI へ送るコードに届かない (記録が要らないことの裏付け)', () => {
    const vercelCronRoutes = Object.keys(CRON_ENTRYPOINTS)
      .filter((entry) => entry.startsWith('vercel:'))
      .map((entry) => `src/app${entry.slice('vercel:'.length)}/route.ts`);
    // 一覧に無い cron が 1 本以上あること (app-log-alerts など)。0 本だとこのテストは何も確かめない
    const unlisted = vercelCronRoutes.filter((file) => !(file in ALL_ROUTES));
    expect(unlisted).toContain('src/app/api/cron/app-log-alerts/route.ts');
    expect(unlisted.filter((file) => reachesAi(path.join(ROOT, file)))).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// 7. AI のキュー (#1465)
// ─────────────────────────────────────────────

/**
 * AI のキュー: 行を積むと、service role の処理が AI へ送る表 (#1465)。
 * 通常の操作は、行を積む route で記録する (献立生成 = POST /api/ai/menu/v5/generate、料理画像 = 献立の保存・更新の route)。
 * 利用者 (authenticated) がこれらの表に直接書けると、route を通らずに積んだ行・積み直した行がどこでも記録されず、
 * 上限 (T40 #1149) もすり抜けられる。取り出す側で記録しても、取り直し (止まったワーカーの続き) と見分ける列も
 * 利用者が書けるので、記録の仕方では閉じられない。そのため、書き込みは service role だけにした
 * (migration 20261011010000_ai_queue_service_role_writes.sql。route は src/lib/ai/ai-queue-writer.ts の getAiQueueWriter で書く)。
 * 表の一覧は src/lib/ai/ai-queue-tables.ts の AI_QUEUE_TABLES と同じ (下のテストが突き合わせる)。
 */
const AI_QUEUES: Record<AiQueueTable, { worker: string; note: string }> = {
  weekly_menu_requests: {
    worker: 'src/app/api/cron/process-menu-queue/route.ts',
    note: 'queued の行を Vercel Cron が取り出し、行の generated_data と user_id で generate-menu-v5 を service role で呼ぶ (Edge Function は service role の経路では記録しない)',
  },
  meal_image_jobs: {
    worker: 'supabase/functions/process-meal-image-jobs/index.ts',
    note: 'pending のジョブを、献立の保存・更新の route が呼ぶたびに処理する (行の prompt で画像を生成する。service role で記録しない)',
  },
};

/**
 * 既知の穴: AI のキューのうち、まだ利用者 (authenticated) が書けるもの。#1465 で 2 つとも閉じたので空。
 * 書き込みのポリシーや権限を足して穴が戻ると、下のテストが落ちる (この一覧に足して通すのではなく、穴を閉じること)。
 */
const USER_WRITABLE_AI_QUEUES: ReadonlySet<AiQueueTable> = new Set<AiQueueTable>();

/**
 * migration を順に読み、authenticated がそのテーブルに INSERT / UPDATE / DELETE できるか (権限と、許可のポリシーの両方があるか)。
 * ポリシーの条件 (USING / WITH CHECK) は評価しない (条件つきでも、その操作を許すポリシーがあれば書けるとみなす)
 */
function authenticatedCanWrite(
  table: string,
  sqlFiles: Array<{ name: string; sql: string }> = migrationSqls(),
): { insert: boolean; update: boolean; delete: boolean } {
  const ALL_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
  // 名前の続きが英数字・_ のもの (例: weekly_menu_requests_archive) は別のテーブルなので、後ろを区切る
  const tableRef = `(?:"?public"?\\.)?"?${table}"?(?![A-Za-z0-9_])`;
  const rolesOf = (text: string) => text.split(',').map((role) => role.trim().replace(/"/g, '').toLowerCase());
  const privilegesOf = (text: string) =>
    /^ALL(\s+PRIVILEGES)?$/i.test(text.trim()) ? ALL_PRIVILEGES : text.split(',').map((p) => p.trim().toUpperCase());
  const privileges = new Set<string>();
  const policies = new Map<string, { command: string; roles: string[] }>();
  for (const { sql: raw } of sqlFiles) {
    const sql = raw.replace(/--.*$/gm, '');
    const statements: Array<{ index: number; apply: () => void }> = [];
    for (const m of sql.matchAll(new RegExp(`GRANT\\s+([A-Z ,]+?)\\s+ON\\s+(?:TABLE\\s+)?${tableRef}\\s+TO\\s+([^;]+);`, 'gi'))) {
      statements.push({
        index: m.index!,
        apply: () => {
          if (rolesOf(m[2]).includes('authenticated')) for (const p of privilegesOf(m[1])) privileges.add(p);
        },
      });
    }
    for (const m of sql.matchAll(new RegExp(`REVOKE\\s+([A-Z ,]+?)\\s+ON\\s+(?:TABLE\\s+)?${tableRef}\\s+FROM\\s+([^;]+);`, 'gi'))) {
      statements.push({
        index: m.index!,
        apply: () => {
          if (rolesOf(m[2]).some((role) => role === 'authenticated' || role === 'public')) {
            for (const p of privilegesOf(m[1])) privileges.delete(p);
          }
        },
      });
    }
    for (const m of sql.matchAll(new RegExp(`CREATE\\s+POLICY\\s+"([^"]+)"\\s+ON\\s+${tableRef}([^;]*);`, 'gi'))) {
      statements.push({
        index: m.index!,
        apply: () => {
          const rest = m[2];
          if (/AS\s+RESTRICTIVE/i.test(rest)) return;
          const command = rest.match(/\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i)?.[1].toUpperCase() ?? 'ALL';
          const to = rest.match(/\bTO\s+(.+?)(?:\s+USING\b|\s+WITH\s+CHECK\b|$)/i)?.[1];
          policies.set(m[1], { command, roles: to ? rolesOf(to) : ['public'] });
        },
      });
    }
    for (const m of sql.matchAll(new RegExp(`DROP\\s+POLICY\\s+(?:IF\\s+EXISTS\\s+)?"([^"]+)"\\s+ON\\s+${tableRef}\\s*;`, 'gi'))) {
      statements.push({ index: m.index!, apply: () => policies.delete(m[1]) });
    }
    for (const statement of statements.sort((x, y) => x.index - y.index)) statement.apply();
  }
  const allows = (command: string) =>
    [...policies.values()].some(
      (policy) => (policy.command === command || policy.command === 'ALL') && policy.roles.some((r) => r === 'authenticated' || r === 'public'),
    );
  return {
    insert: privileges.has('INSERT') && allows('INSERT'),
    update: privileges.has('UPDATE') && allows('UPDATE'),
    delete: privileges.has('DELETE') && allows('DELETE'),
  };
}

describe('AI 利用回数の記録 (#1177 / #1465): AI のキューは利用者から書けない', () => {
  it('AI のキューの一覧は、src/lib/ai/ai-queue-tables.ts の AI_QUEUE_TABLES と同じ', () => {
    expect(sorted(Object.keys(AI_QUEUES))).toEqual(sorted(AI_QUEUE_TABLES));
  });

  it('既知の穴 (USER_WRITABLE_AI_QUEUES) は空 (#1465 で閉じた)', () => {
    expect([...USER_WRITABLE_AI_QUEUES]).toEqual([]);
  });

  it.each(Object.entries(AI_QUEUES))('%s は、利用者 (authenticated) が INSERT / UPDATE / DELETE できない (migration から)', (table, { worker, note }) => {
    expect(note.trim().length).toBeGreaterThan(10);
    expect(fs.existsSync(path.join(ROOT, worker)), `${worker} が無い`).toBe(true);
    const writable = authenticatedCanWrite(table);
    const canWrite = writable.insert || writable.update || writable.delete;
    expect(
      canWrite,
      canWrite
        ? `${table} に利用者 (authenticated) の書き込みの権限とポリシーが戻った (${JSON.stringify(writable)})。` +
            'route を通らずに積んだ行は AI の利用回数の記録 (#1177) と上限 (T40) をすり抜けるので、書き込みは service role だけにすること (#1465)'
        : `${table} は USER_WRITABLE_AI_QUEUES にあるのに、利用者から書けない。一覧から消すこと`,
    ).toBe(USER_WRITABLE_AI_QUEUES.has(table as AiQueueTable));
  });

  it('キューを取り出して AI へ送る側の説明と README は、キューが利用者から書けない (#1465) ことを書いている', () => {
    const cron = ENFORCED_ROUTES['src/app/api/cron/process-menu-queue/route.ts'].handlers.GET;
    expect(cron && 'recordedBy' in cron ? cron.recordedBy : '').toContain('AI_QUEUE_TABLES');
    const imageWorker = ENFORCED_EDGE['process-meal-image-jobs'].usage;
    expect('recordedBy' in imageWorker ? imageWorker.recordedBy : '').toContain('AI_QUEUE_TABLES');
    const readme = read('supabase/functions/README.md');
    for (const table of Object.keys(AI_QUEUES)) expect(readme, `README.md に ${table} が書かれていない`).toContain(table);
    expect(readme).toContain('#1465');
    for (const doc of ['supabase/functions/README.md', 'CLAUDE.md', 'src/lib/plan/entitlements.ts']) {
      expect(read(doc), `${doc} に、閉じた穴の古い説明 (USER_WRITABLE_AI_QUEUES が穴を確かめる) が残っている`).not.toMatch(
        /USER_WRITABLE_AI_QUEUES/,
      );
    }
  });

  it('migration の読み取り: 権限とポリシーの両方があるときだけ書けるとみなし、REVOKE・DROP POLICY で閉じる', () => {
    const base = {
      name: '1.sql',
      sql: `
        CREATE POLICY "own_all" ON "public"."q" USING (("auth"."uid"() = "user_id"));
        GRANT INSERT, SELECT, UPDATE ON TABLE public."q" TO "authenticated";
      `,
    };
    expect(authenticatedCanWrite('q', [base])).toEqual({ insert: true, update: true, delete: false });
    expect(
      authenticatedCanWrite('q', [{ name: '1.sql', sql: `${base.sql}\nGRANT DELETE ON TABLE public.q TO authenticated;` }]),
    ).toEqual({ insert: true, update: true, delete: true });
    expect(authenticatedCanWrite('q', [base, { name: '2.sql', sql: 'REVOKE INSERT, UPDATE ON TABLE public.q FROM authenticated;' }])).toEqual({
      insert: false,
      update: false,
      delete: false,
    });
    // 本番の形 (ALL を付けたあと、REVOKE で書き込みだけを外す。複数のロールを並べる)
    expect(
      authenticatedCanWrite('q', [
        { name: '1.sql', sql: 'CREATE POLICY "own" ON public.q USING (true);\nGRANT ALL ON TABLE public.q TO anon, authenticated;' },
        { name: '2.sql', sql: 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.q FROM anon, authenticated;' },
      ]),
    ).toEqual({ insert: false, update: false, delete: false });
    expect(
      authenticatedCanWrite('q', [
        base,
        { name: '2.sql', sql: 'DROP POLICY IF EXISTS "own_all" ON public.q; CREATE POLICY "own_read" ON public.q FOR SELECT USING (true);' },
      ]),
    ).toEqual({ insert: false, update: false, delete: false });
    expect(
      authenticatedCanWrite('q', [
        { name: '1.sql', sql: 'CREATE POLICY "a" ON public.q_archive USING (true);\nGRANT ALL ON TABLE public.q_archive TO authenticated;' },
      ]),
    ).toEqual({ insert: false, update: false, delete: false });
    expect(
      authenticatedCanWrite('q', [
        { name: '1.sql', sql: '-- GRANT ALL ON TABLE public.q TO authenticated;\nCREATE POLICY "svc" ON public.q FOR ALL TO service_role USING (true);\nGRANT ALL ON TABLE public.q TO authenticated;' },
      ]),
    ).toEqual({ insert: false, update: false, delete: false });
  });
});

// ─────────────────────────────────────────────
// 8. 機能名
// ─────────────────────────────────────────────
describe('AI 利用回数の記録 (#1177): 機能名の定義', () => {
  // version (ファイル名の先頭の 14 桁) は付け直されることがあるので、名前の後半だけで探す
  const migrationFiles = fs.readdirSync(path.join(ROOT, 'supabase/migrations')).filter((name) => /^\d{14}_ai_usage_foundation\.sql$/.test(name));
  const DB_FEATURE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

  it('機能名は DB の形式 (migration の CHECK と関数の検証と同じ正規表現) に合っている。重複が無い', () => {
    expect(migrationFiles).toHaveLength(1);
    const migration = read(`supabase/migrations/${migrationFiles[0]}`);
    // migration 側の正規表現が変わったら、ここも合わせる (3 か所: CHECK 1 + 関数の検証 1 + ここ)
    expect(migration.match(/\^\[a-z\]\[a-z0-9_\]\{0,63\}\$/g)?.length, 'migration の正規表現').toBe(2);
    for (const feature of AI_FEATURES) expect(feature, feature).toMatch(DB_FEATURE_PATTERN);
    expect(new Set(AI_FEATURES).size).toBe(AI_FEATURES.length);
  });

  it('(#1149) 上限に数えない機能と既定のプランは、migration の consume_ai_usage_at (最後の定義) と同じ', () => {
    const definitions = migrationSqls()
      .map(({ sql }) => sql.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.consume_ai_usage_at\([\s\S]*?\$\$([\s\S]*?)\$\$/i)?.[1])
      .filter((body): body is string => Boolean(body));
    expect(definitions.length, 'consume_ai_usage_at の定義が見つからない').toBeGreaterThan(0);
    const body = definitions[definitions.length - 1];
    const unmetered = body.match(/c_unmetered\s+CONSTANT\s+TEXT\[\]\s*:=\s*ARRAY\[([^\]]*)\]/i)?.[1];
    expect(unmetered, 'c_unmetered が見つからない').toBeDefined();
    expect([...unmetered!.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort()).toEqual([...AI_UNMETERED_FEATURES].sort());
    expect(body.match(/c_default_plan\s+CONSTANT\s+TEXT\s*:=\s*'([a-z0-9_]+)'/i)?.[1]).toBe(AI_DAILY_LIMIT_DEFAULT_PLAN_KEY);
  });

  it('(#1149) 一覧の記録する入口には、上限に達したときの止め方 (onLimit) がある。画像だけ見送るのは料理画像の入口だけ', () => {
    const entries = [
      ...Object.entries(ALL_ROUTES).flatMap(([file, entry]) => Object.entries(entry.handlers).map(([method, usage]) => [`${method} ${file}`, usage] as const)),
      ...Object.entries(ALL_EDGE).map(([name, entry]) => [name, entry.usage] as const),
    ];
    for (const [label, usage] of entries) {
      if (!usage || !('record' in usage)) continue;
      expect(['reject', 'skipAi', 'skipImage'], label).toContain(usage.onLimit);
      if (usage.onLimit === 'skipImage') expect([...usage.record], label).toEqual(['image_generation']);
    }
    // Edge Function は、どれも 429 で止める (保存と AI を一緒にする関数は無い)
    for (const [name, entry] of Object.entries(ALL_EDGE)) {
      if ('record' in entry.usage) expect(entry.usage.onLimit, name).toBe('reject');
    }
  });

  it('(#1149) 記録・判定・数え戻しの DB 関数を直接呼ぶのは、判定の部品 (entitlements.ts / _shared/ai-usage.ts) だけ', () => {
    const files = [
      ...listFiles(path.join(ROOT, 'src'), (name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)),
      ...listFiles(path.join(ROOT, 'supabase/functions'), (name) => /\.ts$/.test(name)),
      ...['lib', 'shared'].flatMap((dir) => (fs.existsSync(path.join(ROOT, dir)) ? listFiles(path.join(ROOT, dir), (name) => /\.(ts|tsx|mjs)$/.test(name)) : [])),
    ]
      .map(rel)
      .filter((file) => !file.startsWith('src/__tests__/'));
    const callers = files.filter((file) => /rpc\(\s*['"](?:record_ai_usage|consume_ai_usage|refund_ai_usage)['"]/.test(stripComments(read(file))));
    expect(callers.sort()).toEqual(['src/lib/plan/entitlements.ts', 'supabase/functions/_shared/ai-usage.ts']);
  });

  it('すべての機能が、どこか (route・ライブラリ・Edge Function) で使われている', () => {
    const used = new Set<string>([
      ...Object.values(ALL_ROUTES).flatMap((entry) => Object.values(entry.handlers).flatMap((usage) => recordedFeatures(usage))),
      ...Object.values(LIBRARY_RECORDERS).flatMap((entry) => entry.record),
      ...Object.values(ALL_EDGE).flatMap((entry) => recordedFeatures(entry.usage)),
    ]);
    expect([...AI_FEATURES].filter((f) => !used.has(f))).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// 検査そのものの確かめ
// ─────────────────────────────────────────────
describe('AI 利用回数の記録 (#1177): 検査そのものの確かめ', () => {
  it('公開ハンドラの読み取り: export async function / export const / export { x as POST } / 再 export。コメントの中は拾わない', () => {
    expect(exportedHandlers('export async function POST() {}\nexport const GET = async () => {};')).toEqual(['GET', 'POST']);
    expect(exportedHandlers("async function h() {}\nexport { h as PUT };\nexport { DELETE } from './x';")).toEqual(['PUT', 'DELETE']);
    expect(exportedHandlers('// export async function PATCH() {}\nexport function helper() {}')).toEqual([]);
  });

  it('回帰 (R3 指摘 3): 一覧の route に、AI へ送るハンドラ (PUT) を足すと、ハンドラの全数が一覧と合わなくなる', () => {
    for (const file of ['src/app/api/meal-plans/add-from-photo/route.ts', 'src/app/api/cron/process-menu-queue/route.ts']) {
      const mutated = `${read(file)}\nexport async function PUT() {\n  await fetch('https://api.openai.com/v1/chat/completions');\n}\n`;
      expect(exportedHandlers(mutated), file).not.toEqual(exportedHandlers(read(file)));
      expect(exportedHandlers(mutated)).toContain('PUT');
      expect(Object.keys(ALL_ROUTES[file].handlers)).not.toContain('PUT');
    }
  });

  it('判定と記録の呼び出しの読み取り: 機能名を文字列で書いた呼び出しだけを数え、コメントの中は数えない', () => {
    expect(recordCalls("await consumeAiUsage(user.id, 'consultation');\n// consumeAiUsage(user.id, 'x')", 'consumeAiUsage')).toEqual({
      total: 1,
      features: ['consultation'],
    });
    expect(recordCalls('await consumeAiUsage(user.id, feature);', 'consumeAiUsage')).toEqual({ total: 1, features: [] });
    expect(recordCalls('await consumeEdgeAiUsage(req, directJwtUserId, "menu_generation");', 'consumeEdgeAiUsage')).toEqual({
      total: 1,
      features: ['menu_generation'],
    });
  });

  it('(#1149) 結果を見ていない呼び出しを見つける: 捨てる・別の名前を読む・呼ぶ前に読む、は落ちる。三項演算子・あとからの代入は通る', () => {
    const check = (body: string) => unguardedConsumeCalls('x.ts', `async function h() {\n${body}\n}`, 'consumeAiUsage');
    expect(check("await consumeAiUsage(u, 'consultation');\nawait send();")).toEqual(['x.ts:2']);
    expect(check("const a = await consumeAiUsage(u, 'consultation');\nif (!b.allowed) return;")).toEqual(['x.ts:2']);
    expect(check("let a = null;\nif (a?.allowed) {}\na = await consumeAiUsage(u, 'consultation');")).toEqual(['x.ts:4']);
    expect(check("const a = await consumeAiUsage(u, 'consultation');\nif (!a.allowed) return deny(a);")).toEqual([]);
    expect(check("const a = f ? await consumeAiUsage(u, 'nutrition_advice') : await consumeAiUsage(u, 'nutrition_advice_auto');\nif (!a.allowed) return;")).toEqual([]);
    expect(check("let a = null;\na = await consumeAiUsage(u, 'image_generation');\nif (!a.allowed) skip();")).toEqual([]);
    expect(check("const a = ok ? await consumeAiUsage(u, 'health_review') : null;\nif (a?.allowed) send();")).toEqual([]);
  });
});
