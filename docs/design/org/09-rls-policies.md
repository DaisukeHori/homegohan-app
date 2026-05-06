# org/ RLS ポリシー

## 1. 目的・スコープ

組織管理ドメインの全テーブルに対する Row Level Security (RLS) ポリシーの具体的 SQL 定義。

設計原則:
- `organization_id` 境界を全テーブルで厳守
- 産業医境界: 家族領域は絶対に閲覧不可
- HR Webhook / service_role バイパス: Edge Function のみ
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
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

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
| `organizations` | ✅ | super_admin | 同組織 org ロール | org_admin + 運営 | super_admin |
| `departments` | ✅ | org_admin/manager | 同組織全員 | org_admin/manager | org_admin |
| `department_history` | ✅ | org_admin/manager | 本人 + org_admin/manager | ❌ | ❌ |
| `org_subscriptions` | ✅ | service_role | org_admin | service_role | ❌ |
| `org_license_pools` | ✅ | service_role | org_admin/manager/viewer | service_role | ❌ |
| `org_license_assignments` | ✅ | org_admin/manager | 本人 + admin/manager/viewer | org_admin/manager + service | ❌ |
| `org_license_audit_log` | ✅ | org_admin/manager + service | org_admin/manager/viewer | ❌ | ❌ |
| `org_health_access_logs` | ✅ | service_role | 産業医(自分) + org_admin | ❌ | ❌ |
| `org_health_notes` | ✅ | org_industrial_doctor | org_industrial_doctor | org_industrial_doctor (非AI) | ❌ |
| `organization_invites` | ✅ | org_admin/manager | org_admin/manager | service_role + admin/manager | org_admin |
| `organization_challenges` | ✅ | org_admin/manager | 同組織全員 | org_admin/manager | org_admin |
| `org_challenge_participants` | ✅ | 本人 + service | 本人 + admin/manager | service_role | ❌ |
| `hr_webhook_events` | ✅ | service_role | service_role | service_role | service_role |
| `hr_revoke_jobs` | ✅ | service_role | service_role | service_role | service_role |

## 19. テスト方針

- **Integration (Supabase Local)**:
  - `org_member` ユーザーで `org_license_pools` を SELECT → 403 相当 (0 行返却) を確認
  - 産業医が別組織の `org_health_notes` を SELECT → 0 行返却を確認
  - `org_license_audit_log` への UPDATE → RLS エラーを確認
  - `hr_webhook_events` を直接 SELECT (anon/auth role) → 403 を確認
  - 産業医が `user_daily_meals` で `source_family_group_id IS NOT NULL` の行を SELECT → 0 行確認

## 20. 既存実装との関連

- 既存 RLS ポリシー: clean-build で DROP → 本仕様で再作成
- `user_daily_meals` の既存 RLS は保持しつつ、産業医ポリシーを追加

## 21. 未解決事項

- `get_user_org_id()` の複数組織所属対応: 現状はプライマリ `organization_id` を返す。複数組織での RLS は API 層でのフィルタリングで補完
- `org_health_access_logs` の 10 年保管期間中の RLS: 長期保管後は Cold Storage に移行するが、その際の RLS ポリシーをどう引き継ぐか
