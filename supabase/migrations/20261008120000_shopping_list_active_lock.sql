-- migration: 20261008120000_shopping_list_active_lock.sql
-- #1312: 買い物リストの再生成と「レシピから追加」が同時に走ると、再生成が一意制約違反 (23505) で失敗する問題を、
--        ユーザーごとの排他ロックを取る DB 関数 2 本にまとめて直す
--
-- 背景:
--   shopping_lists には「ユーザーごとにアクティブ (status = 'active') なリストは 1 つだけ」という部分ユニーク索引
--   idx_shopping_lists_active_unique (user_id) WHERE status = 'active' がある。
--   再生成 (Edge Function regenerate-shopping-list-v2。service role) は、PostgREST への別々の HTTP 呼び出しで次の順に処理していた。
--     1) 今のアクティブなリストを UPDATE ... SET status = 'archived' する (この結果のエラーは見ていない)
--     2) 新しいアクティブなリストを INSERT する
--   一方 POST /api/shopping-list/add-recipe (src/lib/shopping-list/active-list.ts の getOrCreateActiveShoppingList) は、
--   #1214 (PR #1291) から「アクティブなリストを SELECT して、無ければ INSERT」でリストを作る。
--   1) と 2) の間にこれが入ると、add-recipe は「アクティブなリストは無い」と判定して自分のリストを INSERT する。
--   そのあとに再生成の 2) が INSERT すると、部分ユニーク索引に当たって 23505 で失敗する。
--   再生成のリクエストは failed になり、やり直すまで新しいリストはできない。
--   (add-recipe 側は 23505 を受けたら再取得するので失敗しない。負けるのは再生成の側だけ。)
--   データは壊れない (一意制約が守っている) が、利用者から見ると「再生成が失敗した」になる。
--
-- 変更 (public に関数を 2 本足すだけ。テーブル・制約・インデックス・既存データには触れない):
--   どちらの関数も、アクティブなリストを書き込む(作る・差し替える)前に、そのユーザーの排他ロックを取る。
--     pg_advisory_xact_lock(hashtextextended('shopping_lists:' || p_user_id::text, 0))
--   ロックはトランザクションが終わると自動で手放される。キーはユーザーごとなので、別のユーザーどうしは待ち合わない。
--   2 本は同じキーを使うので、同じユーザーの再生成と add-recipe の「書き込み」は、どちらが先に来ても 1 件ずつ順に処理される。
--   (ロックの順序は常に「advisory lock -> shopping_lists の行」なので、2 本の間でデッドロックしない。)
--
--   1. public.replace_active_shopping_list(p_user_id, p_title, p_start_date, p_end_date, p_servings_config) RETURNS uuid
--      再生成が使う。ロックを取ってから「今のアクティブなリストをアーカイブ -> 新しいアクティブなリストを INSERT」を
--      1 つのトランザクションで行い、新しいリストの id を返す。途中で失敗すれば全部なかったことになる
--      (旧リストがアーカイブされたまま新しいリストが無い、という状態にならない)。
--   2. public.get_or_create_active_shopping_list(p_user_id, p_title, p_start_date, p_end_date) RETURNS uuid
--      add-recipe と、AI 相談のアクション add_to_shopping_list が使う。アクティブなリストがあればその id を返す
--      (一番よくある場合。何も書き込まないのでロックは取らない)。無ければロックを取り、もう一度確かめてから INSERT する。
--
--   どちらも INSERT は ON CONFLICT DO NOTHING で書く。衝突したら (= ロックを取らない書き込みが先にコミットした場合)、
--   もう一度やり直す (最大 3 回)。ロックを取らない書き込みとは、この migration より前の add-recipe
--   (デプロイの途中で古い Web がまだ動いている間) や、RLS 上は利用者に許されている shopping_lists への直接の INSERT。
--   これらが相手でも、再生成は 23505 で失敗しない。
--
-- 同時に来たときの結果 (どちらも失敗せず、アクティブなリストは常に 1 つ):
--   - add-recipe が先: add-recipe が (無ければ) リストを作って食材を追加し、続けて再生成がそのリストをアーカイブして
--     新しいリストを作る。add-recipe が追加した食材は、アーカイブされたリストに残る。
--     「add-recipe が再生成のほんの少し前に実行された」場合と同じ結果で、2 つを間を空けて順に実行したときと変わらない。
--   - 再生成が先: 再生成が新しいリストを作り、add-recipe はそのリストに食材を追加する。
--   - 再生成の途中 (アーカイブ -> INSERT がコミットされる前) に add-recipe が来て、まだアクティブなリストが見える場合は、
--     get_or_create はそのリストを待たずに返す。食材を追加する頃には再生成がコミットしてそのリストはアーカイブ済みなので、
--     食材はアーカイブされたリストに入る (「add-recipe が先」と同じ扱い)。
--
-- 権限:
--   - replace_active_shopping_list: service_role だけ (PUBLIC / anon / authenticated へは付けない)。
--     呼ぶのは Edge Function だけで、Edge Function は service role で動く。p_user_id は Edge Function が認証済みの値を渡す。
--   - get_or_create_active_shopping_list: authenticated と service_role だけ (PUBLIC / anon へは付けない)。
--     呼び出し元の route は利用者の JWT で呼ぶので、関数の中で「p_user_id が呼び出した本人 (auth.uid()) であること」を確かめる。
--     service_role だけは任意のユーザーを指定できる。本人以外を指定すると 42501 (FORBIDDEN) で、何も作らない。
--   どちらも SECURITY DEFINER + SET search_path = '' (テーブル・関数は完全修飾名)。
--
-- 注意: この migration は関数を 2 本足すだけで、本番のデータは一切書き換えない (UPDATE / DELETE の修復文なし)。
--       新しい Web と Edge Function がこの 2 本を呼ぶので、この migration を先に (または同時に) 本番へ反映すること。
--       migration は version 順にマージする。
--
-- 冪等: CREATE OR REPLACE FUNCTION。REVOKE / GRANT / COMMENT は何度流しても同じ結果になる。
-- 確認: tests/integration/security/shopping-list-active-lock.test.ts
-- ロールバック: supabase/rollbacks/20261008120000_shopping_list_active_lock.down.sql
--   (先に Web と Edge Function を戻すこと。新しい Web / Edge Function のままこの関数だけ消すと、
--    「レシピから追加」と買い物リストの再生成が失敗する)

CREATE OR REPLACE FUNCTION public.replace_active_shopping_list(
  p_user_id         UUID,
  p_title           TEXT,
  p_start_date      DATE,
  p_end_date        DATE,
  p_servings_config JSONB DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_list_id UUID;
  v_attempt INTEGER := 0;
BEGIN
  -- 0. 引数の検証。失敗した場合は何も変更しない (ロックを取る前に弾く)
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'replace_active_shopping_list: p_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    RAISE EXCEPTION 'replace_active_shopping_list: p_start_date and p_end_date are required' USING ERRCODE = '22023';
  END IF;

  -- 1. このユーザーの「アクティブなリストを作る・差し替える」処理を直列化する。
  --    get_or_create_active_shopping_list も同じキーで取る。トランザクションの終わりに自動で手放される。
  PERFORM pg_advisory_xact_lock(hashtextextended('shopping_lists:' || p_user_id::text, 0));

  LOOP
    v_attempt := v_attempt + 1;

    -- 2. 今のアクティブなリストをアーカイブする (アーカイブ済みのリストと食材はそのまま残る)
    UPDATE public.shopping_lists AS sl
       SET status = 'archived',
           updated_at = now()
     WHERE sl.user_id = p_user_id
       AND sl.status = 'active';

    -- 3. 新しいアクティブなリストを作る。
    --    ロックを取らない書き込みが 2 と 3 の間に先にコミットしていた場合は、衝突して何も入らない (v_list_id は NULL)。
    --    その場合は 2 からやり直し、そのリストもアーカイブしてから作る。
    INSERT INTO public.shopping_lists (user_id, title, start_date, end_date, status, servings_config)
    VALUES (p_user_id, p_title, p_start_date, p_end_date, 'active', p_servings_config)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_list_id;

    IF v_list_id IS NOT NULL THEN
      RETURN v_list_id;
    END IF;

    IF v_attempt >= 3 THEN
      RAISE EXCEPTION 'replace_active_shopping_list: could not replace the active shopping list' USING ERRCODE = '23505';
    END IF;
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION public.get_or_create_active_shopping_list(
  p_user_id    UUID,
  p_title      TEXT,
  p_start_date DATE,
  p_end_date   DATE
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_list_id UUID;
  v_attempt INTEGER := 0;
BEGIN
  -- 0. 呼び出し元の確認。SECURITY DEFINER なので RLS は効かない。ここで本人であることを確かめる。
  --    service_role だけは任意のユーザーを指定できる。それ以外 (authenticated) は自分自身だけ。
  --    どちらの失敗も同じ 42501 にして、他人の user_id が実在するかを漏らさない。
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'get_or_create_active_shopping_list: p_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    RAISE EXCEPTION 'get_or_create_active_shopping_list: p_start_date and p_end_date are required' USING ERRCODE = '22023';
  END IF;

  -- 1. すでにアクティブなリストがあれば、それを返す (一番よくある場合。ロックは取らない)。
  --    再生成が同時に実行中で、このリストをアーカイブする途中でも、ここで見えるのは再生成がコミットする前のリスト。
  --    その場合に追加した食材は、アーカイブされたリストに残る (再生成の少し前に追加したのと同じ扱い)。
  SELECT sl.id
    INTO v_list_id
    FROM public.shopping_lists AS sl
   WHERE sl.user_id = p_user_id
     AND sl.status = 'active';
  IF v_list_id IS NOT NULL THEN
    RETURN v_list_id;
  END IF;

  -- 2. 無かった。作る処理を直列化する (replace_active_shopping_list と同じキー)。
  --    ロックを待っている間に再生成や別の add-recipe がリストを作ってコミットすることがあるので、
  --    ロックを取ったあとにもう一度確かめる (READ COMMITTED では、ロック後の SELECT はコミット済みの最新の状態を見る)。
  PERFORM pg_advisory_xact_lock(hashtextextended('shopping_lists:' || p_user_id::text, 0));

  LOOP
    v_attempt := v_attempt + 1;

    SELECT sl.id
      INTO v_list_id
      FROM public.shopping_lists AS sl
     WHERE sl.user_id = p_user_id
       AND sl.status = 'active';
    IF v_list_id IS NOT NULL THEN
      RETURN v_list_id;
    END IF;

    -- 3. 作る。ロックを取らない書き込み (この migration より前の add-recipe など) が直前にコミットしていた場合は、
    --    衝突して何も入らない (v_list_id は NULL)。次の周回の SELECT でそのリストを拾う。
    INSERT INTO public.shopping_lists (user_id, title, start_date, end_date, status)
    VALUES (p_user_id, p_title, p_start_date, p_end_date, 'active')
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_list_id;

    IF v_list_id IS NOT NULL THEN
      RETURN v_list_id;
    END IF;

    IF v_attempt >= 3 THEN
      RAISE EXCEPTION 'get_or_create_active_shopping_list: could not get or create the active shopping list' USING ERRCODE = '23505';
    END IF;
  END LOOP;
END
$$;

-- 関数の権限。
-- Supabase は関数作成時に anon / authenticated / service_role へ EXECUTE を自動付与し、PUBLIC にも EXECUTE が付く。
-- 引数の型まで含めた完全形で、いったん全員から外してから必要な役割にだけ付け直す
-- (20261007160000_family_member_limit_row_lock.sql と同じ形。何度流しても最終的な権限は同じになる)。
REVOKE ALL ON FUNCTION public.replace_active_shopping_list(UUID, TEXT, DATE, DATE, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.replace_active_shopping_list(UUID, TEXT, DATE, DATE, JSONB)
  TO service_role;

REVOKE ALL ON FUNCTION public.get_or_create_active_shopping_list(UUID, TEXT, DATE, DATE)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_or_create_active_shopping_list(UUID, TEXT, DATE, DATE)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.replace_active_shopping_list(UUID, TEXT, DATE, DATE, JSONB) IS
  '#1312: ユーザーの今のアクティブな買い物リストをアーカイブして、新しいアクティブなリストを作り、その id を返す。ユーザーごとの advisory lock を取り、アーカイブと INSERT を 1 トランザクションで行う (get_or_create_active_shopping_list と同じキー)。service_role のみ。';
COMMENT ON FUNCTION public.get_or_create_active_shopping_list(UUID, TEXT, DATE, DATE) IS
  '#1312: ユーザーのアクティブな買い物リストの id を返す。無ければ、ユーザーごとの advisory lock を取って (replace_active_shopping_list と同じキー) から作る。p_user_id は呼び出した本人か、service_role の場合のみ任意 (本人以外は 42501 FORBIDDEN)。authenticated / service_role のみ。';
