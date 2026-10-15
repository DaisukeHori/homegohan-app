-- migration: 20261015190000_org_challenge_min10_join_policy.sql
-- #1600: 組織チャレンジの集計の最小人数を 5 → 10 人にし、参加の直接の INSERT を API と同じ条件で拒む。#1132 (20261014100100_org_challenge_progress.sql) の残り
--
-- 背景:
--   1. 管理者に見せる集計 (get_org_challenge_aggregates) の最小人数が 5 人だった。
--      要件書 (docs/requirements/02-organization-management.md §6.4) は、部署の匿名化集計の最低人数を 10 名以上とする。
--   2. 参加の INSERT ポリシー (#1238 の「Users can join challenges」) は、本人・自分の組織のチャレンジ・進捗 0・順位なししか見なかった。
--      部署の限定・状態・種類・終了日は API (POST /api/org/challenges/[id]/join) だけが見ていたので、利用者の JWT で PostgREST に
--      直接 INSERT すると、別の部署向け・下書き・終わったチャレンジにも参加行を作れ、夜の集計の順位と人数に混ざった。
--
-- 変更 (表・列は増やさない。関数の名前・引数・返す列も変えない):
--   1. get_org_challenge_aggregates(p_organization_id) を CREATE OR REPLACE で作り直す。
--        本体は 20261014100100_org_challenge_progress.sql の定義の写しで、変えたのは最小人数 (cfg.min_participants) の 5 → 10 だけ。
--        SECURITY INVOKER・STABLE・search_path = ''・EXECUTE は service_role (と所有者 postgres) だけ、は元のまま。
--          参加者数 = 参加者 (今も組織のメンバーである人) が 10 人に満たなければ NULL
--          平均     = 集計が済んだ (順位がついた) 参加者が 10 人に満たなければ NULL
--        最小人数を見る関数は、この 1 本だけ (update_org_challenge_progress / get_org_challenge_ranking は最小人数を見ない)。
--   2. 参加の INSERT ポリシー「Users can join challenges」に、API が見ている条件を足す:
--        チャレンジが開催中 (status = 'active')・食事の記録から計算できる種類 (breakfast_rate / veg_score / cooking_rate。
--        src/lib/org-challenges.ts の ORG_CHALLENGE_TYPES と同じ)・終了日 (JST) を過ぎていない・
--        部署を限定したチャレンジは、その部署のメンバーだけ。
--        元の条件 (本人・自分の組織のチャレンジ・進捗 0・順位なし) はそのまま。
--
-- 既知の限界 (この migration では直さない): 集計の差分の攻撃 (参加をやめる・メンバーを外す前後の平均の差から 1 人の値を逆算する) は残る。#1688 で設計する。
--
-- 本番のデータへの影響:
--   - 既存の行は 1 件も書き換えない (関数の作り直しとポリシーの付け替えだけ)。
--   - 参加者が 5〜9 人のチャレンジは、管理者向けの画面で人数・平均が「10人未満」「集計中」に戻る (値は隠れるだけで消えない)。
--   - すでにある参加行は、新しい条件に合わなくても消さない (ポリシーは INSERT のときだけ見る)。
--   - 表への書き込みを待たせるロックは、ポリシーの付け替え (ACCESS EXCLUSIVE。一瞬) だけ。10 秒でロック待ちを諦める。
--
-- 冪等: CREATE OR REPLACE FUNCTION / DROP POLICY IF EXISTS → CREATE POLICY。何度流しても同じ結果になる。
-- 確認: tests/integration/rls/org-challenge-progress.test.ts (H: 9 人では返さず 10 人で返す) /
--       tests/integration/rls/challenge-participants-org-scope.test.ts (#1600 INSERT) /
--       tests/integration/security/org-challenges-api.test.ts (D) / tests/org-challenge-min10-join-policy-migration-contract.test.ts
-- ロールバック: supabase/rollbacks/20261015190000_org_challenge_min10_join_policy.down.sql
--   (戻すと、最小人数が 5 人に戻り、別の部署向け・下書き・終わったチャレンジへの直接の INSERT が通る状態に戻る。守りが弱くなるので注意)

SET LOCAL lock_timeout = '10s';

-- ─────────────────────────────────────────────────────────
-- 1. 管理者に見せる集計 (人数と平均だけ。個人の値は返さない。10 人に満たない間は値を返さない)
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

-- 関数の権限: service_role だけ (20261014100100 と同じ)。CREATE OR REPLACE は既存の権限を保つが、何度流しても同じになるよう流し直す
REVOKE ALL ON FUNCTION public.get_org_challenge_aggregates(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_org_challenge_aggregates(uuid)
  TO service_role;

COMMENT ON FUNCTION public.get_org_challenge_aggregates(uuid) IS
  '#1132 / #1600: 管理者向けの集計。組織のチャレンジごとに、参加者数 (今も組織のメンバーである人) と、集計が済んだ参加者の平均だけを返す。個人の値・ID は返さない。参加者が min_participants (10) に満たないときは参加者数を、集計が済んだ人が min_participants に満たないときは平均を NULL にする。SECURITY INVOKER。service_role のみ。';

-- ─────────────────────────────────────────────────────────
-- 2. 参加の INSERT ポリシーに、API と同じ条件を足す
-- ─────────────────────────────────────────────────────────
-- API (POST /api/org/challenges/[id]/join) が見ている条件と同じ:
--   開催中 (status = 'active')・食事の記録から計算できる種類 (src/lib/org-challenges.ts の ORG_CHALLENGE_TYPES と同じ 3 つ)・
--   終了日 (JST) を過ぎていない・部署を限定したチャレンジは、その部署のメンバーだけ。
-- 元の条件 (本人・自分の組織のチャレンジ・進捗 0・順位なし) はそのまま。
DROP POLICY IF EXISTS "Users can join challenges" ON public.organization_challenge_participants;
CREATE POLICY "Users can join challenges" ON public.organization_challenge_participants
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
        FROM public.organization_challenges AS oc
        JOIN public.user_profiles AS up
          ON up.organization_id = oc.organization_id
       WHERE oc.id = organization_challenge_participants.challenge_id
         AND up.id = (SELECT auth.uid())
         AND oc.status = 'active'
         AND oc.challenge_type IN ('breakfast_rate', 'veg_score', 'cooking_rate')
         AND oc.end_date >= (now() AT TIME ZONE 'Asia/Tokyo')::date
         AND (oc.department_id IS NULL OR oc.department_id = up.department_id)
    )
    AND COALESCE(current_value, 0) = 0
    AND rank IS NULL
  );
