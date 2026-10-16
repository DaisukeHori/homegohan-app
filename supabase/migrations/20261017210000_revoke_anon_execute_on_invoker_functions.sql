-- migration: 20261017210000_revoke_anon_execute_on_invoker_functions.sql
-- #1821: 未ログインの anon が EXECUTE できる SECURITY INVOKER の関数から、anon と PUBLIC の EXECUTE を外す
--
-- 背景:
--   #1103 (7) (20261008160000_revoke_anon_execute_on_definer_functions.sql) は SECURITY DEFINER の関数だけを閉じた。
--   SECURITY INVOKER の関数は呼び出し元 (anon) の権限と RLS のもとで動くが、anon に EXECUTE が残っていると、
--   anon キー (公開鍵) だけで /rest/v1/rpc/<関数> から直接呼べる。
--   本番 (2026-10-17 の読み取り) とローカル (ベースライン + migration) で、public の SECURITY INVOKER の関数
--   (prokind = 'f'・拡張機能の関数を除く) のうち anon が EXECUTE できるものは同じ 38 本だった。
--   多くは 2025-11 の土台の migration (20251126124224_create_meal_planner_tables.sql) の `GRANT ALL ... TO "anon"` と、
--   PostgreSQL が関数の作成時に PUBLIC へ付ける EXECUTE が、そのまま残ったもの。
--
-- 38 本の分け方:
--   トリガー関数 (RETURNS trigger) 26 本: 触らない。
--     トリガーとして動くときは EXECUTE の権限を確かめない。/rest/v1/rpc からは呼べない (PostgREST は RPC として出さない。
--     直接呼んでも「トリガーとしてしか呼べない」で失敗する)。検査 (tests/integration/security/anon-invoker-execute.test.ts) は
--     許可一覧に入れず、除外の条件で扱う。
--   anon から呼ぶ必要があるもの: 0 本。
--     src・apps/mobile・supabase/functions で、下の 12 本を呼ぶ箇所はどれもログインした利用者 (authenticated) か
--     service_role のクライアントから呼ぶ。未ログインの画面・経路から呼ぶ箇所は無い。
--   外してよいもの 12 本 (この migration で anon と PUBLIC の EXECUTE を外す):
--     create_org_invite(uuid, text, org_role_enum, text)
--       呼び出し元: POST /api/org/invites (src/lib/membership/org-invite.ts。ログインした組織の owner / admin のクライアント)
--     get_7d_checkin_averages(uuid, date)
--       呼び出し元: GET /api/performance/analyze・GET /api/performance/checkins (ログインした利用者のクライアント)
--     user_has_non_sandbox_activity()
--       呼び出し元: POST /api/handson-tour/complete・src/lib/handson-tour/getStatus.ts・sandbox-eligibility.ts
--       (ログインした利用者のクライアント。auth.uid() を使う)
--     normalize_dish_name(text)
--       呼び出し元: search_recipes_hybrid・search_recipes_with_nutrition・search_similar_dataset_ingredients・
--       search_similar_dataset_recipes の本文 (どれも SECURITY INVOKER。呼び出し元の権限で呼ばれる。下の 4 本も anon を外す)
--     search_dataset_ingredients_by_embedding(vector, integer)
--     search_ingredients_by_text_similarity(text, numeric, integer)
--     search_ingredients_full_by_embedding(vector, integer)
--     search_menu_examples(vector, integer, text, numeric, text[])
--     search_recipes_hybrid(text, vector, integer, numeric)
--     search_recipes_with_nutrition(text, numeric, integer)
--     search_similar_dataset_ingredients(text, numeric, integer)
--     search_similar_dataset_recipes(text, numeric, integer)
--       呼び出し元: Edge Function (create-derived-recipe・generate-menu-v4 / v5・knowledge-gpt は service_role のクライアント。
--       analyze-meal-photo は利用者の JWT を付けたクライアントで、auth.getUser() で確かめてから呼ぶ = authenticated)。
--       ほかに開発用のスクリプト scripts/*.mjs (製品の経路ではない) がある。
--   どれも RLS のポリシー・ビュー・列の既定値・索引・トリガーからは参照されていない (pg_depend と関数の本文で確かめた)。
--   pg_cron のジョブも呼ばない。
--
-- 変更 (表・行・既存のデータ・関数の本文には一切触れない):
--   12 本の EXECUTE を、引数の型まで書いた完全形で anon と PUBLIC から REVOKE する。
--   authenticated・service_role の EXECUTE は変えない (どの関数も authenticated・service_role へ直接 GRANT 済みで、
--   PUBLIC を外しても残る)。所有者 postgres の EXECUTE も外さない。
--   ALTER DEFAULT PRIVILEGES は変えない (20261008160000 と同じ理由。変えると今後作る全部の関数の権限が黙って変わる)。
--   新しい関数が既定の権限のまま作られたら、tests/integration/security/anon-invoker-execute.test.ts が落ちる。
--
-- 本番への影響:
--   - ログインした利用者・service_role の経路: 変わらない。
--   - anon が直接 /rest/v1/rpc/<関数> で 12 本を呼ぶと、42501 (HTTP 401) で失敗する。未ログインの呼び出し元のコードは無い。
--   - REVOKE (関数) は表にロックを取らない。既存のデータを書き換える文は無い。
--
-- 冪等: REVOKE は何度流しても同じ結果になる。
-- 適用順: migration は version 順にマージする。
-- 確認: tests/integration/security/anon-invoker-execute.test.ts・tests/anon-invoker-execute-migration-contract.test.ts
-- ロールバック: supabase/rollbacks/20261017210000_revoke_anon_execute_on_invoker_functions.down.sql

-- 1. ログインした利用者が API 経由で呼ぶ関数
REVOKE EXECUTE ON FUNCTION public.create_org_invite(uuid, text, public.org_role_enum, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_7d_checkin_averages(uuid, date) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.user_has_non_sandbox_activity() FROM anon, PUBLIC;

-- 2. 検索の関数が本文で呼ぶ関数
REVOKE EXECUTE ON FUNCTION public.normalize_dish_name(text) FROM anon, PUBLIC;

-- 3. Edge Function (service_role・ログインした利用者) が呼ぶ検索の関数
REVOKE EXECUTE ON FUNCTION public.search_dataset_ingredients_by_embedding(extensions.vector, integer) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.search_ingredients_by_text_similarity(text, numeric, integer) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.search_ingredients_full_by_embedding(extensions.vector, integer) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.search_menu_examples(extensions.vector, integer, text, numeric, text[]) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.search_recipes_hybrid(text, extensions.vector, integer, numeric) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.search_recipes_with_nutrition(text, numeric, integer) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.search_similar_dataset_ingredients(text, numeric, integer) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.search_similar_dataset_recipes(text, numeric, integer) FROM anon, PUBLIC;
