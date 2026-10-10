/**
 * #1177 (T26) AI 利用回数の記録 (consumeAiQuota / consumeEdgeAiQuota) のソース走査 contract テスト
 *
 * AI を使う処理が増えたときに、利用回数を数え忘れないための安全網。いまは全プラン無制限で計測だけだが、
 * 上限 (T40) を入れたとき、数えていない経路があるとそこだけ上限をすり抜ける。
 * src/・lib/・shared/ と supabase/functions/ のソースを読み (TypeScript の構文木で解析するので、
 * コメントや文字列の中の呼び出しには反応しない)、AI 事業者へ送る入口を**全数**列挙して、下の一覧と**完全に一致**することを確かめる。
 * (件数の下限で確かめると、新しい入口の数え忘れを見逃すため。入口が増えても減っても、一覧を直すまで落ちる)
 *
 * 【入口の一覧】
 *   - Next.js の API ルート: AI_QUOTA_ROUTES (数える) / ROUTES_COUNTED_IN_LIBRARY (import したライブラリが数える) /
 *     AI_QUOTA_EXEMPT (数えない。理由つき) / AI_QUEUE_ROUTES (キューに積むだけ。積む時点で数える)
 *   - 数えるライブラリ: NON_ROUTE_CALLERS
 *   - Edge Functions: EDGE_FUNCTIONS (user-jwt = 数える / service-ai = 数えない。呼び出し元つき / no-ai)
 *   - 定期実行: CRON_ENTRYPOINTS (vercel.json の crons と、migration の pg_cron が呼ぶ Edge Function)
 *   - どの route からも届かない AI のファイル: AI_SINK_FILES_NOT_REACHED_BY_ROUTES
 *
 * 【Next.js】
 *   1. 素朴な文字の検出で AI の印があるファイルは、構文木の走査でも見つかる (走査が壊れていないことの突き合わせ)
 *   2. AI に届く route の全数 = 一覧 (数える・ライブラリが数える・数えない)。ページ・サーバーアクションは AI を import しない
 *   3. 数える route は consumeAiQuota を呼び、結果の allowed を使う (捨てない)。機能は一覧どおりで AI_FEATURES にある名前
 *   4. AI のレート制限 (analysis / generation / image) を通る場所の全数 = 数える場所。同じ関数の中のあとで数える
 *   5. consumeAiQuota を呼ぶ場所の全数 = 数える route と決めたライブラリ (数える場所が散らばって二重に数えない)
 *   6. Edge Function をユーザーの JWT で呼ぶ処理の全数は一覧どおりで、どれも数え済みの印 (aiQuotaCountedHeaders) を付ける
 * 【Edge Functions】
 *   7. Edge Function の全数・AI に届く関数の全数・ユーザーの JWT を確かめる関数の全数が、EDGE_FUNCTIONS と一致する
 *   8. ユーザーの JWT を確かめる関数は、JWT を確かめた経路でだけ数える (service role / cron の経路では数えない)。
 *      AI へ送る直前で数えるため、service role の経路と合流する関数は、確かめたブロックで directJwtUserId に代入し、
 *      あとで if (directJwtUserId) の中で数える
 * 【定期実行】
 *   9. 定期実行の入口の全数が CRON_ENTRYPOINTS と一致し、どれも数えない
 * 【定義】
 *  10. 機能名は DB の CHECK (migration) と同じ形式。すべての機能がどこかで使われている
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
  // AI 相談 (アクションの実行は、AI を使うアクションだけをライブラリが数える: ROUTES_COUNTED_IN_LIBRARY)
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

/** route 以外で consumeAiQuota を呼んでよいファイルと、数える機能・理由 */
const NON_ROUTE_CALLERS: Record<string, { features: readonly Feature[]; reason: string }> = {
  'src/lib/ai/consultation-action-executor.ts': {
    features: ['menu_generation', 'image_generation'],
    reason:
      'AI 相談のアクションのうち AI を使うもの (献立の生成 3 種 = menu_generation、update_meal が付ける料理画像 = image_generation) だけを、AI へ送る直前に数える。' +
      'アクションの実行 (execute) と、会話の中での自動実行 (messages) の両方から呼ばれる。AI を使わないアクション (献立の削除・買い物リストの操作など) は数えない',
  },
};

/**
 * 自分では consumeAiQuota を呼ばず、import しているライブラリ (NON_ROUTE_CALLERS) が AI へ送る直前に数える route。
 * (AI を使うかどうかが、route ではなくライブラリの分岐で決まるため)
 */
const ROUTES_COUNTED_IN_LIBRARY: Record<string, { library: string; reason: string }> = {
  'src/app/api/ai/consultation/actions/[actionId]/execute/route.ts': {
    library: 'src/lib/ai/consultation-action-executor.ts',
    reason: 'アクションの種類によって AI を使うかが決まる。AI を使うアクションだけを runConsultationAction が数える',
  },
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

/**
 * Edge Function (supabase/functions/<名前>/index.ts) の全数と、それぞれの扱い。走査の結果と完全に一致すること。
 *  - user-jwt:    ユーザーの JWT で直接呼べる。JWT を確かめた経路で、AI へ送る直前に consumeEdgeAiQuota で数える (features)
 *  - service-ai:  service role / cron のシークレットでだけ呼ばれ、AI を使う。ここでは数えない (呼び出し元が数え済み、または利用者の操作ではない)。callers に呼び出し元を書く
 *  - no-ai:       AI を使わない
 */
type EdgeFunctionEntry =
  | { kind: 'user-jwt'; features: readonly Feature[] }
  | { kind: 'service-ai'; callers: string }
  | { kind: 'no-ai'; note: string };

const EDGE_FUNCTIONS: Record<string, EdgeFunctionEntry> = {
  'aggregate-org-stats': { kind: 'no-ai', note: '組織統計の集計 (#1325 で停止中。410 を返すだけ)' },
  'analyze-fridge': { kind: 'user-jwt', features: ['photo_analysis'] },
  'analyze-health-photo': { kind: 'user-jwt', features: ['photo_analysis'] },
  'analyze-meal-photo': { kind: 'user-jwt', features: ['photo_analysis'] },
  'backfill-ingredient-embeddings': {
    kind: 'service-ai',
    callers: '運営が service role key で手動で走らせる、食材の埋め込みの埋め戻しバッチ。アプリの画面・API・cron からは呼ばない (利用者の操作ではない)',
  },
  'calculate-segment-stats': { kind: 'no-ai', note: 'セグメント統計の集計 (pg_cron と POST /api/comparison/trigger が service role で呼ぶ)' },
  'create-derived-recipe': {
    kind: 'service-ai',
    callers: '運営が service role key で手動で呼ぶ、派生レシピの作成。アプリの画面・API・cron からは呼ばない (利用者の操作ではない)',
  },
  'generate-health-insights': { kind: 'user-jwt', features: ['health_review'] },
  'generate-hint': { kind: 'user-jwt', features: ['nutrition_advice'] },
  'generate-menu-v4': { kind: 'user-jwt', features: ['menu_generation'] },
  'generate-menu-v5': { kind: 'user-jwt', features: ['menu_generation'] },
  'import-convenience-catalog': {
    kind: 'service-ai',
    callers: '運営専用のコンビニ商品カタログの取り込み (POST /api/admin/catalog/import が service role で呼ぶ。AI_QUOTA_EXEMPT)',
  },
  'import-familymart-catalog': { kind: 'service-ai', callers: '同上 (POST /api/admin/catalog/import)' },
  'import-lawson-catalog': { kind: 'service-ai', callers: '同上 (POST /api/admin/catalog/import)' },
  'import-ministop-catalog': { kind: 'service-ai', callers: '同上 (POST /api/admin/catalog/import)' },
  'import-natural-lawson-catalog': { kind: 'service-ai', callers: '同上 (POST /api/admin/catalog/import)' },
  'import-seven-eleven-catalog': { kind: 'service-ai', callers: '同上 (POST /api/admin/catalog/import)' },
  'knowledge-gpt': { kind: 'user-jwt', features: ['consultation'] },
  'normalize-shopping-list': { kind: 'user-jwt', features: ['shopping_list'] },
  'process-meal-image-jobs': {
    kind: 'service-ai',
    callers:
      '料理画像の生成ジョブの実行。献立の保存・更新の route (image_generation として数え済み) と、献立生成 (menu_generation の一部) が積んだジョブを、service role で処理する',
  },
  'regenerate-embeddings': {
    kind: 'service-ai',
    callers: 'super_admin 専用の埋め込みの再生成 (POST /api/super-admin/embeddings/regenerate。AI_QUOTA_EXEMPT) と cron のシークレット',
  },
  'regenerate-shopping-list-v2': { kind: 'user-jwt', features: ['shopping_list'] },
  'stripe-price-sync': { kind: 'no-ai', note: 'Stripe の価格の同期 (service role)' },
};

/** Edge Function の呼び出しのうち、AI を使わないもの (名前が分かるときだけ除外する) */
const NON_AI_EDGE_FUNCTIONS = new Set(Object.entries(EDGE_FUNCTIONS).filter(([, e]) => e.kind === 'no-ai').map(([name]) => name));

/** ユーザーの JWT を確かめる Edge Function と、数える機能 (EDGE_FUNCTIONS の user-jwt) */
const EDGE_USER_JWT_FUNCTIONS: Record<string, readonly Feature[]> = Object.fromEntries(
  Object.entries(EDGE_FUNCTIONS).flatMap(([name, e]) => (e.kind === 'user-jwt' ? [[name, e.features] as const] : [])),
);

/**
 * 定期実行 (Vercel Cron の vercel.json / pg_cron の migration) が呼ぶ入口の全数。走査の結果と完全に一致すること。
 * どれも service role / cron のシークレットで呼ぶので、AI を使うものは数えない (利用者の操作は、積んだ時点で数え済み)。
 */
const CRON_ENTRYPOINTS: Record<string, string> = {
  'vercel:/api/cron/process-menu-queue': 'キューに積まれた献立生成を実行する (積む時点の POST /api/ai/menu/v5/generate で数え済み。route は AI_QUOTA_EXEMPT)',
  'pg_cron:calculate-segment-stats': 'セグメント統計の集計 (AI を使わない)',
  // DB の関数が、名前を引数で受け取って Edge Function を呼ぶもの (pg_cron のジョブ・運営の手動実行から呼ばれ得る)
  'pg_net:invoke_catalog_import':
    'コンビニ商品カタログの取り込み (import-*-catalog の 5 つに限る。どれも service-ai)。cron のシークレットで呼ぶ運営の処理で、利用者の AI 利用ではない',
};

/** pg_net の入口 (DB の関数) が呼び得る Edge Function。どれも user-jwt ではないこと */
const PG_NET_CALLEES: Record<string, readonly string[]> = {
  'pg_net:invoke_catalog_import': [
    'import-seven-eleven-catalog',
    'import-familymart-catalog',
    'import-lawson-catalog',
    'import-natural-lawson-catalog',
    'import-ministop-catalog',
  ],
};

const RATE_LIMIT_AI_CATEGORIES = new Set(['analysis', 'generation', 'image']);
const AI_PACKAGES = ['@google/genai', 'openai', '@openai/agents', '@anthropic-ai/sdk'];
const AI_HOSTS = [
  'generativelanguage.googleapis.com',
  'api.openai.com',
  'api.x.ai',
  'api.anthropic.com',
  'api.perplexity.ai',
  // 埋め込み (検索用ベクトル) の提供元 (shared/dataset-embedding.mjs)
  'api.aimlapi.com',
];
const AI_ENV_KEYS = new Set([
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'GOOGLE_AI_STUDIO_API_KEY',
  'GOOGLE_GEN_AI_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'PERPLEXITY_API_KEY',
  'AIMLAPI_API_KEY',
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

/** 文字列リテラルで初期化した const の名前と値 (同じ名前が別の値で 2 回以上あるものは、どちらか分からないので除く) */
function collectStringConsts(sf: ts.SourceFile): Map<string, string> {
  const consts = new Map<string, string>();
  const ambiguous = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.Const) !== 0
    ) {
      for (const declaration of node.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const value = stringValue(declaration.initializer);
        if (value === null) continue;
        const name = declaration.name.text;
        if (consts.has(name) && consts.get(name) !== value) ambiguous.add(name);
        consts.set(name, value);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const name of ambiguous) consts.delete(name);
  return consts;
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
  // 文字列リテラルで初期化した const (例: const EDGE_FUNCTION_NAME = 'calculate-segment-stats')。
  // Edge Function の名前を定数で書いた呼び出し・URL を、名前まで読み取るため
  const stringConsts = collectStringConsts(sf);
  const resolveString = (node: ts.Node | undefined): string | null =>
    stringValue(node) ?? (node && ts.isIdentifier(node) ? stringConsts.get(node.text) ?? null : null);

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
        const name = resolveString(node.arguments[0]);
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
      const text =
        node.head.text +
        node.templateSpans.map((span) => `${resolveString(span.expression) ?? '${}'}${span.literal.text}`).join('');
      const url = edgeFunctionNameFromUrl(text);
      if (url.found) addEdgeSink(url.name);
      for (const host of AI_HOSTS) if (text.includes(host)) analysis.sinks.push(`host:${host}`);
    }

    // Deno.env.get('OPENAI_API_KEY') など (Edge Functions)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'get' &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'env'
    ) {
      const key = resolveString(node.arguments[0]);
      if (key && AI_ENV_KEYS.has(key)) analysis.sinks.push(`env:${key}`);
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
    // Edge Functions の npm: / esm.sh の指定 (例: npm:openai@6.9.1) も、パッケージ名で比べる
    const bare = specifier.replace(/^npm:/, '').replace(/^https:\/\/esm\.sh\//, '');
    const name = bare.startsWith('@') ? bare.split('/').slice(0, 2).join('/') : bare.split('/')[0];
    const pkgName = name.replace(/(.)@[^/]*$/, '$1');
    const subpath = bare.slice(name.length);
    if (AI_PACKAGES.some((pkg) => pkgName === pkg || `${pkgName}${subpath}`.startsWith(`${pkg}/`))) analysis.sinks.push(`pkg:${specifier}`);
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
    } else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx|mjs)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const toRelative = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');

const analyses = new Map<string, FileAnalysis>();
// @/ の別名は src/ を先に、無ければ ルート直下 (tsconfig の paths と同じ。ルート直下の lib/ もたどる)。
// ルート直下の shared/ (Next.js と Edge Functions が共用する .mjs) も読む
for (const dir of ['src', 'lib', 'shared']) {
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
/**
 * 利用者の操作を積むだけで、AI へ送るのは別の入口 (cron) の route。積む時点で数える (送る側は AI_QUOTA_EXEMPT で数えない)。
 * これらは route 自身は AI に届かないので、走査では AI の route として見つからない。
 */
const AI_QUEUE_ROUTES: Record<string, { sender: string; reason: string }> = {
  'src/app/api/ai/menu/v5/generate/route.ts': {
    sender: 'src/app/api/cron/process-menu-queue/route.ts',
    reason: '献立生成をキュー (weekly_menu_requests の queued) に積むだけ。AI へ送るのは Vercel Cron の process-menu-queue (service role)',
  },
};

/**
 * AI を直接呼ぶ印 (SDK / 提供元の URL / API キーの環境変数) があるが、どの API ルートからも届かないファイルと理由。
 * (ここに無いのに、どの route からも届かない AI のファイルができたら、数えていない入口 (ページ・サーバーアクションなど) の疑い)
 */
const AI_SINK_FILES_NOT_REACHED_BY_ROUTES: Record<string, string> = {
  'src/lib/env.ts': '環境変数の一覧の説明文に、既定の接続先 (https://api.x.ai/v1) を文字として書いているだけ。AI を呼ばない',
  'shared/dataset-embedding.mjs':
    '埋め込み (検索用ベクトル) の取得。Edge Functions (knowledge-gpt / generate-menu-v4 / v5 / regenerate-embeddings など) だけが使う。Next.js からは使わない',
};

/**
 * Edge Function をユーザーの JWT で呼ぶ処理 (supabase.functions.invoke) の全数。ファイル -> 呼ぶ関数の名前 (式で決まるときは '?')。
 * どれも数え済みの印 (aiQuotaCountedHeaders) を付ける。
 */
const USER_JWT_INVOKES: Record<string, readonly string[]> = {
  'src/app/api/ai/analyze-meal-photo/route.ts': ['analyze-meal-photo'],
  'src/app/api/ai/analyze-weight-scale/route.ts': ['analyze-health-photo'],
  // AI 相談のアクション (献立の生成 3 種)。名前は機能フラグで generate-menu-v4 / v5 を切り替える (engineLabel)
  'src/lib/ai/consultation-action-executor.ts': ['?', '?', '?'],
};

const sortedUnique = (values: Iterable<string>) => [...new Set(values)].sort();

/** コメントを除いた本文に、AI の印が文字として現れるか (構文木の走査とは別の、素朴な検出。走査が壊れていないかの突き合わせに使う) */
function hasRawAiMarker(source: string): boolean {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return (
    AI_HOSTS.some((host) => stripped.includes(host)) ||
    [...AI_ENV_KEYS].some((key) => new RegExp(`process\\.env\\.${key}\\b`).test(stripped)) ||
    AI_PACKAGES.some((pkg) => new RegExp(`from\\s+['"]${escape(pkg)}(['"]|/)`).test(stripped))
  );
}

describe('AI 利用回数の記録 (#1177): Next.js の API ルート', () => {
  it('走査が機能している: 素朴な文字の検出で AI の印があるファイルは、構文木の走査でも AI を呼ぶファイルとして見つかる', () => {
    const rawMarked = [...analyses.keys()].filter((file) =>
      hasRawAiMarker(fs.readFileSync(path.join(ROOT, file), 'utf-8')),
    );
    // 素朴な検出が何も見つけられなくなったら、この突き合わせ自体が空振りする
    expect(rawMarked.length, '素朴な検出が AI の印を 1 つも見つけていない (検出が壊れている)').toBeGreaterThan(0);
    const missedByAst = rawMarked.filter((file) => analyses.get(file)!.sinks.length === 0);
    expect(missedByAst, '構文木の走査が、AI の印のあるファイルを見落としている: ' + missedByAst.join(', ')).toEqual([]);
  });

  it('AI に届く route の全数 = 数える (AI_QUOTA_ROUTES) + ライブラリが数える (ROUTES_COUNTED_IN_LIBRARY) + 数えない (AI_QUOTA_EXEMPT)。キューに積むだけの route (AI_QUEUE_ROUTES) は除く', () => {
    const classified = sortedUnique([
      ...Object.keys(AI_QUOTA_ROUTES).filter((file) => !(file in AI_QUEUE_ROUTES)),
      ...Object.keys(ROUTES_COUNTED_IN_LIBRARY),
      ...Object.keys(AI_QUOTA_EXEMPT),
    ]);
    const unclassified = aiRoutes.filter((file) => !classified.includes(file));
    const stale = classified.filter((file) => !aiRoutes.includes(file));

    expect(
      unclassified,
      'AI を呼ぶ route は consumeAiQuota (@/lib/plan/entitlements) で利用回数を数え、このテストの AI_QUOTA_ROUTES に足すこと。' +
        '利用者の AI 利用ではない (運営専用・cron など) 場合だけ、理由を書いて AI_QUOTA_EXEMPT に足す: ' +
        unclassified.join(', '),
    ).toEqual([]);
    expect(stale, '一覧にあるのに AI に届かない route (一覧から消すか、AI_QUEUE_ROUTES に移すこと): ' + stale.join(', ')).toEqual([]);
    expect(aiRoutes).toEqual(classified);
  });

  it('キューに積むだけの route (AI_QUEUE_ROUTES) は、数える一覧に載っていて自分では AI に届かず、送る側の route は AI に届き数えない一覧に載っている', () => {
    for (const [file, { sender, reason }] of Object.entries(AI_QUEUE_ROUTES)) {
      expect(reason.trim().length, `${file}: 理由を書くこと`).toBeGreaterThan(10);
      expect(file in AI_QUOTA_ROUTES, `${file} は AI_QUOTA_ROUTES (積む時点で数える) に載せること`).toBe(true);
      expect(aiRoutes, `${file} が AI に届くようになった: AI_QUEUE_ROUTES から消すこと`).not.toContain(file);
      expect(aiRoutes, `${sender} (送る側) が AI に届かない`).toContain(sender);
      expect(sender in AI_QUOTA_EXEMPT, `${sender} (送る側) は AI_QUOTA_EXEMPT (二重に数えない) に載せること`).toBe(true);
    }
  });

  it('AI を直接呼ぶファイルは、どれかの API ルートから届くか、届かない理由が一覧 (AI_SINK_FILES_NOT_REACHED_BY_ROUTES) にある', () => {
    const reached = new Set<string>();
    for (const route of routeFiles) for (const sink of aiSinkFilesReachedFrom(route)) reached.add(sink);
    const sinkFiles = [...analyses].filter(([, a]) => a.sinks.length > 0).map(([file]) => file);
    const notReached = sortedUnique(sinkFiles.filter((file) => !reached.has(file)));
    expect(
      notReached,
      'AI を呼ぶのに、どの API ルートからも届かないファイルがある (ページ・サーバーアクションなどから AI を呼ぶと、利用回数を数えられない)。' +
        'API ルートから呼ぶか、AI を呼ばない理由を AI_SINK_FILES_NOT_REACHED_BY_ROUTES に書くこと',
    ).toEqual(Object.keys(AI_SINK_FILES_NOT_REACHED_BY_ROUTES).sort());
  });

  it('API ルート以外 (ページ・レイアウト・サーバーアクション・middleware) は、AI を呼ぶファイルを import しない', () => {
    const nonRouteEntrypoints = [...analyses.keys()].filter(
      (file) => (file.startsWith('src/app/') && !/\/route\.ts$/.test(file)) || /^src\/middleware\.tsx?$/.test(file),
    );
    const offenders = nonRouteEntrypoints.filter((file) => aiSinkFilesReachedFrom(file).length > 0);
    expect(offenders, 'AI は API ルートから呼び、そこで利用回数を数えること: ' + offenders.join(', ')).toEqual([]);
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

      const features = sortedUnique(a.consumeCalls.map((c) => c.feature as string));
      expect(features, `${file} の機能が一覧と違う`).toEqual([...expectedFeatures].sort());
    });
  });

  describe('ライブラリが数える route (ROUTES_COUNTED_IN_LIBRARY) は、自分では数えず、数えるライブラリを import している', () => {
    it.each(Object.entries(ROUTES_COUNTED_IN_LIBRARY))('%s', (file, { library, reason }) => {
      expect(reason.trim().length, '理由を書くこと').toBeGreaterThan(10);
      expect(analyses.get(file)?.consumeCalls.length, `${file} は自分で数えている: AI_QUOTA_ROUTES に移すこと`).toBe(0);
      expect(library in NON_ROUTE_CALLERS, `${library} は NON_ROUTE_CALLERS (数えるライブラリ) に載せること`).toBe(true);
      const imported = analyses.get(file)!.imports.map((specifier) => resolveImport(file, specifier));
      expect(imported, `${file} は ${library} を import すること`).toContain(library);
    });
  });

  it('AI のレート制限 (analysis / generation / image) を通る場所の全数 = 数える場所 (route とライブラリ) と、ライブラリが数える route', () => {
    const rateLimited = sortedUnique(
      [...analyses]
        .filter(([file]) => file.startsWith('src/'))
        .filter(([, a]) => a.rateLimitCalls.some((call) => call.category && RATE_LIMIT_AI_CATEGORIES.has(call.category)))
        .map(([file]) => file),
    );
    expect(rateLimited).toEqual(
      sortedUnique([...Object.keys(AI_QUOTA_ROUTES), ...Object.keys(NON_ROUTE_CALLERS), ...Object.keys(ROUTES_COUNTED_IN_LIBRARY)]),
    );
  });

  it('checkRateLimit (analysis / generation / image) を呼ぶ場所では、同じ関数の中のあとに consumeAiQuota がある (ライブラリが数える route を除く)', () => {
    const violations: string[] = [];
    for (const [file, a] of analyses) {
      if (!file.startsWith('src/') || file in ROUTES_COUNTED_IN_LIBRARY) continue;
      for (const rateLimit of a.rateLimitCalls) {
        if (!rateLimit.category || !RATE_LIMIT_AI_CATEGORIES.has(rateLimit.category)) continue;
        const counted = a.consumeCalls.some(
          (call) => call.pos > rateLimit.pos && (rateLimit.fn ? within(call.pos, rateLimit.fn) : true),
        );
        if (!counted) violations.push(`${file} (checkRateLimit '${rateLimit.category}' のあとに consumeAiQuota が無い)`);
      }
    }
    expect(
      violations,
      'AI のレート制限を通る処理は、そのあとで consumeAiQuota を呼ぶこと (数え忘れると、上限をすり抜ける): ' + violations.join(', '),
    ).toEqual([]);
  });

  it('consumeAiQuota を呼ぶ場所の全数 = AI_QUOTA_ROUTES の route と、決めたライブラリ (数える場所が散らばって二重に数えない)', () => {
    const callers = sortedUnique(
      [...analyses]
        .filter(([file, a]) => file !== 'src/lib/plan/entitlements.ts' && a.consumeCalls.length > 0)
        .map(([file]) => file),
    );
    expect(callers).toEqual(sortedUnique([...Object.keys(AI_QUOTA_ROUTES), ...Object.keys(NON_ROUTE_CALLERS)]));
  });

  describe('数えるライブラリ (NON_ROUTE_CALLERS) は、決めた機能だけを数え、結果を使っている', () => {
    it.each(Object.entries(NON_ROUTE_CALLERS))('%s', (file, { features, reason }) => {
      expect(reason.trim().length, '理由を書くこと').toBeGreaterThan(10);
      const a = analyses.get(file)!;
      for (const call of a.consumeCalls) {
        expect(call.resultUsed && call.allowedRead, `${file}: consumeAiQuota の結果の allowed を読むこと`).toBe(true);
      }
      expect(sortedUnique(a.consumeCalls.map((c) => String(c.feature)))).toEqual([...features].sort());
    });
  });

  it('Edge Function をユーザーの JWT で呼ぶ処理 (supabase.functions.invoke) の全数は一覧どおりで、どれも数え済みの印 (aiQuotaCountedHeaders) を付けている', () => {
    const invokes = [...analyses]
      .filter(([file]) => file.startsWith('src/') || file.startsWith('lib/'))
      .flatMap(([file, a]) => a.invokeCalls.map((call) => ({ file, ...call })));

    const actual: Record<string, string[]> = {};
    for (const invoke of invokes) (actual[invoke.file] ??= []).push(invoke.name ?? '?');
    for (const names of Object.values(actual)) names.sort();
    const expected = Object.fromEntries(Object.entries(USER_JWT_INVOKES).map(([file, names]) => [file, [...names].sort()]));
    expect(actual).toEqual(expected);

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
    /** if (directJwtUserId) { ... } の中にあるか */
    guardedByDirectJwt: boolean;
  }>;
  /** directJwtUserId = ... の代入の位置 (宣言の初期値 null は含めない) */
  directJwtAssignments: number[];
}

/** JWT で直接呼ばれたときだけ数えるための変数名 (JWT を確かめたブロックの中でだけ代入し、AI へ送る直前に if で数える) */
const DIRECT_JWT_USER_ID = 'directJwtUserId';

function analyzeEdgeSource(source: string, fileName = 'index.ts'): EdgeAnalysis {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const analysis: EdgeAnalysis = { authCalls: [], consumeCalls: [], directJwtAssignments: [] };

  const nearestBlock = (node: ts.Node): Span | null => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isBlock(current) || ts.isSourceFile(current)) return { start: current.getStart(sf), end: current.getEnd() };
      current = current.parent;
    }
    return null;
  };

  const isGuardedByDirectJwt = (node: ts.Node): boolean => {
    let child: ts.Node = node;
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (
        ts.isIfStatement(current) &&
        current.thenStatement === child &&
        ts.isIdentifier(current.expression) &&
        current.expression.text === DIRECT_JWT_USER_ID
      ) {
        return true;
      }
      child = current;
      current = current.parent;
    }
    return false;
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
          guardedByDirectJwt: isGuardedByDirectJwt(node),
        });
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === DIRECT_JWT_USER_ID
    ) {
      analysis.directJwtAssignments.push(node.getStart(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return analysis;
}

const EDGE_ROOT = 'supabase/functions';
const edgeEntrypoints = fs
  .readdirSync(path.join(ROOT, EDGE_ROOT), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && entry.name !== 'node_modules')
  .map((entry) => entry.name)
  .filter((name) => fs.existsSync(path.join(ROOT, EDGE_ROOT, name, 'index.ts')))
  .sort();

const edgeAnalyses = new Map<string, EdgeAnalysis>();
for (const name of edgeEntrypoints) {
  edgeAnalyses.set(name, analyzeEdgeSource(fs.readFileSync(path.join(ROOT, EDGE_ROOT, name, 'index.ts'), 'utf-8'), `${name}/index.ts`));
}
const edgeUserJwtFunctions = edgeEntrypoints.filter((name) => edgeAnalyses.get(name)!.authCalls.length > 0);

/** Edge Function のファイル (supabase/functions と shared/) の解析。import は相対パス (拡張子つき) だけをたどる */
const edgeFileAnalyses = new Map<string, FileAnalysis>();
function edgeFileAnalysis(file: string): FileAnalysis | null {
  if (edgeFileAnalyses.has(file)) return edgeFileAnalyses.get(file)!;
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  const analysis = analyzeSource(fs.readFileSync(full, 'utf-8'), file);
  edgeFileAnalyses.set(file, analysis);
  return analysis;
}

/** Edge Function の index.ts から import をたどって、AI を直接呼ぶ印 (SDK / 提供元の URL / API キーの環境変数) に届くか */
function edgeReachesAi(entry: string): boolean {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const analysis = edgeFileAnalysis(file);
    if (!analysis) continue;
    // Edge Function から別の Edge Function を呼ぶ印 (続きの工程の自分自身など) は、AI の印に数えない
    if (analysis.sinks.some((sink) => !sink.startsWith('edge:'))) return true;
    for (const specifier of analysis.imports) {
      if (!specifier.startsWith('.')) continue;
      stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
    }
  }
  return false;
}

const edgeAiFunctions = edgeEntrypoints.filter((name) => edgeReachesAi(`${EDGE_ROOT}/${name}/index.ts`));

/** 定期実行の入口の走査 (vercel.json の crons と、migration の pg_cron が呼ぶ Edge Function) */
function scanCronEntrypoints(): string[] {
  const entries = new Set<string>();
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf-8')) as { crons?: Array<{ path: string }> };
  for (const cron of vercel.crons ?? []) entries.add(`vercel:${cron.path}`);
  const migrationsDir = path.join(ROOT, 'supabase/migrations');
  for (const name of fs.readdirSync(migrationsDir)) {
    if (!name.endsWith('.sql') || name.endsWith('.down.sql')) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf-8').replace(/--.*$/gm, '');
    for (const match of sql.matchAll(/functions\/v1\/([a-z0-9-]+)/g)) entries.add(`pg_cron:${match[1]}`);
    // 名前を文字列の連結で決める呼び出し ('.../functions/v1/' || p_function_name) は、名前が読めないので、
    // それを含む DB の関数の名前で一覧と突き合わせる (呼ばれ得る Edge Function は、CRON_ENTRYPOINTS の説明に書く)
    for (const match of sql.matchAll(/functions\/v1\/'\s*\|\|/g)) {
      const before = sql.slice(0, match.index);
      const fnNames = [...before.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?public"?\."?([a-z0-9_]+)"?/gi)];
      entries.add(`pg_net:${fnNames.length > 0 ? fnNames[fnNames.length - 1][1] : '?'}`);
    }
  }
  return [...entries].sort();
}

describe('AI 利用回数の記録 (#1177): Edge Functions', () => {
  it('Edge Function の全数は EDGE_FUNCTIONS の一覧どおり (新しい関数は、数えるか・数えない理由を決めて足す)', () => {
    expect(edgeEntrypoints).toEqual(Object.keys(EDGE_FUNCTIONS).sort());
  });

  it('AI に届く Edge Function の全数 = 一覧の user-jwt と service-ai (no-ai の関数は AI に届かない)', () => {
    const expected = Object.entries(EDGE_FUNCTIONS)
      .filter(([, e]) => e.kind !== 'no-ai')
      .map(([name]) => name)
      .sort();
    expect(edgeAiFunctions).toEqual(expected);
  });

  it('ユーザーの JWT を確かめる Edge Function の全数 = 一覧の user-jwt (数え忘れない。service-ai / no-ai は JWT を確かめない)', () => {
    expect(edgeUserJwtFunctions).toEqual(Object.keys(EDGE_USER_JWT_FUNCTIONS).sort());
  });

  it('service-ai の関数は、呼び出し元 (誰が数えるか・なぜ数えないか) を書いている', () => {
    for (const [name, entry] of Object.entries(EDGE_FUNCTIONS)) {
      if (entry.kind === 'service-ai') expect(entry.callers.trim().length, name).toBeGreaterThan(10);
      if (entry.kind === 'no-ai') expect(entry.note.trim().length, name).toBeGreaterThan(5);
    }
  });

  describe('JWT を確かめた経路で、AI へ送る直前に consumeEdgeAiQuota を呼んでいる', () => {
    it.each(Object.entries(EDGE_USER_JWT_FUNCTIONS))('%s', (name, expectedFeatures) => {
      const a = edgeAnalyses.get(name);
      expect(a, `supabase/functions/${name}/index.ts が無い`).toBeDefined();
      expect(a!.consumeCalls.length, `${name} が consumeEdgeAiQuota を呼んでいない`).toBeGreaterThan(0);

      const inBlock = (pos: number, block: Span | null) => !!block && pos >= block.start && pos < block.end;

      // 数えるのは、ユーザーの JWT を確かめた経路だけ。次のどちらか:
      //  (a) 確かめたのと同じブロックの中で、確かめたあとに数える
      //  (b) 確かめたブロックの中で directJwtUserId に代入し、あとで if (directJwtUserId) { ... } の中で数える
      //      (service role の経路と合流したあと、AI へ送る直前で数えるため)
      // service role / cron の経路 (別の分岐) では数えない (Next.js が数え済み、または利用者の操作ではない)
      for (const auth of a!.authCalls) {
        const direct = a!.consumeCalls.find((c) => c.pos > auth.pos && inBlock(c.pos, auth.block));
        const assignment = a!.directJwtAssignments.find((p) => p > auth.pos && inBlock(p, auth.block));
        const deferred =
          assignment !== undefined &&
          a!.consumeCalls.some((c) => c.pos > assignment && c.guardedByDirectJwt && c.userIdArgument === DIRECT_JWT_USER_ID);
        expect(
          direct !== undefined || deferred,
          `${name}: JWT を確かめたブロックの中で数えるか、そこで ${DIRECT_JWT_USER_ID} に代入してから if (${DIRECT_JWT_USER_ID}) の中で数えること`,
        ).toBe(true);
      }
      // directJwtUserId に代入してよいのは、JWT を確かめたブロックの中 (確かめたあと) だけ
      for (const assignment of a!.directJwtAssignments) {
        expect(
          a!.authCalls.some((auth) => assignment > auth.pos && inBlock(assignment, auth.block)),
          `${name}: ${DIRECT_JWT_USER_ID} への代入が、JWT を確かめたブロックの外にある (service role の経路で数えてしまう)`,
        ).toBe(true);
      }
      for (const call of a!.consumeCalls) {
        expect(call.firstArgument, `${name}: 1 つ目の引数は受け取った req (数え済みの印のヘッダーを読むため)`).toBe('req');
        expect(call.userIdArgument, `${name}: ユーザー ID は JWT から確定した値を渡す (リクエストの本文のユーザー ID は渡さない)`).toMatch(
          /^(userId|user\.id|authResult\.userId|userData\.user\.id|directJwtUserId)$/,
        );
        if (call.userIdArgument === DIRECT_JWT_USER_ID) {
          expect(call.guardedByDirectJwt, `${name}: ${DIRECT_JWT_USER_ID} で数えるときは if (${DIRECT_JWT_USER_ID}) の中で呼ぶこと`).toBe(true);
        }
        expect(call.allowedRead, `${name}: consumeEdgeAiQuota の結果の allowed を読んでいない`).toBe(true);
        expect(call.feature, `${name}: 機能名は文字列リテラルで渡すこと`).not.toBeNull();
        expect(AI_FEATURE_SET.has(call.feature!), `${name}: 機能名 ${call.feature} は AI_FEATURES に無い`).toBe(true);
      }
      const features = sortedUnique(a!.consumeCalls.map((c) => c.feature as string));
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

/** DB の関数 (migration の CREATE FUNCTION) の本文のうち、呼び先の許可リスト (NOT IN (...)) にある名前。最後の定義を正とする */
function pgNetAllowedCallees(sqlFunctionName: string): string[] {
  let latest: string[] = [];
  const migrationsDir = path.join(ROOT, 'supabase/migrations');
  for (const name of fs.readdirSync(migrationsDir).sort()) {
    if (!name.endsWith('.sql') || name.endsWith('.down.sql')) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf-8').replace(/--.*$/gm, '');
    const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+"?public"?\\."?${sqlFunctionName}"?[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`, 'gi');
    for (const match of sql.matchAll(pattern)) {
      const allowList = match[1].match(/NOT\s+IN\s*\(([^)]*)\)/i);
      latest = allowList ? [...allowList[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]) : ['?'];
    }
  }
  return latest.sort();
}

describe('AI 利用回数の記録 (#1177): 定期実行 (cron) の入口', () => {
  it('pg_net の入口 (DB の関数) が呼び得る Edge Function は、migration の許可リストと一致する', () => {
    for (const [entry, callees] of Object.entries(PG_NET_CALLEES)) {
      expect(pgNetAllowedCallees(entry.slice('pg_net:'.length)), entry).toEqual([...callees].sort());
    }
  });

  it('定期実行の入口の全数は CRON_ENTRYPOINTS の一覧どおり', () => {
    expect(scanCronEntrypoints()).toEqual(Object.keys(CRON_ENTRYPOINTS).sort());
  });

  it('定期実行は利用回数を数えない: AI に届く Vercel Cron の route は AI_QUOTA_EXEMPT、pg_cron が呼ぶ Edge Function は user-jwt ではない', () => {
    for (const [entry, reason] of Object.entries(CRON_ENTRYPOINTS)) {
      expect(reason.trim().length, entry).toBeGreaterThan(5);
      if (entry.startsWith('vercel:')) {
        const file = `src/app${entry.slice('vercel:'.length)}/route.ts`;
        expect(analyses.has(file), `${file} が無い`).toBe(true);
        if (aiRoutes.includes(file)) expect(file in AI_QUOTA_EXEMPT, `${file} は AI_QUOTA_EXEMPT に載せること`).toBe(true);
        expect(analyses.get(file)!.consumeCalls.length, `${file} は数えない`).toBe(0);
      } else if (entry.startsWith('pg_net:')) {
        const callees = PG_NET_CALLEES[entry];
        expect(callees, `${entry}: 呼び得る Edge Function を PG_NET_CALLEES に書くこと`).toBeDefined();
        for (const name of callees) {
          expect(EDGE_FUNCTIONS[name], `${name} が EDGE_FUNCTIONS に無い`).toBeDefined();
          expect(EDGE_FUNCTIONS[name].kind, `${name} は cron のシークレットで呼ばれるので user-jwt ではない`).not.toBe('user-jwt');
        }
      } else {
        const name = entry.slice('pg_cron:'.length);
        expect(EDGE_FUNCTIONS[name], `${name} が EDGE_FUNCTIONS に無い`).toBeDefined();
        expect(EDGE_FUNCTIONS[name].kind, `${name} は service role で呼ばれるので user-jwt ではない`).not.toBe('user-jwt');
      }
    }
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

  it('Edge Functions の書き方 (Deno.env.get / npm: の指定) も、AI を呼ぶ印として検出する', () => {
    expect(analyzeSource(`const key = Deno.env.get('OPENAI_API_KEY');`).sinks).toContain('env:OPENAI_API_KEY');
    expect(analyzeSource(`const KEY_ENV = 'AIMLAPI_API_KEY'; const key = Deno.env.get(KEY_ENV);`).sinks).toContain('env:AIMLAPI_API_KEY');
    expect(analyzeSource(`import OpenAI from 'npm:openai@6.9.1';`).sinks).toContain('pkg:npm:openai@6.9.1');
    expect(analyzeSource(`import { GoogleGenAI } from 'npm:@google/genai@1.44.0';`).sinks).toContain('pkg:npm:@google/genai@1.44.0');
    expect(analyzeSource(`const url = Deno.env.get('SUPABASE_URL'); import x from 'npm:zod@4';`).sinks).toEqual([]);
  });

  it('Edge Function の名前を定数で書いた呼び出し・URL も、名前まで読み取る', () => {
    expect(
      analyzeSource("const EDGE_FUNCTION_NAME = 'calculate-segment-stats'; await fetch(`${url}/functions/v1/${EDGE_FUNCTION_NAME}`);").sinks,
    ).toEqual([]);
    expect(analyzeSource("const NAME = 'knowledge-gpt'; await fetch(`${url}/functions/v1/${NAME}`);").sinks).toContain('edge:knowledge-gpt');
    expect(analyzeSource("const NAME = 'stripe-price-sync'; await supabase.functions.invoke(NAME, {});").sinks).toEqual([]);
    // 同じ名前の定数が別の値で 2 つあるときは、どちらか分からないので名前を読まない (AI を呼ぶ側に倒す)
    expect(
      analyzeSource("const N = 'stripe-price-sync'; function f() { const N = 'knowledge-gpt'; } await fetch(`${u}/functions/v1/${N}`);").sinks,
    ).toContain('edge:?');
  });

  it('素朴な文字の検出 (hasRawAiMarker): コメントの中は拾わず、URL・環境変数・import は拾う', () => {
    expect(hasRawAiMarker(`fetch('https://api.openai.com/v1/chat/completions')`)).toBe(true);
    expect(hasRawAiMarker(`const key = process.env.OPENAI_API_KEY;`)).toBe(true);
    expect(hasRawAiMarker(`import OpenAI from 'openai';`)).toBe(true);
    expect(hasRawAiMarker(`// fetch('https://api.openai.com/v1')\n/* process.env.OPENAI_API_KEY */`)).toBe(false);
    expect(hasRawAiMarker(`const note = 'OPENAI_API_KEY を使う';`)).toBe(false);
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

  it('Edge Function: JWT を確かめたブロックで directJwtUserId に代入し、あとで if (directJwtUserId) の中で数える形を読み取る', () => {
    const a = analyzeEdgeSource(`
      Deno.serve(async (req) => {
        let directJwtUserId: string | null = null;
        if (isServiceRole) {
          userId = body.userId;
        } else {
          const { data: { user } } = await supabase.auth.getUser();
          directJwtUserId = user.id;
        }
        if (directJwtUserId) {
          const quota = await consumeEdgeAiQuota(req, directJwtUserId, 'consultation');
          if (!quota.allowed) return aiQuotaExceededResponse(quota, corsHeaders);
        }
        const unguarded = await consumeEdgeAiQuota(req, directJwtUserId, 'consultation');
      });
    `);
    expect(a.authCalls).toHaveLength(1);
    expect(a.directJwtAssignments).toHaveLength(1);
    const auth = a.authCalls[0];
    expect(a.directJwtAssignments[0] > auth.pos && a.directJwtAssignments[0] < auth.block!.end).toBe(true);
    expect(a.consumeCalls.map((c) => c.guardedByDirectJwt)).toEqual([true, false]);
    expect(a.consumeCalls[0]).toMatchObject({ userIdArgument: 'directJwtUserId', allowedRead: true });
    // 宣言の初期値 (= null) は代入に数えない。service role の分岐での代入は、JWT を確かめたブロックの外として見つかる
    const b = analyzeEdgeSource(`
      Deno.serve(async (req) => {
        let directJwtUserId: string | null = null;
        if (isServiceRole) { directJwtUserId = body.userId; } else { const { data } = await supabase.auth.getUser(); }
      });
    `);
    expect(b.directJwtAssignments).toHaveLength(1);
    expect(b.directJwtAssignments[0] < b.authCalls[0].pos).toBe(true);
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
