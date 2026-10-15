-- rollback: 20261015190000_org_challenge_min10_join_policy.sql
-- ⚠️ 守りが弱くなる: 戻すと、管理者向けの集計 (get_org_challenge_aggregates) の最小人数が 5 人に戻り、
--    参加の INSERT ポリシーも #1238 の形 (本人・自分の組織のチャレンジ・進捗 0・順位なし) に戻って、利用者の JWT で PostgREST に
--    直接 INSERT すると、別の部署向け・下書き・終わったチャレンジにも参加行を作れる状態に戻る (#1600 の前の状態)。
--    明示的な承認を得た場合に限って使う。
--
-- 内容:
--   1. get_org_challenge_aggregates(uuid) を、20261014100100_org_challenge_progress.sql の定義 (最小人数 5) にそのまま戻す
--      (権限も同じ: service_role だけ)
--   2. 参加の INSERT ポリシー「Users can join challenges」を、#1238 の定義 (supabase/baseline/prod_schema.sql と同じ) に戻す
--   データには触れない (参加者の行・チャレンジの行はそのまま)。
--
-- API・画面のコードは戻さなくてよい (関数の名前・引数・返す列は変わらない)。画面の説明文の既定値「10人」は、
-- packages/shared の ORG_CHALLENGE_MIN_PARTICIPANTS を戻さない限り、API が返す min_participants (5) で上書きされる。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 何度流しても同じ結果になる (冪等)。

SET LOCAL lock_timeout = '10s';

-- ─────────────────────────────────────────────────────────
-- 1. 管理者に見せる集計を 20261014100100 の定義に戻す (最小人数 5)
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
    -- 値を出すのに必要な最小人数 (#1120 の判断。個人を特定されない集計にする人数)
    SELECT 5 AS min_participants
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
  '#1132: 管理者向けの集計。組織のチャレンジごとに、参加者数 (今も組織のメンバーである人) と、集計が済んだ参加者の平均だけを返す。個人の値・ID は返さない。参加者が min_participants (5) に満たないときは参加者数を、集計が済んだ人が min_participants に満たないときは平均を NULL にする。SECURITY INVOKER。service_role のみ。';

-- ─────────────────────────────────────────────────────────
-- 2. 参加の INSERT ポリシーを #1238 の定義に戻す (supabase/baseline/prod_schema.sql と同じ)
-- ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can join challenges" ON public.organization_challenge_participants;
CREATE POLICY "Users can join challenges" ON "public"."organization_challenge_participants" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM ("public"."organization_challenges" "oc"
     JOIN "public"."user_profiles" "up" ON (("up"."organization_id" = "oc"."organization_id")))
  WHERE (("oc"."id" = "organization_challenge_participants"."challenge_id") AND ("up"."id" = ( SELECT "auth"."uid"() AS "uid"))))) AND (COALESCE("current_value", (0)::numeric) = (0)::numeric) AND ("rank" IS NULL)));
