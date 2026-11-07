-- migration: 20261107140000_ai_action_logs_claim_token.sql
-- 戻し方: supabase/rollbacks/20261107140000_ai_action_logs_claim_token.down.sql
-- #2299 の B (書き戻しの ABA) の前段 W2a: AI 相談の提案の記録 (ai_action_logs) に、実行の印 (approved) を付けたリクエストごとの
-- token の列 claim_token を足す。この migration は列を足すだけで、列を使うコード (書き戻しをこの token で絞る) は後段の W2b。
--
-- 背景:
--   書き戻し (src/lib/ai/consultation-action-log-writes.ts の writeBackAiActionLog) の条件は status = approved だけで、
--   どの実行が付けた印かを見分けない。次の順で起きると、実行済みの提案の行が pending に戻り、二重の実行になりうる。
--     1. 書き戻しの 1 回目が DB には書けたのに、応答が失われる。
--     2. その間に、別の画面が pending → approved を取る。
--     3. 1 の 2 回目が、新しい approved を pending で上書きする。
--   これを防ぐため、実行の印 (claim) のたびに付ける token の列を足す (W2b が claim のときに書き、書き戻しをこの token で絞る)。
--
-- 変更:
--   1. ai_action_logs に claim_token uuid を足す (NULL を許す・既定値なし)。ADD COLUMN IF NOT EXISTS。
--   2. 列のコメントを付ける。
--   3. 足したあとの状態を確かめ、違えば例外で止める (列がある・型が uuid・NULL 可・既定値なし。
--      表の権限は 20261107120000_ai_action_logs_select_only.sql のまま = authenticated は INSERT / UPDATE / DELETE を持たず
--      (列の単位でも持たない)・anon は何も持たない・service_role は書ける)。
--   権限 (GRANT / REVOKE) とポリシーには触れない。列の権限は表の権限に従うので、authenticated は新しい列も読めるだけで書けない。
--
-- 既存データへの影響: なし (既存の行の claim_token は NULL のまま。行は書き換えない)。
-- ロック: NULL 可・既定値なしの ADD COLUMN はカタログだけの変更で、表を書き直さない (ACCESS EXCLUSIVE ロックを一瞬取る)。
--   lock_timeout は他の migration と同じ 10 秒。
-- 冪等: ADD COLUMN IF NOT EXISTS と COMMENT ON COLUMN は、2 回続けて適用してもエラーにならない。
-- 型: src/types/database.types.ts と packages/shared/src/database.types.ts の ai_action_logs に claim_token を足す。
-- 確認: tests/integration/rls/ai-action-logs-claim-token-2299.test.ts (実 DB。列・権限・サーバーの書き込み・戻し口)
--       tests/ai-action-logs-claim-token-migration-contract.test.ts (静的)

SET LOCAL lock_timeout = '10s';

-- 1. 列を足す
ALTER TABLE public.ai_action_logs ADD COLUMN IF NOT EXISTS claim_token uuid;

-- 2. 列のコメント
COMMENT ON COLUMN public.ai_action_logs.claim_token IS '実行の印 (approved) を付けたリクエストごとの token。書き戻しはこの token で絞り、別のリクエストの印を上書きしない (#2299)。';

-- 3. 足したあとの状態を確かめる
DO $verify$
DECLARE
  v_type text;
  v_not_null boolean;
  v_has_default boolean;
  v_left text[] := ARRAY[]::text[];
  v_priv text;
BEGIN
  SELECT pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull, a.atthasdef
    INTO v_type, v_not_null, v_has_default
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = 'public.ai_action_logs'::regclass
     AND a.attname = 'claim_token'
     AND NOT a.attisdropped;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_action_logs.claim_token が無い';
  END IF;
  IF v_type <> 'uuid' THEN
    RAISE EXCEPTION 'ai_action_logs.claim_token の型が uuid でない: %', v_type;
  END IF;
  IF v_not_null THEN
    RAISE EXCEPTION 'ai_action_logs.claim_token が NOT NULL になっている (既存の行は NULL のまま残す)';
  END IF;
  IF v_has_default THEN
    RAISE EXCEPTION 'ai_action_logs.claim_token に既定値がある (token は claim のたびにサーバーが付ける)';
  END IF;
  FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    IF pg_catalog.has_table_privilege('authenticated', 'public.ai_action_logs', v_priv) THEN
      v_left := v_left || ('authenticated ' || v_priv);
    END IF;
  END LOOP;
  FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE'] LOOP
    IF pg_catalog.has_column_privilege('authenticated', 'public.ai_action_logs', 'claim_token', v_priv) THEN
      v_left := v_left || ('authenticated ' || v_priv || ' (claim_token)');
    END IF;
  END LOOP;
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
    IF pg_catalog.has_table_privilege('anon', 'public.ai_action_logs', v_priv) THEN
      v_left := v_left || ('anon ' || v_priv);
    END IF;
  END LOOP;
  IF cardinality(v_left) > 0 THEN
    RAISE EXCEPTION 'ai_action_logs に利用者の書き込みの権限が残っている: %', array_to_string(v_left, ', ');
  END IF;
  IF NOT pg_catalog.has_table_privilege('authenticated', 'public.ai_action_logs', 'SELECT') THEN
    RAISE EXCEPTION 'ai_action_logs の authenticated の SELECT が無い (利用者が自分の提案の記録を読めなくなる)';
  END IF;
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
    IF NOT pg_catalog.has_column_privilege('service_role', 'public.ai_action_logs', 'claim_token', v_priv) THEN
      RAISE EXCEPTION 'ai_action_logs.claim_token の service_role の % が無い (サーバーが token を書けない)', v_priv;
    END IF;
  END LOOP;
END
$verify$;
