-- migration: 20261022200000_family_groups_no_direct_delete.sql
-- 戻し方: supabase/rollbacks/20261022200000_family_groups_no_direct_delete.down.sql
-- #1917: 家族の代表者が PostgREST の直接の DELETE で family_groups の行を消せ、保護者の同意の記録 (parental_consents) が
-- 外部キーの CASCADE で物理削除されてしまう既存の欠陥を直す。解散の RPC (通知・監査) も通らなかった。
-- オーナーの選択 (2026-10-22・選択式): 「直接の削除を塞ぐ (推奨)」。選択肢の説明の文は
-- 「家族の削除は解散の仕組み (通知・監査つき) だけにする。代表者が解散する操作そのものは今どおりできる」。
--
-- 背景:
--   本番のベースライン (20251126124224_create_meal_planner_tables.sql) の
--     :10352 family_groups_delete_representative  FOR DELETE (TO public) USING (representative_id = auth.uid())
--   と、:13588-13589 の anon / authenticated への DELETE・TRUNCATE の権限により、家族の代表者は自分の家族の行を直接 DELETE できた。
--   そのとき、family_groups を参照する表が外部キーの CASCADE で一緒に消える:
--     family_members・family_invites・family_promotion_requests・parental_consents (20261017030000_parental_consent_and_birth_date.sql:92
--     family_id ... ON DELETE CASCADE)。user_profiles.family_id は SET NULL。
--   保護者の同意の記録は、解散のあとも残す (解散から 90 日の物理削除 20261018010000_purge_dissolved_family_groups.sql も、
--   同意の記録を持つ家族は消さずに残す) 取り決めだが、この直接の DELETE だけがそれを消せた。解散の RPC が書く監査
--   (membership_audit の group_dissolved) と解散の知らせ (メール) も通らない。これより後の migration に、このポリシーを外すものは無い。
--
--   家族の行を消す経路 (origin/main で git grep した):
--     - 解散した家族の物理削除: purge_dissolved_family_groups (SECURITY INVOKER。呼ぶのは pg_cron (所有者 postgres) と service_role だけ)。
--       解散から 90 日を過ぎ、同意の記録を持たない家族だけを消す
--     - 運営の手作業・テストの後片付け・e2e の補助 (tests/e2e/fixtures/fresh-family.ts・tests/e2e/helpers/membership-family.ts・
--       scripts/guide-screenshots/seed.ts): どれも service_role の鍵で書く
--     - 代表者の退会では家族の行は消えない: family_groups から auth.users への外部キーは representative_id の ON DELETE RESTRICT
--       だけ (ベースライン :8883。名前が family_groups_owner_id_fkey の CASCADE の外部キーは legacy_family_groups の owner_id のもの)。
--       代表者は譲渡か解散をしないと退会できず、解散で representative_id を NULL にしたあとの退会も家族の行に触れない
--     - Web (src)・モバイル (apps/mobile)・Edge Function (supabase/functions) は、利用者のセッションで family_groups を DELETE しない
--       (`from('family_groups')` の `.delete(` は 0 件)。代表者が家族をやめる操作は、解散の RPC dissolve_family_by_representative
--       (SECURITY DEFINER。POST /api/family/dissolve) で行う。解散の RPC と運営の強制解散 operator_force_dissolve_family は
--       family_groups を UPDATE するだけ (DELETE しない) なので、この変更の影響を受けない
--     - 直接の DELETE を使っていたのは結合テストだけ (#1310 のロックの順の回帰テスト・#1163 の上限・#1912 の CASCADE・
--       billing/01 のテスト 106)。どれも service_role の DELETE か解散の RPC に置き換える (ロックの順は DELETE 文の性質なので、
--       service_role の DELETE と purge でも同じ順になる)
--
-- 変更 (20261022150000_family_invites_rpc_only_writes.sql と同じ形):
--   1. DELETE を許すポリシー family_groups_delete_representative を消す。
--      SELECT の family_groups_select_member と UPDATE の family_groups_update_adult は残す (画面が読み、家族の名前などを書き換える。
--      特権列は guard_family_groups_privileged が守る)。
--   2. DELETE と TRUNCATE の権限を anon と authenticated から外す。
--      ポリシーを消すだけだと DELETE は 0 行で黙って終わる。権限を外すと DELETE は 42501 (permission denied) で止まり、
--      後で誰かが DELETE のポリシーを足しても開かない (二重に閉じる)。TRUNCATE は RLS が効かない書き込みなので一緒に外す。
--      INSERT・SELECT・UPDATE・REFERENCES・TRIGGER・MAINTAIN と service_role の権限は変えない。
--      SECURITY DEFINER の RPC と pg_cron は所有者 (postgres) の権限で動き、service_role は DELETE の権限を持ったままなので、
--      解散と purge はこの変更の影響を受けない。
--
-- 既存データへの影響: なし (ポリシーと権限だけの変更。行は消さない・変えない)。
-- 冪等: DROP POLICY IF EXISTS と REVOKE のため、2 回続けて適用してもエラーにならない。
-- ロック: DROP POLICY は family_groups に ACCESS EXCLUSIVE を取る。家族の表は小さく、長い処理が走っていなければ一瞬で終わる。
-- 確認: tests/integration/rls/family-groups-no-direct-delete.test.ts (実 DB)
--       tests/family-groups-no-direct-delete-migration-contract.test.ts (静的)

-- 表のロックを長く待たない (待ちが続いたら失敗させて流し直す。20261022150000 と同じ)
SET LOCAL lock_timeout = '10s';

-- 1. DELETE のポリシー
DROP POLICY IF EXISTS family_groups_delete_representative ON public.family_groups;

-- 2. DELETE・TRUNCATE の権限
REVOKE DELETE, TRUNCATE ON TABLE public.family_groups FROM anon, authenticated;
