-- rollback: 20261016240000_org_challenge_diff_privacy.sql
-- ⚠️ 守りが弱くなる: 戻すと、集計は参加者の行をその場で数える形 (20261016170000 の定義) に、順位表は管理者にも返す形
--    (20261014100100 の定義) に戻り、終了・中止したチャレンジの状態や開始後の期間を管理者が書き換えられ、開催中・終了した
--    チャレンジを消せる状態に戻る。明示的な承認を得た場合に限って使う。
--
-- 内容:
--   1. トリガー 4 本 (trg_org_challenge_count_join / trg_org_challenge_guard_update / trg_org_challenge_finalize /
--      trg_org_challenge_mark_admin) と、その関数 4 本を消す
--   2. ポリシー "Org challenges can be deleted only as draft or cancelled" を消す
--   3. get_org_challenge_aggregates(uuid) を 20261016170000_org_challenge_min10_join_policy.sql の定義 (最小人数 10。その場で数える) に戻す
--   4. get_org_challenge_ranking(uuid, uuid, integer, boolean) を 20261014100100_org_challenge_progress.sql の定義に戻す
--   5. 表 organization_challenge_ranking_exclusions と organization_challenge_aggregates を消す (印と控えのデータは失われる。
--      参加行・チャレンジの行はそのまま)
--   6. organization_challenges.status の NOT NULL を外す (本番の定義に戻す。NULL から draft にした行は draft のまま)
--   権限 (service_role だけ) は 3・4 で流し直す。
-- 先に API のデプロイ (順位表の reason・PUT のガード) を戻す必要は無い (関数の名前・引数・返す列は変わらない。
-- 管理者への順位表は API 側で伏せたまま)。本番に戻すときは、この内容を新しい migration として PR 経由で適用する。
-- 何度流しても同じ結果になる (冪等)。

SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS trg_org_challenge_count_join   ON public.organization_challenge_participants;
DROP TRIGGER IF EXISTS trg_org_challenge_guard_update ON public.organization_challenges;
DROP TRIGGER IF EXISTS trg_org_challenge_finalize     ON public.organization_challenges;
DROP TRIGGER IF EXISTS trg_org_challenge_mark_admin   ON public.user_profiles;
DROP FUNCTION IF EXISTS public.org_challenge_count_join();
DROP FUNCTION IF EXISTS public.org_challenge_guard_update();
DROP FUNCTION IF EXISTS public.org_challenge_finalize();
DROP FUNCTION IF EXISTS public.org_challenge_mark_admin();

DROP POLICY IF EXISTS "Org challenges can be deleted only as draft or cancelled" ON public.organization_challenges;

-- ─────────────────────────────────────────────────────────
-- 3. 管理者に見せる集計を 20261016170000_org_challenge_min10_join_policy.sql の定義に戻す (同 migration の 44〜86 行の逐語。最小人数 10。その場で数える)
--    集計の表を読む新しい定義を、表を消す前に置き換える
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
    -- 値を出すのに必要な最小人数 (要件書 §6.4 の匿名化集計の最低人数。#1600。個人を特定されない集計にする人数)
    SELECT 10 AS min_participants
  ),
  agg AS (
    SELECT c.id AS challenge_id,
           count(m.user_id)                                       AS participants,
           count(m.user_id) FILTER (WHERE m.rank IS NOT NULL)     AS ranked,
           avg(m.current_value) FILTER (WHERE m.rank IS NOT NULL) AS average_value
      FROM public.organization_challenges AS c
      LEFT JOIN LATERAL (
        -- 今も組織のメンバーである参加者だけ
        SELECT p.user_id, p.rank, p.current_value
          FROM public.organization_challenge_participants AS p
          JOIN public.user_profiles AS up
            ON up.id = p.user_id
           AND up.organization_id = c.organization_id
         WHERE p.challenge_id = c.id
      ) AS m ON true
     WHERE c.organization_id = p_organization_id
     GROUP BY c.id
  )
  SELECT a.challenge_id,
         -- 参加者が最小人数に満たないときは、人数も出さない
         CASE WHEN a.participants >= cfg.min_participants THEN a.participants END,
         cfg.min_participants,
         -- 集計が済んだ (順位がついた) 参加者が最小人数に満たないときは、平均を出さない
         CASE WHEN a.ranked >= cfg.min_participants THEN round(a.average_value, 1) END
    FROM agg AS a
   CROSS JOIN cfg
$$;

REVOKE ALL ON FUNCTION public.get_org_challenge_aggregates(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_org_challenge_aggregates(uuid)
  TO service_role;

COMMENT ON FUNCTION public.get_org_challenge_aggregates(uuid) IS
  '#1132 / #1600: 管理者向けの集計。組織のチャレンジごとに、参加者数 (今も組織のメンバーである人) と、集計が済んだ参加者の平均だけを返す。個人の値・ID は返さない。参加者が min_participants (10) に満たないときは参加者数を、集計が済んだ人が min_participants に満たないときは平均を NULL にする。SECURITY INVOKER。service_role のみ。';

-- ─────────────────────────────────────────────────────────
-- 4. 参加者に見せる順位表を 20261014100100_org_challenge_progress.sql の定義に戻す (同 migration の 269〜334 行の逐語)
--    ranking を先に戻してから印の表を消す (新しい定義が印の表を読んでいるため)
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
    -- 順位表に出す人数 (上位から。本人の行は、圏外でも別に付ける)
    --   default_limit: p_limit が NULL のときの人数。画面の順位表の人数 (src/lib/org-challenges.ts の RANKING_ENTRY_LIMIT) と同じ値にする
    --                  (設計書 docs/design/org/07-challenge.md「上位 20 人と本人の行」。tests/org-challenges-lib.test.ts が同じ値かを確かめる)
    --   max_limit:     p_limit に大きな値が渡されても、1 回に返す行数をこの人数で打ち切る (順位表は上位だけを見せるもので、
    --                  大きな組織の全員分を返さない。API が 1 回に受け取れる行数の上限 1000 行よりも十分小さくする)
    SELECT 20 AS default_limit, 100 AS max_limit
  ),
  ranked AS (
    -- 順位がついている (集計が済んだ) 参加者。今も、そのチャレンジの組織のメンバーである人だけ
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
   -- 人数は 1 人以上・max_limit 人以下にそろえる (0 以下が渡されても、1 人は返す)
   WHERE (r.pos <= LEAST(GREATEST(COALESCE(p_limit, cfg.default_limit), 1), cfg.max_limit) OR r.user_id = p_user_id)
     -- 順位表を見られるのは、そのチャレンジの参加者本人 (今も組織のメンバー) だけ。参加していない人には 0 行
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
     )
   ORDER BY r.pos
$$;

REVOKE ALL ON FUNCTION public.get_org_challenge_ranking(uuid, uuid, integer, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_org_challenge_ranking(uuid, uuid, integer, boolean)
  TO service_role;

COMMENT ON FUNCTION public.get_org_challenge_ranking(uuid, uuid, integer, boolean) IS
  '#1132: 参加者に見せる順位表。p_user_id がそのチャレンジの参加者 (今も組織のメンバー) のときだけ、順位がついている参加者を上位 p_limit 人 (NULL は既定の default_limit = 20 人。1〜max_limit = 100 人にそろえる) と本人の行について返す (参加していない人には 0 行)。他人の user_id は返さない (is_me だけ)。nickname は p_with_names が true のときだけ入る。SECURITY INVOKER。service_role のみ。';

-- 5. 表を消す (印と控えのデータは失われる)
DROP TABLE IF EXISTS public.organization_challenge_ranking_exclusions;
DROP TABLE IF EXISTS public.organization_challenge_aggregates;

-- 6. 状態の NOT NULL を外す
ALTER TABLE public.organization_challenges ALTER COLUMN status DROP NOT NULL;
