-- rollback: 20261101150000_ai_action_logs_action_type_generate_single_meal.sql
-- #2189 W1 の戻し口 (このファイルは supabase/rollbacks/20261101150000_ai_action_logs_action_type_generate_single_meal.down.sql。1 行目は対の migration の名前)。
-- AI 相談の提案の記録 (ai_action_logs) の種類の制約 ai_action_logs_action_type_check を、generate_single_meal を足す前の 24 種類に戻す。
-- 注意: 戻すと、generate_single_meal の提案は行を作れなくなり、自動実行も「実行する」も実行されなくなる (適用前と同じ)。
-- 戻すまでに作られた generate_single_meal の行は消さない (黙って行を消さない)。そのため NOT VALID で足し、VALIDATE しない
--   (既存の行は確かめず、これから書く行だけが制約に従う)。
-- 表の権限 (GRANT) には触れない (20261022190000 より後の戻し口の規律: TRUNCATE / ALL を付け直さない)。
-- 冪等: DROP CONSTRAINT IF EXISTS のあとに作る。2 回流しても同じ結果になる。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。

SET LOCAL lock_timeout = '10s';

ALTER TABLE public.ai_action_logs DROP CONSTRAINT IF EXISTS ai_action_logs_action_type_check;

ALTER TABLE public.ai_action_logs
  ADD CONSTRAINT ai_action_logs_action_type_check CHECK (action_type = ANY (ARRAY[
    'generate_day_menu'::text,
    'generate_week_menu'::text,
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
