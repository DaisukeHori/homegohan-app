/**
 * テスト用: 利用者のデータを外国の AI 事業者へ送る経路のうち、送る手前で同意を判定するものの一覧 (T15 / #1154)
 *
 * 2 つのテストが同じ一覧を使う。
 *   - tests/ai-consent-enforcement.test.ts        : 棚卸し (AI へ送るコードに届く経路は、すべてこの一覧か除外の一覧にある)
 *   - tests/ai-consent-enforcement-routes.test.ts : 一覧の各経路を実際に呼び、未同意なら AI へ送らないこと
 * 新しく経路を足したら、ここに載せ、tests/ai-consent-enforcement-routes.test.ts の表にも行を足す
 * (表に行の無い経路があると、そのテストが落ちる)。
 */

/** Next.js の API Route で、送る手前で判定を呼ぶもの → 判定の場所 */
export const ENFORCED_ROUTES: Record<string, string> = {
  'src/app/api/ai/analyze-fridge/route.ts': '冷蔵庫の写真 (Google)。認証の直後に 403',
  'src/app/api/ai/analyze-health-checkup/route.ts': '健康診断の写真 (Google)。認証の直後に 403',
  'src/app/api/ai/analyze-meal-photo/route.ts': '食事の写真 (Edge Function analyze-meal-photo。Google / Perplexity)。認証の直後に 403',
  'src/app/api/ai/analyze-weight-scale/route.ts': '体重計の写真 (Edge Function analyze-health-photo。Google)。認証の直後に 403',
  'src/app/api/ai/classify-photo/route.ts': '写真の種類の判別 (Google)。認証の直後に 403',
  'src/app/api/ai/image/generate/route.ts': '料理の画像の作成 (Google)。認証の直後に 403',
  'src/app/api/ai/nutrition/route.ts': '写真の URL から栄養の推定 (xAI)。imageUrl のときだけ 403 (数値の保存は送らない)',
  'src/app/api/ai/nutrition-analysis/route.ts': 'GET は AI の部分だけ省いて aiSkipped。POST (献立の変更) は 403',
  'src/app/api/ai/nutrition/feedback/route.ts': '栄養士のコメント (OpenAI)。作成済みのコメントを返すとき以外は 403',
  'src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts': 'AI 相談 (xAI / knowledge-gpt)。認証の直後に 403',
  'src/app/api/ai/consultation/sessions/[sessionId]/summarize/route.ts': '相談の要約 (xAI)。認証の直後に 403',
  'src/app/api/ai/consultation/sessions/[sessionId]/close/route.ts': '相談を閉じる。要約 (xAI) だけを省いて閉じる (aiSkipped)',
  'src/app/api/ai/consultation/actions/[actionId]/execute/route.ts': '献立の生成のアクションだけ 403 (AI_SENDING_ACTION_TYPES)',
  'src/app/api/ai/menu/day/regenerate/route.ts': '献立の生成 (Edge Function generate-menu-v4 / v5)。認証の直後に 403',
  'src/app/api/ai/menu/meal/generate/route.ts': '献立の生成。認証の直後に 403',
  'src/app/api/ai/menu/meal/regenerate/route.ts': '献立の再生成。認証の直後に 403',
  'src/app/api/ai/menu/v4/generate/route.ts': '献立の生成。認証の直後に 403',
  'src/app/api/ai/menu/v5/generate/route.ts': '献立の生成 (キューに積む。cron の側でも止める)。認証の直後に 403',
  'src/app/api/ai/menu/weekly/request/route.ts': '週間献立の生成。認証の直後に 403',
  'src/app/api/health/blood-tests/route.ts': '血液検査のレビュー (xAI)。保存はして、レビューだけ省く (aiSkipped)',
  'src/app/api/health/checkups/route.ts': '健康診断のレビュー (xAI)。保存はして、レビューだけ省く (aiSkipped)',
  'src/app/api/health/insights/route.ts': '健康のインサイト (Google)。POST は認証の直後に 403',
  'src/app/api/shopping-list/regenerate/route.ts': '買い物リストの作成 (Edge Function regenerate-shopping-list-v2。xAI)。認証の直後に 403',
  'src/app/api/cron/process-menu-queue/route.ts': 'cron: キューの行の user_id で判定し、未同意なら Edge Function を呼ばずに失敗にする',
};

/** Edge Function で、送る手前で判定を呼ぶもの → 判定の場所 */
export const ENFORCED_EDGE: Record<string, string> = {
  'analyze-fridge': '利用者の JWT (requireAuth) の直後',
  'analyze-health-photo': '利用者の JWT の直後',
  'analyze-meal-photo': '利用者の JWT の直後 (栄養推定で Perplexity にも送る)',
  'create-derived-recipe': 'service role のみ。user_id があるときだけ判定 (無ければデータセットだけから作る)',
  'generate-health-insights': '利用者の JWT の直後',
  'generate-hint': '利用者の JWT の直後',
  'generate-menu-v4': '利用者の JWT / service role (Next.js) / 続きの工程のどれでも、userId が決まった直後',
  'generate-menu-v5': '利用者の JWT / service role (Next.js・cron) / 続きの工程のどれでも、userId が決まった直後',
  'knowledge-gpt': '利用者の JWT のとき。service role の呼び出しは AI 相談の API が判定してから呼ぶ',
  'normalize-shopping-list': '利用者の JWT の直後',
  'process-meal-image-jobs': 'ジョブごとに、献立の持ち主 (meal_image_jobs.user_id) で判定。未同意なら取り消す',
  'regenerate-shopping-list-v2': '利用者の JWT / service role のどちらでも、userId が決まった直後',
};

