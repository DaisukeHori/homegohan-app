-- migration: 20261008090000_family_members_status_guard.sql
-- Issue #1309: 家族のメンバーが自分の family_members.status を PostgREST から直接書き換えられ、
--   退出・除名のあとに家族へ戻れてしまう (人数の上限 member_limit も超える) 問題を直す
--
-- 背景 (本番の現状: supabase/baseline/prod_schema.sql。20261007112200 より新しい migration で、family_members の UPDATE の入口を変えたものは無い):
--   family_members の UPDATE ポリシー family_members_update_self_or_adult は、列を限らずに更新を許している。
--     USING ((user_id = auth.uid()) OR is_active_family_adult(family_id))   (WITH CHECK 無し)
--   anon / authenticated には family_members への UPDATE が GRANT されている (テーブル単位。列単位の絞りは無い) ので、
--   防いでいるのは RLS とトリガー guard_family_members_privileged だけ。このトリガーが守っているのは
--   role / family_id / user_id (と、本人以外の共有設定 share_*) で、status と removed_at は守っていない。
--   そのため、ログインユーザーは PostgREST から (PATCH /rest/v1/family_members?id=eq.<自分の行>) 次のことができた。
--     1. 退出 (left)・除名 (removed) された本人が、自分の行を status = 'active' に戻す。
--        招待の承諾 (accept_family_invite) を通らないので、人数の上限 (member_limit) の確認も、招待の確認も受けない。
--        上限 2 の家族で active が 3 人になる (Issue #1309 に記載。tests/integration/security/family-member-status-guard.test.ts の R1 / R2 で再現する)。
--        status = 'active' は、can_view_user_meals / is_active_family_member / is_active_family_adult のように、
--        家族の中での閲覧・管理の権限の根拠になっている。戻ると、家族が共有しているデータをまた見られ、大人だった人は招待や家族の設定変更もまたできる。
--     2. active なメンバーが自分を 'left' にする。leave_family が確認する「代表者は退出できない」、プロフィールの family_id を外す処理、
--        監査ログ (member_left) をすべて迂回する。代表者が自分を 'left' にすると、active な代表者のいない家族ができる
--        (uniq_family_representative は active な代表者が 0 人の状態を止めない)。
--     3. active な大人 (is_active_family_adult の枝) が、代表者を含む他のメンバーの行を 'removed' にする。remove_family_member の規則
--        (代表者は除名できない・監査ログ) を迂回する。除名済みの行を 'active' に戻して、他人を上限を超えて家族へ戻すこともできる。
--
-- 変更 (1 関数だけ。CREATE OR REPLACE。signature・戻り値・属性・実行権限は現行のまま):
--   guard_family_members_privileged() が、ログインユーザー (current_user が authenticated / anon) による status と removed_at の変更も拒否する。
--   拒否のしかたは role / family_id / user_id と同じ (RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501')。
--   - 値を変えない更新 (NEW.status = OLD.status) は拒否しない。行をまるごと送り直すクライアントも壊れない。
--   - removed_at も一緒に守る。status と対で leave_family / remove_family_member が書く列で、直接書き換えられると、退出・除名の時刻を
--     消したり偽ったりできる。ログインユーザーが直接書く正規の経路は無い。
--   - SECURITY DEFINER の RPC (所有者 postgres。実行中の current_user は postgres) と service_role は、従来どおりこのガードの対象外。
--     退出・除名・解散は、これらの RPC か service_role だけが行う。
--   - 属性は変えない。SECURITY INVOKER のまま (SECURITY DEFINER にすると current_user が常に postgres になり、ガードが一切効かなくなる)。
--     search_path の指定も、現行 (指定なし) のまま。本文は auth.uid() をスキーマ付きで呼ぶだけで、ほかの名前解決は無い。
--   次は変更しない: トリガー本体 (BEFORE UPDATE FOR EACH ROW。関数の本文だけが変わるので、トリガーを作り直す必要は無い)、
--     RLS ポリシー、テーブルの GRANT、関数の GRANT、#1015 の共有設定のガード、ほかの関数。
--
-- 方式の選び方 (いちばん危険が小さいもの):
--   (a) トリガーで status / removed_at も守る  ← 採用。既存のガード (role / family_id / user_id) と同じ仕組みで、動作も権限の見方も揃う。
--   (b) UPDATE の列権限 (GRANT UPDATE (列, ...)) を絞る: テーブル単位の GRANT を列単位に作り替える大きな変更になり、今後列を足すたびに
--       権限の付け忘れが起きる。本番の権限スナップショット (supabase/baseline/prod_table_acl.sql) とも形が変わる。
--   (c) RLS の WITH CHECK で守る: 変更前の値 (OLD) を参照できないので、「status を変えた」ことを判定できない。
--   ポリシーの USING を「自分の行は active のときだけ」へ狭める案もあるが、退出・除名済みの人が自分の古い行の表示名などを触れること自体は
--   権限の昇格ではなく、狭めると既存の挙動 (ポリシー) を変える。status のガードだけで #1309 の穴は塞がるので、ここでは変えない。
--
-- 既存の正当な利用経路への影響: なし。
--   family_members.status / removed_at を書くのは、次のいずれかの経路だけで、ログインユーザーの直接の UPDATE ではない。
--     - leave_family() / remove_family_member() / operator_force_dissolve_family(): SECURITY DEFINER (所有者 postgres)。
--     - 家族に入る行は INSERT (create_family_group / accept_family_invite / add_family_child)。INSERT は BEFORE UPDATE トリガーの対象外。
--       退出した人が戻る正規の経路は「新しい招待を承諾して、新しい行を INSERT する」で、古い行は left のまま残る。
--     - service_role (Next.js の service role クライアント、運営ツール、テスト)。
--   アプリ (Next.js・Edge Function・scripts) に、ログインユーザーとして family_members を直接 UPDATE する箇所は無い
--   (family_members の読み取りは SELECT だけ。書き込みはすべて RPC)。モバイルの apps/mobile/app/family/index.tsx は
--   .update({ is_active: false }) と、family_members に無い列を更新していて (旧テーブル用のコードの残り)、元から失敗する。status は書いていないので、影響は変わらない。
--
-- 既存データへの影響: なし (関数の本文だけを置き換える。データの更新・削除はしない)。
--   すでに上限を超えている家族や、退出済み・除名済みなのに active に戻っている行が本番にあっても、この migration は直さない。
--   件数を数える読み取り専用の SQL は PR の本文にある。直すかどうかは、件数を見てから別に決める。
--
-- 冪等: CREATE OR REPLACE FUNCTION のため、2 回続けて適用してもエラーにならない。実行権限 (ACL) は CREATE OR REPLACE では変わらない。
-- 確認: tests/integration/security/family-member-status-guard.test.ts。修正前は退出・除名・active の各ケースで UPDATE が通って失敗し、
--       この migration の後は全件成功する (RPC・service_role・status 以外の列の更新が通ることも同じテストで確かめる)。
-- ロールバック: supabase/rollbacks/20261008090000_family_members_status_guard.down.sql

CREATE OR REPLACE FUNCTION public.guard_family_members_privileged() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    -- #1309: status / removed_at もログインユーザーは直接変更できない。退出・除名・解散は
    -- DEFINER RPC (leave_family / remove_family_member / operator_force_dissolve_family) か service_role だけが行う。
    -- 退出・除名済みの本人が自分の行を active に戻すと、招待の承諾も人数の上限の確認も通らずに家族へ戻れてしまう。
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.family_id IS DISTINCT FROM OLD.family_id
       OR NEW.user_id   IS DISTINCT FROM OLD.user_id
       OR NEW.status     IS DISTINCT FROM OLD.status
       OR NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;

    -- #1015: 共有設定 (share_meals/share_health/share_menu) は本人のみ直接 UPDATE 可。
    -- 子供メンバー等 (OLD.user_id IS NULL) は「本人」が存在しないため常に拒否され、
    -- 変更が必要な場合は DEFINER RPC 経由での対応が必要。
    IF auth.uid() IS DISTINCT FROM OLD.user_id THEN
      IF NEW.share_meals  IS DISTINCT FROM OLD.share_meals
         OR NEW.share_health IS DISTINCT FROM OLD.share_health
         OR NEW.share_menu   IS DISTINCT FROM OLD.share_menu THEN
        RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
