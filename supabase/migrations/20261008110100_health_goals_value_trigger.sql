-- migration: 20261008110100_health_goals_value_trigger.sql
-- health_goals (健康目標) の target_value / current_value / goal_type を、書き込むときだけ検査するトリガーを足す (#1229)
--
-- 背景:
--   2026-10-07 の本番スナップショット (supabase/baseline/prod_schema.sql) の health_goals は、値の列が次のとおり。
--     target_value  numeric(10,2) NOT NULL  ← 桁あふれは防げるが、-50 や 0 が入る
--     current_value numeric(10,2)           ← 負の値が入る
--     goal_type     text NOT NULL           ← '' や 'x y'、日本語、長大な文字列でも入る
--   (status にだけ health_goals_status_check がある。本番のテーブルに元からあるもので、#1116 でベースライン (20251126124224)
--    にも入っている。この migration では触らない)
--   RLS で見えるのは本人の行だけだが、アプリ (POST /api/health/goals など) の入力検証は、PostgREST を直接叩けば迂回できる。
--   アプリの検証が効かない経路でも守れるのは DB のルールだけ。
--   異常な値 (例: 体重の目標が -50) は、AI 相談のプロンプト (health_goals の行をそのまま載せる) や栄養目標の計算に波及する。
--
-- なぜ CHECK 制約ではなくトリガーか:
--   CHECK 制約は NOT VALID で足しても、INSERT / UPDATE のたびに「更新後の行全体」を検査する (省けるのは既存行の走査だけ)。
--   もし本番に新しいルールへ違反している行が既にあると、その行は、どの列を更新しても (status や note だけでも) 23514 で失敗するようになり、
--   既存の利用者の画面を壊しかねない。本番のデータはこちらから読めず、事前確認をオーナーに頼む形にもしたくない。
--   そこで、「書き込もうとしている値」だけを検査するトリガーにした。
--     - INSERT:                新しい行の target_value / current_value / goal_type をすべて検査する
--     - UPDATE:                値が変わる列だけ検査する (NEW.<列> IS DISTINCT FROM OLD.<列>)。
--                              変わらない列は、既存の行が違反していても検査しない
--     - UPDATE OF <この 3 列>: この 3 列を書き換えない UPDATE (status・note・updated_at など) では、関数自体が呼ばれない
--
-- 検査する内容 (範囲は、レビュー済みの CHECK 制約案と同じ。NaN の拒否だけを足した):
--   target_value   0 より大きい値だけ
--   current_value  NULL (未計測) か 0 以上。0 は有効な計測値 (例: 今日の歩数 0 歩)
--   goal_type      小文字英字で始まる 64 文字以内の英数字・_・-  (正規表現 ^[a-z][a-z0-9_-]{0,63}$)
--   - numeric の NaN は「0 より大きい」「0 以上」のどちらの比較にも当たらず、CHECK 制約なら素通りしてしまう。
--     数値として使えない値なので、target_value / current_value では NaN も拒否する。
--   - goal_type を列挙にしないのは、種類を足すたびに migration を要さないようにするため。
--     使える種類 (weight / body_fat / steps / step_count / sleep_hours) と種類ごとの値の範囲 (例: 体重 20〜300 kg) は、
--     アプリ層 (src/lib/health-goal-types.ts、src/lib/health-payloads.ts) で検証する。
--
-- エラー: SQLSTATE 23514 (check_violation)。メッセージに列名を入れる (例: "health_goals.target_value must be ...")。
--   PostgREST は 23514 を HTTP 400 で返す。アプリ層の検証 (同じ PR) が先に 400 を返すので、通常この経路には来ない。
--
-- 既存データへの影響: なし。
--   - 既存の行を検査も書き換えもしない (UPDATE / DELETE 文は無く、テーブルの走査もしない)。
--   - 違反している既存の行があっても migration は成功し、その行は status や note など他の列を今までどおり更新できる。
--     target_value / current_value / goal_type を別の値に書き換えるときだけ、新しい値が検査される
--     (違反した値のまま同じ値を書き直しても通る。値を直せば通る)。
--
-- 既存の正当な利用経路への影響: なし。
--   Web / モバイルの目標作成・更新は、アプリ層の検証 (同じ PR) を通ってから書き込むため、このトリガーには当たらない。
--   モバイルが送る goal_type (weight / body_fat / sleep_hours / step_count) も形式に合う。
--   このテーブルに触れる Edge Function (generate-health-insights) は SELECT だけ。
--
-- CHECK 制約との違い (承知のうえ):
--   - トリガーは session_replication_role = replica にした接続 (運用でのデータ移行など) では動かない。
--     通常の接続はすべて検査される (anon / authenticated / service_role も同じ)。
--   - 既存の health_goals にデータだけを流し込む復元 (pg_restore --table など。docs/design/cross/07-dr-backup.md) では、
--     INSERT のたびに検査される。違反した行を含むバックアップなら --disable-triggers を付ける。
--     丸ごとの復元 (pg_restore --clean) は、データを入れたあとにトリガーを作るので影響を受けない。
--
-- 関数: SECURITY INVOKER (呼び出した人の権限のまま。他のテーブルは読まない)・SET search_path = ''・LANGUAGE plpgsql。
--   トリガー関数は直接呼び出せず、トリガーとして動くときは EXECUTE 権限を確認されないので、EXECUTE 権限は付け替えない
--   (何も足さない。既存の update_health_goals_updated_at と同じ扱い)。
--
-- 冪等: CREATE OR REPLACE FUNCTION / CREATE OR REPLACE TRIGGER なので、2 回続けて流してもエラーにならない。
--   旧版 (CHECK 制約方式。マージ前のブランチで version 20261007160600 として用意していたもの) を流した DB が万一あれば、
--   その 3 本の制約を外してこの方式にそろえる。旧版はマージしておらず本番には無いので、本番では何も起きない
--   (制約が無いときは ALTER TABLE を実行しないので、テーブルのロックも取らない)。
-- 確認:
--   - tests/integration/rls/health-goals-constraints.test.ts
--     範囲外の INSERT / UPDATE は拒否される、範囲内は通る、違反している既存の行は他の列なら更新できる、を確かめる。
--   - tests/integration/security/health-goals-api.test.ts
--     実際の API ルートと、このトリガーを持つ DB をつないで確かめる。
-- ロールバック: supabase/rollbacks/20261008110100_health_goals_value_trigger.down.sql
-- マージ順: migration は version の順にマージすること (この version: 20261008110100)。

-- 1. 旧版 (CHECK 制約方式) の後始末。制約があるときだけ外す
DO $cleanup_old_check_constraints$
DECLARE
  v_constraint_name text;
BEGIN
  FOR v_constraint_name IN
    SELECT c.conname
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.health_goals'::pg_catalog.regclass
      AND c.conname IN (
        'health_goals_target_value_positive',
        'health_goals_current_value_nonnegative',
        'health_goals_goal_type_format'
      )
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE public.health_goals DROP CONSTRAINT %I', v_constraint_name);
  END LOOP;
END
$cleanup_old_check_constraints$;

-- 2. 検査する関数
CREATE OR REPLACE FUNCTION public.health_goals_validate_values()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_check_target_value  boolean;
  v_check_current_value boolean;
  v_check_goal_type     boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- UPDATE: 値が変わる列だけ検査する。変わらない列は、既存の行が違反していても通す
    -- (違反している既存の行の、他の列の更新を止めないため)
    v_check_target_value  := NEW.target_value  IS DISTINCT FROM OLD.target_value;
    v_check_current_value := NEW.current_value IS DISTINCT FROM OLD.current_value;
    v_check_goal_type     := NEW.goal_type     IS DISTINCT FROM OLD.goal_type;
  ELSE
    -- INSERT: 新しい行の値をすべて検査する
    v_check_target_value  := true;
    v_check_current_value := true;
    v_check_goal_type     := true;
  END IF;

  -- NULL は検査しない (CHECK 制約と同じ扱い)。target_value / goal_type の NULL は NOT NULL 制約が拒否する。
  -- numeric(10,2) への丸めは、BEFORE トリガーが呼ばれる前に済んでいる (0.004 は 0.00 として検査される)

  IF v_check_target_value
     AND (NEW.target_value <= 0 OR NEW.target_value = 'NaN'::pg_catalog.numeric) THEN
    RAISE EXCEPTION 'health_goals.target_value must be a number greater than 0 (got %)', NEW.target_value
      USING ERRCODE = '23514', SCHEMA = 'public', TABLE = 'health_goals', COLUMN = 'target_value';
  END IF;

  IF v_check_current_value
     AND (NEW.current_value < 0 OR NEW.current_value = 'NaN'::pg_catalog.numeric) THEN
    RAISE EXCEPTION 'health_goals.current_value must be NULL or a number greater than or equal to 0 (got %)', NEW.current_value
      USING ERRCODE = '23514', SCHEMA = 'public', TABLE = 'health_goals', COLUMN = 'current_value';
  END IF;

  IF v_check_goal_type AND NEW.goal_type !~ '^[a-z][a-z0-9_-]{0,63}$' THEN
    -- goal_type は利用者が決める任意の長さの文字列なので、メッセージには値を載せない
    RAISE EXCEPTION 'health_goals.goal_type must start with a lowercase letter and contain only lowercase letters, digits, "_" and "-" (at most 64 characters)'
      USING ERRCODE = '23514', SCHEMA = 'public', TABLE = 'health_goals', COLUMN = 'goal_type';
  END IF;

  RETURN NEW;
END
$function$;

COMMENT ON FUNCTION public.health_goals_validate_values() IS
  'health_goals の target_value (> 0) / current_value (NULL か >= 0) / goal_type (小文字英字で始まる 64 文字以内の英数字・_・-) を、書き込む値だけ検査する (#1229)。UPDATE では値が変わる列だけ検査するので、違反している既存の行の他の列の更新は止めない。違反は 23514。';

-- 3. トリガー。この 3 列を書き換えない UPDATE では関数自体を呼ばない
CREATE OR REPLACE TRIGGER trg_health_goals_validate_values
  BEFORE INSERT OR UPDATE OF target_value, current_value, goal_type
  ON public.health_goals
  FOR EACH ROW
  EXECUTE FUNCTION public.health_goals_validate_values();

COMMENT ON TRIGGER trg_health_goals_validate_values ON public.health_goals IS
  '目標値・現在値・goal_type の書き込みを検査する (#1229)。CHECK 制約にしなかったのは、違反している既存の行の他の列の更新まで止めてしまうため。';
