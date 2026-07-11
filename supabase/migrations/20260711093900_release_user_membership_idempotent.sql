-- migration: 20260711093900_release_user_membership_idempotent.sql
-- Issue #1039 follow-up (2モデルレビュー一致指摘・Warning): release_user_membership の冪等化
--
-- 20260710210039_membership_lifecycle_fixes.sql で新設した release_user_membership は
-- 「organization_id が NULL でなければ used_licenses を1減らす」実装だったが、
-- user_profiles 側の状態を一切更新しないため再実行しても organization_id が
-- NULL に戻らない。account/delete のフローは
--   1. release_user_membership 呼び出し (used_licenses -1)
--   2. auth.admin.deleteUser 呼び出し
-- の順で、1 が成功し 2 が失敗した場合 (ネットワーク断・Auth API 障害等) に
-- ユーザーが削除を再試行すると 1 が再実行され、user_profiles.organization_id が
-- まだ元の組織を指したままのため used_licenses が二重に減算される
-- (席数の過小計上によるライセンスプールの実質的な水増し)。
--
-- 修正: leave_org / remove_org_member と同じ「対象を無効化してからカウントを
-- 減らす」パターンに変更する。同一トランザクション内で先に user_profiles を
-- 無効化 (organization_id/org_role を NULL、is_active_in_org を FALSE) し、
-- その UPDATE が実際に対象行を書き換えた場合のみ used_licenses を減らす。
-- 2回目以降の呼び出しは organization_id が既に NULL のため対象条件が不成立と
-- なり (WHERE organization_id = v_org_id が0行)、decrement も監査ログ挿入も
-- スキップされる (no-op)。
--
-- account/delete (src/app/api/account/delete/route.ts) は本 RPC の失敗を
-- ベストエフォート扱いで無視し、deleteUser 呼び出しへ処理を続ける設計のため、
-- 2回目呼び出しが例外を投げても投げなくても account/delete の制御フローには
-- 影響しない。本 migration は「例外を投げず静かに no-op する」実装とし、
-- route 側の変更は不要 (「deleteUser 前に呼ぶ」順序は CASCADE 対策としてそのまま有効)。
--
-- family 側について: release_user_membership の現行実装 (000039) には
-- family 分岐は存在せず、org_license_pools/used_licenses のみを扱う。
-- family_groups の席数は member_limit に対する COUNT(*) で判定されており
-- (20260511000115_membership_family_rpc.sql)、used_licenses のような
-- カウンタ列を持たないため、本 Issue と同型のリークは家族グループ側には
-- 存在しない。よって family 側の対応は不要。
--
-- REVOKE/GRANT/SET search_path は 000039 の定義をそのまま踏襲する
-- (service_role 専用、anon/authenticated/service_role へも default privileges
-- 経由で自動付与されるため明示 REVOKE が必要)。

CREATE OR REPLACE FUNCTION public.release_user_membership(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org_id UUID;
BEGIN
  SELECT organization_id INTO v_org_id FROM user_profiles WHERE id = p_user_id FOR UPDATE;

  IF v_org_id IS NOT NULL THEN
    -- 対象を無効化してからカウントを減らす (leave_org と同じ冪等パターン)。
    -- WHERE organization_id = v_org_id が不成立 (=既に無効化済み) なら
    -- 0行 UPDATE となり、以降の decrement/監査ログもスキップされる。
    UPDATE user_profiles
      SET organization_id = NULL, org_role = NULL,
          is_active_in_org = FALSE, joined_org_at = NULL
      WHERE id = p_user_id AND organization_id = v_org_id;

    IF FOUND THEN
      UPDATE org_license_pools
        SET used_licenses = GREATEST(used_licenses - 1, 0), updated_at = NOW()
        WHERE organization_id = v_org_id;

      INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
      VALUES ('organization', v_org_id, 'member_left', p_user_id, p_user_id,
              jsonb_build_object('reason', 'account_delete'));
    END IF;
  END IF;
END $$;

-- anon/authenticated にも default privileges 経由で自動付与されるため明示的に revoke
-- (本 RPC は service_role 専用。authenticated からの直接呼び出しは不可)
REVOKE EXECUTE ON FUNCTION public.release_user_membership FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_user_membership TO service_role;
