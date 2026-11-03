// @vitest-environment node
/**
 * #2195 V1 AI 相談の操作 → 変わる表 → 出す Web のページ の閉じた一覧 (src/lib/ai/consultation-refetch-coverage.ts) を、
 * ソースの構文木から組み立てた表と突き合わせる (網羅の機械の検査)。
 *
 * 問題 (直す前): 受け手のページ (useAiConsultationDataRefetch) を手で書いた一覧で選んでいたため、AI が書く表を出すページの抜けが
 * 敵対レビューの周ごとに 1〜2 件ずつ見つかった (/meals/[id]・/health/streaks・/profile/nutrition-targets・/health の選んだ日のパネル)。
 *
 * 確かめること:
 *   1. 実行の各 case (runConsultationAction) が書く表 = AI_CONSULTATION_ACTION_WRITTEN_TABLES
 *      (case からたどれる `.from('<表>')` の書き込み + DB の関数 (rpc) + Edge Function の書き込み)
 *   2. src/app/(main) のページのうち AI が書く表を読むもの = AI_CONSULTATION_REFETCH_PAGES のキー (受け手か除外)。
 *      各ページの読む AI が書く表は表の aiTables と一致し、受け手は useAiConsultationDataRefetch / useAiConsultationRefetchKey を使う。
 *      受け手は、開いたとき・パネルが読むもの全部を取り直すことを描画のテスト (tests/helpers/ai-refetch-read-recorder.ts の
 *      expectRefetchReadsCoverMount) で確かめ、空の応答の取り直しが空の応答で開いたときと同じこと (expectEmptyRefetchMatchesFreshMount) も確かめる。
 *      その 2 つを呼ぶテストが受け手ごとにあることをここで数える
 *
 * 読み取りのしかたと限界は tests/helpers/ai-consultation-refetch-scan.ts の先頭。ほかに:
 *   - ページが読む表 = ページからたどれる宣言の Supabase の読み取り + ページからたどれる '/api/' の URL に当たる route の GET が
 *     たどれる読み取り。POST などで読んで応答に出すもの (押したときに作る分析など) は数えない
 *   - レイアウト (src/app/(main)/MainLayout.tsx) とその部品は数えない (ページではない)
 *   - DB の関数の中の読み書きは、AI_CONSULTATION_RPC_WRITTEN_TABLES の宣言と、その migration に表の名前が出てくることだけを確かめる
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';
import {
  SourceScanner,
  UNRESOLVED_RPC_PREFIX,
  caseLabelOf,
  listFiles,
  routeSegmentsOf,
  routesForUrl,
  switchCasesOf,
  type ScanFindings,
  type TableAccess,
} from './helpers/ai-consultation-refetch-scan';
import {
  AI_CONSULTATION_ACTION_WRITTEN_TABLES,
  AI_CONSULTATION_COLUMN_SANITIZERS,
  AI_CONSULTATION_EDGE_FUNCTION_ENTRY,
  AI_CONSULTATION_INVOKED_EDGE_FUNCTIONS,
  AI_CONSULTATION_REFETCH_PAGES,
  AI_CONSULTATION_RPC_WRITTEN_TABLES,
  AI_CONSULTATION_UNRESOLVED_RPC_CALL_FILES,
  AI_CONSULTATION_WRITTEN_COLUMNS,
  AI_CONSULTATION_WRITTEN_TABLE_NAMES,
  type AiConsultationWrittenTable,
} from '@/lib/ai/consultation-refetch-coverage';
import { AI_PROFILE_FORBIDDEN_FIELDS, AI_PROFILE_PREFERENCE_FIELD_NAMES, sanitizeAiProfilePreferenceUpdates } from '@/lib/ai/profile-preference-updates';

// リポジトリのページ・route・Edge Function を構文木にしてたどる (TypeScript の構文木によるリポジトリの走査) ので、負荷の高い機械で
// vitest の既定の時間切れを超えうる (根拠と上書きは tests/helpers/heavy-unit-test-timeout.ts)。テストを定義する前に置く
applyHeavyUnitTestTimeout();

const ROOT = path.resolve(__dirname, '..');
const EXECUTOR = 'src/lib/ai/consultation-action-executor.ts';
const EXECUTOR_FUNCTION = 'runConsultationAction';
const EXECUTOR_SWITCH = 'action.action_type';
const PAGES_ROOT = 'src/app/(main)';
const PAGE_FILE = 'page.tsx';
const API_ROOT = 'src/app/api';
const ROUTE_FILE = 'route.ts';
const READ_HANDLER = 'GET';
const RECEIVER_HOOK_FILE = 'src/hooks/useAiConsultationDataRefetch.ts';
const RECEIVER_HOOKS = ['useAiConsultationDataRefetch', 'useAiConsultationRefetchKey'] as const;
/** 描画のテストの呼び出し (受け手ごとにあること)。tests/helpers/ai-refetch-read-recorder.ts の関数の名前 */
const RENDER_CHECKS = ['expectRefetchReadsCoverMount', 'expectEmptyRefetchMatchesFreshMount'] as const;
/** 描画のテストを探す場所 */
const TEST_ROOT = 'tests';
const SELF = 'tests/ai-consultation-refetch-coverage-2195.test.ts';
/** どの列を読むか数えられない読み取りの印 */
const ALL_COLUMNS = '*';
/**
 * 検査が何も読まずに緑になるのを防ぐ下限 (2026-11-03 の実数: ページ 49・AI が書く表を読むページ 25・実行の case 23。
 * ページを減らしてこれを割ったら、実数を数え直して下げる)
 */
const MIN_PAGES = 40;
const MIN_AI_READING_PAGES = 20;
const MIN_ACTION_CASES = 20;

const scanner = new SourceScanner(ROOT);
const WRITTEN = new Set<string>(AI_CONSULTATION_WRITTEN_TABLE_NAMES);
const sorted = <T extends string>(xs: Iterable<T>): T[] => [...new Set(xs)].sort();

// ─── 1. 実行の case が書く表 ─────────────────────────────────────────────

/** case の節ごとのたどった結果 (中身の無い case は次の case と同じ節として数える) */
function executorCases(): Map<string, ScanFindings> {
  const mod = scanner.module(EXECUTOR);
  if (!mod) throw new Error(`${EXECUTOR} が無い`);
  const out = new Map<string, ScanFindings>();
  let pending: string[] = [];
  for (const clause of switchCasesOf(mod.sf, EXECUTOR_FUNCTION, EXECUTOR_SWITCH)) {
    const label = caseLabelOf(clause);
    if (label === null) throw new Error(`case のラベルが文字列でない: ${clause.expression.getText(mod.sf)}`);
    pending.push(label);
    if (clause.statements.length === 0) continue;
    const findings = scanner.newFindings();
    for (const st of clause.statements) scanner.scanNode(EXECUTOR, st, findings);
    for (const l of pending) out.set(l, findings);
    pending = [];
  }
  return out;
}

const isWrite = (t: TableAccess) => t.kind === 'write' || t.kind === 'unknown';

interface WrittenTables {
  tables: string[];
  /** 宣言の無い rpc・解けない rpc の場所・知らない Edge Function */
  problems: string[];
}

function rpcTables(findings: ScanFindings, problems: string[]): string[] {
  const tables: string[] = [];
  for (const [name, at] of findings.rpcs) {
    if (name.startsWith(UNRESOLVED_RPC_PREFIX)) {
      const file = name.slice(UNRESOLVED_RPC_PREFIX.length).split(':')[0];
      if (!(file in AI_CONSULTATION_UNRESOLVED_RPC_CALL_FILES)) problems.push(`名前を解けない rpc: ${name} (${at})`);
      continue;
    }
    const declared = AI_CONSULTATION_RPC_WRITTEN_TABLES[name];
    if (!declared) {
      problems.push(`AI_CONSULTATION_RPC_WRITTEN_TABLES に無い rpc: ${name} (${at})`);
      continue;
    }
    tables.push(...declared.tables);
  }
  return tables;
}

const edgeCache = new Map<string, ScanFindings>();
function edgeFindings(name: string): ScanFindings {
  const cached = edgeCache.get(name);
  if (cached) return cached;
  const findings = scanner.newFindings();
  scanner.scanWholeModule(AI_CONSULTATION_EDGE_FUNCTION_ENTRY(name), findings);
  edgeCache.set(name, findings);
  return findings;
}

function writtenTablesOf(findings: ScanFindings): WrittenTables {
  const problems: string[] = [];
  const tables = findings.tables.filter(isWrite).map((t) => t.table);
  tables.push(...rpcTables(findings, problems));
  const edges = new Set<string>(findings.edgeFunctionUrls);
  if (findings.invokesEdgeFunction) for (const name of AI_CONSULTATION_INVOKED_EDGE_FUNCTIONS) edges.add(name);
  for (const name of edges) {
    if (!fs.existsSync(path.join(ROOT, AI_CONSULTATION_EDGE_FUNCTION_ENTRY(name)))) {
      problems.push(`Edge Function の入口が無い: ${name}`);
      continue;
    }
    const edge = edgeFindings(name);
    tables.push(...edge.tables.filter(isWrite).map((t) => t.table));
    tables.push(...rpcTables(edge, problems));
  }
  return { tables: sorted(tables), problems };
}

const CASES = executorCases();

describe('1. 実行の case が書く表 (#2195 V1)', () => {
  it('表の case は runConsultationAction の switch の case と一致する', () => {
    expect(CASES.size).toBeGreaterThanOrEqual(MIN_ACTION_CASES);
    expect(sorted(CASES.keys())).toEqual(sorted(Object.keys(AI_CONSULTATION_ACTION_WRITTEN_TABLES)));
  });

  it('各 case の書く表は、たどった書き込み・rpc・Edge Function の書き込みの和と一致する', () => {
    const mismatches: string[] = [];
    for (const [label, findings] of CASES) {
      const { tables, problems } = writtenTablesOf(findings);
      mismatches.push(...problems.map((p) => `${label}: ${p}`));
      const declared = sorted((AI_CONSULTATION_ACTION_WRITTEN_TABLES as Record<string, readonly string[]>)[label] ?? []);
      if (JSON.stringify(declared) !== JSON.stringify(tables)) {
        mismatches.push(`${label}: 表 ${JSON.stringify(declared)} / たどった結果 ${JSON.stringify(tables)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('AI が書く表の一覧は、全部の case の書く表の和と一致する', () => {
    const union = sorted(Object.values(AI_CONSULTATION_ACTION_WRITTEN_TABLES).flat());
    expect(sorted(AI_CONSULTATION_WRITTEN_TABLE_NAMES)).toEqual(union);
  });

  it('実行が invoke で呼ぶ Edge Function の名前は、一覧と一致する (executor の中のリテラル)', () => {
    const source = fs.readFileSync(path.join(ROOT, EXECUTOR), 'utf8');
    const literals = sorted([...source.matchAll(/'(generate-menu-v\d+)'/g)].map((m) => m[1]));
    expect(literals).toEqual(sorted(AI_CONSULTATION_INVOKED_EDGE_FUNCTIONS));
  });

  it('rpc の書く表は、その関数を作る migration に出てくる', () => {
    const problems: string[] = [];
    for (const [name, { tables, definedIn }] of Object.entries(AI_CONSULTATION_RPC_WRITTEN_TABLES)) {
      if (tables.length === 0) continue;
      const texts = definedIn.map((rel) => {
        const abs = path.join(ROOT, rel);
        if (!fs.existsSync(abs)) problems.push(`${name}: ${rel} が無い`);
        return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      });
      const all = texts.join('\n');
      if (!new RegExp(`function\\s+public\\.${name}\\s*\\(`, 'i').test(all)) problems.push(`${name}: definedIn に関数の定義が無い`);
      for (const table of tables) {
        if (!new RegExp(`public\\.${table}\\b`).test(all)) problems.push(`${name}: definedIn に public.${table} が出てこない`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('列を絞る表 (user_profiles) への書き込みは、AI が書く列だけ (リテラルのキーか、列を絞る関数の値)', () => {
    const problems: string[] = [];
    for (const [label, findings] of CASES) {
      for (const access of findings.tables.filter(isWrite)) {
        const columns = AI_CONSULTATION_WRITTEN_COLUMNS[access.table as AiConsultationWrittenTable];
        if (!columns) continue;
        if (access.columns) {
          const extra = access.columns.filter((c) => !columns.includes(c));
          if (extra.length > 0) problems.push(`${label}: ${access.at} が AI_CONSULTATION_WRITTEN_COLUMNS に無い列 ${extra.join(', ')} を書く`);
          continue;
        }
        const sanitizer = access.writeArg ? sanitizerOf(access) : null;
        if (!sanitizer || AI_CONSULTATION_COLUMN_SANITIZERS[sanitizer] !== access.table) {
          problems.push(`${label}: ${access.at} の書き込みの値の列を数えられない (${access.writeArg?.getText() ?? '値なし'})`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('列を絞る関数 sanitizeAiProfilePreferenceUpdates は、AI が書く列のキーしか返さない', () => {
    const input: Record<string, unknown> = { not_a_column: 1 };
    for (const name of [...AI_PROFILE_PREFERENCE_FIELD_NAMES.keys(), ...AI_PROFILE_FORBIDDEN_FIELDS]) input[name] = null;
    const { data } = sanitizeAiProfilePreferenceUpdates(input);
    const allowed = AI_CONSULTATION_WRITTEN_COLUMNS.user_profiles ?? [];
    expect(Object.keys(data).filter((k) => !allowed.includes(k))).toEqual([]);
    expect(Object.keys(AI_CONSULTATION_COLUMN_SANITIZERS)).toEqual(['sanitizeAiProfilePreferenceUpdates']);
  });
});

/** 識別子を含むいちばん内側の case の節か関数 (同じ名前の変数を別の case で作り直すため、その中だけを探す) */
function enclosingScope(node: ts.Node): ts.Node {
  let cur: ts.Node | undefined = node.parent;
  while (cur && !ts.isCaseClause(cur) && !ts.isFunctionLike(cur) && !ts.isSourceFile(cur)) cur = cur.parent;
  return cur ?? node.getSourceFile();
}

/**
 * 書き込みの値の識別子を、同じ case の節 (か関数) の中で `const { data: <名前> } = <関数>(...)` (か `const <名前> = <関数>(...)`) で
 * 作っていれば、その関数の名前
 */
function sanitizerOf(access: TableAccess): string | null {
  const arg = access.writeArg;
  if (!arg || !ts.isIdentifier(arg)) return null;
  const name = arg.text;
  let found: string | null = null;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer) && ts.isIdentifier(n.initializer.expression)) {
      const binds =
        (ts.isIdentifier(n.name) && n.name.text === name) ||
        (ts.isObjectBindingPattern(n.name) && n.name.elements.some((el) => ts.isIdentifier(el.name) && el.name.text === name));
      if (binds) found = n.initializer.expression.text;
    }
    ts.forEachChild(n, visit);
  };
  visit(enclosingScope(arg));
  return found;
}

// ─── 2. AI が書く表を読むページ ─────────────────────────────────────────

/** src/app/(main)/<道>/page.tsx → '/<道>' (ルートのグループは URL に出ない) */
function pageKeyOf(rel: string): string {
  const inner = path.posix.relative(PAGES_ROOT, path.posix.dirname(rel));
  const segs = inner.split('/').filter((s) => s !== '' && s !== '.' && !/^\(.*\)$/.test(s));
  return `/${segs.join('/')}`;
}

interface PageReads {
  rel: string;
  /** 読む AI が書く表 → どこで読むか */
  tables: Map<string, Set<string>>;
  /** 列を絞る表の、読む AI が書く列 ('*' = 数えられない) */
  columns: Map<string, Set<string>>;
  visited: Set<string>;
}

const ROUTES = listFiles(ROOT, API_ROOT, (rel) => rel.endsWith(`/${ROUTE_FILE}`)).map((rel) => ({ rel, segs: routeSegmentsOf(rel, API_ROOT) }));
const routeReadCache = new Map<string, TableAccess[]>();
function routeReads(rel: string): TableAccess[] {
  const cached = routeReadCache.get(rel);
  if (cached) return cached;
  const findings = scanner.newFindings();
  scanner.scanExport(rel, READ_HANDLER, findings);
  const reads = findings.tables.filter((t) => t.kind !== 'write');
  routeReadCache.set(rel, reads);
  return reads;
}

function addRead(reads: PageReads, access: TableAccess, via: string) {
  if (!WRITTEN.has(access.table)) return;
  const restricted = AI_CONSULTATION_WRITTEN_COLUMNS[access.table as AiConsultationWrittenTable];
  let cols: string[] = [];
  if (restricted) {
    cols = access.columns === null ? [ALL_COLUMNS] : access.columns.filter((c) => restricted.includes(c));
    if (cols.length === 0) return;
  }
  const where = reads.tables.get(access.table) ?? new Set<string>();
  where.add(via);
  reads.tables.set(access.table, where);
  if (restricted) {
    const set = reads.columns.get(access.table) ?? new Set<string>();
    for (const c of cols) set.add(c);
    reads.columns.set(access.table, set);
  }
}

function pageReads(rel: string): PageReads {
  const findings = scanner.newFindings();
  scanner.scanWholeModule(rel, findings);
  const reads: PageReads = { rel, tables: new Map(), columns: new Map(), visited: findings.visited };
  for (const access of findings.tables.filter((t) => t.kind !== 'write')) addRead(reads, access, access.at);
  for (const url of findings.apiUrls) {
    for (const route of routesForUrl(url, ROUTES)) {
      for (const access of routeReads(route)) addRead(reads, access, `${url} → ${route} (${access.at})`);
    }
  }
  return reads;
}

const PAGES = listFiles(ROOT, PAGES_ROOT, (rel) => rel.endsWith(`/${PAGE_FILE}`));
const READS = new Map(PAGES.map((rel) => [pageKeyOf(rel), pageReads(rel)]));

/** 描画のテストのファイル (このファイル自身は数えない) */
function testFiles(): { rel: string; source: string }[] {
  return listFiles(ROOT, TEST_ROOT, (rel) => /\.test\.tsx?$/.test(rel) && rel !== SELF).map((rel) => ({
    rel,
    source: fs.readFileSync(path.join(ROOT, rel), 'utf8'),
  }));
}

describe('2. AI が書く表を読むページは、受け手か除外の表にある (#2195 V1)', () => {
  it('ページを読めている (下限)', () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(MIN_PAGES);
    const aiReading = [...READS.values()].filter((r) => r.tables.size > 0);
    expect(aiReading.length).toBeGreaterThanOrEqual(MIN_AI_READING_PAGES);
  });

  it('AI が書く表を読むページは、全部 AI_CONSULTATION_REFETCH_PAGES にある', () => {
    const missing = [...READS.entries()]
      .filter(([key, reads]) => reads.tables.size > 0 && !(key in AI_CONSULTATION_REFETCH_PAGES))
      .map(([key, reads]) => `${key}: ${[...reads.tables.entries()].map(([t, w]) => `${t} ← ${[...w].join(' / ')}`).join('; ')}`);
    expect(missing).toEqual([]);
  });

  it('表の各ページは実在し、読む AI が書く表 (と列) が一致する', () => {
    const problems: string[] = [];
    for (const [key, entry] of Object.entries(AI_CONSULTATION_REFETCH_PAGES)) {
      const reads = READS.get(key);
      if (!reads) {
        problems.push(`${key}: ページが無い`);
        continue;
      }
      const tables = sorted(reads.tables.keys());
      if (JSON.stringify(sorted(entry.aiTables)) !== JSON.stringify(tables)) {
        problems.push(`${key}: 表 ${JSON.stringify(sorted(entry.aiTables))} / 数えた結果 ${JSON.stringify(tables)}`);
      }
      if (entry.kind === 'excluded') {
        if (tables.length === 0) problems.push(`${key}: AI が書く表を読まないので除外の表に要らない`);
        for (const [table, cols] of reads.columns) {
          const declared = entry.aiColumns?.[table as AiConsultationWrittenTable];
          if (!declared || JSON.stringify(sorted(declared)) !== JSON.stringify(sorted(cols))) {
            problems.push(`${key}: ${table} の列 表 ${JSON.stringify(declared ?? null)} / 数えた結果 ${JSON.stringify(sorted(cols))}`);
          }
        }
        if (entry.reason.trim() === '') problems.push(`${key}: 除外の理由が空`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('受け手のページは、取り直しの hook を使う', () => {
    const notWired = Object.entries(AI_CONSULTATION_REFETCH_PAGES)
      .filter(([, entry]) => entry.kind === 'receiver')
      .filter(([key]) => {
        const visited = READS.get(key)?.visited ?? new Set<string>();
        return !RECEIVER_HOOKS.some((hook) => visited.has(`${RECEIVER_HOOK_FILE}#${hook}`));
      })
      .map(([key]) => key);
    expect(notWired).toEqual([]);
  });

  it('除外のページは、取り直しの hook を使わない (表と食い違わない)', () => {
    const wired = Object.entries(AI_CONSULTATION_REFETCH_PAGES)
      .filter(([, entry]) => entry.kind === 'excluded')
      .filter(([key]) => {
        const visited = READS.get(key)?.visited ?? new Set<string>();
        return RECEIVER_HOOKS.some((hook) => visited.has(`${RECEIVER_HOOK_FILE}#${hook}`));
      })
      .map(([key]) => key);
    expect(wired).toEqual([]);
  });

  it('受け手ごとに、開いたとき・パネルの読み取りの取り直しと、空の応答の取り直しを描画で確かめるテストがある', () => {
    // 2 つの判定を呼ぶテストのファイルのうち、受け手のキーを判定に渡すページの表の page: '<キー>' か、判定の引数のリテラルで持つもの
    const checking = testFiles().filter((file) => RENDER_CHECKS.every((check) => new RegExp(`\\b${check}\\(`).test(file.source)));
    const missing = Object.entries(AI_CONSULTATION_REFETCH_PAGES)
      .filter(([, entry]) => entry.kind === 'receiver')
      .filter(([key]) => {
        const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const named = new RegExp(`(page:\\s*'${k}'|(${RENDER_CHECKS.join('|')})\\(\\s*'${k}')`);
        return !checking.some((file) => named.test(file.source));
      })
      .map(([key]) => key);
    expect(checking.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
