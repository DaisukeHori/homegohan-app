# org/ RLS ポリシー

## 1. 目的・スコープ

組織管理ドメインの全テーブルに対する Row Level Security (RLS) ポリシーの具体的 SQL 定義。

設計原則:
- `organization_id` 境界を全テーブルで厳守
- 産業医境界: 家族領域は絶対に閲覧不可
- service_role の client を作る場所: 製品のコード (Edge Function と Next.js) では、Edge Function と、Next.js では `getSupabaseAdmin()` (例外は `tests/supabase-service-role-client-scan.test.ts` の一覧で service_role を使うとしたファイルだけ。Next.js での自前の `createClient(SERVICE_ROLE_KEY)` は禁止で、`scripts/` は走査の対象外。HR Webhook も同じ。`cross/02-rls-patterns.md` §3.3)
- 監査ログは immutable (DELETE / UPDATE 不可)

## 2. 関連要件

- 要件定義 02 §7 (データモデル)
- `cross/02-rls-patterns.md` (RLS テンプレート)
- `docs/design/CLAUDE.md` §3 (RLS 厳格化)

## 3. 共通ヘルパー関数

```sql
-- 現在ユーザーの organization_id を取得するヘルパー
CREATE OR REPLACE FUNCTION get_user_org_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT organization_id FROM user_profiles WHERE id = auth.uid()
$$;

-- 現在ユーザーのロールが指定ロール配列に含まれるかチェック
-- 注: user_profiles.roles 配列には system ロール (admin / super_admin) と
-- org ロール (org_admin / org_member 等) が混在する。本関数は両方を判定可能で、
-- has_org_role(ARRAY['admin', 'super_admin']) のような system ロール判定にも使える。
-- 関数名は org/ ドメインに最適化されているが、実装上は汎用ロールチェック関数。
CREATE OR REPLACE FUNCTION has_org_role(required_roles TEXT[])
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT roles && required_roles
  FROM user_profiles WHERE id = auth.uid()
$$;

-- 産業医境界チェック: 同組織 + 同意済 + 在籍中
CREATE OR REPLACE FUNCTION can_doctor_access_patient(p_patient_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_profiles caller
    WHERE caller.id = auth.uid()
      AND 'org_industrial_doctor' = ANY(caller.roles)
      AND caller.organization_id = (
        SELECT organization_id FROM user_profiles WHERE id = p_patient_id
      )
  )
  AND EXISTS (
    SELECT 1 FROM user_profiles patient
    WHERE patient.id = p_patient_id
      AND patient.consent_org_health_data = TRUE
      AND patient.is_active_in_org = TRUE
  )
$$;
```

## 4. organizations

```sql
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;  -- 設計の時点の案 (この 4 本のポリシーは作っていない)。今のポリシーの名前と中身は、下の「実装」の段落と表が正

-- SELECT: 自組織 org ロール全員 + 運営
CREATE POLICY "organizations_select" ON organizations
  FOR SELECT USING (
    id = get_user_org_id()
    OR has_org_role(ARRAY['admin', 'super_admin'])
  );

-- INSERT: super_admin のみ (org 新規作成は運営側のみ)
CREATE POLICY "organizations_insert" ON organizations
  FOR INSERT WITH CHECK (
    has_org_role(ARRAY['super_admin'])
  );

-- UPDATE: org_admin (自組織のみ) + 運営
CREATE POLICY "organizations_update" ON organizations
  FOR UPDATE USING (
    (id = get_user_org_id() AND has_org_role(ARRAY['org_admin']))
    OR has_org_role(ARRAY['admin', 'super_admin'])
  );

-- DELETE: super_admin のみ
CREATE POLICY "organizations_delete" ON organizations
  FOR DELETE USING (
    has_org_role(ARRAY['super_admin'])
  );
```

実装 (migration `20261022190000_db_privilege_hardening.sql`): UPDATE はポリシー `organizations_update_admin` (同じ組織の owner / admin) で列を限らずに許すが、ログインユーザー (current_user が authenticated / anon) は次の列を変えられない。値を変えない UPDATE (組織名の変更・同じ値を書く UPDATE) は止めない。service_role と SECURITY DEFINER の関数の中 (current_user が関数の所有者) は書ける。

| 列 | 止めるトリガー関数 | 拒否 | 書く経路 |
|---|---|---|---|
| `owner_id`・`status` | `guard_organizations_privileged` | `CANNOT_MODIFY_PRIVILEGED_COLUMN` (42501) | `owner_id` は譲渡の RPC (SECURITY DEFINER。承諾 `accept_org_owner_transfer`・運営の強制譲渡 `operator_force_owner_transfer`) と解散の後始末 `org_dissolve_apply` (NULL にする)。`status` は解散の後始末 `org_dissolve_apply` (`dissolved` にする)。`org_dissolve_apply` は SECURITY INVOKER で、service_role だけが実行でき、SECURITY DEFINER の `dissolve_org_by_owner` / `operator_force_dissolve_org` が呼ぶ (`supabase/migrations/20261019120000_self_dissolve.sql`: SECURITY INVOKER は `:85`、service_role だけに EXECUTE は `:114-115`、`status` / `owner_id` を書く UPDATE は `:104-108`)。`owner_id` は UPDATE のポリシー `organizations_update_admin` の WITH CHECK (`organizations_owner_id_unchanged(id, owner_id)`) でも止まる (二重の守り) |
| `subscription_status`・`subscription_expires_at` | `guard_organizations_privileged` | `CANNOT_MODIFY_PRIVILEGED_COLUMN` (42501) | 無い (表示用。運営が直すときは service_role) |
| `dissolved_at` | `guard_organizations_privileged` | `CANNOT_MODIFY_PRIVILEGED_COLUMN` (42501) | 解散の後始末 `org_dissolve_apply` (service_role だけが実行でき、SECURITY DEFINER の `dissolve_org_by_owner` / `operator_force_dissolve_org` が呼ぶ) |
| `plan` | `guard_organizations_plan_value` | `ORG_PLAN_OPERATOR_ONLY` (42501) | 運営の画面 (service_role) |

確認: `tests/integration/security/db-privilege-hardening.test.ts` (実 DB)・`tests/db-privilege-hardening-migration-contract.test.ts` (3 列を書く関数の最新の定義がどれも SECURITY DEFINER か利用者が実行できない関数であることを、migration の文面から機械で見る)。

実装 (migration `20261023100000_organizations_no_owner_direct_delete.sql`・#1917 の続き): DELETE のポリシーは運営の `organizations_delete_super_admin` (TO authenticated・`user_profiles.roles` に `super_admin` があり `operator_mfa_satisfied()`。`20261017130000`) だけ。ベースラインのオーナーの DELETE のポリシー `organizations_delete_owner` (`owner_id = auth.uid()`) は消した。オーナーの DELETE は RLS を通り、列を読まない WHERE の DELETE なら所属の列を持つ人がいない組織を消せた (PostgREST の DELETE は SELECT のポリシーにも当たる必要があり、所属しているオーナーは 23514 で止まっていた)。そのときの直接の DELETE は、部署・招待・チャレンジ・席数・日次の集計・レポート (`departments` / `organization_invites` / `organization_challenges` / `org_license_pools` / `org_daily_stats` / `organization_reports`) を外部キーの CASCADE で消し、解散の RPC の知らせ・監査を通らなかったため (家族の同じ欠陥は `20261022200000_family_groups_no_direct_delete.sql` で塞いだ)。オーナーの選択 (2026-10-23・選択式): 「オーナーの直接の削除を塞ぐ (推奨)」。選択肢の説明の文は「家族と同じ扱いにします。組織を消すのは解散の仕組みだけで、オーナーが解散する操作は今どおりできます。運営 (super_admin) の削除のポリシーは残します。」

| 呼び出し元 | 直接の DELETE の結果 |
|---|---|
| オーナー・管理者・メンバー・別の組織の利用者・解散した組織の元のオーナー | 0 行 (エラーなし)。当たる DELETE のポリシーが無い (列を読まない WHERE の DELETE でも 0 行) |
| 未認証 (anon) | 42501 (DELETE の権限を外した) |
| 運営 (super_admin・MFA 済み) | 今までどおり。PostgREST の DELETE は WHERE で列を読むので SELECT のポリシー `organizations_select_member` (所属している人だけ) にも当たる必要があり、所属していない組織は 0 行・所属している組織は CHECK `user_profiles_org_consistency` (23514) で止まる |
| service_role | 消える (テストと e2e の後片付け) |

権限: anon の DELETE は外した。authenticated の DELETE は運営のポリシーが効くために残す。TRUNCATE は `20261022190000_db_privilege_hardening.sql` が anon / authenticated から外してある。組織をやめるのは解散の RPC (`dissolve_org_by_owner` (POST /api/org/dissolve)・`operator_force_dissolve_org`) だけで、どちらも後始末 `org_dissolve_apply` で行を dissolved にする (DELETE しない)。アプリ (Web・モバイル・Edge Function) は利用者のセッションで organizations を DELETE しない。

確認: `tests/integration/rls/organizations-no-owner-direct-delete.test.ts` (実 DB)・`tests/organizations-no-owner-direct-delete-migration-contract.test.ts` (migration の文面・戻し口・アプリのコードの走査)。

## 5. departments

```sql
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;

-- SELECT: 同組織の全 org ロール
CREATE POLICY "departments_select" ON departments
  FOR SELECT USING (
    organization_id = get_user_org_id()
  );

-- INSERT: 同組織の org_admin / org_manager
CREATE POLICY "departments_insert" ON departments
  FOR INSERT WITH CHECK (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_admin', 'org_manager'])
  );

-- UPDATE: 同組織の org_admin / org_manager
CREATE POLICY "departments_update" ON departments
  FOR UPDATE USING (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_admin', 'org_manager'])
  );

-- DELETE: 同組織の org_admin のみ
CREATE POLICY "departments_delete" ON departments
  FOR DELETE USING (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_admin'])
  );
```

## 6. department_history

```sql
ALTER TABLE department_history ENABLE ROW LEVEL SECURITY;

-- SELECT: 本人 or 同組織 org_admin / org_manager
CREATE POLICY "dept_history_select" ON department_history
  FOR SELECT USING (
    user_id = auth.uid()
    OR (
      organization_id = get_user_org_id()
      AND has_org_role(ARRAY['org_admin', 'org_manager'])
    )
  );

-- INSERT: 同組織 org_admin / org_manager のみ
CREATE POLICY "dept_history_insert" ON department_history
  FOR INSERT WITH CHECK (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_admin', 'org_manager'])
  );

-- UPDATE / DELETE 不可 (履歴は immutable)
CREATE POLICY "dept_history_no_update" ON department_history
  FOR UPDATE USING (false);
CREATE POLICY "dept_history_no_delete" ON department_history
  FOR DELETE USING (false);
```

## 7. org_subscriptions / org_invoices

```sql
ALTER TABLE org_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_invoices ENABLE ROW LEVEL SECURITY;

-- SELECT: 同組織 org_admin のみ (課金情報は最小公開)
CREATE POLICY "org_subscriptions_select" ON org_subscriptions
  FOR SELECT USING (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_admin'])
  );

-- INSERT / UPDATE: service_role のみ (Stripe webhook 経由)
CREATE POLICY "org_subscriptions_insert" ON org_subscriptions
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "org_subscriptions_update" ON org_subscriptions
  FOR UPDATE USING (auth.role() = 'service_role');

-- DELETE 不可
CREATE POLICY "org_subscriptions_no_delete" ON org_subscriptions
  FOR DELETE USING (false);

-- org_invoices: 同様
CREATE POLICY "org_invoices_select" ON org_invoices
  FOR SELECT USING (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_admin'])
  );
CREATE POLICY "org_invoices_no_delete" ON org_invoices
  FOR DELETE USING (false);
```

## 8. org_license_pools

```sql
ALTER TABLE org_license_pools ENABLE ROW LEVEL SECURITY;

-- SELECT: 本人の割当があるプール or 同組織 admin/manager/viewer
CREATE POLICY "org_license_pools_select" ON org_license_pools
  FOR SELECT USING (
    (organization_id = get_user_org_id() AND has_org_role(ARRAY['org_admin', 'org_manager', 'org_viewer']))
    OR EXISTS (
      SELECT 1 FROM org_license_assignments
      WHERE license_pool_id = org_license_pools.id
        AND user_id = auth.uid()
        AND status = 'active'
    )
  );

-- INSERT: service_role のみ (Stripe webhook 経由)
CREATE POLICY "org_license_pools_insert" ON org_license_pools
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

-- UPDATE: service_role のみ (used_licenses はトリガー経由のみ変更可)
-- ※ available_licenses は GENERATED ALWAYS なので UPDATE 不可 (DB 側で強制)
CREATE POLICY "org_license_pools_update" ON org_license_pools
  FOR UPDATE USING (auth.role() = 'service_role');

-- DELETE 不可 (期限切れても履歴保持)
CREATE POLICY "org_license_pools_no_delete" ON org_license_pools
  FOR DELETE USING (false);
```

実装 (migration `20261022180000_org_tables_rpc_only_writes.sql`・#1917): 利用者 (anon / authenticated) の書き込みのポリシーは置かず、INSERT / UPDATE / DELETE / TRUNCATE の権限も外してある。SELECT はポリシー `org_license_pools_select_member` (同じ組織のメンバー)。席数 (`total_licenses` / `used_licenses`) を書くのは service_role と SECURITY DEFINER の RPC (`accept_org_invite`・`leave_org`・`remove_org_member`・`release_user_membership`・解散の後始末 `org_dissolve_apply` (service_role だけが実行できる)) だけ。

## 9. org_license_assignments

```sql
ALTER TABLE org_license_assignments ENABLE ROW LEVEL SECURITY;

-- SELECT: 本人 or 同組織 admin/manager/viewer
CREATE POLICY "org_license_assignments_select" ON org_license_assignments
  FOR SELECT USING (
    user_id = auth.uid()
    OR (
      organization_id = get_user_org_id()
      AND has_org_role(ARRAY['org_admin', 'org_manager', 'org_viewer'])
    )
  );

-- INSERT: 同組織 org_admin / org_manager のみ
CREATE POLICY "org_license_assignments_insert" ON org_license_assignments
  FOR INSERT WITH CHECK (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_admin', 'org_manager'])
  );

-- UPDATE (revoke 等): 同組織 org_admin / org_manager + service_role (HR webhook)
CREATE POLICY "org_license_assignments_update" ON org_license_assignments
  FOR UPDATE USING (
    auth.role() = 'service_role'
    OR (
      organization_id = get_user_org_id()
      AND has_org_role(ARRAY['org_admin', 'org_manager'])
    )
  );

-- DELETE 不可 (履歴保持、revoke は status 変更で表現)
CREATE POLICY "org_license_assignments_no_delete" ON org_license_assignments
  FOR DELETE USING (false);
```

## 10. org_license_audit_log

```sql
ALTER TABLE org_license_audit_log ENABLE ROW LEVEL SECURITY;

-- SELECT: 同組織 org_admin / org_manager / org_viewer
CREATE POLICY "org_license_audit_select" ON org_license_audit_log
  FOR SELECT USING (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_admin', 'org_manager', 'org_viewer'])
  );

-- INSERT: 同組織 org_admin / org_manager + service_role
-- WITH CHECK で actor_id = auth.uid() を強制 (service_role は除外)
CREATE POLICY "org_license_audit_insert" ON org_license_audit_log
  FOR INSERT WITH CHECK (
    auth.role() = 'service_role'
    OR (
      organization_id = get_user_org_id()
      AND has_org_role(ARRAY['org_admin', 'org_manager'])
      AND actor_id = auth.uid()  -- actor_id の改ざん防止
    )
  );

-- UPDATE / DELETE 不可 (immutable 監査ログ)
CREATE POLICY "org_license_audit_no_update" ON org_license_audit_log
  FOR UPDATE USING (false);
CREATE POLICY "org_license_audit_no_delete" ON org_license_audit_log
  FOR DELETE USING (false);
```

## 11. org_health_access_logs (産業医境界)

```sql
ALTER TABLE org_health_access_logs ENABLE ROW LEVEL SECURITY;

-- SELECT: 同組織 org_industrial_doctor (自分のアクセス履歴のみ) + org_admin
CREATE POLICY "org_health_access_select" ON org_health_access_logs
  FOR SELECT USING (
    (
      doctor_id = auth.uid()
      AND organization_id = get_user_org_id()
      AND has_org_role(ARRAY['org_industrial_doctor'])
    )
    OR (
      organization_id = get_user_org_id()
      AND has_org_role(ARRAY['org_admin'])
    )
    OR auth.role() = 'service_role'
  );

-- INSERT: service_role のみ (API Route Handler から service_role クライアントで挿入)
-- ※ 産業医が直接 INSERT できると改ざんされるため service_role 限定
CREATE POLICY "org_health_access_insert" ON org_health_access_logs
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

-- UPDATE / DELETE 不可 (immutable、10 年保管)
CREATE POLICY "org_health_access_no_update" ON org_health_access_logs
  FOR UPDATE USING (false);
CREATE POLICY "org_health_access_no_delete" ON org_health_access_logs
  FOR DELETE USING (false);
```

## 12. org_health_notes (産業医境界)

```sql
ALTER TABLE org_health_notes ENABLE ROW LEVEL SECURITY;

-- SELECT: 同組織の org_industrial_doctor のみ (患者本人は参照不可)
CREATE POLICY "org_health_notes_select" ON org_health_notes
  FOR SELECT USING (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_industrial_doctor'])
    -- 家族領域 (family_groups 配下) を参照するメモは返さない
    -- ※ patient_id が org_license_assignments.user_id に存在することで保証
    AND EXISTS (
      SELECT 1 FROM org_license_assignments ola
      WHERE ola.user_id = org_health_notes.patient_id
        AND ola.organization_id = get_user_org_id()
        AND ola.status = 'active'
    )
  );

-- INSERT: 同組織の org_industrial_doctor
CREATE POLICY "org_health_notes_insert" ON org_health_notes
  FOR INSERT WITH CHECK (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_industrial_doctor'])
    AND doctor_id = auth.uid()  -- 自分の名義のメモのみ
  );

-- UPDATE: 同組織の org_industrial_doctor (自分のメモのみ、is_ai_generated=false のみ)
CREATE POLICY "org_health_notes_update" ON org_health_notes
  FOR UPDATE USING (
    doctor_id = auth.uid()
    AND organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_industrial_doctor'])
    AND is_ai_generated = FALSE  -- AI 生成メモは変更不可
  );

-- DELETE 不可 (5 年保管、soft delete は updated_at + deleted_at で管理)
CREATE POLICY "org_health_notes_no_delete" ON org_health_notes
  FOR DELETE USING (false);
```

## 13. organization_invites

```sql
ALTER TABLE organization_invites ENABLE ROW LEVEL SECURITY;

-- SELECT: 同組織 org_admin / org_manager + 招待 token アクセス (認証不要部分は API レイヤーで処理)
CREATE POLICY "org_invites_select" ON organization_invites
  FOR SELECT USING (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_admin', 'org_manager'])
  );

-- INSERT: 同組織 org_admin / org_manager
CREATE POLICY "org_invites_insert" ON organization_invites
  FOR INSERT WITH CHECK (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_admin', 'org_manager'])
    AND invited_by = auth.uid()
  );

-- UPDATE (accept): service_role (受諾処理は service_role クライアントで行う)
--                  + 同組織 org_admin / org_manager (キャンセル)
CREATE POLICY "org_invites_update" ON organization_invites
  FOR UPDATE USING (
    auth.role() = 'service_role'
    OR (
      organization_id = get_user_org_id()
      AND has_org_role(ARRAY['org_admin', 'org_manager'])
    )
  );

-- DELETE: 同組織 org_admin のみ (取消は status 変更を推奨、物理削除は admin 限定)
CREATE POLICY "org_invites_delete" ON organization_invites
  FOR DELETE USING (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_admin'])
  );
```

実装 (migration `20261022180000_org_tables_rpc_only_writes.sql`・#1917): 利用者 (anon / authenticated) の INSERT / UPDATE のポリシーは置かず、INSERT / UPDATE / TRUNCATE の権限も外してある。招待の作成は SECURITY DEFINER の RPC `create_org_invite` だけ (所属組織の owner / admin の判定・`p_role` が `owner` なら `INSUFFICIENT_PERMISSION`・宛先の在籍 `ALREADY_IN_ORG`・席数 `SEAT_LIMIT_EXCEEDED`・24 時間の上限 `RATE_LIMITED`)。承諾・拒否・取り消しも SECURITY DEFINER の RPC (`accept_org_invite` / `reject_org_invite` / `revoke_org_invite`)。DELETE はポリシー `"Org admins can delete invites"` (TO authenticated・同じ組織の利用者で、org_role が owner / admin のときだけ。DELETE /api/org/invites が使う。運営 (`roles` の admin / super_admin) の枝は `20261025120000_operator_session_writes_select_only.sql` (#1917 の続き) で外した) で、権限は authenticated だけ。SELECT は `org_invites_select_admin` と `"Org admins can view invites"`。

## 14. organization_challenges / org_challenge_participants

```sql
ALTER TABLE organization_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_challenge_participants ENABLE ROW LEVEL SECURITY;

-- challenges: SELECT は同組織全員
CREATE POLICY "challenges_select" ON organization_challenges
  FOR SELECT USING (organization_id = get_user_org_id());

-- INSERT / UPDATE: org_admin / org_manager
CREATE POLICY "challenges_insert" ON organization_challenges
  FOR INSERT WITH CHECK (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_admin', 'org_manager'])
  );
CREATE POLICY "challenges_update" ON organization_challenges
  FOR UPDATE USING (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_admin', 'org_manager'])
  );
CREATE POLICY "challenges_delete" ON organization_challenges
  FOR DELETE USING (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_admin'])
  );

-- participants: SELECT は参加者本人 + org_admin / org_manager
CREATE POLICY "participants_select" ON org_challenge_participants
  FOR SELECT USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM organization_challenges oc
      WHERE oc.id = org_challenge_participants.challenge_id
        AND oc.organization_id = get_user_org_id()
        AND has_org_role(ARRAY['org_admin', 'org_manager'])
    )
  );

-- participants INSERT: 本人 (join) + service_role (auto_join バッチ)
CREATE POLICY "participants_insert" ON org_challenge_participants
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    OR auth.role() = 'service_role'
  );

-- participants UPDATE: service_role (バッチ進捗更新) のみ
CREATE POLICY "participants_update" ON org_challenge_participants
  FOR UPDATE USING (auth.role() = 'service_role');
```

> **実装との違い (#1132, 2026-10-08)**: 実装のテーブルは `organization_challenge_participants` (既存)。#1132 の方針により、
> **管理者にも参加者個人の行は見せない** (管理者には集計だけ)。SELECT は本人の行だけ、DELETE も本人の行だけ (参加は任意でいつでもやめられる)、
> INSERT は #1238 のポリシー (本人・自分の組織のチャレンジ・進捗 0・順位なし)、UPDATE のポリシーは無い。
> 順位表と集計は、DB の関数 (`get_org_challenge_ranking` / `get_org_challenge_aggregates`。service_role のみ) を API が認可のあとに呼んで返す。
> 詳細は `07-challenge.md` §15。

> **集計の差分の守り (#1688)**: migration `supabase/migrations/20261016240000_org_challenge_diff_privacy.sql` (設計 `org/10-challenge-diff-privacy.md` §5) で次を足した。
> - `organization_challenges` の DELETE: RESTRICTIVE のポリシー「Org challenges can be deleted only as draft or cancelled」(`TO authenticated`・`USING (status IN ('draft', 'cancelled'))`。同 migration `:280`〜`:286`)。「Org admins can manage challenges」(FOR ALL) と AND で効くので、管理者でも消せるのは draft と cancelled だけ。組織の削除の CASCADE と service_role は RLS を通らないので止めない。
> - `organization_challenges` の UPDATE: ポリシーではなく BEFORE のトリガー `trg_org_challenge_guard_update` (関数 `org_challenge_guard_update`。同 `:132`〜`:179`)。状態の遷移 (draft → active / completed / cancelled、active → completed / cancelled) 以外と NULL への変更を `CHALLENGE_STATUS_LOCKED`、draft 以外での `start_date` / `end_date` / `challenge_type` / `department_id` の変更と、常時の `organization_id` の変更を `CHALLENGE_PERIOD_LOCKED` で止める (どちらも P0001)。トリガーなので、ロールを問わず効く。
> - 新しい表 `organization_challenge_aggregates` (集計の控え。同 `:57`〜`:79`) と `organization_challenge_ranking_exclusions` (管理者だった印。同 `:84`〜`:98`): RLS 有効・ポリシー無し。`PUBLIC` / `anon` / `authenticated` から全権限を外し、service_role にだけ SELECT / INSERT / UPDATE / DELETE を許す。書くのは SECURITY DEFINER のトリガー関数 `org_challenge_count_join` / `org_challenge_finalize` / `org_challenge_mark_admin`。

## 15. hr_webhook_events / hr_revoke_jobs

```sql
ALTER TABLE hr_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_revoke_jobs ENABLE ROW LEVEL SECURITY;

-- service_role のみアクセス可 (HR Webhook は外部システムとの連携、RLS は service_role でバイパス)
CREATE POLICY "hr_webhook_events_service_only" ON hr_webhook_events
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "hr_revoke_jobs_service_only" ON hr_revoke_jobs
  FOR ALL USING (auth.role() = 'service_role');
```

## 16. org_webhook_endpoints / org_webhook_deliveries

```sql
ALTER TABLE org_webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- org_webhook_endpoints: 同組織 org_admin のみ管理
CREATE POLICY "webhook_endpoints_select" ON org_webhook_endpoints
  FOR SELECT USING (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_admin'])
  );
CREATE POLICY "webhook_endpoints_insert" ON org_webhook_endpoints
  FOR INSERT WITH CHECK (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_admin'])
  );
CREATE POLICY "webhook_endpoints_update" ON org_webhook_endpoints
  FOR UPDATE USING (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_admin'])
  );
CREATE POLICY "webhook_endpoints_delete" ON org_webhook_endpoints
  FOR DELETE USING (
    organization_id = get_user_org_id()
    AND has_org_role(ARRAY['org_admin'])
  );

-- deliveries: service_role + org_admin (閲覧のみ)
CREATE POLICY "webhook_deliveries_select" ON org_webhook_deliveries
  FOR SELECT USING (
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1 FROM org_webhook_endpoints owe
      WHERE owe.id = org_webhook_deliveries.endpoint_id
        AND owe.organization_id = get_user_org_id()
        AND has_org_role(ARRAY['org_admin'])
    )
  );
CREATE POLICY "webhook_deliveries_insert" ON org_webhook_deliveries
  FOR INSERT WITH CHECK (auth.role() = 'service_role');
```

## 17. 産業医境界の追加 RLS (user_daily_meals)

産業医が `user_daily_meals` を閲覧する際、家族グループ共有記録を除外する:

```sql
-- user_daily_meals に産業医ポリシーを追加
-- (既存の個人アクセスポリシーに追加)
CREATE POLICY "meals_industrial_doctor" ON user_daily_meals
  FOR SELECT USING (
    -- 既存: 本人
    user_id = auth.uid()
    -- 追加: 産業医 (同組織 + 同意済 + 在籍中 + 家族領域除外)
    OR (
      has_org_role(ARRAY['org_industrial_doctor'])
      AND can_doctor_access_patient(user_daily_meals.user_id)
      -- 家族グループ共有記録は除外
      AND source_family_group_id IS NULL
      -- 本人の直接記録のみ
      AND recorded_by = user_daily_meals.user_id
    )
  );
```

## 18. RLS 有効化まとめ

| テーブル | RLS 有効 | INSERT | SELECT | UPDATE | DELETE |
|---------|---------|--------|--------|--------|--------|
| `organizations` | ✅ | super_admin | 同組織 org ロール | org_admin + 運営 (owner_id・status・plan・subscription_status・subscription_expires_at・dissolved_at はトリガーで不可。§4) | super_admin |
| `departments` | ✅ | org_admin/manager | 同組織全員 | org_admin/manager | org_admin |
| `department_history` | ✅ | org_admin/manager | 本人 + org_admin/manager | ❌ | ❌ |
| `org_subscriptions` | ✅ | service_role | org_admin | service_role | ❌ |
| `org_license_pools` | ✅ | service_role (+ SECURITY DEFINER の RPC) | 同組織のメンバー | service_role (+ SECURITY DEFINER の RPC。利用者の権限なし。#1917) | ❌ (利用者の権限なし) |
| `org_license_assignments` | ✅ | org_admin/manager | 本人 + admin/manager/viewer | org_admin/manager + service | ❌ |
| `org_license_audit_log` | ✅ | org_admin/manager + service | org_admin/manager/viewer | ❌ | ❌ |
| `org_health_access_logs` | ✅ | service_role | 産業医(自分) + org_admin | ❌ | ❌ |
| `org_health_notes` | ✅ | org_industrial_doctor | org_industrial_doctor | org_industrial_doctor (非AI) | ❌ |
| `organization_invites` | ✅ | RPC `create_org_invite` だけ (SECURITY DEFINER。利用者の権限なし。#1917) | owner/admin | RPC だけ (承諾・拒否・取り消し・作り直し。利用者の権限なし。#1917) | owner/admin |
| `organization_challenges` | ✅ | org_admin/manager | 同組織全員 | org_admin/manager | org_admin (draft / cancelled だけ。#1688) |
| `org_challenge_participants` | ✅ | 本人 + service | 本人 + admin/manager | service_role | ❌ |
| `organization_challenge_aggregates` | ✅ | service_role | service_role | service_role | service_role |
| `organization_challenge_ranking_exclusions` | ✅ | service_role | service_role | service_role | service_role |
| `hr_webhook_events` | ✅ | service_role | service_role | service_role | service_role |
| `hr_revoke_jobs` | ✅ | service_role | service_role | service_role | service_role |

## 19. テスト方針

主要テストケース:

1. `it('returns 0 rows when org_member selects org_license_pools')`
2. `it('returns 0 rows when industrial_doctor selects org_health_notes of other org')`
3. `it('rejects UPDATE on org_license_audit_log for all roles')`
4. `it('returns 0 rows when anon role selects hr_webhook_events')`
5. `it('returns 0 rows when industrial_doctor selects family meal records (source_family_group_id IS NOT NULL)')`
6. `it('org_admin can SELECT all org_license_pools in own org')`
7. `it('org_admin cannot SELECT org_license_pools from other org')`

```typescript
// tests/integration/org/rls-policies.integration.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
// 接続情報は src/lib の getter で取り出す (`process.env.<変数名>!` は使わない。#1182・#1434)
import { getSupabaseAnonKey, getSupabaseServiceRoleKey, getSupabaseUrl } from '@/lib/env-required';
import { signInAsUser } from '../../helpers/auth';

const supabaseAdmin = createClient(
  getSupabaseUrl(),
  getSupabaseServiceRoleKey(),
);

describe('org_license_pools RLS', () => {
  let orgMemberToken: string;
  let orgAdminToken: string;

  beforeAll(async () => {
    orgMemberToken = await signInAsUser('org-member@test.local');
    orgAdminToken = await signInAsUser('org-admin@test.local');
  });

  it('returns 0 rows when org_member selects org_license_pools', async () => {
    const memberClient = createClient(
      getSupabaseUrl(),
      getSupabaseAnonKey(),
      { global: { headers: { Authorization: `Bearer ${orgMemberToken}` } } },
    );
    const { data, error } = await memberClient
      .from('org_license_pools')
      .select('id');
    expect(error).toBeNull();
    expect(data).toHaveLength(0); // RLS: org_member は閲覧不可
  });

  it('org_admin can SELECT all org_license_pools in own org', async () => {
    const adminClient = createClient(
      getSupabaseUrl(),
      getSupabaseAnonKey(),
      { global: { headers: { Authorization: `Bearer ${orgAdminToken}` } } },
    );
    const { data, error } = await adminClient
      .from('org_license_pools')
      .select('id');
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0); // org_admin は自組織を閲覧可
  });

  it('org_admin cannot SELECT org_license_pools from other org', async () => {
    const adminClient = createClient(
      getSupabaseUrl(),
      getSupabaseAnonKey(),
      { global: { headers: { Authorization: `Bearer ${orgAdminToken}` } } },
    );
    // 他組織のプールを直接 ID 指定で取得しようとする
    const otherOrgPoolId = await getPoolIdFromOrg('org-002');
    const { data } = await adminClient
      .from('org_license_pools')
      .select('id')
      .eq('id', otherOrgPoolId);
    expect(data).toHaveLength(0); // RLS: 他組織のデータは見えない
  });
});

describe('org_health_notes RLS (産業医)', () => {
  let doctorToken: string;

  beforeAll(async () => {
    doctorToken = await signInAsUser('doctor@test.local');
  });

  it('returns 0 rows when industrial_doctor selects health_notes of other org', async () => {
    const doctorClient = createClient(
      getSupabaseUrl(),
      getSupabaseAnonKey(),
      { global: { headers: { Authorization: `Bearer ${doctorToken}` } } },
    );
    const otherOrgPatientId = await getPatientFromOrg('org-002');
    const { data } = await doctorClient
      .from('org_health_notes')
      .select('id')
      .eq('patient_user_id', otherOrgPatientId);
    expect(data).toHaveLength(0);
  });

  it('returns 0 rows when industrial_doctor selects family meal records', async () => {
    const doctorClient = createClient(
      getSupabaseUrl(),
      getSupabaseAnonKey(),
      { global: { headers: { Authorization: `Bearer ${doctorToken}` } } },
    );
    // 家族グループ由来の food records は産業医から見えない
    const { data } = await doctorClient
      .from('user_daily_meals')
      .select('id')
      .not('source_family_group_id', 'is', null);
    expect(data).toHaveLength(0);
  });
});

describe('org_license_audit_log RLS (immutable)', () => {
  it('rejects UPDATE on org_license_audit_log for org_admin', async () => {
    const orgAdminToken = await signInAsUser('org-admin@test.local');
    const adminClient = createClient(
      getSupabaseUrl(),
      getSupabaseAnonKey(),
      { global: { headers: { Authorization: `Bearer ${orgAdminToken}` } } },
    );
    const { error } = await adminClient
      .from('org_license_audit_log')
      .update({ action: '改ざん試行' } as never)
      .eq('id', faker.string.uuid());
    expect(error).not.toBeNull(); // RLS: UPDATE 禁止
  });

  it('rejects DELETE on org_license_audit_log for super_admin', async () => {
    const superToken = await signInAsUser('super@test.local');
    const superClient = createClient(
      getSupabaseUrl(),
      getSupabaseAnonKey(),
      { global: { headers: { Authorization: `Bearer ${superToken}` } } },
    );
    const { error } = await superClient
      .from('org_license_audit_log')
      .delete()
      .eq('id', faker.string.uuid());
    expect(error).not.toBeNull(); // RLS: DELETE 禁止
  });
});

describe('hr_webhook_events RLS', () => {
  it('returns 0 rows when anon role selects hr_webhook_events', async () => {
    const anonClient = createClient(
      getSupabaseUrl(),
      getSupabaseAnonKey(),
    );
    const { data, error } = await anonClient
      .from('hr_webhook_events')
      .select('id');
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('returns 0 rows when org_member selects hr_webhook_events', async () => {
    const orgMemberToken = await signInAsUser('org-member@test.local');
    const memberClient = createClient(
      getSupabaseUrl(),
      getSupabaseAnonKey(),
      { global: { headers: { Authorization: `Bearer ${orgMemberToken}` } } },
    );
    const { data } = await memberClient.from('hr_webhook_events').select('id');
    expect(data).toHaveLength(0); // service_role のみアクセス可
  });
});

## 20. 既存実装との関連

- 既存 RLS ポリシー: clean-build で DROP → 本仕様で再作成
- `user_daily_meals` の既存 RLS は保持しつつ、産業医ポリシーを追加

## 21. 未解決事項

- `get_user_org_id()` の複数組織所属対応: 現状はプライマリ `organization_id` を返す。複数組織での RLS は API 層でのフィルタリングで補完
- `org_health_access_logs` の 10 年保管期間中の RLS: 長期保管後は Cold Storage に移行するが、その際の RLS ポリシーをどう引き継ぐか
