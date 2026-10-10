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
 *   - 定期実行: CRON_ENTRYPOINTS (vercel.json の crons と、migration の pg_cron / pg_net が呼ぶ Edge Function)
 *   - どの route からも届かない AI のファイル: AI_SINK_FILES_NOT_REACHED_BY_ROUTES
 *   - src/app/api の外の route ハンドラ: NON_API_ROUTE_HANDLERS (route ハンドラは src/app 全体から集める)
 *   - 数える route の公開ハンドラのうち、AI に届かず数えないもの: ROUTE_HANDLERS_WITHOUT_AI (ファイル -> メソッド -> 理由)
 *   - 既知の穴 (利用者が直接書けるキューから AI へ送る経路。数えられない): USER_WRITABLE_AI_QUEUES
 *
 * 【Next.js】
 *   1. 素朴な文字の検出で AI の印があるファイルは、構文木の走査でも見つかる (走査が壊れていないことの突き合わせ)
 *   2. AI に届く route の全数 = 一覧 (数える・ライブラリが数える・数えない)。ページ・サーバーアクションは AI を import しない
 *   3. 数える route は consumeAiQuota を呼び、結果の allowed を使う (捨てない)。機能は一覧どおりで AI_FEATURES にある名前
 *   3a. 照合の単位は公開ハンドラ (GET / POST / PUT ...): 数える route のどのハンドラも、ハンドラの中で (同じファイルの関数を経由してよい)
 *       数えるか、ROUTE_HANDLERS_WITHOUT_AI に載っていて AI に届かない。ハンドラの全数も一覧と一致する
 *       (ファイル単位だと、すでに数えている route に数えない AI のハンドラを足しても見逃す)
 *   4. AI のレート制限 (analysis / generation / image) を通る場所の全数 = 数える場所。同じ関数の中のあとで数える
 *   5. consumeAiQuota を呼ぶ場所の全数 = 数える route と決めたライブラリ (数える場所が散らばって二重に数えない)
 *   6. Edge Function をユーザーの JWT で呼ぶ処理の全数は一覧どおりで、どれも数え済みの印 (aiQuotaCountedHeaders) を付ける
 *   6a. 順番: 同意の判定 (T15 / #1154) → 利用回数の記録 → AI への送信。数える前に、同じ関数の中で同意を判定している
 *       (呼び出し元が判定するものは CONSENT_CHECKED_BY_CALLERS)。数える前に、同じ経路で AI へ送っていない
 *       (AI に届くかは、同じファイルのヘルパー関数の本文と、import した関数の export した宣言の本文まで再帰的にたどって決める。
 *        実際に route を動かして呼ばれた順番を確かめるのは tests/ai-consent-enforcement-routes.test.ts)
 * 【Edge Functions】
 *   7. Edge Function の全数・AI に届く関数の全数・ユーザーの JWT を確かめる関数の全数が、EDGE_FUNCTIONS と一致する。
 *      数えない関数 (service-ai) は service role でしか呼べない (ユーザーの JWT で直接呼んで、数えずに AI を使えない)
 *   8. ユーザーの JWT を確かめる関数は、JWT を確かめた経路でだけ数える (service role / cron の経路では数えない)。
 *      AI へ送る直前で数えるため、service role の経路と合流する関数は、確かめたブロックで directJwtUserId に代入し、
 *      あとで if (directJwtUserId) の中で数える。どちらの形でも、数える前に同じ経路で同意を判定している
 * 【定期実行】
 *   9. 定期実行の入口の全数が CRON_ENTRYPOINTS と一致し、どれも数えない。DB の関数が名前を連結して
 *      Edge Function を呼ぶ入口 (pg_net) も含め、呼び得る関数を migration の許可リストと突き合わせる
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
  // 献立生成 (v5 のキューは、利用者の操作を積む時点で数える。実行する cron は数えない: AI_QUOTA_EXEMPT。
  // キューの行は利用者が直接書けるので、route を通らずに積んだ行は数えられない既知の穴がある: USER_WRITABLE_AI_QUEUES)
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
const ROUTES_COUNTED_IN_LIBRARY: Record<string, { library: string; entry: string; reason: string }> = {
  'src/app/api/ai/consultation/actions/[actionId]/execute/route.ts': {
    library: 'src/lib/ai/consultation-action-executor.ts',
    // ハンドラがこの名前に届けば、ライブラリが数える (ハンドラ単位の検査で使う)
    entry: 'runConsultationAction',
    reason: 'アクションの種類によって AI を使うかが決まる。AI を使うアクションだけを runConsultationAction が数える',
  },
};

/** AI の SDK / URL / Edge Function に届くが、利用者の AI 利用としては数えない route と理由 */
const AI_QUOTA_EXEMPT: Record<string, string> = {
  'src/app/api/cron/process-menu-queue/route.ts':
    'Vercel Cron が、キューに積まれた献立生成を service role で実行する。POST /api/ai/menu/v5/generate で積んだ行は、積む時点で数え済み (ここで数えると二重になる)。' +
    'ただし weekly_menu_requests は利用者が直接書けるので、route を通らずに積んだ行・積み直した行は数えられない (既知の穴。USER_WRITABLE_AI_QUEUES)',
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
      '料理画像の生成ジョブの実行。献立の保存・更新の route (image_generation として数え済み) と、献立生成 (menu_generation の一部) が積んだジョブを、service role で処理する。' +
      'meal_image_jobs は利用者が直接書けるので、route を通らずに積んだジョブは数えられない (既知の穴。USER_WRITABLE_AI_QUEUES)',
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
 * どれも service role / cron のシークレットで呼ぶので、AI を使うものは数えない (利用者の操作は、積んだ時点で数え済み。
 * 利用者が直接書けるキューの行は数えられない既知の穴がある: USER_WRITABLE_AI_QUEUES)。
 */
const CRON_ENTRYPOINTS: Record<string, string> = {
  'vercel:/api/cron/process-menu-queue':
    'キューに積まれた献立生成を実行する (POST /api/ai/menu/v5/generate で積んだ行は、積む時点で数え済み。route は AI_QUOTA_EXEMPT。' +
    '利用者が直接書いた行は数えられない既知の穴: USER_WRITABLE_AI_QUEUES)',
  'pg_cron:calculate-segment-stats': 'セグメント統計の集計 (AI を使わない)',
  // DB の関数が、名前を引数で受け取って Edge Function を呼ぶもの (pg_cron のジョブ・運営の手動実行から呼ばれ得る)
  'pg_net:invoke_catalog_import':
    'コンビニ商品カタログの取り込み (import-*-catalog の 5 つに限る。どれも service-ai)。cron のシークレットで呼ぶ運営の処理で、利用者の AI 利用ではない',
};

/**
 * 既知の穴: 利用者が自分の権限 (authenticated) で行を書けるキューのうち、service role の処理が AI へ送るもの。
 * 通常の操作は、行を積む route で数える (献立生成 = POST /api/ai/menu/v5/generate、料理画像 = 献立の保存・更新の route)。
 * ところが行は RLS で本人が直接 INSERT / UPDATE できる (Supabase の PostgREST に anon key と本人の JWT で書ける) ので、
 * route を通らずに積んだ行・積み直した行 (status / attempt_count / current_step / generated_data を書き換える) は、どこでも数えられない。
 * 取り出す側で数えても、取り直し (止まったワーカーの続き) と見分ける列も利用者が書けるので、数え方では閉じられない。
 * 閉じるには、書き込みを service role だけにする (RLS / 権限を取り上げる変更。route の書き込みも service role に移す)。
 * これは既存の権限を取り上げる DB の変更なので、この Issue (#1177) では行わず、別の Issue にする。
 * 閉じたら (下のテストが落ちたら)、この一覧から消し、AI_QUOTA_EXEMPT・CRON_ENTRYPOINTS・EDGE_FUNCTIONS の説明と
 * supabase/functions/README.md の「既知の穴」を直すこと。
 */
const USER_WRITABLE_AI_QUEUES: Record<string, { worker: string; note: string }> = {
  weekly_menu_requests: {
    worker: 'src/app/api/cron/process-menu-queue/route.ts',
    note: 'queued の行を Vercel Cron が取り出し、行の generated_data と user_id で generate-menu-v5 を service role で呼ぶ (Edge Function は service role の経路では数えない)',
  },
  meal_image_jobs: {
    worker: 'supabase/functions/process-meal-image-jobs/index.ts',
    note: 'pending のジョブを、献立の保存・更新の route が呼ぶたびに処理する (行の prompt で画像を生成する。service-ai で数えない)',
  },
};

/**
 * migration を順に読み、authenticated がそのテーブルに INSERT / UPDATE できるか (権限と、許可のポリシーの両方があるか)。
 * ポリシーの条件 (USING / WITH CHECK) は評価しない (条件つきでも、その操作を許すポリシーがあれば書けるとみなす)
 */
function authenticatedCanWrite(table: string, sqlFiles?: Array<{ name: string; sql: string }>): { insert: boolean; update: boolean } {
  const files =
    sqlFiles ??
    fs
      .readdirSync(path.join(ROOT, 'supabase/migrations'))
      .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
      .sort()
      .map((name) => ({ name, sql: fs.readFileSync(path.join(ROOT, 'supabase/migrations', name), 'utf-8') }));
  const ALL_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
  // 名前の続きが英数字・_ のもの (例: weekly_menu_requests_archive) は別のテーブルなので、後ろを区切る
  const tableRef = `(?:"?public"?\\.)?"?${table}"?(?![A-Za-z0-9_])`;
  const rolesOf = (text: string) => text.split(',').map((role) => role.trim().replace(/"/g, '').toLowerCase());
  const privilegesOf = (text: string) =>
    /^ALL(\s+PRIVILEGES)?$/i.test(text.trim()) ? ALL_PRIVILEGES : text.split(',').map((p) => p.trim().toUpperCase());
  const privileges = new Set<string>();
  const policies = new Map<string, { command: string; roles: string[] }>();
  for (const { sql: raw } of files) {
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
  return { insert: privileges.has('INSERT') && allows('INSERT'), update: privileges.has('UPDATE') && allows('UPDATE') };
}

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
/** 外国の AI 事業者への提供の同意の判定 (T15 / #1154)。Next.js の API ルートが、AI へ送る手前で呼ぶ */
const CONSENT_GUARD_MODULE = '@/lib/ai/consent-guard';
const CONSENT_GUARD_FUNCTIONS = new Set(['requireAiConsent', 'checkUserAiConsent']);

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
  /** 数える処理が通る範囲: switch の case の中ならその case、そうでなければ関数 (別の case の処理は同じ経路ではない) */
  scope: Span | null;
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

interface ConsentCall {
  pos: number;
  fn: Span | null;
}

interface ImportedCall {
  pos: number;
  /** 呼んだ名前 (import した名前。X.y(...) なら X) */
  name: string;
  /** その名前を import したモジュールの指定 */
  specifier: string;
  fn: Span | null;
}

interface FileAnalysis {
  imports: string[];
  /** AI を直接呼ぶ印 (SDK / 提供元の URL / API キーの環境変数 / Edge Function の呼び出し) */
  sinks: string[];
  /** ファイルの中で AI へ送る印が現れる位置 (提供元の URL・Edge Function の呼び出しと URL。API キーを読むだけ・import は含めない) */
  sinkSites: Array<{ pos: number; fn: Span | null }>;
  importsEntitlementsQuota: boolean;
  consumeCalls: ConsumeCall[];
  /** 同意の判定 (requireAiConsent / checkUserAiConsent。@/lib/ai/consent-guard から import したもの) の呼び出し */
  consentCalls: ConsentCall[];
  /** import した名前の呼び出し (AI に届くモジュールの関数を、数える前に呼んでいないかを見るため) */
  importedCalls: ImportedCall[];
  /** 名前で呼んだ関数 (f(...)) の呼び出し。同じファイルの関数も含む */
  namedCalls: Array<{ pos: number; name: string; fn: Span | null }>;
  rateLimitCalls: RateLimitCall[];
  invokeCalls: InvokeCall[];
  /** import した名前 (型だけの import は除く) -> モジュールの指定 */
  importedNames: Map<string, string>;
  /** import した名前 -> 元の名前 (既定の import は 'default'、名前空間の import は '*') */
  importedOriginals: Map<string, string>;
  /**
   * export した名前 -> 中身。local = 同じファイルの宣言の名前 / span = 名前の無い既定の export の範囲 /
   * from = 別のモジュールからの再 export
   */
  exports: Map<string, { kind: 'local'; name: string } | { kind: 'span'; span: Span } | { kind: 'from'; specifier: string; name: string }>;
  /** export * from '...' のモジュールの指定 */
  starExports: string[];
  /** ファイル直下の宣言 (関数・変数・クラス) の名前 -> 宣言の範囲 */
  topLevel: Map<string, Span[]>;
  /**
   * 識別子の参照 (呼び出しに限らない。コールバックとして渡す・変数に入れるものも含む)。
   * 宣言の名前・プロパティ名 (x.name の name)・import の指定・型の中は除く。
   * chained: 呼んだ結果をそのまま続けて使っている (X().y / new X().y。クライアントを作ってすぐ送る書き方)
   */
  refs: Array<{ pos: number; name: string; chained: boolean }>;
  /** 公開した HTTP のハンドラ (export async function GET など)。span が null は中身を読めない (別のモジュールからの再 export) */
  handlers: Array<{ method: string; span: Span | null }>;
}

/** Next.js の route ハンドラとして公開できる名前 */
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** AI の SDK のパッケージの指定か (Edge Functions の npm: / esm.sh の指定も、パッケージ名で比べる) */
function isAiPackageSpecifier(specifier: string): boolean {
  const bare = specifier.replace(/^npm:/, '').replace(/^https:\/\/esm\.sh\//, '');
  const name = bare.startsWith('@') ? bare.split('/').slice(0, 2).join('/') : bare.split('/')[0];
  const pkgName = name.replace(/(.)@[^/]*$/, '$1');
  const subpath = bare.slice(name.length);
  return AI_PACKAGES.some((pkg) => pkgName === pkg || `${pkgName}${subpath}`.startsWith(`${pkg}/`));
}

/** 識別子が、値としての参照か (宣言の名前・プロパティ名・import / export の指定・ラベルではない) */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent)) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isParameter(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) return false;
  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportEqualsDeclaration(parent) ||
    ts.isExportSpecifier(parent)
  ) {
    return false;
  }
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  if (ts.isJsxAttribute(parent)) return false;
  return true;
}

const hasExportModifier = (node: ts.Node) =>
  ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** 束縛のパターン ({ a, b: [c] } など) に現れる名前 */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isBindingElement(element) ? bindingNames(element.name) : []));
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

/** 呼び出しが通る範囲: 最も内側の switch の case (関数の中にあるもの)、無ければ関数 */
function enclosingScope(node: ts.Node, sf: ts.SourceFile): Span | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isCaseClause(current) || ts.isDefaultClause(current)) return { start: current.getStart(sf), end: current.getEnd() };
    if (isFunctionLike(current)) return { start: current.getStart(sf), end: current.getEnd() };
    current = current.parent;
  }
  return null;
}

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
    sinkSites: [],
    importsEntitlementsQuota: false,
    consumeCalls: [],
    consentCalls: [],
    importedCalls: [],
    namedCalls: [],
    rateLimitCalls: [],
    invokeCalls: [],
    importedNames: new Map(),
    importedOriginals: new Map(),
    exports: new Map(),
    starExports: [],
    topLevel: new Map(),
    refs: [],
    handlers: [],
  };
  // consumeAiQuota を別名で import している場合に備えて、ローカル名を集める
  const consumeLocalNames = new Set<string>(['consumeAiQuota']);
  // 同意の判定のローカル名 (@/lib/ai/consent-guard から import したものだけ)
  const consentLocalNames = new Set<string>();
  // import した名前 -> モジュールの指定 (既定の import・名前つき・名前空間のどれも)
  const importedNames = analysis.importedNames;
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    if (clause.name) {
      importedNames.set(clause.name.text, specifier);
      analysis.importedOriginals.set(clause.name.text, 'default');
    }
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      importedNames.set(bindings.name.text, specifier);
      analysis.importedOriginals.set(bindings.name.text, '*');
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        importedNames.set(element.name.text, specifier);
        analysis.importedOriginals.set(element.name.text, (element.propertyName ?? element.name).text);
        if (specifier === CONSENT_GUARD_MODULE && CONSENT_GUARD_FUNCTIONS.has((element.propertyName ?? element.name).text)) {
          consentLocalNames.add(element.name.text);
        }
      }
    }
  }
  /** X(...) / X.y.z(...) の X (import した名前なら) */
  const importedRoot = (callee: ts.Expression): string | null => {
    let current: ts.Expression = callee;
    while (ts.isPropertyAccessExpression(current)) current = current.expression;
    return ts.isIdentifier(current) && importedNames.has(current.text) ? current.text : null;
  };
  // 文字列リテラルで初期化した const (例: const EDGE_FUNCTION_NAME = 'calculate-segment-stats')。
  // Edge Function の名前を定数で書いた呼び出し・URL を、名前まで読み取るため
  const stringConsts = collectStringConsts(sf);
  const resolveString = (node: ts.Node | undefined): string | null =>
    stringValue(node) ?? (node && ts.isIdentifier(node) ? stringConsts.get(node.text) ?? null : null);

  const addEdgeSink = (name: string | null, node?: ts.Node) => {
    if (name && NON_AI_EDGE_FUNCTIONS.has(name)) return;
    analysis.sinks.push(`edge:${name ?? '?'}`);
    if (node) analysis.sinkSites.push({ pos: node.getStart(sf), fn: enclosingFunction(node, sf) });
  };
  const addSinkSite = (node: ts.Node) => analysis.sinkSites.push({ pos: node.getStart(sf), fn: enclosingFunction(node, sf) });

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
          scope: enclosingScope(node, sf),
        });
      }

      if (ts.isIdentifier(callee) && callee.text === 'checkRateLimit') {
        analysis.rateLimitCalls.push({ pos, category: stringValue(node.arguments[1]), fn: enclosingFunction(node, sf) });
      }

      if (ts.isIdentifier(callee) && consentLocalNames.has(callee.text)) {
        analysis.consentCalls.push({ pos, fn: enclosingFunction(node, sf) });
      }

      if (ts.isIdentifier(callee)) analysis.namedCalls.push({ pos, name: callee.text, fn: enclosingFunction(node, sf) });

      const root = importedRoot(callee);
      if (root) {
        analysis.importedCalls.push({ pos, name: root, specifier: importedNames.get(root)!, fn: enclosingFunction(node, sf) });
      }

      // supabase.functions.invoke('name', { ... })
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'invoke' &&
        ts.isPropertyAccessExpression(callee.expression) &&
        callee.expression.name.text === 'functions'
      ) {
        const name = resolveString(node.arguments[0]);
        addEdgeSink(name, node);
        if (!(name && NON_AI_EDGE_FUNCTIONS.has(name))) {
          analysis.invokeCalls.push({ name, optionsText: node.arguments[1] ? node.arguments[1].getText(sf) : '' });
        }
      }
    }

    // fetch(`${url}/functions/v1/<name>`) など
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const url = edgeFunctionNameFromUrl(node.text);
      if (url.found) addEdgeSink(url.name, node);
      for (const host of AI_HOSTS) {
        if (node.text.includes(host)) {
          analysis.sinks.push(`host:${host}`);
          addSinkSite(node);
        }
      }
    }
    if (ts.isTemplateExpression(node)) {
      const text =
        node.head.text +
        node.templateSpans.map((span) => `${resolveString(span.expression) ?? '${}'}${span.literal.text}`).join('');
      const url = edgeFunctionNameFromUrl(text);
      if (url.found) addEdgeSink(url.name, node);
      for (const host of AI_HOSTS) {
        if (text.includes(host)) {
          analysis.sinks.push(`host:${host}`);
          addSinkSite(node);
        }
      }
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
    if (isAiPackageSpecifier(specifier)) analysis.sinks.push(`pkg:${specifier}`);
  }

  // ファイル直下の宣言と、公開した HTTP のハンドラ
  const spanOf = (node: ts.Node): Span => ({ start: node.getStart(sf), end: node.getEnd() });
  const addTopLevel = (name: string, node: ts.Node) => {
    const spans = analysis.topLevel.get(name) ?? [];
    spans.push(spanOf(node));
    analysis.topLevel.set(name, spans);
  };
  const isDefaultExport = (node: ts.Node) =>
    ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) addTopLevel(statement.name.text, statement);
      if (hasExportModifier(statement)) {
        if (isDefaultExport(statement)) {
          analysis.exports.set('default', statement.name ? { kind: 'local', name: statement.name.text } : { kind: 'span', span: spanOf(statement) });
        } else if (statement.name) {
          analysis.exports.set(statement.name.text, { kind: 'local', name: statement.name.text });
        }
      }
      if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement) && HTTP_METHODS.has(statement.name.text)) {
        analysis.handlers.push({ method: statement.name.text, span: spanOf(statement) });
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) {
          addTopLevel(name, declaration);
          if (hasExportModifier(statement)) analysis.exports.set(name, { kind: 'local', name });
          if (hasExportModifier(statement) && HTTP_METHODS.has(name)) analysis.handlers.push({ method: name, span: spanOf(declaration) });
        }
      }
    }
    // export default <式>
    if (ts.isExportAssignment(statement)) {
      analysis.exports.set(
        'default',
        ts.isIdentifier(statement.expression) ? { kind: 'local', name: statement.expression.text } : { kind: 'span', span: spanOf(statement) },
      );
    }
  }
  // export { a as b } / export { a } from './x' / export * from './x'。
  // route の公開ハンドラ: export { handler as POST } は同じファイルの宣言を読み、別のモジュールからの再 export は中身を読めない (span: null)
  for (const statement of sf.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    const from = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
    if (!statement.exportClause) {
      if (from) analysis.starExports.push(from);
      analysis.handlers.push({ method: '*', span: null });
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue;
      const local = (element.propertyName ?? element.name).text;
      analysis.exports.set(element.name.text, from ? { kind: 'from', specifier: from, name: local } : { kind: 'local', name: local });
      if (!HTTP_METHODS.has(element.name.text)) continue;
      analysis.handlers.push({ method: element.name.text, span: from ? null : analysis.topLevel.get(local)?.[0] ?? null });
    }
  }

  // 識別子の参照 (型の中・import の宣言は除く)
  const collectRefs = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isIdentifier(node) && isValueReference(node)) {
      const parent = node.parent;
      const chained =
        (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
        parent.expression === node &&
        !!parent.parent &&
        (ts.isPropertyAccessExpression(parent.parent) || ts.isElementAccessExpression(parent.parent)) &&
        parent.parent.expression === parent;
      analysis.refs.push({ pos: node.getStart(sf), name: node.text, chained });
    }
    ts.forEachChild(node, collectRefs);
  };
  collectRefs(sf);
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

/**
 * モジュールが export した名前が、AI へ送るところに届くか。export した宣言の本文を (同じファイルの宣言・import を再帰的に) たどる。
 * 中身を読めないもの (export に無い名前・export * の先が分からない) は、モジュール全体が AI に届くかで決める (送る側に倒す)
 */
function exportReachesAi(file: string, exportName: string, stack: Set<string>): boolean {
  const found = findExport(file, exportName);
  if (!found) return aiSinkFilesReachedFrom(file).length > 0;
  const { file: owner, entry } = found;
  const a = analyses.get(owner)!;
  if (entry.kind === 'local') return localReachesAi(owner, a, entry.name, stack);
  if (entry.kind === 'span') return spanReachesAi(owner, a, entry.span, stack);
  return importReachesAi(owner, entry.specifier, entry.name, stack);
}

/** export した名前の持ち主 (export * from '...' の先もたどる)。見つからなければ null */
function findExport(
  file: string,
  exportName: string,
  seen: Set<string> = new Set(),
): { file: string; entry: FileAnalysis['exports'] extends Map<string, infer E> ? E : never } | null {
  const a = analyses.get(file);
  if (!a || seen.has(file)) return null;
  seen.add(file);
  const entry = a.exports.get(exportName);
  if (entry) return { file, entry };
  if (exportName === 'default') return null;
  for (const specifier of a.starExports) {
    const resolved = resolveImport(file, specifier);
    const found = resolved ? findExport(resolved, exportName, seen) : null;
    if (found) return found;
  }
  return null;
}

/**
 * import した名前が AI に届くか。AI の SDK のパッケージなら届く。名前空間の import (import * as X) はモジュール全体で、
 * 名前つき・既定の import は、そのモジュールが export した宣言の本文で決める (同じモジュールの AI を使わない関数を、AI に届くとしない)
 */
function importReachesAi(file: string, specifier: string, original: string, stack: Set<string>): boolean {
  if (isAiPackageSpecifier(specifier)) return true;
  const resolved = resolveImport(file, specifier);
  if (!resolved) return false;
  if (original === '*') return aiSinkFilesReachedFrom(resolved).length > 0;
  return exportReachesAi(resolved, original, stack);
}

/** 同じファイルの宣言 (関数・変数・クラス) の本文が AI に届くか */
const localReachMemo = new Map<string, boolean>();
function localReachesAi(file: string, a: FileAnalysis, name: string, stack: Set<string>): boolean {
  const key = `${file}#${name}`;
  const memo = localReachMemo.get(key);
  if (memo !== undefined) return memo;
  const spans = a.topLevel.get(name);
  if (!spans || stack.has(key)) return false;
  stack.add(key);
  const reached = spans.some((span) => spanReachesAi(file, a, span, stack));
  stack.delete(key);
  // 循環の途中 (stack が空でない) で「届かない」と出た結果は、循環を切った仮の値なので覚えない
  if (reached || stack.size === 0) localReachMemo.set(key, reached);
  return reached;
}

/**
 * 名前の参照が、AI へ送るところに届くか。import した名前は export した宣言の本文まで、同じファイルの宣言はその本文を、
 * 再帰的にたどる (ヘルパー関数を経由して送るものも見つける)。解析は合成のソース (テスト用) にも使うので、ファイルの解析を引数で受け取る
 */
function refReachesAi(file: string, a: FileAnalysis, name: string, stack: Set<string> = new Set()): boolean {
  const specifier = a.importedNames.get(name);
  if (specifier !== undefined) return importReachesAi(file, specifier, a.importedOriginals.get(name) ?? '*', stack);
  if (analyses.get(file) !== a) {
    // 合成のソース (変異を入れた写し) は、覚えた結果 (元のファイルのもの) を使わない
    const spans = a.topLevel.get(name);
    const key = `${file}#${name}`;
    if (!spans || stack.has(key)) return false;
    stack.add(key);
    const reached = spans.some((span) => spanReachesAi(file, a, span, stack));
    stack.delete(key);
    return reached;
  }
  return localReachesAi(file, a, name, stack);
}

/** 範囲 (ハンドラ・関数) の中から、AI へ送るところに届くか (URL・Edge Function の呼び出しの位置、または AI に届く名前の参照) */
function spanReachesAi(file: string, a: FileAnalysis, span: Span, stack: Set<string> = new Set()): boolean {
  if (a.sinkSites.some((site) => within(site.pos, span))) return true;
  return a.refs.some((ref) => within(ref.pos, span) && refReachesAi(file, a, ref.name, stack));
}

/**
 * 範囲 (ハンドラ) の中から、利用回数を数える呼び出しに届くか。consumeAiQuota の呼び出しが範囲の中にあるか、
 * 範囲の中で参照する同じファイルの宣言の本文に (再帰的に) あるか。countingImports に挙げた import の名前 (数えるライブラリの入口) の参照も数える
 */
function spanReachesConsume(
  a: FileAnalysis,
  span: Span,
  countingImports: readonly string[] = [],
  stack: Set<string> = new Set(),
): boolean {
  if (a.consumeCalls.some((call) => within(call.pos, span))) return true;
  return a.refs.some((ref) => {
    if (!within(ref.pos, span)) return false;
    if (countingImports.includes(ref.name) && a.importedNames.has(ref.name)) return true;
    const spans = a.topLevel.get(ref.name);
    if (!spans || a.importedNames.has(ref.name) || stack.has(ref.name)) return false;
    stack.add(ref.name);
    const reached = spans.some((inner) => spanReachesConsume(a, inner, countingImports, stack));
    stack.delete(ref.name);
    return reached;
  });
}

/**
 * Next.js の route ハンドラ (route.ts / route.tsx)。src/app/api の外 (例: src/app/(auth)/auth/callback/route.ts) に置いても
 * HTTP の入口になるので、src/app 全体から集める (api の下だけを見ると、外に置いた AI の入口の数え忘れを見逃す)
 */
const isRouteHandlerFile = (file: string) => /^src\/app\/(?:.+\/)?route\.tsx?$/.test(file);
const routeFiles = [...analyses.keys()].filter(isRouteHandlerFile).sort();
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
    reason:
      '献立生成をキュー (weekly_menu_requests の queued) に積むだけ。AI へ送るのは Vercel Cron の process-menu-queue (service role)。' +
      'キューの行は利用者が直接書けるので、この route を通らない行は数えられない (既知の穴。USER_WRITABLE_AI_QUEUES)',
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

/**
 * src/app/api の外にある route ハンドラのうち、AI に届かないものの全数と、それぞれが何をするか。
 * (AI に届く route は、api の中でも外でも、上の全数の突き合わせで AI_QUOTA_ROUTES / AI_QUOTA_EXEMPT への分類を求められる)
 */
const NON_API_ROUTE_HANDLERS: Record<string, string> = {
  'src/app/(auth)/auth/callback/route.ts': 'ログインの戻り先 (Supabase Auth のコードの引き換え)。AI を呼ばない',
  'src/app/(auth)/auth/native-bridge/route.ts': 'ネイティブアプリのセッションを WebView の Cookie に引き継ぐ。AI を呼ばない',
  'src/app/handson-tour/replay/route.ts': 'ハンズオンツアーをもう一度見るための Cookie を発行する。AI を呼ばない',
};

/**
 * 数える関数のうち、同意の判定 (T15 / #1154) を呼び出し元の route が済ませてから呼ばれるもの。
 * 呼び出し元 (callers: route -> 数える関数に届く呼び出しの名前) は、その呼び出しより前に、同じ関数の中で同意を判定すること
 */
const CONSENT_CHECKED_BY_CALLERS: Record<string, { features: readonly Feature[]; callers: Record<string, string>; reason: string }> = {
  'src/lib/ai/consultation-action-executor.ts': {
    features: ['menu_generation'],
    callers: {
      'src/app/api/ai/consultation/actions/[actionId]/execute/route.ts': 'runConsultationAction',
      'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts': 'executeAndFinalizeAction',
    },
    reason:
      '献立の生成のアクション (AI_SENDING_ACTION_TYPES) は、実行の API (execute) がアクションを実行する前に、' +
      '会話の中の自動実行 (messages) が POST の最初に、同意を判定する。数える関数 (countMenuGenerationAction) はそのあとで呼ばれる',
  },
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

/**
 * 数える前に使ってよい、AI に届く import の名前 (ファイル -> import した名前 -> 理由)。
 * AI のクライアントを作るだけで、送るのは数えたあとのもの。走査が AI に届くとみなす名前だけを載せる
 * (import した関数は、export した宣言の本文まで読むので、同じモジュールの AI を使わない関数 (写真の読み込み・ジョブの組み立て) は載せなくてよい)
 */
const AI_MODULE_CALLS_BEFORE_COUNT: Record<string, Record<string, string>> = {
  'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts': {
    getFastLLMClient: 'AI のクライアントを作るだけ (送るのは、数えたあとの chat.completions.create)',
  },
  'src/app/api/ai/image/generate/route.ts': {
    GoogleGenAI: 'AI のクライアントを作るだけ (new GoogleGenAI)。送るのは、数えたあとの ai.models.generateContent',
  },
};

/**
 * 数える route の公開ハンドラのうち、AI に届かず数えないものの全数 (ファイル -> メソッド -> 理由)。
 * 数える route の公開ハンドラは、どれもハンドラの中で数えるか、ここに載っていること。ここに載せたハンドラは AI に届かないこと。
 * (照合の単位をファイルにすると、すでに数えている route に、数えない AI のハンドラを足しても見逃す)
 */
const ROUTE_HANDLERS_WITHOUT_AI: Record<string, Record<string, string>> = {
  'src/app/api/ai/consultation/actions/[actionId]/execute/route.ts': {
    DELETE: 'アクションの却下。ai_action_logs の状態を書き換えるだけで、AI を呼ばない',
  },
  'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts': {
    GET: '会話のメッセージの一覧を DB から読むだけ。AI を呼ばない (AI へ送るのは POST)',
  },
  'src/app/api/ai/nutrition/feedback/route.ts': {
    GET: '生成済みのフィードバック (nutrition_feedback_cache) を DB から読むだけ。AI を呼ばない (生成は POST)',
  },
  'src/app/api/health/blood-tests/route.ts': {
    GET: '血液検査の結果と経年レビューを DB から読むだけ。AI を呼ばない (AI のレビューは POST)',
  },
  'src/app/api/health/checkups/route.ts': {
    GET: '健康診断の結果と経年レビューを DB から読むだけ。AI を呼ばない (AI のレビューは POST)',
  },
  'src/app/api/health/insights/route.ts': {
    GET: '健康インサイトの一覧と未読数・アラート数を DB から読むだけ。AI を呼ばない (生成は POST)',
  },
  'src/app/api/meal-plans/meals/[id]/route.ts': {
    DELETE: '献立の削除。未処理の料理画像の生成ジョブを取り消す (cancelPendingMealImageJobs は DB を書き換えるだけ) が、AI を呼ばない',
  },
  'src/app/api/meals/route.ts': {
    GET: 'その日の献立を DB から読むだけ。AI を呼ばない (料理画像の生成は POST)',
  },
  'src/app/api/meals/[id]/route.ts': {
    GET: '献立を 1 件 DB から読むだけ。AI を呼ばない',
    DELETE: '献立の削除。未処理の料理画像の生成ジョブを取り消す (cancelPendingMealImageJobs は DB を書き換えるだけ) が、AI を呼ばない',
  },
};

/**
 * 数える場所 (consumeAiQuota の呼び出し) より前に、同じ経路 (同じ関数、switch の中なら同じ case) で AI へ送っていないか。
 * 送る印 (URL・Edge Function の呼び出し) の位置と、AI に届く名前の参照 (import した関数、同じファイルのヘルパー関数を再帰的に) を見る。
 * AI_MODULE_CALLS_BEFORE_COUNT に理由つきで載せた import の名前 (クライアントを作るだけのもの) は、数える前に直接使ってよい。
 * ただし作ったクライアントでそのまま送る書き方 (getFastLLMClient().chat.completions.create(...)) と、
 * ヘルパー関数の本文の中での使用 (再帰的にたどる先) には、この許可を当てない
 */
function sendBeforeCountViolations(file: string, a: FileAnalysis): string[] {
  const allowed = AI_MODULE_CALLS_BEFORE_COUNT[file] ?? {};
  const violations: string[] = [];
  for (const call of a.consumeCalls) {
    if (!call.scope) continue;
    const before = (pos: number) => pos < call.pos && within(pos, call.scope);
    for (const site of a.sinkSites) {
      if (before(site.pos)) violations.push(`${file}: AI へ送る印 (URL・Edge Function の呼び出し) が数える前にある`);
    }
    for (const ref of a.refs) {
      // 載せた名前でも、作ったクライアントでそのまま送る書き方 (getFastLLMClient().chat.completions.create(...)) は送信とみなす
      if (!before(ref.pos) || (Object.hasOwn(allowed, ref.name) && !ref.chained)) continue;
      if (refReachesAi(file, a, ref.name)) violations.push(`${file}: ${ref.name} (AI へ送るところに届く) を数える前に使っている`);
    }
  }
  return violations;
}

/**
 * 数える route の公開ハンドラの検査。どのハンドラも、ハンドラの中で (同じファイルの関数を経由してよい) 数えるか、
 * ROUTE_HANDLERS_WITHOUT_AI に載っていて AI に届かないこと。一覧に載っているのに無いハンドラ・数えるハンドラは古い載せ方
 */
function handlerViolations(file: string, a: FileAnalysis): string[] {
  const listed = ROUTE_HANDLERS_WITHOUT_AI[file] ?? {};
  const violations: string[] = [];
  // ライブラリが数える route は、ライブラリの入口 (entry) をそのライブラリから import して使うハンドラを、数えるハンドラとする
  const library = ROUTES_COUNTED_IN_LIBRARY[file];
  const countingImports: string[] = [];
  if (library) {
    const specifier = a.importedNames.get(library.entry);
    if (specifier !== undefined && resolveImport(file, specifier) === library.library) countingImports.push(library.entry);
    else violations.push(`${file}: ${library.entry} を ${library.library} から import していない`);
  }
  if (a.handlers.length === 0) violations.push(`${file}: 公開ハンドラが見つからない (走査が壊れている)`);
  for (const handler of a.handlers) {
    const isListed = Object.hasOwn(listed, handler.method);
    if (!handler.span) {
      violations.push(`${file} ${handler.method}: 別のモジュールから再 export したハンドラは中身を読めない (この route の中で定義すること)`);
      continue;
    }
    const counts = spanReachesConsume(a, handler.span, countingImports);
    if (counts && isListed) violations.push(`${file} ${handler.method}: 数えるようになった (ROUTE_HANDLERS_WITHOUT_AI から消すこと)`);
    if (!counts && !isListed) {
      violations.push(
        spanReachesAi(file, a, handler.span)
          ? `${file} ${handler.method}: AI に届くのに、このハンドラでは数えていない`
          : `${file} ${handler.method}: 数えないハンドラが増えた (AI に届かないなら、理由を書いて ROUTE_HANDLERS_WITHOUT_AI に足す)`,
      );
    }
    if (!counts && isListed && spanReachesAi(file, a, handler.span)) {
      violations.push(`${file} ${handler.method}: AI に届かないハンドラの一覧にあるのに、AI に届く (数えること)`);
    }
  }
  for (const method of Object.keys(listed)) {
    if (!a.handlers.some((handler) => handler.method === method)) violations.push(`${file} ${method}: もう無いハンドラ (ROUTE_HANDLERS_WITHOUT_AI から消すこと)`);
  }
  return violations;
}

/** consumeAiQuota の前に、同じ関数の中で同意を判定しているか (判定を含む関数の中で、判定のあとに数える) */
function consumeCoveredByConsent(a: FileAnalysis, call: ConsumeCall): boolean {
  return a.consentCalls.some((c) => c.pos < call.pos && (c.fn === null || within(call.pos, c.fn)));
}

/**
 * AI 相談のアクションの実行 (consultation-action-executor.ts) から、
 * 実行の API が同意を判定するアクション (AI_SENDING_ACTION_TYPES の new Set([...]) の中身) と、
 * 献立の生成として数えるアクション (countMenuGenerationAction を呼ぶ case の値) を取り出す
 */
function consultationActionTypes(source: string): { sendingTypes: string[]; countedTypes: string[] } {
  const sf = ts.createSourceFile('consultation-action-executor.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sendingTypes: string[] = [];
  const countedTypes: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'AI_SENDING_ACTION_TYPES' &&
      node.initializer &&
      ts.isNewExpression(node.initializer)
    ) {
      const list = node.initializer.arguments?.[0];
      if (list && ts.isArrayLiteralExpression(list)) {
        for (const element of list.elements) if (ts.isStringLiteralLike(element)) sendingTypes.push(element.text);
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'countMenuGenerationAction') {
      let current: ts.Node | undefined = node.parent;
      while (current && !ts.isCaseClause(current)) current = current.parent;
      countedTypes.push(current && ts.isCaseClause(current) && ts.isStringLiteralLike(current.expression) ? current.expression.text : '?');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { sendingTypes: sortedUnique(sendingTypes), countedTypes: sortedUnique(countedTypes) };
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
      (file) => (file.startsWith('src/app/') && !isRouteHandlerFile(file)) || /^src\/middleware\.tsx?$/.test(file),
    );
    const offenders = nonRouteEntrypoints.filter((file) => aiSinkFilesReachedFrom(file).length > 0);
    expect(offenders, 'AI は API ルートから呼び、そこで利用回数を数えること: ' + offenders.join(', ')).toEqual([]);
  });

  it('route ハンドラは src/app 全体から集める: src/app/api の外の route ハンドラのうち AI に届かないものの全数は一覧 (NON_API_ROUTE_HANDLERS) どおり', () => {
    const nonApi = routeFiles.filter((file) => !file.startsWith('src/app/api/'));
    // 走査が api の外を見ていなければ、ここが空になる (実在する api の外の route を見落としている)
    expect(nonApi.length, 'src/app/api の外の route ハンドラを 1 つも見つけていない (走査の範囲が狭い)').toBeGreaterThan(0);
    expect(
      nonApi.filter((file) => !aiRoutes.includes(file)),
      'src/app/api の外の route ハンドラが増えた・減った: AI に届かないなら NON_API_ROUTE_HANDLERS に足す (届くなら数えて AI_QUOTA_ROUTES に足す)',
    ).toEqual(Object.keys(NON_API_ROUTE_HANDLERS).sort());
    for (const [file, note] of Object.entries(NON_API_ROUTE_HANDLERS)) expect(note.trim().length, file).toBeGreaterThan(5);
  });

  it('数える場所では、同じ関数の中で先に同意を判定している (同意の判定 → 利用回数の記録。同意していない人の操作は数えない)', () => {
    const violations: string[] = [];
    for (const file of sortedUnique([...Object.keys(AI_QUOTA_ROUTES), ...Object.keys(NON_ROUTE_CALLERS)])) {
      const a = analyses.get(file)!;
      const byCallers = CONSENT_CHECKED_BY_CALLERS[file];
      for (const call of a.consumeCalls) {
        if (byCallers && call.feature !== null && (byCallers.features as readonly string[]).includes(call.feature)) continue;
        if (!consumeCoveredByConsent(a, call)) violations.push(`${file} (${call.feature})`);
      }
    }
    expect(
      violations,
      '利用回数を数える前に、同じ関数の中で同意を判定すること (requireAiConsent / checkUserAiConsent。' +
        '同意していない人の操作は AI へ送らないので数えない。呼び出し元が判定するなら CONSENT_CHECKED_BY_CALLERS に書く): ' +
        violations.join(', '),
    ).toEqual([]);
  });

  describe('同意の判定を呼び出し元が済ませる数える関数 (CONSENT_CHECKED_BY_CALLERS): 呼び出し元の全数が一覧どおりで、数える関数に届く呼び出しより前に同意を判定している', () => {
    it.each(Object.entries(CONSENT_CHECKED_BY_CALLERS))('%s', (library, { callers, reason }) => {
      expect(reason.trim().length, '理由を書くこと').toBeGreaterThan(10);
      const importers = routeFiles.filter((route) =>
        analyses.get(route)!.imports.some((specifier) => resolveImport(route, specifier) === library),
      );
      expect(importers, `${library} を import する route が増えた・減った: CONSENT_CHECKED_BY_CALLERS の callers を直すこと`).toEqual(
        Object.keys(callers).sort(),
      );
      for (const [route, sendingCall] of Object.entries(callers)) {
        const a = analyses.get(route)!;
        const sends = a.namedCalls.filter((c) => c.name === sendingCall);
        expect(sends.length, `${route}: ${sendingCall} の呼び出しが無い`).toBeGreaterThan(0);
        for (const send of sends) {
          expect(
            a.consentCalls.some((c) => c.pos < send.pos && (c.fn === null || within(send.pos, c.fn))),
            `${route}: ${sendingCall} を呼ぶ前に、同じ関数の中で同意を判定すること`,
          ).toBe(true);
        }
      }
    });
  });

  it('ライブラリが数える献立の生成のアクションは、実行の API が同意を判定するアクション (AI_SENDING_ACTION_TYPES) と同じ', () => {
    const file = 'src/lib/ai/consultation-action-executor.ts';
    const { sendingTypes, countedTypes } = consultationActionTypes(fs.readFileSync(path.join(ROOT, file), 'utf-8'));
    expect(countedTypes.length, '献立の生成のアクションで数えていない').toBeGreaterThan(0);
    expect(countedTypes, '数えるアクションと、同意を判定するアクションが食い違っている').toEqual(sendingTypes);
  });

  it('数える場所より前に、同じ経路で AI へ送っていない (利用回数の記録 → AI への送信)。同じファイルのヘルパー関数を経由する送信もたどる', () => {
    const violations = sortedUnique(
      sortedUnique([...Object.keys(AI_QUOTA_ROUTES), ...Object.keys(NON_ROUTE_CALLERS)]).flatMap((file) =>
        sendBeforeCountViolations(file, analyses.get(file)!),
      ),
    );
    expect(
      violations,
      'AI に届く関数 (同じファイルのヘルパー関数を含む) は、利用回数を数えたあとで呼ぶこと ' +
        '(import した関数で、AI へ送らないものなら、理由を書いて AI_MODULE_CALLS_BEFORE_COUNT に足す)',
    ).toEqual([]);
    for (const [file, names] of Object.entries(AI_MODULE_CALLS_BEFORE_COUNT)) {
      for (const [name, reason] of Object.entries(names)) {
        expect(reason.trim().length, `${file} ${name}: 理由を書くこと`).toBeGreaterThan(10);
        const a = analyses.get(file)!;
        expect(
          a.importedNames.has(name) && a.refs.some((ref) => ref.name === name),
          `${file} は ${name} をもう使っていない: AI_MODULE_CALLS_BEFORE_COUNT から消すこと`,
        ).toBe(true);
        // AI に届かない関数を載せておくと、一覧が「見逃してよい名前」の置き場になる。載せるのは、走査が AI に届くとみなすものだけ
        expect(refReachesAi(file, a, name), `${file} ${name} は AI に届かない (載せなくても検査を通る): AI_MODULE_CALLS_BEFORE_COUNT から消すこと`).toBe(true);
      }
    }
  });

  it('AI に届く route の公開ハンドラ (GET / POST / PUT ...) は、どれも数えるか、AI に届かないハンドラの一覧 (ROUTE_HANDLERS_WITHOUT_AI) にある。ハンドラの全数は一覧と一致する', () => {
    const violations = sortedUnique(
      sortedUnique([...Object.keys(AI_QUOTA_ROUTES), ...Object.keys(ROUTES_COUNTED_IN_LIBRARY)]).flatMap((file) =>
        handlerViolations(file, analyses.get(file)!),
      ),
    );
    expect(
      violations,
      '数える route に足したハンドラは、そのハンドラの中 (同じファイルの関数を経由してよい) で consumeAiQuota を呼ぶこと。' +
        'AI に届かないハンドラなら、理由を書いて ROUTE_HANDLERS_WITHOUT_AI に足す',
    ).toEqual([]);
    for (const [file, methods] of Object.entries(ROUTE_HANDLERS_WITHOUT_AI)) {
      expect(file in AI_QUOTA_ROUTES || file in ROUTES_COUNTED_IN_LIBRARY, `${file} は数える route ではない: 一覧から消すこと`).toBe(true);
      for (const [method, reason] of Object.entries(methods)) expect(reason.trim().length, `${file} ${method}: 理由を書くこと`).toBeGreaterThan(10);
    }
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
    it.each(Object.entries(ROUTES_COUNTED_IN_LIBRARY))('%s', (file, { library, entry, reason }) => {
      expect(reason.trim().length, '理由を書くこと').toBeGreaterThan(10);
      expect(analyses.get(file)?.consumeCalls.length, `${file} は自分で数えている: AI_QUOTA_ROUTES に移すこと`).toBe(0);
      expect(library in NON_ROUTE_CALLERS, `${library} は NON_ROUTE_CALLERS (数えるライブラリ) に載せること`).toBe(true);
      const imported = analyses.get(file)!.imports.map((specifier) => resolveImport(file, specifier));
      expect(imported, `${file} は ${library} を import すること`).toContain(library);
      // 入口 (entry) は、ライブラリが export した関数で、その本文 (同じファイルの関数を経由してよい) で数える
      const found = findExport(library, entry);
      expect(found?.entry.kind, `${library} が ${entry} を export していない`).toBe('local');
      const owner = analyses.get(found!.file)!;
      const spans = found!.entry.kind === 'local' ? owner.topLevel.get(found!.entry.name) ?? [] : [];
      expect(spans.some((span) => spanReachesConsume(owner, span)), `${library} の ${entry} が consumeAiQuota に届かない`).toBe(true);
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
  /** 同意の判定 (requireAiConsentForUser / checkAiConsent。T15 / #1154) の呼び出しの位置と、それを含む最も内側のブロック */
  consentCalls: Array<{ pos: number; block: Span | null }>;
}

/** Edge Functions の同意の判定 (supabase/functions/_shared/ai-consent-guard.ts) */
const EDGE_CONSENT_FUNCTIONS = new Set(['requireAiConsentForUser', 'checkAiConsent']);

/** JWT で直接呼ばれたときだけ数えるための変数名 (JWT を確かめたブロックの中でだけ代入し、AI へ送る直前に if で数える) */
const DIRECT_JWT_USER_ID = 'directJwtUserId';

function analyzeEdgeSource(source: string, fileName = 'index.ts'): EdgeAnalysis {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const analysis: EdgeAnalysis = { authCalls: [], consumeCalls: [], directJwtAssignments: [], consentCalls: [] };

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
      if (ts.isIdentifier(callee) && EDGE_CONSENT_FUNCTIONS.has(callee.text)) analysis.consentCalls.push({ pos, block: nearestBlock(node) });

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

/**
 * consumeEdgeAiQuota の呼び出しの前に、同じ経路で同意を判定しているか。次のどちらか:
 *  (a) 同意の判定のあと、それを含むブロックの中で数える
 *  (b) if (directJwtUserId) の中で数えるとき、同意の判定のあと、それを含むブロックの中で directJwtUserId に代入している
 *      (JWT を確かめたブロックの中で判定してから、数える対象の利用者を決める)
 */
function edgeConsumeCoveredByConsent(a: EdgeAnalysis, call: EdgeAnalysis['consumeCalls'][number]): boolean {
  const inBlock = (pos: number, block: Span | null) => !!block && pos >= block.start && pos < block.end;
  return a.consentCalls.some(
    (consent) =>
      (consent.pos < call.pos && inBlock(call.pos, consent.block)) ||
      (call.guardedByDirectJwt &&
        call.userIdArgument === DIRECT_JWT_USER_ID &&
        a.directJwtAssignments.length > 0 &&
        a.directJwtAssignments.every((assignment) => consent.pos < assignment && inBlock(assignment, consent.block))),
  );
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

  describe('数える前に同意を判定している (同意の判定 → 利用回数の記録。同意していない人の操作は数えない)', () => {
    it.each(Object.keys(EDGE_USER_JWT_FUNCTIONS))('%s', (name) => {
      const a = edgeAnalyses.get(name)!;
      expect(a.consentCalls.length, `${name} が同意を判定していない (requireAiConsentForUser / checkAiConsent)`).toBeGreaterThan(0);
      for (const call of a.consumeCalls) {
        expect(edgeConsumeCoveredByConsent(a, call), `${name}: consumeEdgeAiQuota の前に、同じ経路で同意を判定すること`).toBe(true);
      }
    });
  });

  it('service-ai の関数は、service role (または cron のシークレット) でしか呼べない (ユーザーの JWT で直接呼んで、数えずに AI を使えない)', () => {
    // 認証の書き方: 共通の requireServiceRole(req)、または service role key との完全一致の比較
    const SERVICE_ONLY_GUARD = /requireServiceRole\(|[!=]==\s*(?:SERVICE_ROLE_KEY|SUPABASE_SERVICE_KEY|SUPABASE_SERVICE_ROLE_KEY)\b/;
    const unguarded: string[] = [];
    for (const [name, entry] of Object.entries(EDGE_FUNCTIONS)) {
      if (entry.kind !== 'service-ai') continue;
      // index.ts から相対 import でたどれるファイル (共通の取り込み処理 _shared/catalog/import-runner.ts など) のどこかにあればよい
      const seen = new Set<string>();
      const stack = [`${EDGE_ROOT}/${name}/index.ts`];
      let guarded = false;
      while (stack.length > 0 && !guarded) {
        const file = stack.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        const full = path.join(ROOT, file);
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
        const source = fs.readFileSync(full, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        if (SERVICE_ONLY_GUARD.test(source)) guarded = true;
        for (const specifier of edgeFileAnalysis(file)?.imports ?? []) {
          if (specifier.startsWith('.') && !specifier.endsWith('/auth.ts')) {
            stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
          }
        }
      }
      if (!guarded) unguarded.push(name);
    }
    expect(
      unguarded,
      'service-ai の関数が service role の確認をしていない (ユーザーが直接呼ぶと、利用回数を数えずに AI を使えてしまう)。' +
        'requireServiceRole を使うか、ユーザーの JWT で呼べるなら user-jwt にして consumeEdgeAiQuota で数えること: ' +
        unguarded.join(', '),
    ).toEqual([]);
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

describe('AI 利用回数の記録 (#1177): 既知の穴 (利用者が書けるキューから AI へ送る経路)', () => {
  it.each(Object.entries(USER_WRITABLE_AI_QUEUES))('%s は、まだ利用者 (authenticated) が書ける。閉じたらこの一覧と説明を直す', (table, { worker, note }) => {
    expect(note.trim().length).toBeGreaterThan(10);
    expect(fs.existsSync(path.join(ROOT, worker)), `${worker} が無い`).toBe(true);
    const writable = authenticatedCanWrite(table);
    expect(
      writable.insert || writable.update,
      `${table} は利用者から書けなくなった (穴が閉じた)。USER_WRITABLE_AI_QUEUES から消し、AI_QUOTA_EXEMPT・CRON_ENTRYPOINTS・EDGE_FUNCTIONS の説明と ` +
        'supabase/functions/README.md の「既知の穴」を、事実 (取り出す側で数えなくてよい理由) に合わせて直すこと',
    ).toBe(true);
  });

  it('数えない一覧の説明が、既知の穴を隠していない (キューを取り出して AI へ送る側の説明に、直接書ける行は数えられないことを書く)', () => {
    expect(AI_QUOTA_EXEMPT['src/app/api/cron/process-menu-queue/route.ts']).toContain('weekly_menu_requests');
    expect(AI_QUOTA_EXEMPT['src/app/api/cron/process-menu-queue/route.ts']).toContain('USER_WRITABLE_AI_QUEUES');
    expect(CRON_ENTRYPOINTS['vercel:/api/cron/process-menu-queue']).toContain('USER_WRITABLE_AI_QUEUES');
    const imageWorker = EDGE_FUNCTIONS['process-meal-image-jobs'];
    expect(imageWorker.kind === 'service-ai' ? imageWorker.callers : '').toContain('USER_WRITABLE_AI_QUEUES');
    const readme = fs.readFileSync(path.join(ROOT, 'supabase/functions/README.md'), 'utf-8');
    for (const table of Object.keys(USER_WRITABLE_AI_QUEUES)) expect(readme, `README.md に ${table} の既知の穴が書かれていない`).toContain(table);
    expect(readme).toContain('既知の穴');
  });

  it('migration の読み取り: 権限とポリシーの両方があるときだけ書けるとみなし、REVOKE・DROP POLICY で閉じる', () => {
    const base = {
      name: '1.sql',
      sql: `
        CREATE POLICY "own_all" ON "public"."q" USING (("auth"."uid"() = "user_id"));
        GRANT INSERT, SELECT, UPDATE ON TABLE public."q" TO "authenticated";
      `,
    };
    expect(authenticatedCanWrite('q', [base])).toEqual({ insert: true, update: true });
    // 権限を取り上げる
    expect(authenticatedCanWrite('q', [base, { name: '2.sql', sql: 'REVOKE INSERT, UPDATE ON TABLE public.q FROM authenticated;' }])).toEqual({
      insert: false,
      update: false,
    });
    // 許可のポリシーを消す (SELECT だけのポリシーでは書けない)
    expect(
      authenticatedCanWrite('q', [
        base,
        { name: '2.sql', sql: 'DROP POLICY IF EXISTS "own_all" ON public.q; CREATE POLICY "own_read" ON public.q FOR SELECT USING (true);' },
      ]),
    ).toEqual({ insert: false, update: false });
    // 名前が前方一致する別のテーブル (q_archive) の権限・ポリシーは、q のものとして読まない
    expect(
      authenticatedCanWrite('q', [
        { name: '1.sql', sql: 'CREATE POLICY "a" ON public.q_archive USING (true);\nGRANT ALL ON TABLE public.q_archive TO authenticated;' },
      ]),
    ).toEqual({ insert: false, update: false });
    // service_role にだけ付けたポリシーは、authenticated の許可にしない。コメントの中の GRANT は読まない
    expect(
      authenticatedCanWrite('q', [
        { name: '1.sql', sql: '-- GRANT ALL ON TABLE public.q TO authenticated;\nCREATE POLICY "svc" ON public.q FOR ALL TO service_role USING (true);\nGRANT ALL ON TABLE public.q TO authenticated;' },
      ]),
    ).toEqual({ insert: false, update: false });
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

  it('route ハンドラは src/app 全体 (api の外・route.tsx を含む) から集める。ページ・レイアウトは route ハンドラにしない', () => {
    expect(isRouteHandlerFile('src/app/api/ai/analyze-fridge/route.ts')).toBe(true);
    expect(isRouteHandlerFile('src/app/(auth)/auth/callback/route.ts')).toBe(true);
    expect(isRouteHandlerFile('src/app/feed/route.tsx')).toBe(true);
    expect(isRouteHandlerFile('src/app/route.ts')).toBe(true);
    expect(isRouteHandlerFile('src/app/(main)/home/page.tsx')).toBe(false);
    expect(isRouteHandlerFile('src/app/layout.tsx')).toBe(false);
    expect(isRouteHandlerFile('src/lib/route.ts')).toBe(false);
    // api の外に AI を呼ぶ route を置くと、AI の印のある route ハンドラとして見つかる (全数の突き合わせで、数えるか分類を求められる)
    const file = 'src/app/(main)/ai-shortcut/route.ts';
    const a = analyzeSource(`import OpenAI from 'openai'; export async function POST() { return new OpenAI(); }`, file);
    expect(isRouteHandlerFile(file) && a.sinks.length > 0).toBe(true);
  });

  it('同意の判定 (@/lib/ai/consent-guard の requireAiConsent / checkUserAiConsent) の呼び出しと、数える前に判定しているかを読み取る', () => {
    const ordered = analyzeSource(`
      import { requireAiConsent } from '@/lib/ai/consent-guard';
      import { consumeAiQuota } from '@/lib/plan/entitlements';
      export async function POST() {
        const denied = await requireAiConsent(supabase, user.id);
        if (denied) return denied;
        const quota = await consumeAiQuota(user.id, 'photo_analysis');
        if (!quota.allowed) return null;
      }
    `);
    expect(ordered.consentCalls).toHaveLength(1);
    expect(consumeCoveredByConsent(ordered, ordered.consumeCalls[0])).toBe(true);

    // 数えてから同意を判定する (同意していない人の操作を数えてしまう)
    const reversed = analyzeSource(`
      import { checkUserAiConsent as consentOf } from '@/lib/ai/consent-guard';
      import { consumeAiQuota } from '@/lib/plan/entitlements';
      export async function POST() {
        const quota = await consumeAiQuota(user.id, 'health_review');
        const consent = await consentOf(supabase, user.id);
        if (consent.allowed && quota.allowed) send();
      }
    `);
    expect(reversed.consentCalls).toHaveLength(1);
    expect(consumeCoveredByConsent(reversed, reversed.consumeCalls[0])).toBe(false);

    // 別の関数での判定・別のモジュールの同名関数は、判定に数えない
    const otherFunction = analyzeSource(`
      import { requireAiConsent } from '@/lib/ai/consent-guard';
      import { consumeAiQuota } from '@/lib/plan/entitlements';
      export async function GET() { await requireAiConsent(supabase, user.id); }
      export async function POST() { const q = await consumeAiQuota(user.id, 'consultation'); if (!q.allowed) return null; }
    `);
    expect(consumeCoveredByConsent(otherFunction, otherFunction.consumeCalls[0])).toBe(false);
    const otherModule = analyzeSource(`
      import { requireAiConsent } from '@/lib/somewhere-else';
      export async function POST() { await requireAiConsent(supabase, user.id); }
    `);
    expect(otherModule.consentCalls).toEqual([]);
  });

  it('数える前の送信: Edge Function の呼び出し・提供元の URL の位置と、import した関数の呼び出しを読み取る。switch の別の case は同じ経路にしない', () => {
    const a = analyzeSource(`
      import { consumeAiQuota } from '@/lib/plan/entitlements';
      import { generateReview } from '@/lib/ai/review';
      import * as helpers from './helpers';
      export async function run(action) {
        switch (action.type) {
          case 'generate': {
            await supabase.functions.invoke('generate-menu-v5', { body: {} });
            break;
          }
          case 'review': {
            const early = await generateReview();
            helpers.prepare();
            const q = await consumeAiQuota(user.id, 'health_review');
            if (!q.allowed) return null;
            await fetch('https://api.openai.com/v1/chat/completions');
            break;
          }
        }
      }
    `);
    const call = a.consumeCalls[0];
    expect(call.scope).not.toBeNull();
    // 別の case の Edge Function の呼び出しは、数える経路の前の送信にしない
    expect(a.sinkSites.filter((site) => site.pos < call.pos && within(site.pos, call.scope))).toEqual([]);
    // 数えたあとの送信は、前の送信にしない (位置が後ろ)
    expect(a.sinkSites.some((site) => site.pos > call.pos && within(site.pos, call.scope))).toBe(true);
    // 同じ case の中で数える前に呼んだ import の関数 (名前と、import 元)
    const before = a.importedCalls.filter((c) => c.pos < call.pos && within(c.pos, call.scope)).map((c) => `${c.name}:${c.specifier}`);
    expect(before).toEqual(['generateReview:@/lib/ai/review', 'helpers:./helpers']);
    // API キーを読むだけ (クライアントを作るだけ) は、送信の位置にしない
    expect(analyzeSource(`export function f() { const key = process.env.OPENAI_API_KEY; }`).sinkSites).toEqual([]);
  });

  it('回帰 (R2 指摘 2): 同じファイルのヘルパー関数を経由して、数える前に AI へ送ると落ちる (実際の route に変異を入れて確かめる)', () => {
    const file = 'src/app/api/health/blood-tests/route.ts';
    const source = fs.readFileSync(path.join(ROOT, file), 'utf-8');
    // 変異を入れない実物は通る (この回帰テストが空振りしていないことの確かめ)
    expect(sendBeforeCountViolations(file, analyzeSource(source, file))).toEqual([]);
    // 同意の判定のあと、記録の前に、AI のレビュー (ヘルパー関数の中で getFastLLMClient().chat.completions.create) を呼ぶ
    const anchor = 'if (aiConsent.allowed) {';
    expect(source.split(anchor).length - 1, `${file} に ${anchor} が 1 つだけあること (変異の場所)`).toBe(1);
    const mutated = source.replace(anchor, `${anchor}\n    await generateBloodTestReview(data);`);
    expect(sendBeforeCountViolations(file, analyzeSource(mutated, file))).toEqual([
      `${file}: generateBloodTestReview (AI へ送るところに届く) を数える前に使っている`,
    ]);
  });

  it('数える前の送信: ヘルパー関数を何段たどっても見つける。数えたあとの呼び出し・AI に届かないヘルパーは送信にしない', () => {
    const file = 'src/app/api/synthetic/route.ts';
    const make = (body: string) =>
      analyzeSource(
        `
        import { consumeAiQuota } from '@/lib/plan/entitlements';
        const SYSTEM_PROMPT = 'あなたは栄養士です';
        async function send(text: string) { return fetch('https://api.openai.com/v1/chat/completions', { body: text }); }
        async function review(text: string) { return send(SYSTEM_PROMPT + text); }
        function format(text: string) { return SYSTEM_PROMPT + text; }
        const helpers = { review };
        export async function POST() {
          ${body}
        }
      `,
        file,
      );
    const counted = "const q = await consumeAiQuota(user.id, 'health_review'); if (!q.allowed) return null;";
    expect(sendBeforeCountViolations(file, make(`const t = format('x'); ${counted} await review(t);`))).toEqual([]);
    expect(sendBeforeCountViolations(file, make(`await review('x'); ${counted}`))).toEqual([
      `${file}: review (AI へ送るところに届く) を数える前に使っている`,
    ]);
    // オブジェクトに入れたヘルパー (helpers.review) も、宣言の本文から届く
    expect(sendBeforeCountViolations(file, make(`await helpers.review('x'); ${counted}`))).toEqual([
      `${file}: helpers (AI へ送るところに届く) を数える前に使っている`,
    ]);
  });

  it('数える前に使ってよい名前 (AI_MODULE_CALLS_BEFORE_COUNT) でも、作ったクライアントでそのまま送る書き方は送信とみなす', () => {
    const file = 'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts';
    const make = (body: string) =>
      analyzeSource(
        `
        import { consumeAiQuota } from '@/lib/plan/entitlements';
        import { getFastLLMClient } from '@/lib/ai/fast-llm';
        export async function POST() {
          ${body}
          const q = await consumeAiQuota(user.id, 'consultation');
          if (!q.allowed) return null;
        }
      `,
        file,
      );
    expect(sendBeforeCountViolations(file, make('const client = getFastLLMClient();'))).toEqual([]);
    expect(sendBeforeCountViolations(file, make("await getFastLLMClient().chat.completions.create({ model: 'm', messages: [] });"))).toEqual([
      `${file}: getFastLLMClient (AI へ送るところに届く) を数える前に使っている`,
    ]);
  });

  it('import した関数は、export した宣言の本文で AI に届くかを決める (同じモジュールの AI を使わない関数は届かない。export * の先もたどる)', () => {
    const file = 'src/app/api/synthetic/route.ts';
    const a = analyzeSource(
      `
      import { cancelPendingMealImageJobs, triggerMealImageJobProcessing } from '@/lib/meal-image-jobs';
      import { getFastLLMClient } from '@/lib/ai/fast-llm';
      import OpenAI from 'openai';
    `,
      file,
    );
    // src/lib/meal-image-jobs.ts は export * from '../../lib/meal-image-jobs'。取り消しは DB だけ、起動は Edge Function を呼ぶ
    expect(refReachesAi(file, a, 'cancelPendingMealImageJobs')).toBe(false);
    expect(refReachesAi(file, a, 'triggerMealImageJobProcessing')).toBe(true);
    expect(refReachesAi(file, a, 'getFastLLMClient')).toBe(true);
    expect(refReachesAi(file, a, 'OpenAI')).toBe(true);
  });

  it('回帰 (R2 指摘 1): すでに数えている route に、数えない AI のハンドラを足すと落ちる (実際の route に変異を入れて確かめる)', () => {
    const file = 'src/app/api/health/blood-tests/route.ts';
    const source = fs.readFileSync(path.join(ROOT, file), 'utf-8');
    // 変異を入れない実物は通る
    expect(handlerViolations(file, analyzeSource(source, file))).toEqual([]);
    // 数えずに AI へ送る PUT を足す (R2 の指摘の変異そのもの)
    const withAiPut = `${source}
export async function PUT(request: NextRequest) {
  const completion = await getFastLLMClient().chat.completions.create({ model: getFastLLMModel(), messages: [] });
  return NextResponse.json({ completion });
}
`;
    expect(handlerViolations(file, analyzeSource(withAiPut, file))).toEqual([`${file} PUT: AI に届くのに、このハンドラでは数えていない`]);
    // 同じファイルのヘルパー関数を経由して AI へ送る PUT も同じ
    const viaHelper = `${source}
export async function PUT(request: NextRequest) {
  return NextResponse.json({ review: await generateBloodTestReview(await request.json()) });
}
`;
    expect(handlerViolations(file, analyzeSource(viaHelper, file))).toEqual([`${file} PUT: AI に届くのに、このハンドラでは数えていない`]);
    // AI に届かないハンドラでも、一覧に無ければ落ちる (ハンドラの数の変化)
    const withPlainPut = `${source}
export async function PUT() {
  return NextResponse.json({ ok: true });
}
`;
    expect(handlerViolations(file, analyzeSource(withPlainPut, file))).toEqual([
      `${file} PUT: 数えないハンドラが増えた (AI に届かないなら、理由を書いて ROUTE_HANDLERS_WITHOUT_AI に足す)`,
    ]);
    // 一覧に載っている GET が AI に届くようになったら落ちる
    const getAnchor = 'export async function GET(request: NextRequest) {';
    expect(source.split(getAnchor).length - 1, `${file} に ${getAnchor} が 1 つだけあること (変異の場所)`).toBe(1);
    const aiInGet = source.replace(getAnchor, `${getAnchor}\n  await generateBloodTestReview({});`);
    expect(handlerViolations(file, analyzeSource(aiInGet, file))).toEqual([
      `${file} GET: AI に届かないハンドラの一覧にあるのに、AI に届く (数えること)`,
    ]);
  });

  it('公開ハンドラの読み取り: export async function / export const / export { x as POST } / 別のモジュールからの再 export', () => {
    const a = analyzeSource(
      `
      import { consumeAiQuota } from '@/lib/plan/entitlements';
      async function handle() { const q = await consumeAiQuota(user.id, 'consultation'); if (!q.allowed) return null; }
      async function plain() { return null; }
      export async function GET() { return plain(); }
      export const POST = async () => handle();
      export { plain as PATCH };
      export { DELETE } from './other';
    `,
      'src/app/api/synthetic/route.ts',
    );
    expect(a.handlers.map((h) => [h.method, h.span !== null])).toEqual([
      ['GET', true],
      ['POST', true],
      ['PATCH', true],
      ['DELETE', false],
    ]);
    const post = a.handlers.find((h) => h.method === 'POST')!;
    const get = a.handlers.find((h) => h.method === 'GET')!;
    // ハンドラから同じファイルの関数を経由して数えるものは、数えるハンドラ
    expect(spanReachesConsume(a, post.span!)).toBe(true);
    expect(spanReachesConsume(a, get.span!)).toBe(false);
  });

  it('AI 相談のアクション: 同意を判定するアクション (AI_SENDING_ACTION_TYPES) と、献立の生成として数えるアクションを取り出す', () => {
    const types = consultationActionTypes(`
      export const AI_SENDING_ACTION_TYPES: ReadonlySet<string> = new Set(['generate_day_menu', 'generate_single_meal']);
      async function run(action) {
        switch (action.action_type) {
          case 'generate_day_menu': { await countMenuGenerationAction(user.id); break; }
          case 'generate_week_menu': { await countMenuGenerationAction(user.id); break; }
          case 'delete_meal': { break; }
        }
      }
    `);
    expect(types.sendingTypes).toEqual(['generate_day_menu', 'generate_single_meal']);
    expect(types.countedTypes).toEqual(['generate_day_menu', 'generate_week_menu']);
  });

  it('Edge Function: 数える前に、同じ経路で同意を判定しているか (判定のブロックの中であと / 判定のあとに directJwtUserId に代入)', () => {
    const deferred = analyzeEdgeSource(`
      Deno.serve(async (req) => {
        let directJwtUserId: string | null = null;
        if (!isServiceRole) {
          const { data: { user } } = await supabaseAuth.auth.getUser();
          const denied = await requireAiConsentForUser(user.id, corsHeaders);
          if (denied) return denied;
          directJwtUserId = user.id;
        }
        if (directJwtUserId) {
          const quota = await consumeEdgeAiQuota(req, directJwtUserId, 'consultation');
          if (!quota.allowed) return aiQuotaExceededResponse(quota, corsHeaders);
        }
      });
    `);
    expect(deferred.consentCalls).toHaveLength(1);
    expect(edgeConsumeCoveredByConsent(deferred, deferred.consumeCalls[0])).toBe(true);

    // 判定より前に directJwtUserId を決めていて、数える場所も判定のブロックの外 (未同意でも数えてしまう)
    const assignedFirst = analyzeEdgeSource(`
      Deno.serve(async (req) => {
        let directJwtUserId: string | null = null;
        if (!isServiceRole) {
          const { data: { user } } = await supabaseAuth.auth.getUser();
          directJwtUserId = user.id;
          const denied = await requireAiConsentForUser(user.id, corsHeaders);
          if (denied) return denied;
        }
        if (directJwtUserId) {
          const quota = await consumeEdgeAiQuota(req, directJwtUserId, 'consultation');
          if (!quota.allowed) return aiQuotaExceededResponse(quota, corsHeaders);
        }
      });
    `);
    expect(edgeConsumeCoveredByConsent(assignedFirst, assignedFirst.consumeCalls[0])).toBe(false);

    // 数えてから同意を判定する
    const countedFirst = analyzeEdgeSource(`
      Deno.serve(async (req) => {
        const authResult = await requireAuth(req);
        const quota = await consumeEdgeAiQuota(req, authResult.userId, 'photo_analysis');
        const consent = await checkAiConsent(supabase, authResult.userId);
        if (!quota.allowed || !consent.allowed) return null;
      });
    `);
    expect(edgeConsumeCoveredByConsent(countedFirst, countedFirst.consumeCalls[0])).toBe(false);
  });
});
