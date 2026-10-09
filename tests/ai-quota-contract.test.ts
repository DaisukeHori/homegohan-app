/**
 * #1177 (T26) AI 利用回数の記録 (consumeAiQuota / consumeEdgeAiQuota) のソース走査 contract テスト
 *
 * AI を使う処理が増えたときに、利用回数を数え忘れないための安全網。いまは全プラン無制限で計測だけだが、
 * 上限 (T40) を入れたとき、数えていない経路があるとそこだけ上限をすり抜ける。
 * src/ と supabase/functions/ の全ファイルをソースとして読み (TypeScript の構文木で解析するので、
 * コメントや文字列の中の呼び出しには反応しない)、次を確かめる。
 *
 * 【Next.js の API ルート】
 *   1. AI を呼ぶ route (AI の SDK / 提供元の URL / API キーの環境変数 / Edge Function の呼び出しに、import をたどって届く route) は、
 *      AI_QUOTA_ROUTES (数える) か AI_QUOTA_EXEMPT (数えない。理由つき) のどちらかに載っている。
 *      → 新しい AI の route を足してこのテストが落ちたら、consumeAiQuota を呼んで AI_QUOTA_ROUTES に足す
 *   2. AI_QUOTA_ROUTES の route は consumeAiQuota (@/lib/plan/entitlements) を呼び、結果の allowed を使っている (捨てていない)。
 *      数える機能 (feature) は一覧どおりで、AI_FEATURES にある名前
 *   3. checkRateLimit (analysis / generation / image) を呼ぶ全ての場所 (src/ 全体) で、同じ関数の中のあとに consumeAiQuota がある
 *      → 「checkRateLimit のあとに数える」の順序と、レート制限だけして数えない経路が無いこと
 *   4. consumeAiQuota を呼んでよいのは、AI_QUOTA_ROUTES の route と、決めたライブラリだけ (数える場所が散らばって二重に数えない)
 *   5. Edge Function をユーザーの JWT で呼ぶ処理 (supabase.functions.invoke) は、数え済みの印 (aiQuotaCountedHeaders) を付けている
 *   6. 数えない一覧 (AI_QUOTA_EXEMPT) が古くならない
 * 【Edge Functions】
 *   7. ユーザーの JWT を確かめる Edge Function (requireAuth / auth.getUser) は、確かめたのと同じブロックの中で
 *      consumeEdgeAiQuota を呼ぶ (service role / cron の経路では数えない)。機能は EDGE_USER_JWT_FUNCTIONS のとおり
 * 【定義】
 *   8. 機能名は DB の CHECK (migration) と同じ形式。すべての機能がどこかで使われている
 *
 * 数える場所を変えるときは、このテストの一覧と、src/lib/plan/entitlements.ts の説明を合わせること。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AI_FEATURES } from '../supabase/functions/_shared/ai-quota-core';

const ROOT = path.resolve(__dirname, '..');

type Feature = (typeof AI_FEATURES)[number];

/**
 * consumeAiQuota を呼ぶ route (AI を使う処理) と、数える機能。
 * 値は、その route の consumeAiQuota の呼び出しに現れる機能の集合 (順序は問わない)。
 */
const AI_QUOTA_ROUTES: Record<string, readonly Feature[]> = {
  // 写真の解析
  'src/app/api/ai/analyze-fridge/route.ts': ['photo_analysis'],
  'src/app/api/ai/analyze-health-checkup/route.ts': ['photo_analysis'],
  'src/app/api/ai/analyze-meal-photo/route.ts': ['photo_analysis'],
  'src/app/api/ai/analyze-weight-scale/route.ts': ['photo_analysis'],
  'src/app/api/ai/classify-photo/route.ts': ['photo_analysis'],
  // 画像 URL から AI で栄養を解析するときだけ数える (nutritionData を直接渡す経路は AI を呼ばない)
  'src/app/api/ai/nutrition/route.ts': ['photo_analysis'],
  // AI 相談
  'src/app/api/ai/consultation/actions/[actionId]/execute/route.ts': ['consultation'],
  'src/app/api/ai/consultation/sessions/[sessionId]/close/route.ts': ['consultation'],
  'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts': ['consultation'],
  'src/app/api/ai/consultation/sessions/[sessionId]/summarize/route.ts': ['consultation'],
  // 献立生成 (v5 のキューは、利用者の操作を積む時点で数える。実行する cron は数えない: AI_QUOTA_EXEMPT)
  'src/app/api/ai/menu/day/regenerate/route.ts': ['menu_generation'],
  'src/app/api/ai/menu/meal/generate/route.ts': ['menu_generation'],
  'src/app/api/ai/menu/meal/regenerate/route.ts': ['menu_generation'],
  'src/app/api/ai/menu/v4/generate/route.ts': ['menu_generation'],
  'src/app/api/ai/menu/v5/generate/route.ts': ['menu_generation'],
  'src/app/api/ai/menu/weekly/request/route.ts': ['menu_generation'],
  // 栄養分析: GET はアドバイス・提案を付けるとき (AI を呼ぶとき) だけ、POST は AI が提案した献立変更の実行
  'src/app/api/ai/nutrition-analysis/route.ts': ['nutrition_advice', 'menu_generation'],
  // キャッシュを返すだけの経路では数えない (キャッシュが無く、生成を始めるときだけ数える)
  'src/app/api/ai/nutrition/feedback/route.ts': ['nutrition_advice'],
  // 画像の生成
  'src/app/api/ai/image/generate/route.ts': ['image_generation'],
  // 健康診断・血液検査・健康インサイトの AI レビュー
  'src/app/api/health/blood-tests/route.ts': ['health_review'],
  'src/app/api/health/checkups/route.ts': ['health_review'],
  'src/app/api/health/insights/route.ts': ['health_review'],
  // 買い物リスト (Edge Function regenerate-shopping-list-v2 が LLM で正規化する)
  'src/app/api/shopping-list/regenerate/route.ts': ['shopping_list'],
  // 料理画像の生成 (献立の保存・更新に付く副作用。image のレート制限を通ったあとで数え、超えたら画像だけ見送る)
  'src/app/api/meals/route.ts': ['image_generation'],
  'src/app/api/meals/[id]/route.ts': ['image_generation'],
  'src/app/api/meal-plans/meals/route.ts': ['image_generation'],
  'src/app/api/meal-plans/meals/[id]/route.ts': ['image_generation'],
};

/** route 以外で consumeAiQuota を呼んでよいファイルと理由 */
const NON_ROUTE_CALLERS: Record<string, string> = {
  'src/lib/ai/consultation-action-executor.ts':
    'AI 相談のアクション実行 (update_meal) が付ける料理画像の生成を、image のレート制限のあとで数える。呼び出し元の route は consultation として別に数える (画像生成は別の AI 呼び出しのため)',
};

/** AI の SDK / URL / Edge Function に届くが、利用者の AI 利用としては数えない route と理由 */
const AI_QUOTA_EXEMPT: Record<string, string> = {
  'src/app/api/cron/process-menu-queue/route.ts':
    'Vercel Cron が、キューに積まれた献立生成 (POST /api/ai/menu/v5/generate) を service role で実行する。利用者の操作は、積む時点 (POST /api/ai/menu/v5/generate) で数え済み。ここで数えると二重になる',
  'src/app/api/admin/catalog/import/route.ts':
    '運営 (admin / super_admin) 専用のコンビニ商品カタログの取り込み。Edge Function が Firecrawl / LLM を使うが、利用者の AI 利用ではない',
  'src/app/api/super-admin/embeddings/regenerate/route.ts':
    'super_admin 専用の埋め込み (検索用ベクトル) の再生成バッチ。利用者の AI 利用ではない',
  'src/app/api/meal-plans/add-from-photo/route.ts':
    '写真から献立を作る処理で、画像生成ジョブの取り消し (cancelPendingMealImageJobs) だけを使う。AI を呼ばない (AI の解析は analyze-meal-photo / classify-photo の route が数える)',
};

/** Edge Function の呼び出しのうち、AI を使わないもの (名前が分かるときだけ除外する) */
const NON_AI_EDGE_FUNCTIONS = new Set(['calculate-segment-stats', 'stripe-price-sync']);

/**
 * ユーザーの JWT を確かめる Edge Function (requireAuth / auth.getUser) と、数える機能。
 * ここに無いのに JWT を確かめる Edge Function ができたら、テストが落ちる (数えるか、この一覧に理由つきで足す)。
 */
const EDGE_USER_JWT_FUNCTIONS: Record<string, readonly Feature[]> = {
  'analyze-fridge': ['photo_analysis'],
  'analyze-health-photo': ['photo_analysis'],
  'analyze-meal-photo': ['photo_analysis'],
  'generate-health-insights': ['health_review'],
  'generate-hint': ['nutrition_advice'],
  'generate-menu-v4': ['menu_generation'],
  'generate-menu-v5': ['menu_generation'],
  'knowledge-gpt': ['consultation'],
  'normalize-shopping-list': ['shopping_list'],
  'regenerate-shopping-list-v2': ['shopping_list'],
};

const RATE_LIMIT_AI_CATEGORIES = new Set(['analysis', 'generation', 'image']);
const AI_PACKAGES = ['@google/genai', 'openai', '@anthropic-ai/sdk'];
const AI_HOSTS = [
  'generativelanguage.googleapis.com',
  'api.openai.com',
  'api.x.ai',
  'api.anthropic.com',
  'api.perplexity.ai',
];
const AI_ENV_KEYS = new Set([
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'GOOGLE_AI_STUDIO_API_KEY',
  'GOOGLE_GEN_AI_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'PERPLEXITY_API_KEY',
]);

const ENTITLEMENTS_MODULE = '@/lib/plan/entitlements';

// ─────────────────────────────────────────────
// ソース解析
// ─────────────────────────────────────────────
interface Span {
  start: number;
  end: number;
}

interface ConsumeCall {
  pos: number;
  /** 機能名 (文字列リテラルでなければ null) */
  feature: string | null;
  /** 戻り値を使っているか (await consumeAiQuota(...) だけの文は false) */
  resultUsed: boolean;
  /** 戻り値の allowed を読んでいるか */
  allowedRead: boolean;
  fn: Span | null;
}

interface RateLimitCall {
  pos: number;
  category: string | null;
  fn: Span | null;
}

interface InvokeCall {
  /** 関数名 (文字列リテラルでなければ null) */
  name: string | null;
  optionsText: string;
}

interface FileAnalysis {
  imports: string[];
  /** AI を直接呼ぶ印 (SDK / 提供元の URL / API キーの環境変数 / Edge Function の呼び出し) */
  sinks: string[];
  importsEntitlementsQuota: boolean;
  consumeCalls: ConsumeCall[];
  rateLimitCalls: RateLimitCall[];
  invokeCalls: InvokeCall[];
}

const isFunctionLike = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node);

function enclosingFunction(node: ts.Node, sf: ts.SourceFile): Span | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isFunctionLike(current)) return { start: current.getStart(sf), end: current.getEnd() };
    current = current.parent;
  }
  return null;
}

const within = (inner: number, span: Span | null) => !!span && inner >= span.start && inner < span.end;

function stringValue(node: ts.Node | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

/** `/functions/v1/<name>` の <name>。名前が式 (${...}) のときは null */
function edgeFunctionNameFromUrl(text: string): { found: boolean; name: string | null } {
  const index = text.indexOf('/functions/v1/');
  if (index < 0) return { found: false, name: null };
  const match = text.slice(index + '/functions/v1/'.length).match(/^([a-z0-9-]+)/);
  return { found: true, name: match ? match[1] : null };
}

function analyzeSource(source: string, fileName = 'file.ts'): FileAnalysis {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const analysis: FileAnalysis = {
    imports: [],
    sinks: [],
    importsEntitlementsQuota: false,
    consumeCalls: [],
    rateLimitCalls: [],
    invokeCalls: [],
  };
  // consumeAiQuota を別名で import している場合に備えて、ローカル名を集める
  const consumeLocalNames = new Set<string>(['consumeAiQuota']);

  const addEdgeSink = (name: string | null) => {
    if (name && NON_AI_EDGE_FUNCTIONS.has(name)) return;
    analysis.sinks.push(`edge:${name ?? '?'}`);
  };

  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      analysis.imports.push(specifier);
      if (ts.isImportDeclaration(node) && specifier === ENTITLEMENTS_MODULE) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if ((element.propertyName ?? element.name).text === 'consumeAiQuota') {
              analysis.importsEntitlementsQuota = true;
              consumeLocalNames.add(element.name.text);
            }
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const pos = node.getStart(sf);

      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = stringValue(node.arguments[0]);
        if (specifier) analysis.imports.push(specifier);
      }
      if (ts.isIdentifier(callee) && callee.text === 'require') {
        const specifier = stringValue(node.arguments[0]);
        if (specifier) analysis.imports.push(specifier);
      }

      if (ts.isIdentifier(callee) && consumeLocalNames.has(callee.text)) {
        analysis.consumeCalls.push({
          pos,
          feature: stringValue(node.arguments[1]),
          ...describeResultUse(node, sf),
          fn: enclosingFunction(node, sf),
        });
      }

      if (ts.isIdentifier(callee) && callee.text === 'checkRateLimit') {
        analysis.rateLimitCalls.push({ pos, category: stringValue(node.arguments[1]), fn: enclosingFunction(node, sf) });
      }

      // supabase.functions.invoke('name', { ... })
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'invoke' &&
        ts.isPropertyAccessExpression(callee.expression) &&
        callee.expression.name.text === 'functions'
      ) {
        const name = stringValue(node.arguments[0]);
        addEdgeSink(name);
        if (!(name && NON_AI_EDGE_FUNCTIONS.has(name))) {
          analysis.invokeCalls.push({ name, optionsText: node.arguments[1] ? node.arguments[1].getText(sf) : '' });
        }
      }
    }

    // fetch(`${url}/functions/v1/<name>`) など
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const url = edgeFunctionNameFromUrl(node.text);
      if (url.found) addEdgeSink(url.name);
      for (const host of AI_HOSTS) if (node.text.includes(host)) analysis.sinks.push(`host:${host}`);
    }
    if (ts.isTemplateExpression(node)) {
      const text = node.head.text + node.templateSpans.map((span) => `\${}${span.literal.text}`).join('');
      const url = edgeFunctionNameFromUrl(text);
      if (url.found) addEdgeSink(url.name);
      for (const host of AI_HOSTS) if (text.includes(host)) analysis.sinks.push(`host:${host}`);
    }

    // process.env.OPENAI_API_KEY など
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'env' &&
      AI_ENV_KEYS.has(node.name.text)
    ) {
      analysis.sinks.push(`env:${node.name.text}`);
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const specifier of analysis.imports) {
    if (AI_PACKAGES.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))) analysis.sinks.push(`pkg:${specifier}`);
  }
  return analysis;
}

/** consumeAiQuota(...) の戻り値の使われ方 */
function describeResultUse(call: ts.CallExpression, sf: ts.SourceFile): { resultUsed: boolean; allowedRead: boolean } {
  let node: ts.Node = call;
  while (
    node.parent &&
    (ts.isAwaitExpression(node.parent) || ts.isParenthesizedExpression(node.parent) || ts.isAsExpression(node.parent))
  ) {
    node = node.parent;
  }
  const parent = node.parent;
  if (!parent || ts.isExpressionStatement(parent)) return { resultUsed: false, allowedRead: false };

  // (await consumeAiQuota(...)).allowed
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return { resultUsed: true, allowedRead: parent.name.text === 'allowed' };
  }
  // const quota = await consumeAiQuota(...) -> 同じ関数の中で quota.allowed を読んでいるか
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    const variable = parent.name.text;
    const fn = enclosingFunction(call, sf);
    let read = false;
    const search = (n: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(n) &&
        n.name.text === 'allowed' &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === variable &&
        (!fn || within(n.getStart(sf), fn))
      ) {
        read = true;
      }
      ts.forEachChild(n, search);
    };
    search(sf);
    return { resultUsed: true, allowedRead: read };
  }
  return { resultUsed: true, allowedRead: false };
}

// ─────────────────────────────────────────────
// ファイルの収集と import の解決
// ─────────────────────────────────────────────
function collectSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      collectSourceFiles(full, files);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const toRelative = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');

const analyses = new Map<string, FileAnalysis>();
// @/ の別名は src/ を先に、無ければ ルート直下 (tsconfig の paths と同じ。ルート直下の lib/ もたどる)
for (const dir of ['src', 'lib']) {
  for (const file of collectSourceFiles(path.join(ROOT, dir))) {
    const relative = toRelative(file);
    analyses.set(relative, analyzeSource(fs.readFileSync(file, 'utf-8'), relative));
  }
}

function resolveImport(from: string, specifier: string): string | null {
  const candidatesFor = (base: string) => [
    `${base}.ts`,
    `${base}.tsx`,
    base,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  const bases: string[] = [];
  if (specifier.startsWith('@/')) {
    bases.push(`src/${specifier.slice(2)}`, specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    bases.push(path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)));
  }
  for (const base of bases) {
    for (const candidate of candidatesFor(base)) {
      if (analyses.has(candidate)) return candidate;
    }
  }
  return null;
}

/** そのファイルから import をたどって届く、AI を直接呼ぶファイル (自分自身を含む) */
const reachMemo = new Map<string, string[]>();
function aiSinkFilesReachedFrom(file: string, stack = new Set<string>()): string[] {
  const memo = reachMemo.get(file);
  if (memo) return memo;
  if (stack.has(file)) return [];
  stack.add(file);

  const analysis = analyses.get(file);
  const reached = new Set<string>();
  if (analysis) {
    if (analysis.sinks.length > 0) reached.add(file);
    for (const specifier of analysis.imports) {
      const resolved = resolveImport(file, specifier);
      if (resolved) for (const sink of aiSinkFilesReachedFrom(resolved, stack)) reached.add(sink);
    }
  }
  stack.delete(file);
  const result = [...reached].sort();
  reachMemo.set(file, result);
  return result;
}

const routeFiles = [...analyses.keys()].filter((file) => /^src\/app\/api\/.+\/route\.ts$/.test(file)).sort();
const aiRoutes = routeFiles.filter((file) => aiSinkFilesReachedFrom(file).length > 0);

const AI_FEATURE_SET = new Set<string>(AI_FEATURES);

// ─────────────────────────────────────────────
// 1〜6. Next.js のソースに対する contract
// ─────────────────────────────────────────────
describe('AI 利用回数の記録 (#1177): Next.js の API ルート', () => {
  it('走査が機能している: 既知の AI の route を検出している', () => {
    // 走査が壊れて何も見つけられなくなったときに、下の contract が空振りで通ってしまわないようにする
    expect(routeFiles.length).toBeGreaterThan(100);
    expect(aiRoutes).toEqual(
      expect.arrayContaining([
        'src/app/api/ai/analyze-fridge/route.ts', // Gemini (fetch)
        'src/app/api/ai/analyze-meal-photo/route.ts', // Edge Function (functions.invoke)
        'src/app/api/ai/image/generate/route.ts', // @google/genai
        'src/app/api/ai/menu/day/regenerate/route.ts', // import をたどって generate-menu のリトライ処理へ届く
        'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts', // fast-llm (openai) と knowledge-gpt
        'src/app/api/health/checkups/route.ts', // fast-llm
        'src/app/api/shopping-list/regenerate/route.ts', // Edge Function (fetch)
        'src/app/api/meals/route.ts', // 料理画像の生成ジョブ (import をたどって届く)
        'src/app/api/cron/process-menu-queue/route.ts',
      ]),
    );
    expect(Object.keys(AI_QUOTA_ROUTES).length).toBeGreaterThanOrEqual(25);
  });

  it('AI を呼ぶ route は、利用回数を数える一覧 (AI_QUOTA_ROUTES) か、数えない一覧 (AI_QUOTA_EXEMPT) に載っている', () => {
    const unclassified = aiRoutes.filter((file) => !(file in AI_QUOTA_ROUTES) && !(file in AI_QUOTA_EXEMPT));

    expect(
      unclassified,
      'AI を呼ぶ route は consumeAiQuota (@/lib/plan/entitlements) で利用回数を数え、このテストの AI_QUOTA_ROUTES に足すこと。' +
        '利用者の AI 利用ではない (運営専用・cron など) 場合だけ、理由を書いて AI_QUOTA_EXEMPT に足す: ' +
        unclassified.join(', '),
    ).toEqual([]);
  });

  describe('AI_QUOTA_ROUTES の route は consumeAiQuota を呼び、結果を使っている', () => {
    it.each(Object.entries(AI_QUOTA_ROUTES))('%s', (file, expectedFeatures) => {
      const analysis = analyses.get(file);
      expect(analysis, `${file} が存在しない: 一覧から消すこと`).toBeDefined();
      const a = analysis!;

      expect(a.importsEntitlementsQuota, `${file} は consumeAiQuota を ${ENTITLEMENTS_MODULE} から import すること`).toBe(true);
      expect(a.consumeCalls.length, `${file} が consumeAiQuota を呼んでいない`).toBeGreaterThan(0);

      for (const call of a.consumeCalls) {
        expect(call.resultUsed, `${file}: consumeAiQuota の結果を捨てている (allowed を見て、拒否なら 429 を返すこと)`).toBe(true);
        expect(call.allowedRead, `${file}: consumeAiQuota の結果の allowed を読んでいない`).toBe(true);
        expect(call.feature, `${file}: 機能名は文字列リテラルで渡すこと`).not.toBeNull();
        expect(AI_FEATURE_SET.has(call.feature!), `${file}: 機能名 ${call.feature} は AI_FEATURES に無い`).toBe(true);
      }

      const features = [...new Set(a.consumeCalls.map((c) => c.feature as string))].sort();
      expect(features, `${file} の機能が一覧と違う`).toEqual([...expectedFeatures].sort());
    });
  });

  it('checkRateLimit (analysis / generation / image) を呼ぶ全ての場所で、同じ関数の中のあとに consumeAiQuota がある', () => {
    const violations: string[] = [];
    let checked = 0;
    for (const [file, a] of analyses) {
      if (!file.startsWith('src/')) continue;
      for (const rateLimit of a.rateLimitCalls) {
        if (!rateLimit.category || !RATE_LIMIT_AI_CATEGORIES.has(rateLimit.category)) continue;
        checked += 1;
        const counted = a.consumeCalls.some(
          (call) => call.pos > rateLimit.pos && (rateLimit.fn ? within(call.pos, rateLimit.fn) : true),
        );
        if (!counted) violations.push(`${file} (checkRateLimit '${rateLimit.category}' のあとに consumeAiQuota が無い)`);
      }
    }

    // 走査が壊れて何も見つけられなくなったときに、空振りで通ってしまわないようにする
    expect(checked).toBeGreaterThanOrEqual(20);
    expect(
      violations,
      'AI のレート制限を通る処理は、そのあとで consumeAiQuota を呼ぶこと (数え忘れると、上限をすり抜ける): ' + violations.join(', '),
    ).toEqual([]);
  });

  it('consumeAiQuota を呼んでよいのは AI_QUOTA_ROUTES の route と、決めたライブラリだけ (数える場所が散らばって二重に数えない)', () => {
    const callers = [...analyses]
      .filter(([file, a]) => file !== 'src/lib/plan/entitlements.ts' && a.consumeCalls.length > 0)
      .map(([file]) => file);
    const unexpected = callers.filter((file) => !(file in AI_QUOTA_ROUTES) && !(file in NON_ROUTE_CALLERS));

    expect(unexpected, 'consumeAiQuota は API ルートから呼ぶ。ライブラリから呼ぶ理由があるときは NON_ROUTE_CALLERS に足す: ' + unexpected.join(', ')).toEqual([]);
    for (const file of Object.keys(NON_ROUTE_CALLERS)) {
      expect(callers, `${file} はもう consumeAiQuota を呼んでいない: NON_ROUTE_CALLERS から消すこと`).toContain(file);
    }
  });

  it('Edge Function をユーザーの JWT で呼ぶ処理 (supabase.functions.invoke) は、数え済みの印 (aiQuotaCountedHeaders) を付けている', () => {
    const invokes = [...analyses]
      .filter(([file]) => file.startsWith('src/'))
      .flatMap(([file, a]) => a.invokeCalls.map((call) => ({ file, ...call })));

    // 走査が壊れて何も見つけられなくなったときに、空振りで通ってしまわないようにする
    expect(invokes.map((i) => i.name).filter(Boolean)).toEqual(expect.arrayContaining(['analyze-meal-photo', 'analyze-health-photo']));
    expect(invokes.filter((i) => i.file === 'src/lib/ai/consultation-action-executor.ts').length).toBe(3);

    const missing = invokes.filter((i) => !i.optionsText.includes('aiQuotaCountedHeaders(')).map((i) => `${i.file} (${i.name ?? '動的な名前'})`);
    expect(
      missing,
      'Edge Function をユーザーの JWT で呼ぶときは headers: await aiQuotaCountedHeaders(user.id) を付けること' +
        ' (付けないと、Edge Function 側でも数えて二重になる): ' +
        missing.join(', '),
    ).toEqual([]);
  });

  describe('数えない一覧 (AI_QUOTA_EXEMPT) が古くなっていない', () => {
    it.each(Object.entries(AI_QUOTA_EXEMPT))('%s', (file, reason) => {
      expect(reason.trim().length, '理由を書くこと').toBeGreaterThan(10);
      expect(analyses.has(file), `${file} が存在しない: 一覧から消すこと`).toBe(true);
      expect(aiRoutes, `${file} はもう AI に届かない: 一覧から消すこと`).toContain(file);
      expect(analyses.get(file)!.consumeCalls.length, `${file} は数えるようになった: 一覧から消して AI_QUOTA_ROUTES に足すこと`).toBe(0);
      expect(file in AI_QUOTA_ROUTES, `${file} は両方の一覧に載っている`).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────
// 7. Edge Functions のソースに対する contract
// ─────────────────────────────────────────────
interface EdgeAnalysis {
  /** ユーザーの JWT を確かめる呼び出しの位置と、それを含む最も内側のブロック */
  authCalls: Array<{ pos: number; block: Span | null }>;
  consumeCalls: Array<{
    pos: number;
    firstArgument: string;
    userIdArgument: string;
    feature: string | null;
    allowedRead: boolean;
  }>;
}

function analyzeEdgeSource(source: string, fileName = 'index.ts'): EdgeAnalysis {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const analysis: EdgeAnalysis = { authCalls: [], consumeCalls: [] };

  const nearestBlock = (node: ts.Node): Span | null => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isBlock(current) || ts.isSourceFile(current)) return { start: current.getStart(sf), end: current.getEnd() };
      current = current.parent;
    }
    return null;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const pos = node.getStart(sf);
      // requireAuth(req) / supabase.auth.getUser(...)
      const isRequireAuth = ts.isIdentifier(callee) && callee.text === 'requireAuth';
      const isGetUser =
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'getUser' &&
        ts.isPropertyAccessExpression(callee.expression) &&
        callee.expression.name.text === 'auth';
      if (isRequireAuth || isGetUser) analysis.authCalls.push({ pos, block: nearestBlock(node) });

      if (ts.isIdentifier(callee) && callee.text === 'consumeEdgeAiQuota') {
        const { allowedRead } = describeResultUse(node, sf);
        analysis.consumeCalls.push({
          pos,
          firstArgument: node.arguments[0]?.getText(sf) ?? '',
          userIdArgument: node.arguments[1]?.getText(sf) ?? '',
          feature: stringValue(node.arguments[2]),
          allowedRead,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return analysis;
}

const EDGE_ROOT = 'supabase/functions';
const edgeEntrypoints = fs
  .readdirSync(path.join(ROOT, EDGE_ROOT), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
  .map((entry) => entry.name)
  .filter((name) => fs.existsSync(path.join(ROOT, EDGE_ROOT, name, 'index.ts')))
  .sort();

const edgeAnalyses = new Map<string, EdgeAnalysis>();
for (const name of edgeEntrypoints) {
  edgeAnalyses.set(name, analyzeEdgeSource(fs.readFileSync(path.join(ROOT, EDGE_ROOT, name, 'index.ts'), 'utf-8'), `${name}/index.ts`));
}
const edgeUserJwtFunctions = edgeEntrypoints.filter((name) => edgeAnalyses.get(name)!.authCalls.length > 0);

describe('AI 利用回数の記録 (#1177): Edge Functions', () => {
  it('走査が機能している: ユーザーの JWT を確かめる Edge Function を検出している', () => {
    expect(edgeEntrypoints.length).toBeGreaterThan(15);
    expect(edgeUserJwtFunctions).toEqual(expect.arrayContaining(['analyze-fridge', 'generate-menu-v5', 'knowledge-gpt']));
    // バッチ専用の関数 (service role / cron のシークレットだけで認証) は含まれない
    expect(edgeUserJwtFunctions).not.toContain('regenerate-embeddings');
    expect(edgeUserJwtFunctions).not.toContain('stripe-price-sync');
  });

  it('ユーザーの JWT を確かめる Edge Function は、すべて EDGE_USER_JWT_FUNCTIONS に載っている (数え忘れない)', () => {
    expect(edgeUserJwtFunctions).toEqual(Object.keys(EDGE_USER_JWT_FUNCTIONS).sort());
  });

  describe('JWT を確かめた経路で consumeEdgeAiQuota を呼んでいる', () => {
    it.each(Object.entries(EDGE_USER_JWT_FUNCTIONS))('%s', (name, expectedFeatures) => {
      const a = edgeAnalyses.get(name);
      expect(a, `supabase/functions/${name}/index.ts が無い`).toBeDefined();
      expect(a!.consumeCalls.length, `${name} が consumeEdgeAiQuota を呼んでいない`).toBeGreaterThan(0);

      // 数えるのは、ユーザーの JWT を確かめたのと同じブロックの中だけ。
      // service role / cron の経路 (別の分岐) では数えない (Next.js が数え済み、または利用者の操作ではない)
      for (const auth of a!.authCalls) {
        const call = a!.consumeCalls.find((c) => c.pos > auth.pos && auth.block && c.pos >= auth.block.start && c.pos < auth.block.end);
        expect(call, `${name}: JWT を確かめたブロックの中で、確かめたあとに consumeEdgeAiQuota を呼ぶこと`).toBeDefined();
      }
      for (const call of a!.consumeCalls) {
        expect(call.firstArgument, `${name}: 1 つ目の引数は受け取った req (数え済みの印のヘッダーを読むため)`).toBe('req');
        expect(call.userIdArgument, `${name}: ユーザー ID は JWT から確定した値を渡す (リクエストの本文のユーザー ID は渡さない)`).toMatch(
          /^(userId|user\.id|authResult\.userId|userData\.user\.id)$/,
        );
        expect(call.allowedRead, `${name}: consumeEdgeAiQuota の結果の allowed を読んでいない`).toBe(true);
        expect(call.feature, `${name}: 機能名は文字列リテラルで渡すこと`).not.toBeNull();
        expect(AI_FEATURE_SET.has(call.feature!), `${name}: 機能名 ${call.feature} は AI_FEATURES に無い`).toBe(true);
      }
      const features = [...new Set(a!.consumeCalls.map((c) => c.feature as string))].sort();
      expect(features, `${name} の機能が一覧と違う`).toEqual([...expectedFeatures].sort());
    });
  });

  it('JWT を確かめない (service role / cron 専用の) Edge Function は、consumeEdgeAiQuota を呼ばない', () => {
    const unexpected = edgeEntrypoints
      .filter((name) => !edgeUserJwtFunctions.includes(name))
      .filter((name) => edgeAnalyses.get(name)!.consumeCalls.length > 0);
    expect(unexpected, 'service role の経路では数えない (Next.js が数え済み、または利用者の操作ではない): ' + unexpected.join(', ')).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// 8. 定義
// ─────────────────────────────────────────────
describe('AI 利用回数の記録 (#1177): 機能名の定義', () => {
  // version (ファイル名の先頭の 14 桁) は付け直されることがあるので、名前の後半だけで探す
  const migrationFiles = fs.readdirSync(path.join(ROOT, 'supabase/migrations')).filter((name) => /^\d{14}_ai_quota_foundation\.sql$/.test(name));
  const migration = migrationFiles.length === 1 ? fs.readFileSync(path.join(ROOT, 'supabase/migrations', migrationFiles[0]), 'utf-8') : '';
  /** DB の CHECK / 関数の検証と同じ形式 */
  const DB_FEATURE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

  it('機能名は DB の形式 (migration の CHECK と同じ正規表現) に合っている', () => {
    // migration 側の正規表現が変わったら、ここも合わせる (3 か所: CHECK 1 + 関数の検証 1 + ここ)
    expect(migration.match(/\^\[a-z\]\[a-z0-9_\]\{0,63\}\$/g)?.length, 'migration の正規表現').toBe(2);
    for (const feature of AI_FEATURES) expect(feature, feature).toMatch(DB_FEATURE_PATTERN);
    expect(new Set(AI_FEATURES).size).toBe(AI_FEATURES.length);
  });

  it('すべての機能が、どこか (route か Edge Function) で使われている', () => {
    const used = new Set<string>();
    for (const features of Object.values(AI_QUOTA_ROUTES)) for (const f of features) used.add(f);
    for (const features of Object.values(EDGE_USER_JWT_FUNCTIONS)) for (const f of features) used.add(f);
    expect([...AI_FEATURES].filter((f) => !used.has(f))).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// 走査ロジック自体の確認 (合成ソースで検出できること / 誤検出しないこと)
// ─────────────────────────────────────────────
describe('AI 利用回数の記録 (#1177): ソース解析のロジック', () => {
  it('AI の SDK / 提供元の URL / API キーの環境変数 / Edge Function の呼び出しを AI を呼ぶ印として検出する', () => {
    expect(analyzeSource(`import OpenAI from 'openai';`).sinks).toContain('pkg:openai');
    expect(analyzeSource(`import { GoogleGenAI } from '@google/genai';`).sinks).toContain('pkg:@google/genai');
    expect(analyzeSource('await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`);').sinks).toContain(
      'host:generativelanguage.googleapis.com',
    );
    expect(analyzeSource(`const key = process.env.OPENAI_API_KEY;`).sinks).toContain('env:OPENAI_API_KEY');
    expect(analyzeSource(`await supabase.functions.invoke('analyze-meal-photo', { body: {} });`).sinks).toContain('edge:analyze-meal-photo');
    expect(analyzeSource('await fetch(`${url}/functions/v1/knowledge-gpt`);').sinks).toContain('edge:knowledge-gpt');
    expect(analyzeSource('await fetch(`${url}/functions/v1/${functionName}`);').sinks).toContain('edge:?');
    expect(analyzeSource(`await supabase.functions.invoke(engineLabel, {});`).sinks).toContain('edge:?');
  });

  it('AI を使わない Edge Function (calculate-segment-stats / stripe-price-sync) の呼び出しは、AI を呼ぶ印にしない', () => {
    expect(analyzeSource(`await supabase.functions.invoke('calculate-segment-stats', {});`).sinks).toEqual([]);
    expect(analyzeSource('await fetch(`${url}/functions/v1/stripe-price-sync`);').sinks).toEqual([]);
  });

  it('コメントや文字列ではない記述には反応しない', () => {
    const a = analyzeSource(`
      // await supabase.functions.invoke('analyze-meal-photo')
      /* fetch('https://api.openai.com/v1/chat/completions'); process.env.OPENAI_API_KEY */
      export const note = 'OPENAI_API_KEY を使う';
    `);
    expect(a.sinks).toEqual([]);
  });

  it('consumeAiQuota の呼び出し: 機能名・結果の使われ方・checkRateLimit との前後を取り出す', () => {
    const a = analyzeSource(`
      import { consumeAiQuota, aiQuotaExceededResponse } from '@/lib/plan/entitlements';
      export async function POST() {
        const rl = await checkRateLimit(user.id, 'analysis');
        const quota = await consumeAiQuota(user.id, 'photo_analysis');
        if (!quota.allowed) return aiQuotaExceededResponse(quota);
      }
    `);
    expect(a.importsEntitlementsQuota).toBe(true);
    expect(a.rateLimitCalls).toHaveLength(1);
    expect(a.rateLimitCalls[0].category).toBe('analysis');
    expect(a.consumeCalls).toHaveLength(1);
    expect(a.consumeCalls[0]).toMatchObject({ feature: 'photo_analysis', resultUsed: true, allowedRead: true });
    expect(a.consumeCalls[0].pos).toBeGreaterThan(a.rateLimitCalls[0].pos);
    expect(within(a.consumeCalls[0].pos, a.rateLimitCalls[0].fn)).toBe(true);
  });

  it('結果を捨てる呼び出し (await consumeAiQuota(...) だけの文) と、allowed を読まない呼び出しを検出する', () => {
    const discarded = analyzeSource(`
      import { consumeAiQuota } from '@/lib/plan/entitlements';
      export async function POST() { await consumeAiQuota(user.id, 'photo_analysis'); }
    `);
    expect(discarded.consumeCalls[0]).toMatchObject({ resultUsed: false, allowedRead: false });

    const notRead = analyzeSource(`
      import { consumeAiQuota } from '@/lib/plan/entitlements';
      export async function POST() { const quota = await consumeAiQuota(user.id, 'photo_analysis'); console.log(quota); }
    `);
    expect(notRead.consumeCalls[0]).toMatchObject({ resultUsed: true, allowedRead: false });

    const inline = analyzeSource(`
      import { consumeAiQuota } from '@/lib/plan/entitlements';
      export async function POST() { ok = (await consumeAiQuota(user.id, 'image_generation')).allowed; }
    `);
    expect(inline.consumeCalls[0]).toMatchObject({ feature: 'image_generation', resultUsed: true, allowedRead: true });
  });

  it('別の関数にある consumeAiQuota は、checkRateLimit の「同じ関数の中のあと」とは見なさない', () => {
    const a = analyzeSource(`
      import { consumeAiQuota } from '@/lib/plan/entitlements';
      export async function POST() { await checkRateLimit(user.id, 'generation'); }
      export async function GET() { const q = await consumeAiQuota(user.id, 'consultation'); if (!q.allowed) return null; }
    `);
    const rateLimit = a.rateLimitCalls[0];
    expect(a.consumeCalls.some((c) => c.pos > rateLimit.pos && within(c.pos, rateLimit.fn))).toBe(false);
  });

  it('別名で import した consumeAiQuota の呼び出しも検出する。別のモジュールの同名関数は検出しない', () => {
    const aliased = analyzeSource(`
      import { consumeAiQuota as count } from '@/lib/plan/entitlements';
      export async function POST() { const q = await count(user.id, 'consultation'); if (!q.allowed) return null; }
    `);
    expect(aliased.consumeCalls).toHaveLength(1);

    const other = analyzeSource(`
      import { consumeAiQuota } from '@/lib/somewhere-else';
      export async function POST() { await consumeAiQuota(user.id, 'consultation'); }
    `);
    expect(other.importsEntitlementsQuota).toBe(false);
  });

  it('Edge Function: JWT を確かめる呼び出しと、それを含むブロック、consumeEdgeAiQuota の引数を取り出す', () => {
    const a = analyzeEdgeSource(`
      Deno.serve(async (req) => {
        const authResult = await requireAuth(req);
        const quota = await consumeEdgeAiQuota(req, authResult.userId, 'photo_analysis');
        if (!quota.allowed) return aiQuotaExceededResponse(quota, corsHeaders);
      });
    `);
    expect(a.authCalls).toHaveLength(1);
    expect(a.consumeCalls[0]).toMatchObject({
      firstArgument: 'req',
      userIdArgument: 'authResult.userId',
      feature: 'photo_analysis',
      allowedRead: true,
    });
    const block = a.authCalls[0].block!;
    expect(a.consumeCalls[0].pos >= block.start && a.consumeCalls[0].pos < block.end).toBe(true);
  });

  it('Edge Function: service role の分岐 (別のブロック) で数えると、JWT を確かめたブロックの外になる', () => {
    const a = analyzeEdgeSource(`
      Deno.serve(async (req) => {
        if (isServiceRole) {
          const quota = await consumeEdgeAiQuota(req, body.userId, 'consultation');
        } else {
          const { data: { user } } = await supabase.auth.getUser();
        }
      });
    `);
    const auth = a.authCalls[0];
    const call = a.consumeCalls[0];
    expect(call.pos > auth.pos).toBe(false); // JWT を確かめる前
    expect(auth.block && call.pos >= auth.block.start && call.pos < auth.block.end).toBe(false);
  });
});
