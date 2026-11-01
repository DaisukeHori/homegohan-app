-- migration: 20261101150000_ai_action_logs_action_type_generate_single_meal.sql
-- 戻し方: supabase/rollbacks/20261101150000_ai_action_logs_action_type_generate_single_meal.down.sql
-- #2189 W1: AI 相談の提案の記録 (ai_action_logs) の種類の制約 ai_action_logs_action_type_check に generate_single_meal を足す。
--
-- 背景:
--   AI 相談の提案は、会話の続きの POST (src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts の executeAndFinalizeAction) が
--   ai_action_logs に 1 行を作ってから実行する。提案のカードの「実行する」(POST /api/ai/consultation/actions/[actionId]/execute) も
--   この行を探して実行する。種類の制約 (本番のスナップショット supabase/baseline/prod_schema.sql と同じ) に、AI への指示が最も勧めている
--   generate_single_meal (1 食を作る。src/lib/ai/consultation-action-executor.ts の case 'generate_single_meal') が無かった。
--   そのため行を作れず (23514)、自動実行も「実行する」も実行されなかった (自動実行は何も出さず、「実行する」は 404)。
--
-- 変更 (表の行・列・権限 (GRANT)・ポリシーには触れない):
--   制約 ai_action_logs_action_type_check を、今までの 24 種類に generate_single_meal を足した 25 種類で作り直す。
--   今までの種類は消さない (create_meal・analyze_nutrition は実行の側に case が無いが、残っている行が制約に合わなくならないよう残す)。
--   実行の側の種類 (executor の case) がこの一覧に入っていることは tests/ai-action-type-registry-2189.test.ts が見張る。
--
-- 既存データへの影響: 行は書き換えない。新しい一覧は今までの一覧を全部含むので、既存の行はどれも合う。
-- ロック: DROP / ADD CONSTRAINT は ai_action_logs に ACCESS EXCLUSIVE ロックを一瞬取る。NOT VALID で足してから VALIDATE で
--   既存の行を確かめる (VALIDATE は SHARE UPDATE EXCLUSIVE で、書き込みを止めない)。lock_timeout は他の migration と同じ 10 秒。
-- 冪等: DROP CONSTRAINT IF EXISTS のあとに作るので、2 回続けて適用してもエラーにならない。
-- 型 (database.types.ts) は CHECK 制約を持たないので作り直さない。
-- 確認: tests/integration/rls/ai-action-logs-action-type.test.ts (実 DB)
--       tests/ai-action-type-registry-2189.test.ts (静的)

SET LOCAL lock_timeout = '10s';

ALTER TABLE public.ai_action_logs DROP CONSTRAINT IF EXISTS ai_action_logs_action_type_check;

ALTER TABLE public.ai_action_logs
  ADD CONSTRAINT ai_action_logs_action_type_check CHECK (action_type = ANY (ARRAY[
    'generate_day_menu'::text,
    'generate_week_menu'::text,
    'generate_single_meal'::text,
    'create_meal'::text,
    'update_meal'::text,
    'delete_meal'::text,
    'complete_meal'::text,
    'add_to_shopping_list'::text,
    'update_shopping_item'::text,
    'delete_shopping_item'::text,
    'check_shopping_item'::text,
    'add_pantry_item'::text,
    'update_pantry_item'::text,
    'delete_pantry_item'::text,
    'suggest_recipe'::text,
    'like_recipe'::text,
    'add_recipe_to_collection'::text,
    'update_nutrition_target'::text,
    'set_health_goal'::text,
    'update_health_goal'::text,
    'delete_health_goal'::text,
    'add_health_record'::text,
    'update_health_record'::text,
    'update_profile_preferences'::text,
    'analyze_nutrition'::text
  ])) NOT VALID;

ALTER TABLE public.ai_action_logs VALIDATE CONSTRAINT ai_action_logs_action_type_check;
