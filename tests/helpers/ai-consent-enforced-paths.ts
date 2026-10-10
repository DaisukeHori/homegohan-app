/**
 * テスト用: 利用者のデータを AI 事業者へ送る入口の一覧 (1 つだけ)。
 * 外国の AI 事業者への提供の同意の判定 (T15 / #1154) と、AI の利用回数の記録 (#1177) が、同じ一覧を使う。
 *
 *   - consent : 同意の判定の場所 (ENFORCED_*) / 判定しない理由 (EXEMPT_*)
 *   - usage   : 利用回数の記録の扱い (下の AiUsage)。route は公開ハンドラ (GET / POST ...) ごと
 *
 * 使うテスト:
 *   - tests/ai-consent-enforcement.test.ts        : 棚卸し (AI に届く入口は、すべてこの一覧にある。検出器は tests/helpers/ai-reach.ts)
 *   - tests/ai-consent-enforcement-routes.test.ts : ENFORCED_ROUTES の各ハンドラを実際に呼び、同意の判定 → 記録 → 送信の順を確かめる
 *   - tests/ai-consent-enforcement-edge.test.ts   : ENFORCED_EDGE の各関数で、判定の結果で止める if が送る呼び出しより前にあること
 *                                                   (構文木。代表の関数は実際のハンドラも呼び、記録 → 送信の順も確かめる)
 *   - tests/ai-usage-contract.test.ts             : usage の列と、記録を呼ぶ場所・機能名・公開ハンドラの全数が一致すること
 * 新しく API Route を足したら、ここに載せ、tests/ai-consent-enforcement-routes.test.ts の表にも行を足す
 * (表に行の無い AI のハンドラがあると、そのテストが落ちる)。
 */
import type { AiFeature } from '../../supabase/functions/_shared/ai-usage-core';
import type { HttpMethod } from './ai-reach';

/** 利用回数の記録 (#1177) の扱い */
export type AiUsage =
  /** ここ (このハンドラ・この関数) が AI へ送る直前に記録する (recordAiUsage / recordEdgeAiUsage)。値は記録する機能名 */
  | { record: readonly AiFeature[] }
  /** AI へ送るが、記録は別の場所が行う (どこが・なぜ) */
  | { recordedBy: string }
  /** AI へ送るが、利用者の AI の利用ではないので記録しない (運営の処理など。理由) */
  | { notRecorded: string }
  /** このハンドラは AI へ送らない (同じファイルの別のハンドラが送る。何をするか) */
  | { noAi: string };

export interface AiRouteEntry {
  /** 同意の判定の場所 (ENFORCED_ROUTES) / 判定しない理由 (EXEMPT_ROUTES) */
  consent: string;
  /** 公開ハンドラの全数と、それぞれの記録の扱い。ファイルが公開するハンドラと完全に一致すること */
  handlers: Partial<Record<HttpMethod, AiUsage>>;
}

export interface AiEdgeEntry {
  consent: string;
  usage: AiUsage;
}

const record = (...features: AiFeature[]): AiUsage => ({ record: features });

/** Next.js の API Route で、送る手前で判定を呼ぶもの */
export const ENFORCED_ROUTES: Record<string, AiRouteEntry> = {
  'src/app/api/ai/analyze-fridge/route.ts': {
    consent: '冷蔵庫の写真 (Google)。認証の直後に 403',
    handlers: { POST: record('photo_analysis') },
  },
  'src/app/api/ai/analyze-health-checkup/route.ts': {
    consent: '健康診断の写真 (Google)。認証の直後に 403',
    handlers: { POST: record('photo_analysis') },
  },
  'src/app/api/ai/analyze-meal-photo/route.ts': {
    consent: '食事の写真 (Edge Function analyze-meal-photo。Google / Perplexity)。認証の直後に 403',
    handlers: { POST: record('photo_analysis') },
  },
  'src/app/api/ai/analyze-weight-scale/route.ts': {
    consent: '体重計の写真 (Edge Function analyze-health-photo。Google)。認証の直後に 403',
    handlers: { POST: record('photo_analysis') },
  },
  'src/app/api/ai/classify-photo/route.ts': {
    consent: '写真の種類の判別 (Google)。認証の直後に 403',
    handlers: { POST: record('photo_analysis') },
  },
  'src/app/api/ai/image/generate/route.ts': {
    consent: '料理の画像の作成 (Google)。認証の直後に 403',
    handlers: { POST: record('image_generation') },
  },
  'src/app/api/ai/nutrition/route.ts': {
    consent: '写真の URL から栄養の推定 (xAI)。imageUrl のときだけ 403 (数値の保存は送らない)',
    // 画像 URL から AI で栄養を解析するときだけ記録する (nutritionData を直接渡す経路は AI を呼ばない)
    handlers: { POST: record('photo_analysis') },
  },
  'src/app/api/ai/nutrition-analysis/route.ts': {
    consent: 'GET は AI の部分だけ省いて aiSkipped。POST (献立の変更) は 403',
    // GET はアドバイス・提案を付けるとき (AI を呼ぶとき) だけ、POST は AI が提案した献立変更の実行
    handlers: { GET: record('nutrition_advice'), POST: record('menu_generation') },
  },
  'src/app/api/ai/nutrition/feedback/route.ts': {
    consent: '栄養士のコメント (OpenAI)。作成済みのコメントを返すとき以外は 403',
    handlers: {
      // キャッシュを返すだけの経路では記録しない (キャッシュが無く、生成を始めるときだけ)
      POST: record('nutrition_advice'),
      GET: { noAi: '生成済みのフィードバック (nutrition_feedback_cache) を DB から読むだけ' },
    },
  },
  'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts': {
    consent: 'AI 相談 (xAI / knowledge-gpt)。認証の直後に 403',
    handlers: {
      POST: record('consultation'),
      GET: { noAi: '会話のメッセージの一覧を DB から読むだけ' },
    },
  },
  'src/app/api/ai/consultation/sessions/[sessionId]/summarize/route.ts': {
    consent: '相談の要約 (xAI)。認証の直後に 403',
    handlers: { POST: record('consultation') },
  },
  'src/app/api/ai/consultation/sessions/[sessionId]/close/route.ts': {
    consent: '相談を閉じる。要約 (xAI) だけを省いて閉じる (aiSkipped)',
    handlers: { POST: record('consultation') },
  },
  'src/app/api/ai/consultation/actions/[actionId]/execute/route.ts': {
    consent: '献立の生成のアクションだけ 403 (AI_SENDING_ACTION_TYPES)',
    handlers: {
      POST: {
        recordedBy:
          'アクションの種類によって AI を使うかが決まる。AI を使うアクション (献立の生成 3 種 = menu_generation、update_meal が付ける料理画像 = image_generation) だけを、' +
          'runConsultationAction (src/lib/ai/consultation-action-executor.ts。LIBRARY_RECORDERS) が AI へ送る直前に記録する',
      },
      DELETE: { noAi: 'アクションの却下。ai_action_logs の状態を書き換えるだけ' },
    },
  },
  'src/app/api/ai/menu/day/regenerate/route.ts': {
    consent: '献立の生成 (Edge Function generate-menu-v4 / v5)。認証の直後に 403',
    handlers: { POST: record('menu_generation') },
  },
  'src/app/api/ai/menu/meal/generate/route.ts': {
    consent: '献立の生成。認証の直後に 403',
    handlers: { POST: record('menu_generation') },
  },
  'src/app/api/ai/menu/meal/regenerate/route.ts': {
    consent: '献立の再生成。認証の直後に 403',
    handlers: { POST: record('menu_generation') },
  },
  'src/app/api/ai/menu/v4/generate/route.ts': {
    consent: '献立の生成。認証の直後に 403',
    handlers: { POST: record('menu_generation') },
  },
  'src/app/api/ai/menu/v5/generate/route.ts': {
    consent: '献立の生成 (キューに積む。cron の側でも止める)。認証の直後に 403',
    // 利用者の操作を積む時点で記録する。送る側 (cron/process-menu-queue) は記録しない
    handlers: { POST: record('menu_generation') },
  },
  'src/app/api/ai/menu/weekly/request/route.ts': {
    consent: '週間献立の生成。認証の直後に 403',
    handlers: { POST: record('menu_generation') },
  },
  'src/app/api/health/blood-tests/route.ts': {
    consent: '血液検査のレビュー (xAI)。保存はして、レビューだけ省く (aiSkipped)',
    handlers: {
      POST: record('health_review'),
      GET: { noAi: '血液検査の結果と経年レビューを DB から読むだけ' },
    },
  },
  'src/app/api/health/checkups/route.ts': {
    consent: '健康診断のレビュー (xAI)。保存はして、レビューだけ省く (aiSkipped)',
    handlers: {
      POST: record('health_review'),
      GET: { noAi: '健康診断の結果と経年レビューを DB から読むだけ' },
    },
  },
  'src/app/api/health/insights/route.ts': {
    consent: '健康のインサイト (Google)。POST は認証の直後に 403',
    handlers: {
      POST: record('health_review'),
      GET: { noAi: '健康インサイトの一覧と未読数・アラート数を DB から読むだけ' },
    },
  },
  'src/app/api/shopping-list/regenerate/route.ts': {
    consent: '買い物リストの作成 (Edge Function regenerate-shopping-list-v2。xAI)。認証の直後に 403',
    handlers: { POST: record('shopping_list') },
  },
  'src/app/api/cron/process-menu-queue/route.ts': {
    consent: 'cron: キューの行の user_id で判定し、未同意なら Edge Function を呼ばずに失敗にする',
    handlers: {
      GET: {
        recordedBy:
          'Vercel Cron が、キューに積まれた献立生成を service role で実行する。POST /api/ai/menu/v5/generate が積む時点で記録済み (ここで記録すると二重になる)。' +
          'weekly_menu_requests は利用者 (authenticated) から書けない (#1465。AI_QUEUE_TABLES) ので、キューの行は記録を通った route だけが積む',
      },
    },
  },
};

/** AI へ送るコードに届くが、利用者のデータを送らない (または送るのは別の入口で、そちらで判定する) API Route */
export const EXEMPT_ROUTES: Record<string, AiRouteEntry> = {
  'src/app/api/admin/catalog/import/route.ts': {
    consent: 'コンビニ商品のカタログの取り込み (運営)。利用者のデータを含まない',
    handlers: { POST: { notRecorded: '運営 (admin / super_admin) 専用。Edge Function が Firecrawl / LLM を使うが、利用者の AI 利用ではない' } },
  },
  'src/app/api/super-admin/embeddings/regenerate/route.ts': {
    consent: 'レシピ・食材のデータセットの数値化 (運営)。利用者のデータを含まない',
    handlers: { POST: { notRecorded: 'super_admin 専用の埋め込み (検索用ベクトル) の再生成バッチ。利用者の AI 利用ではない' } },
  },
  'src/app/api/super-admin/plans/[id]/price-change/route.ts': {
    consent: 'Stripe の価格の同期 (Edge Function stripe-price-sync)。AI へは送らない',
    handlers: { POST: { noAi: 'Edge Function stripe-price-sync を呼ぶ (AI を使わない)' } },
  },
  'src/app/api/comparison/trigger/route.ts': {
    consent: '集計 (Edge Function calculate-segment-stats)。AI へは送らない',
    handlers: { POST: { noAi: 'Edge Function calculate-segment-stats を呼ぶ (AI を使わない)' } },
  },
  // 料理の画像の作成のジョブを積む (と、処理の Edge Function を起こす) だけの route。AI (Google) へ送るのは
  // Edge Function process-meal-image-jobs で、ジョブごとに献立の持ち主の同意を判定し、未同意なら取り消す (ENFORCED_EDGE)。
  // 記録は、利用者の操作 (献立の保存・更新) の時点で、同意済みのときだけ行う (処理する側は service role で記録しない)。
  // 未同意なら記録しないことは tests/meal-image-route-contracts.test.ts が実際の route を呼んで確かめる
  'src/app/api/meal-plans/add-from-photo/route.ts': {
    consent: '画像のジョブを取り消すだけ。送るのは process-meal-image-jobs (判定あり)',
    handlers: {
      POST: { noAi: '写真から作った献立を保存し、未処理の料理画像のジョブを取り消す (cancelPendingMealImageJobs)。ジョブを積まず、AI へ送らない' },
    },
  },
  'src/app/api/meal-plans/meals/[id]/route.ts': {
    consent: '画像のジョブを積むだけ。送るのは process-meal-image-jobs (判定あり)',
    handlers: {
      PATCH: record('image_generation'),
      DELETE: { noAi: '献立の削除。未処理の料理画像のジョブを取り消すだけ' },
    },
  },
  'src/app/api/meal-plans/meals/route.ts': {
    consent: '画像のジョブを積むだけ。送るのは process-meal-image-jobs (判定あり)',
    handlers: { POST: record('image_generation') },
  },
  'src/app/api/meals/[id]/route.ts': {
    consent: '画像のジョブを積むだけ。送るのは process-meal-image-jobs (判定あり)',
    handlers: {
      PATCH: record('image_generation'),
      GET: { noAi: '献立を 1 件 DB から読むだけ' },
      DELETE: { noAi: '献立の削除。未処理の料理画像のジョブを取り消すだけ' },
    },
  },
  'src/app/api/meals/route.ts': {
    consent: '画像のジョブを積むだけ。送るのは process-meal-image-jobs (判定あり)',
    handlers: {
      POST: record('image_generation'),
      GET: { noAi: 'その日の献立を DB から読むだけ' },
    },
  },
  // #1165 ログイン。import を辿ると環境変数の一覧 (src/lib/env.ts。AI の送信先の名前を説明に書いている) に届くだけで、
  // 送る先は Supabase Auth・Cloudflare Turnstile の確認の API・メール (Resend) だけ
  'src/app/api/auth/login/route.ts': {
    consent: 'ログイン (メールアドレスとパスワード)。AI へは送らない (env.ts の一覧に届くだけ)',
    handlers: { POST: { noAi: 'ログイン。送る先は Supabase Auth・Turnstile・Resend だけ' } },
  },
};

/**
 * 自分では AI へ送らず、キュー (weekly_menu_requests) に積むだけの route。積んだ行は cron (process-menu-queue) が
 * Edge Function generate-menu-v5 に渡して AI へ送る。積む前にも判定する (未同意なら積まない) ので ENFORCED_ROUTES に載せるが、
 * import を辿っても AI へ送るコードには届かない
 */
export const QUEUE_ONLY_ROUTES: ReadonlySet<string> = new Set(['src/app/api/ai/menu/v5/generate/route.ts']);

/** route 以外で記録を呼ぶファイル (route から呼ばれるライブラリ) と、記録する機能・理由 */
export const LIBRARY_RECORDERS: Record<string, { record: readonly AiFeature[]; reason: string }> = {
  'src/lib/ai/consultation-action-executor.ts': {
    record: ['menu_generation', 'image_generation'],
    reason:
      'AI 相談のアクションのうち AI を使うもの (献立の生成 3 種 = menu_generation、update_meal が付ける料理画像 = image_generation) だけを、AI へ送る直前に記録する。' +
      'アクションの実行 (execute) と、会話の中での自動実行 (messages) の両方から呼ばれる',
  },
};

/** Edge Function で、送る手前で判定を呼ぶもの */
export const ENFORCED_EDGE: Record<string, AiEdgeEntry> = {
  'analyze-fridge': { consent: '利用者の JWT (requireAuth) の直後', usage: record('photo_analysis') },
  'analyze-health-photo': { consent: '利用者の JWT の直後', usage: record('photo_analysis') },
  'analyze-meal-photo': { consent: '利用者の JWT の直後 (栄養推定で Perplexity にも送る)', usage: record('photo_analysis') },
  'create-derived-recipe': {
    consent: 'service role のみ。user_id があるときだけ判定 (無ければデータセットだけから作る)',
    usage: { notRecorded: '運営が service role key で手動で呼ぶ、派生レシピの作成。アプリの画面・API・cron からは呼ばない (利用者の操作ではない)' },
  },
  'generate-health-insights': { consent: '利用者の JWT の直後', usage: record('health_review') },
  'generate-hint': { consent: '利用者の JWT の直後', usage: record('nutrition_advice') },
  'generate-menu-v4': {
    consent: '利用者の JWT / service role (Next.js) / 続きの工程のどれでも、userId が決まった直後',
    // ユーザーの JWT で直接呼ばれたときだけ記録する (service role の経路は呼び出し元が記録済み)
    usage: record('menu_generation'),
  },
  'generate-menu-v5': {
    consent: '利用者の JWT / service role (Next.js・cron) / 続きの工程のどれでも、userId が決まった直後',
    usage: record('menu_generation'),
  },
  'knowledge-gpt': {
    consent: '利用者の JWT のとき。service role の呼び出しは AI 相談の API が判定してから呼ぶ',
    usage: record('consultation'),
  },
  'normalize-shopping-list': { consent: '利用者の JWT の直後', usage: record('shopping_list') },
  'process-meal-image-jobs': {
    consent: 'ジョブごとに、献立の持ち主 (meal_image_jobs.user_id) で判定。未同意なら取り消す',
    usage: {
      recordedBy:
        '料理画像の生成ジョブの実行。献立の保存・更新の route (image_generation) と、献立生成 (menu_generation の一部) が積んだジョブを、service role で処理する。' +
        'meal_image_jobs は利用者 (authenticated) から書けない (#1465。AI_QUEUE_TABLES) ので、ジョブは記録を通った route と献立生成だけが積む',
    },
  },
  'regenerate-shopping-list-v2': {
    consent: '利用者の JWT / service role のどちらでも、userId が決まった直後',
    usage: record('shopping_list'),
  },
};

/** AI へ送るコードに届くが、利用者のデータを送らない Edge Function */
export const EXEMPT_EDGE: Record<string, AiEdgeEntry> = {
  'import-convenience-catalog': {
    consent: 'コンビニ商品のカタログ (公開情報) の取り込み',
    usage: { notRecorded: '運営専用のコンビニ商品カタログの取り込み (POST /api/admin/catalog/import と pg_net の invoke_catalog_import が呼ぶ)' },
  },
  'import-familymart-catalog': { consent: '同上', usage: { notRecorded: '同上' } },
  'import-lawson-catalog': { consent: '同上', usage: { notRecorded: '同上' } },
  'import-ministop-catalog': { consent: '同上', usage: { notRecorded: '同上' } },
  'import-natural-lawson-catalog': { consent: '同上', usage: { notRecorded: '同上' } },
  'import-seven-eleven-catalog': { consent: '同上', usage: { notRecorded: '同上' } },
  'regenerate-embeddings': {
    consent: 'レシピ・食材のデータセットの数値化 (運営)',
    usage: { notRecorded: 'super_admin 専用の埋め込みの再生成 (POST /api/super-admin/embeddings/regenerate) と cron のシークレット' },
  },
  'backfill-ingredient-embeddings': {
    consent: '食材のデータセットの数値化 (運営)',
    usage: { notRecorded: '運営が service role key で手動で走らせる、食材の埋め込みの埋め戻しバッチ (利用者の操作ではない)' },
  },
  'stripe-price-sync': {
    consent: 'Stripe の価格の同期。AI へは送らない',
    usage: { noAi: 'Stripe の価格の同期 (service role)' },
  },
};
