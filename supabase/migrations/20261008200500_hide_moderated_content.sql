-- migration: 20261008200500_hide_moderated_content.sql
-- #1101: 運営が違反コンテンツを「削除」するとき、行を消さずに「隠す」。完全な削除は保管期間のあとに行う (その削除ジョブは別の作業)
--
-- 背景 (本番の現状: supabase/baseline/prod_schema.sql と supabase/baseline/catalog/catalog_policies.csv。
--       20261007112200 より新しい migration で、meals / recipes の SELECT ポリシーを変えたものは 20261008160000 の ALTER POLICY ... TO authenticated だけ):
--   運営のモデレーション画面 (POST /api/admin/moderation/{type}/{id}) の delete_only / delete_and_warn / delete_and_temp_ban / delete_and_perm_ban は、
--   通報の状態 (moderation_flags / recipe_flags の status) を rejected にするだけで、通報された食事 (meals) やレシピ (recipes) には何もしていなかった。
--   「削除」と名前が付いているのに、コンテンツは他のユーザーに見えたままだった。
--   オーナー判断 (2026-10-08): 削除は「隠す」方式にする。違反コンテンツはすぐには消さず、保管期間のあいだ残し、そのあとで完全に削除する。
--
-- 変更 (表の行・既存のデータには一切触れない):
--   1. meals / recipes に 3 列を足す。どれも NULL を許し、既定値は無い (既存の行は「隠れていない」まま)。
--        hidden_at     timestamptz  隠した日時。NULL = 隠れていない。保管期間はこの日時から数える
--        hidden_by     uuid         隠した運営ユーザー (auth.users。相手のアカウントが消えたら NULL に戻す = ON DELETE SET NULL)
--        hidden_reason text         隠した理由。本人も読める列なので、運営の自由記述は入れない (アプリは 'moderation:<action>' を書く)
--   2. SELECT ポリシーを、隠した行を「本人だけ」が読めるように狭める (式に隠し状態の条件を足す。対象ロールは変えない)。
--        meals.meals_select_owner_or_family  (authenticated):  (hidden_at IS NULL OR user_id = auth.uid()) AND can_view_user_meals(user_id)
--        recipes."Users can view public recipes" (public):     (hidden_at IS NULL OR auth.uid() = user_id) AND (user_id IS NULL OR is_public = true OR auth.uid() = user_id)
--      食事を共有している家族のメンバー、ほかのログインユーザー、未ログイン (anon) は、隠された行を読めない (エラーにならず 0 行)。
--      GET /api/recipes と GET /api/recipes/{id} はユーザーの権限で読むので、コードを変えなくても隠したレシピは本人以外に出なくなる。
--      本人は隠された自分の行を今までどおり読める (recipes は ALL ポリシー "Users can manage own recipes" でも読める)。
--      運営の画面 (モデレーション) は service_role で読むので、隠した行も見える。
--   3. hidden_at / hidden_by / hidden_reason を、ログインユーザー (本人を含む) と anon が書き換えられないようにするトリガーを足す。
--        guard_hidden_content_columns()  BEFORE INSERT OR UPDATE OF hidden_at, hidden_by, hidden_reason ON meals / recipes
--      これが無いと、隠された行の持ち主が PostgREST から自分の行を UPDATE して hidden_at を NULL に戻し、隠された違反コンテンツを自分で元に戻せてしまう。
--      (meals_update_owner と "Users can manage own recipes" は列を限らずに本人の更新を許し、anon / authenticated にはテーブル単位で UPDATE が GRANT されている。
--       supabase/baseline/prod_table_acl.sql。列単位の GRANT に作り替えるのは大きな変更で、今後列を足すたびに付け忘れが起きるので、トリガーで守る。)
--      - 拒否のしかたは guard_family_members_privileged と同じ: current_user が authenticated / anon のときだけ
--        RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501'。
--      - 値を変えない更新 (NEW.<列> = OLD.<列>) は拒否しない。行をまるごと送り直すクライアントも壊れない。
--      - INSERT は、3 列のどれかが NULL でなければ拒否する (自分で「隠した」行や、他人の ID を hidden_by に入れた行を作らせない)。
--      - 運営 (service_role)、SECURITY DEFINER の関数 (所有者 postgres)、外部キーの動き (hidden_by の ON DELETE SET NULL) は
--        current_user が authenticated / anon ではないので止まらない。
--      - SECURITY INVOKER のまま (SECURITY DEFINER にすると current_user が常に postgres になり、ガードが一切効かなくなる)。SET search_path = ''。
--   4. 小さい索引を 4 本足す。どれも「隠した行だけ」を対象にする部分索引なので、ほとんどの行 (hidden_* が NULL) は索引に入らない。
--        idx_meals_hidden_at / idx_recipes_hidden_at    (hidden_at)  WHERE hidden_at IS NOT NULL
--          保管期間を過ぎた行を探す完全削除ジョブ (別の作業) のため。
--        idx_meals_hidden_by / idx_recipes_hidden_by    (hidden_by)  WHERE hidden_by IS NOT NULL
--          auth.users の行を消すたびに、外部キー (ON DELETE SET NULL) が「hidden_by がその人の行」を探す。索引が無いと毎回表全体を読む。
--
-- やらないこと:
--   - 完全削除 (保管期間を過ぎた行と、その画像の削除) はこの migration に入れない。保管期間はオーナー・弁護士が決めるまで未定で、
--     削除をスケジュールすると、決まっていない期間で本番の行が消えてしまう。
--     なお本番の storage.objects には protect_objects_delete トリガー (storage.protect_delete(); supabase/baseline/catalog/catalog_auth_storage_triggers.csv) があり、
--     SQL から行を消しても画像ファイルは消えない / 消せない (Storage API を使う)。pg_cron の SQL だけで「行と画像」を消す形にはならないので、削除ジョブは別の作業で設計する。
--   - 既存の通報 (moderation_flags / recipe_flags) で、すでに rejected になっているものの食事・レシピは隠さない。
--     これまで delete_* は何も隠さなかったので、該当があるかは PR の本文の読み取り専用 SQL で数える。隠すかどうかは件数を見てから別に決める。
--   - 運営が隠した行を元に戻す画面・API (hidden_* を NULL に戻す操作) は作らない。必要になったときは service_role で戻す。
--   - paste_meal_to_family (食事を家族に貼り付ける関数) は変えない。貼り付けは新しい行を作るので、隠した状態は引き継がれない。
--
-- 本番のデータへの影響: なし。
--   - 3 列は NULL のまま足すだけで、表の書き換え (rewrite) も既存の行の更新も無い。
--   - ポリシーは、hidden_at が NULL の行 (= 既存のすべての行) については今と同じ結果を返す。変わるのは「隠した行」だけ。
--   - トリガーは、hidden_* を書く文でだけ動く。今のアプリ (Web・モバイル・Edge Function) に hidden_* を書く箇所は無い。
--     行を丸ごと送り直すクライアントが hidden_* を NULL で送っても、今の値 (NULL) と同じなので通る。
--   - ロック: ALTER TABLE ... ADD COLUMN は meals / recipes に ACCESS EXCLUSIVE ロックを短く取る。hidden_by の外部キーのため auth.users にも
--     SHARE ROW EXCLUSIVE ロックを取る (新しい列は全行 NULL なので、外部キーに違反する既存の行は無い)。ALTER POLICY も ACCESS EXCLUSIVE、
--     CREATE INDEX は書き込みを待たせる (CONCURRENTLY は migration がトランザクションの中で流れるため使えない)。
--     どれも対象の行が少ない (または部分索引で小さい) ので一瞬で終わる。念のため、ロックを 10 秒待っても取れなければ失敗させる
--     (待っているあいだ、meals / recipes への新しい読み書きも待たされるので、待ちの長さに上限を付ける。失敗しても、再実行すれば直る)。
--
-- 冪等: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / CREATE OR REPLACE FUNCTION / CREATE OR REPLACE TRIGGER / ALTER POLICY ... USING / COMMENT は、
--   何度流しても同じ結果になる。(ALTER POLICY は、ポリシーが無いとエラーになる。2 本とも本番にある: supabase/baseline/catalog/catalog_policies.csv)
-- 確認: tests/integration/rls/hidden-content-visibility.test.ts
--   隠された食事・レシピが本人以外 (家族・ほかのログインユーザー・anon) に見えないこと、本人は読めること、本人が隠し状態を書き換えられないこと、
--   運営 (service_role) が隠せること、運営ユーザーを消すと hidden_by だけ NULL に戻ること、定義 (ポリシー・列・外部キー・索引・トリガー) を確かめる。
-- ロールバック: supabase/rollbacks/20261008200500_hide_moderated_content.down.sql
--   ⚠️ 戻すと hidden_* 列ごと「隠した状態」が消え、隠していたコンテンツがすべて元どおり見えるようになる。
-- マージ順: migration は version の順にマージすること (この version: 20261008200500)。

SET LOCAL lock_timeout = '10s';

-- 1. 列 (hidden_by は、運営ユーザーのアカウントが消えても隠した状態を残すため ON DELETE SET NULL)
ALTER TABLE public.meals
  ADD COLUMN IF NOT EXISTS hidden_at timestamptz,
  ADD COLUMN IF NOT EXISTS hidden_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS hidden_reason text;

ALTER TABLE public.recipes
  ADD COLUMN IF NOT EXISTS hidden_at timestamptz,
  ADD COLUMN IF NOT EXISTS hidden_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS hidden_reason text;

COMMENT ON COLUMN public.meals.hidden_at IS '運営が隠した日時 (#1101)。NULL = 隠れていない。値があると本人以外には見えない (RLS)。保管期間はこの日時から数え、そのあとで完全に削除する。書き換えられるのは運営 (service_role) だけ (guard_hidden_content_columns)。';
COMMENT ON COLUMN public.meals.hidden_by IS '隠した運営ユーザー (#1101)。相手のアカウントが消えたら NULL に戻る (隠した状態は残る)。';
COMMENT ON COLUMN public.meals.hidden_reason IS '隠した理由 (#1101)。本人も読める列なので、運営の自由記述は入れず、"moderation:<action>" のような短い識別子にする。';
COMMENT ON COLUMN public.recipes.hidden_at IS '運営が隠した日時 (#1101)。NULL = 隠れていない。値があると本人以外には見えない (RLS)。保管期間はこの日時から数え、そのあとで完全に削除する。書き換えられるのは運営 (service_role) だけ (guard_hidden_content_columns)。';
COMMENT ON COLUMN public.recipes.hidden_by IS '隠した運営ユーザー (#1101)。相手のアカウントが消えたら NULL に戻る (隠した状態は残る)。';
COMMENT ON COLUMN public.recipes.hidden_reason IS '隠した理由 (#1101)。本人も読める列なので、運営の自由記述は入れず、"moderation:<action>" のような短い識別子にする。';

-- 2. 隠した行だけを対象にする部分索引
CREATE INDEX IF NOT EXISTS idx_meals_hidden_at
  ON public.meals (hidden_at) WHERE hidden_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meals_hidden_by
  ON public.meals (hidden_by) WHERE hidden_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recipes_hidden_at
  ON public.recipes (hidden_at) WHERE hidden_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recipes_hidden_by
  ON public.recipes (hidden_by) WHERE hidden_by IS NOT NULL;

-- 3. 隠し状態の書き換えを、ログインユーザーと anon に許さない (meals / recipes 共通)
CREATE OR REPLACE FUNCTION public.guard_hidden_content_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      -- INSERT: 隠した状態の行を作らせない (自分で隠した行・他人の ID を hidden_by に入れた行)
      IF NEW.hidden_at IS NOT NULL OR NEW.hidden_by IS NOT NULL OR NEW.hidden_reason IS NOT NULL THEN
        RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.hidden_at     IS DISTINCT FROM OLD.hidden_at
       OR NEW.hidden_by     IS DISTINCT FROM OLD.hidden_by
       OR NEW.hidden_reason IS DISTINCT FROM OLD.hidden_reason THEN
      -- UPDATE: 値が変わるときだけ拒否する。隠された行の持ち主が hidden_at を NULL に戻せると、モデレーションの結果を自分で取り消せてしまう
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

COMMENT ON FUNCTION public.guard_hidden_content_columns() IS 'meals / recipes の隠し状態 (hidden_at / hidden_by / hidden_reason) を、authenticated / anon が書き換えるのを拒否するトリガー関数 (#1101)。運営 (service_role) と DEFINER 関数は対象外。';

CREATE OR REPLACE TRIGGER trg_meals_guard_hidden_columns
  BEFORE INSERT OR UPDATE OF hidden_at, hidden_by, hidden_reason ON public.meals
  FOR EACH ROW EXECUTE FUNCTION public.guard_hidden_content_columns();

CREATE OR REPLACE TRIGGER trg_recipes_guard_hidden_columns
  BEFORE INSERT OR UPDATE OF hidden_at, hidden_by, hidden_reason ON public.recipes
  FOR EACH ROW EXECUTE FUNCTION public.guard_hidden_content_columns();

-- 4. SELECT ポリシー: 隠した行は本人だけが読める (対象ロールは変えない。meals は authenticated、recipes は public のまま)
ALTER POLICY meals_select_owner_or_family ON public.meals
  USING (
    (hidden_at IS NULL OR user_id = auth.uid())
    AND public.can_view_user_meals(user_id)
  );

ALTER POLICY "Users can view public recipes" ON public.recipes
  USING (
    (hidden_at IS NULL OR auth.uid() = user_id)
    AND (user_id IS NULL OR is_public = true OR auth.uid() = user_id)
  );
