-- migration: 20261016240000_org_challenge_diff_privacy.sql
-- #1688: 組織チャレンジの集計の差分から、やめた人の値を逆算させない。#1600 (20261016170000_org_challenge_min10_join_policy.sql) の残り
--
-- 背景:
--   管理者に見せる集計 (get_org_challenge_aggregates) は参加者の行をその場で数えていたので、参加をやめる・組織から外す前後の
--   人数と平均の差から、やめた人の値が出た (最小人数の規則は 1 回の集計しか守らない)。参加者に見せる順位表も行をその場で読むので、
--   メンバーとして参加した管理者が、メンバーを外した前後で消えた 1 行の値を見られた。個人の値は種類と期間だけで決まるので、
--   同じ種類・同じ期間のチャレンジを 2 本作れば、2 本の平均の差からも 1 人の値が出た。
--
-- 変更 (差の取れる公開値を作らない):
--   1. organization_challenges.status を NOT NULL にする (NULL の行は先に draft にする。CHECK は NULL を通していた)。
--   2. 表 organization_challenge_aggregates (チャレンジごとに 1 行): 参加した人の延べ数 (joined_count) と、終了時に 1 回だけ確定する
--      平均 (final_average_value) と人数 (final_ranked_count)。読み書きは service_role と所有者だけ (RLS 有効・ポリシー無し)。
--   3. 表 organization_challenge_ranking_exclusions (管理者だった印): (challenge_id, user_id)。印のある人には順位表を返さない。
--      読み書きは service_role と所有者だけ (RLS 有効・ポリシー無し)。
--   4. トリガー org_challenge_count_join: 参加の INSERT ごとに joined_count を +1 (やめる・組織から外れる・退会では減らさない)。
--   5. トリガー org_challenge_guard_update: 状態の遷移 (draft → active / completed / cancelled、active → completed / cancelled) 以外
--      (NULL への変更を含む) を CHALLENGE_STATUS_LOCKED で止め、draft 以外での start_date / end_date / challenge_type / department_id と
--      常時の organization_id の変更を CHALLENGE_PERIOD_LOCKED で止める (API の PUT は期間・種類を受け付けない。PostgREST の直接の UPDATE を止める)。
--   6. トリガー org_challenge_finalize: completed への遷移と同じトランザクションで、順位がついた今のメンバーの平均 (小数第 1 位) と
--      人数を 1 回だけ書く (確定済みなら書かない)。中止 (cancelled) は確定しない。書く前に組織ごとの鍵 (pg_advisory_xact_lock) を取り、
--      確定の時刻を鍵を取ったあとの clock_timestamp() にする (同じ組織の確定を 1 本ずつにし、確定の時刻の順をコミットの順とそろえる)。
--   7. トリガー org_challenge_mark_admin (user_profiles): 役割か組織が変わって組織の管理者 (owner / admin) になった時点で、
--      その組織のチャレンジすべてに印を付ける (招待の承諾・所有者の譲渡・運営の操作・service_role の更新のどの経路でも)。
--   8. ポリシー "Org challenges can be deleted only as draft or cancelled" (RESTRICTIVE・DELETE・authenticated): 利用者の権限で消せるのは
--      draft と cancelled だけ。平均を出しうるチャレンジを消して作り直す経路を止める。
--   9. get_org_challenge_aggregates: 控えの表から返す。人数 = joined_count (最小人数未満は NULL)、平均 = 確定値 (確定時点の人数が
--      最小人数未満なら NULL。開催中は常に NULL。同じ組織・同じ種類で期間が重なり、先に確定して最小人数を満たしたチャレンジがあれば NULL)。
--      名前・引数・返す列・SECURITY INVOKER・最小人数 (cfg の 10) は変えない。
--  10. get_org_challenge_ranking: 見る人が組織の管理者 (org_role が owner / admin) か、印がある人なら 0 行。ほかは 20261014100100 の定義のまま。
--  11. 埋め戻し: 既存のチャレンジに joined_count = いまの参加行の数。completed のチャレンジはいまの行から一度だけ確定。
--      印は埋め戻さない (いまの管理者は今の役割で伏せる。過去の役割の履歴は DB に無い)。
--   変えないもの: update_org_challenge_progress・pg_cron のジョブ・参加の INSERT / SELECT / DELETE のポリシー・
--   Org admins can manage challenges ポリシー・招待 / 譲渡 / 脱退 / 除名の関数。
--
-- 本番のデータへの影響: 表を 2 つ足し、既存のチャレンジの行数だけ控えの行を作る。状態が NULL のチャレンジの行だけ draft に書き換える。
--   表への書き込みを待たせるロックは NOT NULL の付与 (organization_challenges の全行を 1 回読む) とトリガーの付与だけ。10 秒でロック待ちを諦める。
-- 冪等: UPDATE ... WHERE status IS NULL / SET NOT NULL / CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION /
--   CREATE OR REPLACE TRIGGER / DROP POLICY IF EXISTS → CREATE POLICY / 埋め戻しは ON CONFLICT。
-- 確認: tests/org-challenge-diff-privacy-migration-contract.test.ts / tests/integration/rls/org-challenge-diff-privacy.test.ts /
--       tests/integration/security/org-challenges-api.test.ts
-- ロールバック: supabase/rollbacks/20261016240000_org_challenge_diff_privacy.down.sql

SET LOCAL lock_timeout = '10s';

-- ─────────────────────────────────────────────────────────
-- 1. 状態の NULL を無くす (ガードのトリガーより先に流す)
-- ─────────────────────────────────────────────────────────
-- NULL の行は、集計 (status = 'active' だけ)・参加 (ポリシーが status = 'active' を求める)・メンバー向けの一覧 (active / completed)
-- のどれの対象でもなく、下書きとして扱ってきた。draft にそろえてから NOT NULL にする
UPDATE public.organization_challenges SET status = 'draft' WHERE status IS NULL;
ALTER TABLE public.organization_challenges ALTER COLUMN status SET NOT NULL;

-- ─────────────────────────────────────────────────────────
-- 2. 集計の控え (チャレンジごとに 1 行)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.organization_challenge_aggregates (
  challenge_id        uuid PRIMARY KEY REFERENCES public.organization_challenges(id) ON DELETE CASCADE,
  -- 参加した人の延べ数。参加の INSERT ごとに +1。やめる・組織から外れる・退会では減らさない
  joined_count        integer NOT NULL DEFAULT 0 CHECK (joined_count >= 0),
  -- 確定した時刻 (確定のトリガーが組織ごとの鍵を取ったあとの clock_timestamp()。同じ組織の中では、この順がコミットの順と一致する)。
  -- NULL = 未確定 (開催中・下書き・中止)
  finalized_at        timestamptz,
  -- 確定時点の、順位がついた今のメンバーの人数と、その平均 (小数第 1 位)。人数 0 なら平均は NULL
  final_ranked_count  integer CHECK (final_ranked_count >= 0),
  final_average_value numeric,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_challenge_aggregates_final_shape CHECK (
    (finalized_at IS NULL AND final_ranked_count IS NULL AND final_average_value IS NULL)
    OR (finalized_at IS NOT NULL AND final_ranked_count IS NOT NULL)
  )
);

COMMENT ON TABLE public.organization_challenge_aggregates IS
  '#1688: 組織チャレンジの集計の控え。joined_count は参加の延べ数 (減らさない)。final_* は completed への遷移で 1 回だけ確定する平均と人数。読み書きは service_role と所有者だけ。';

ALTER TABLE public.organization_challenge_aggregates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.organization_challenge_aggregates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.organization_challenge_aggregates TO service_role;

-- ─────────────────────────────────────────────────────────
-- 3. 管理者だった印 (この人には、このチャレンジの順位表を返さない)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.organization_challenge_ranking_exclusions (
  challenge_id uuid NOT NULL REFERENCES public.organization_challenges(id) ON DELETE CASCADE,
  -- 印の付いた人。退会 (auth.users の削除) で印も消える
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- 印を付けた時刻 (その組織の管理者になった時刻)
  marked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, user_id)
);

COMMENT ON TABLE public.organization_challenge_ranking_exclusions IS
  '#1688: 組織の管理者 (owner / admin) になった人の印。管理者になった時点でその組織にあったチャレンジごとに 1 行。印のある人には get_org_challenge_ranking が 0 行を返す (member に戻っても、参加し直しても消えない)。読み書きは service_role と所有者だけ。';

ALTER TABLE public.organization_challenge_ranking_exclusions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.organization_challenge_ranking_exclusions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.organization_challenge_ranking_exclusions TO service_role;

-- ─────────────────────────────────────────────────────────
-- 4. 参加の延べ数 (参加の INSERT ごとに +1)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.org_challenge_count_join()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.challenge_id IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.organization_challenge_aggregates AS a (challenge_id, joined_count)
  VALUES (NEW.challenge_id, 1)
  ON CONFLICT (challenge_id) DO UPDATE
     SET joined_count = a.joined_count + 1,
         updated_at   = now();
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.org_challenge_count_join() FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.org_challenge_count_join() IS
  '#1688: organization_challenge_participants の INSERT ごとに organization_challenge_aggregates.joined_count を +1 する (延べ数。DELETE では減らさない)。';

CREATE OR REPLACE TRIGGER trg_org_challenge_count_join
  AFTER INSERT ON public.organization_challenge_participants
  FOR EACH ROW EXECUTE FUNCTION public.org_challenge_count_join();

-- ─────────────────────────────────────────────────────────
-- 5. 状態の遷移表と、開始後の期間・種類・部署の不変
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.org_challenge_guard_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  -- 状態の列は NOT NULL (1. で付けた) なので OLD.status は NULL にならない
  v_from text := OLD.status;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- 遷移表 (src/lib/org-challenge-privacy.ts の ORG_CHALLENGE_STATUS_TRANSITIONS と同じ):
    --   draft → active / completed / cancelled、active → completed / cancelled。completed / cancelled からは変えない。
    --   NULL への変更も止める (NOT NULL の 23502 より先に、同じ識別子で断る)。
    --   NOT (NULL) は NULL で IF を素通りするので、比較の結果を COALESCE で false に寄せてから否定する
    IF NEW.status IS NULL OR NOT COALESCE(
         (v_from = 'draft'  AND NEW.status IN ('active', 'completed', 'cancelled'))
      OR (v_from = 'active' AND NEW.status IN ('completed', 'cancelled')),
         false
    ) THEN
      RAISE EXCEPTION 'CHALLENGE_STATUS_LOCKED' USING ERRCODE = 'P0001',
        DETAIL = format('status %L -> %L', v_from, NEW.status);
    END IF;
  END IF;

  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'CHALLENGE_PERIOD_LOCKED' USING ERRCODE = 'P0001', DETAIL = 'organization_id';
  END IF;

  IF v_from <> 'draft' AND (
       NEW.start_date     IS DISTINCT FROM OLD.start_date
    OR NEW.end_date       IS DISTINCT FROM OLD.end_date
    OR NEW.challenge_type IS DISTINCT FROM OLD.challenge_type
    OR NEW.department_id  IS DISTINCT FROM OLD.department_id
  ) THEN
    RAISE EXCEPTION 'CHALLENGE_PERIOD_LOCKED' USING ERRCODE = 'P0001',
      DETAIL = format('status %s', v_from);
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.org_challenge_guard_update() FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.org_challenge_guard_update() IS
  '#1688: organization_challenges の UPDATE を遷移表 (draft → active / completed / cancelled、active → completed / cancelled。NULL へは不可) に限り、draft 以外での start_date / end_date / challenge_type / department_id と、常時の organization_id の変更を止める。CHALLENGE_STATUS_LOCKED / CHALLENGE_PERIOD_LOCKED (P0001)。';

CREATE OR REPLACE TRIGGER trg_org_challenge_guard_update
  BEFORE UPDATE ON public.organization_challenges
  FOR EACH ROW EXECUTE FUNCTION public.org_challenge_guard_update();

-- ─────────────────────────────────────────────────────────
-- 6. 終了時の確定 (completed への遷移と同じトランザクションで 1 回だけ)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.org_challenge_finalize()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_finalized_at timestamptz;
BEGIN
  -- 同じ組織の確定を 1 本ずつにする (コミットで外れる)。get_org_challenge_aggregates は「重なりの中で確定の時刻が最も早い 1 本」
  -- だけに平均を出すので、確定の時刻の順がコミットの順と食い違うと、先に始まって後にコミットした確定が、すでに出ている平均の前に
  -- 割り込んでそれを消す (#1688 §4.3 S-26)。鍵を取ったあとの時計の時刻を確定の時刻にすれば、後の確定の時刻は前の確定の
  -- コミットより後になる。now() (トランザクションの開始時刻) は使わない
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('org_challenge_finalize:' || NEW.organization_id::text, 0));
  v_finalized_at := pg_catalog.clock_timestamp();

  INSERT INTO public.organization_challenge_aggregates AS a
         (challenge_id, joined_count, finalized_at, final_ranked_count, final_average_value, updated_at)
  SELECT NEW.id,
         0,
         v_finalized_at,
         count(p.user_id) FILTER (WHERE p.rank IS NOT NULL),
         round(avg(p.current_value) FILTER (WHERE p.rank IS NOT NULL), 1),
         v_finalized_at
    FROM public.organization_challenge_participants AS p
    JOIN public.user_profiles AS up
      ON up.id = p.user_id
     AND up.organization_id = NEW.organization_id
   WHERE p.challenge_id = NEW.id
  ON CONFLICT (challenge_id) DO UPDATE
     SET finalized_at        = EXCLUDED.finalized_at,
         final_ranked_count  = EXCLUDED.final_ranked_count,
         final_average_value = EXCLUDED.final_average_value,
         updated_at          = EXCLUDED.updated_at
   WHERE a.finalized_at IS NULL;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.org_challenge_finalize() FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.org_challenge_finalize() IS
  '#1688: organization_challenges が completed になる UPDATE の AFTER トリガー。組織ごとの advisory lock (org_challenge_finalize:<organization_id>) を取ってから、同じトランザクションの参加行 (順位がついた今のメンバー) の平均 (小数第 1 位) と人数を organization_challenge_aggregates に 1 回だけ書く (確定済みなら書かない)。確定の時刻は鍵を取ったあとの clock_timestamp() (同じ組織の中で確定の時刻の順 = コミットの順)。';

CREATE OR REPLACE TRIGGER trg_org_challenge_finalize
  AFTER UPDATE OF status ON public.organization_challenges
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'completed')
  EXECUTE FUNCTION public.org_challenge_finalize();

-- ─────────────────────────────────────────────────────────
-- 7. 管理者になったときの印 (user_profiles のどの経路の変更でも)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.org_challenge_mark_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- 組織の管理者 (owner / admin。src/lib/org-challenge-privacy.ts の ORG_CHALLENGE_RANKING_HIDDEN_ROLES と同じ並び) でなければ何もしない
  IF NEW.organization_id IS NULL
     OR NEW.org_role IS NULL
     OR NEW.org_role NOT IN ('owner', 'admin') THEN
    RETURN NULL;
  END IF;
  -- 役割も組織も変わっていない UPDATE (ほかの列の更新・同じ値の上書き) では付けない。管理者になった時点だけ
  -- (INSERT のときは OLD を読まない。TG_OP で分けてから比べる)
  IF TG_OP = 'UPDATE' THEN
    IF OLD.org_role IS NOT DISTINCT FROM NEW.org_role
       AND OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id THEN
      RETURN NULL;
    END IF;
  END IF;
  INSERT INTO public.organization_challenge_ranking_exclusions (challenge_id, user_id)
  SELECT c.id, NEW.id
    FROM public.organization_challenges AS c
   WHERE c.organization_id = NEW.organization_id
  ON CONFLICT (challenge_id, user_id) DO NOTHING;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.org_challenge_mark_admin() FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.org_challenge_mark_admin() IS
  '#1688: user_profiles の INSERT と、org_role / organization_id の UPDATE の AFTER トリガー。役割か組織が変わって組織の管理者 (owner / admin) になった時点で、その組織のチャレンジすべてに organization_challenge_ranking_exclusions の印を付ける (既にあれば何もしない)。';

CREATE OR REPLACE TRIGGER trg_org_challenge_mark_admin
  AFTER INSERT OR UPDATE OF org_role, organization_id ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.org_challenge_mark_admin();

-- ─────────────────────────────────────────────────────────
-- 8. 削除の制限: 利用者の権限で消せるのは draft と cancelled だけ
-- ─────────────────────────────────────────────────────────
-- 平均を出しうる completed と、これから確定する active を消して同じ種類・期間で作り直すと、9. の「重なりの中で 1 本」の判定の
-- 相手が消えて 2 回目の公開ができる。RESTRICTIVE なので Org admins can manage challenges (FOR ALL) と AND で効く。
-- 組織の削除の CASCADE と service_role は RLS を通らないので止めない。
-- 並びは src/lib/org-challenge-privacy.ts の ORG_CHALLENGE_DELETABLE_STATUSES と同じ
DROP POLICY IF EXISTS "Org challenges can be deleted only as draft or cancelled" ON public.organization_challenges;
CREATE POLICY "Org challenges can be deleted only as draft or cancelled"
  ON public.organization_challenges
  AS RESTRICTIVE
  FOR DELETE
  TO authenticated
  USING (status IN ('draft', 'cancelled'));

-- ─────────────────────────────────────────────────────────
-- 9. 管理者に見せる集計: 控えの表から返す (名前・引数・返す列は 20261016170000 と同じ)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_org_challenge_aggregates(p_organization_id uuid)
RETURNS TABLE (
  challenge_id      uuid,
  participant_count bigint,
  min_participants  integer,
  average_value     numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH cfg AS (
    -- 値を出すのに必要な最小人数 (要件書 §6.4 の匿名化集計の最低人数。#1600 で 10 人。個人を特定されない集計にする人数)
    SELECT 10 AS min_participants
  ),
  eligible AS (
    -- 平均を出す資格のある確定 (この組織のチャレンジで、確定時点の順位がついた参加者が最小人数以上)。
    -- 種類・期間は draft の後に変わらず (org_challenge_guard_update)、確定値も変わらない (org_challenge_finalize) ので、この集合は増えるだけ
    SELECT s.id, s.challenge_type, s.start_date, s.end_date, sa.finalized_at
      FROM public.organization_challenges AS s
      JOIN public.organization_challenge_aggregates AS sa
        ON sa.challenge_id = s.id
     CROSS JOIN cfg
     WHERE s.organization_id = p_organization_id
       AND sa.final_ranked_count >= cfg.min_participants
  )
  SELECT c.id,
         -- 参加した人の延べ数 (参加のたびに +1。やめても・組織から外れても減らない)。最小人数に満たなければ NULL
         CASE WHEN a.joined_count >= cfg.min_participants THEN a.joined_count::bigint END,
         cfg.min_participants,
         -- 終了時に確定した平均だけ。確定時点の順位がついた参加者が最小人数に満たなければ NULL。開催中・下書き・中止は常に NULL。
         -- 同じ種類で期間が重なり (両端を含む)、自分より先に確定した (確定の時刻、同じなら ID の順) 資格のあるチャレンジがあれば NULL
         -- (個人の値は種類と期間で決まるので、2 本の平均の差から 1 人の値が出る。公開は重なりの中で 1 本だけ。#1688 §4.1 (e))
         CASE WHEN a.final_ranked_count >= cfg.min_participants
               AND NOT EXISTS (
                 SELECT 1
                   FROM eligible AS e
                  WHERE e.challenge_type = c.challenge_type
                    AND e.start_date <= c.end_date
                    AND c.start_date <= e.end_date
                    AND (e.finalized_at, e.id) < (a.finalized_at, c.id)
               )
              THEN round(a.final_average_value, 1) END
    FROM public.organization_challenges AS c
    LEFT JOIN public.organization_challenge_aggregates AS a
      ON a.challenge_id = c.id
   CROSS JOIN cfg
   WHERE c.organization_id = p_organization_id
$$;

REVOKE ALL ON FUNCTION public.get_org_challenge_aggregates(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_org_challenge_aggregates(uuid)
  TO service_role;

COMMENT ON FUNCTION public.get_org_challenge_aggregates(uuid) IS
  '#1132 / #1600 / #1688: 管理者向けの集計。参加した人の延べ数 (joined_count。min_participants (10) 未満は NULL) と、終了時に確定した平均 (確定時点の順位がついた人が min_participants 未満なら NULL。開催中は NULL。同じ組織・同じ種類で期間が重なり先に確定した資格のあるチャレンジがあれば NULL) を控えの表 organization_challenge_aggregates から返す。個人の値・ID は返さない。SECURITY INVOKER。service_role のみ。';

-- ─────────────────────────────────────────────────────────
-- 10. 参加者に見せる順位表: 組織の管理者と、管理者だった印のある人には返さない (ほかは 20261014100100 の定義のまま)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_org_challenge_ranking(
  p_challenge_id uuid,
  p_user_id      uuid,
  p_limit        integer DEFAULT NULL,  -- NULL は既定の人数 (下の cfg.default_limit)
  p_with_names   boolean DEFAULT false
)
RETURNS TABLE (
  rank         integer,
  current_value numeric,
  is_me        boolean,
  nickname     text,
  ranked_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH cfg AS (
    -- 順位表に出す人数 (上位から。本人の行は、圏外でも別に付ける)。20261014100100 と同じ値
    SELECT 20 AS default_limit, 100 AS max_limit
  ),
  ranked AS (
    SELECT p.rank,
           p.current_value,
           p.user_id,
           CASE WHEN p_with_names THEN up.nickname END AS nickname,
           row_number() OVER (ORDER BY p.rank, p.joined_at, p.user_id) AS pos,
           count(*) OVER () AS total
      FROM public.organization_challenges AS c
      JOIN public.organization_challenge_participants AS p
        ON p.challenge_id = c.id
      JOIN public.user_profiles AS up
        ON up.id = p.user_id
       AND up.organization_id = c.organization_id
     WHERE c.id = p_challenge_id
       AND p.rank IS NOT NULL
  )
  SELECT r.rank,
         r.current_value,
         (r.user_id = p_user_id),
         r.nickname,
         r.total
    FROM ranked AS r
   CROSS JOIN cfg
   WHERE (r.pos <= LEAST(GREATEST(COALESCE(p_limit, cfg.default_limit), 1), cfg.max_limit) OR r.user_id = p_user_id)
     -- 順位表を見られるのは、そのチャレンジの参加者本人 (今も組織のメンバー) で、組織の管理者でなく、管理者だった印も無い人だけ。
     -- 管理者 (org_role が owner / admin。メンバーを組織から外せる人) には 0 行 (#1688。src/lib/org-challenge-privacy.ts の
     -- ORG_CHALLENGE_RANKING_HIDDEN_ROLES と同じ並び)。このチャレンジがある間に管理者になった人 (印。member に戻っても残る) にも 0 行。
     -- 参加していない人にも 0 行
     AND EXISTS (
       SELECT 1
         FROM public.organization_challenges AS c2
         JOIN public.organization_challenge_participants AS me
           ON me.challenge_id = c2.id
          AND me.user_id = p_user_id
         JOIN public.user_profiles AS meup
           ON meup.id = me.user_id
          AND meup.organization_id = c2.organization_id
        WHERE c2.id = p_challenge_id
          AND (meup.org_role IS NULL OR meup.org_role NOT IN ('owner', 'admin'))
          AND NOT EXISTS (
            SELECT 1
              FROM public.organization_challenge_ranking_exclusions AS x
             WHERE x.challenge_id = c2.id
               AND x.user_id = p_user_id
          )
     )
   ORDER BY r.pos
$$;

REVOKE ALL ON FUNCTION public.get_org_challenge_ranking(uuid, uuid, integer, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_org_challenge_ranking(uuid, uuid, integer, boolean)
  TO service_role;

COMMENT ON FUNCTION public.get_org_challenge_ranking(uuid, uuid, integer, boolean) IS
  '#1132 / #1688: 参加者に見せる順位表。p_user_id がそのチャレンジの参加者 (今も組織のメンバー) で、組織の管理者 (owner / admin) でなく、organization_challenge_ranking_exclusions の印も無いときだけ、順位がついている参加者を上位 p_limit 人 (NULL は既定の default_limit = 20 人。1〜max_limit = 100 人) と本人の行について返す。管理者・印のある人・参加していない人には 0 行。他人の user_id は返さない。nickname は p_with_names が true のときだけ。SECURITY INVOKER。service_role のみ。';

-- ─────────────────────────────────────────────────────────
-- 11. 既存のチャレンジの埋め戻し (延べ数 = いまの参加行の数。completed は一度だけ確定。印は埋め戻さない)
-- ─────────────────────────────────────────────────────────
-- 確定の時刻は now() (この migration のトランザクションの開始時刻) でよい。確定のトリガーはこの migration のコミットまで
-- 他のトランザクションから見えず (1. の ALTER TABLE が organization_challenges の排他ロックをコミットまで持つ)、以後の確定の時刻は
-- コミットより後の clock_timestamp() なので、埋め戻した確定は必ずそれより前に並ぶ
INSERT INTO public.organization_challenge_aggregates AS a (challenge_id, joined_count)
SELECT c.id, count(p.id)
  FROM public.organization_challenges AS c
  LEFT JOIN public.organization_challenge_participants AS p
    ON p.challenge_id = c.id
 GROUP BY c.id
ON CONFLICT (challenge_id) DO NOTHING;

INSERT INTO public.organization_challenge_aggregates AS a
       (challenge_id, joined_count, finalized_at, final_ranked_count, final_average_value, updated_at)
SELECT c.id,
       0,
       now(),
       count(m.user_id),
       round(avg(m.current_value), 1),
       now()
  FROM public.organization_challenges AS c
  LEFT JOIN LATERAL (
    -- 順位がついた、今も組織のメンバーである参加者だけ
    SELECT p.user_id, p.current_value
      FROM public.organization_challenge_participants AS p
      JOIN public.user_profiles AS up
        ON up.id = p.user_id
       AND up.organization_id = c.organization_id
     WHERE p.challenge_id = c.id
       AND p.rank IS NOT NULL
  ) AS m ON true
 WHERE c.status = 'completed'
 GROUP BY c.id
ON CONFLICT (challenge_id) DO UPDATE
   SET finalized_at        = EXCLUDED.finalized_at,
       final_ranked_count  = EXCLUDED.final_ranked_count,
       final_average_value = EXCLUDED.final_average_value,
       updated_at          = EXCLUDED.updated_at
 WHERE a.finalized_at IS NULL;
