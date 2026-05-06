# RLS パターン設計

## 1. 目的・スコープ

全テーブルで共通使用する Row Level Security (RLS) パターン・楽観的ロック・advisory lock・行ロックの設計を集約する。  
各ドメイン (family / org / operator) のマイグレーションはここで定義した SQL テンプレートを再利用し、独自実装を禁止する。

**対象外**: Edge Function 内のビジネスロジックによる認可 (cross/01-auth-session.md)

---

## 2. 関連要件

- 要件定義 03 §15.20.7 (RLS 厳格化)
- 要件定義 03 §16.3 (TypeScript 型 / Supabase 自動生成)
- 設計書 CLAUDE.md §3 (RLS 厳格化原則)
- 全要件の「権限管理」セクション全般

---

## 3. RLS 有効化の原則

### 3.1 全テーブル必須化

**新規・既存テーブルすべてで RLS 有効化必須**。  
例外は以下の公開マスターテーブルのみ:
- `dataset_recipes` / `dataset_ingredients` / `dataset_embeddings`
- `subscription_plans` (SELECT のみ公開可)

### 3.2 有効化パターン (マイグレーション雛形)

```sql
-- Step 1: RLS 有効化
ALTER TABLE {table_name} ENABLE ROW LEVEL SECURITY;

-- Step 2: デフォルト拒否 (ENABLE 後は全アクセス拒否が自動的に適用される)
-- 明示的に deny all ポリシーを書く必要はないが、可読性のため追加可:
-- CREATE POLICY "deny_all" ON {table_name} USING (false);

-- Step 3: 必要なポリシーを追加 (下記テンプレートから選択)
```

### 3.3 service_role バイパスのガイドライン

- **service_role を使う場所**: Supabase Edge Function のみ
- **禁止**: Next.js Server Actions・API Routes 内での `createClient(SERVICE_ROLE_KEY)` 直接使用
- **コードレビュー必須**: `service_role` が使われる PR は security ラベルを付与、実装リーダーがレビュー
- Edge Function での service_role 使用時は必ず `admin_audit_logs` に記録

---

## 4. RLS ポリシーテンプレート集

### 4.1 self-ownership パターン

ユーザー自身の行にのみアクセスを許可する最も基本的なパターン。

```sql
-- テンプレート: self_ownership
-- 用途: user_sessions_metadata, password_history, notification_preferences 等

CREATE POLICY "{table}_self_read"
  ON {table_name} FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "{table}_self_insert"
  ON {table_name} FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "{table}_self_update"
  ON {table_name} FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "{table}_self_delete"
  ON {table_name} FOR DELETE
  USING (auth.uid() = user_id);
```

### 4.2 同グループメンバーポリシー (Family)

家族グループのメンバー全員が閲覧できるパターン。

```sql
-- テンプレート: same_family_group
-- 用途: family_activity_log, family_shopping_items, family_shared_menus 等

CREATE POLICY "{table}_family_member_read"
  ON {table_name} FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM family_members fm
      WHERE fm.user_id = auth.uid()
        AND fm.family_group_id = {table_name}.family_group_id
        AND fm.is_active = TRUE
    )
  );

CREATE POLICY "{table}_family_member_insert"
  ON {table_name} FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM family_members fm
      WHERE fm.user_id = auth.uid()
        AND fm.family_group_id = {table_name}.family_group_id
        AND fm.is_active = TRUE
    )
  );

-- owner / admin のみ UPDATE・DELETE を許可する場合:
CREATE POLICY "{table}_family_owner_update"
  ON {table_name} FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM family_members fm
      WHERE fm.user_id = auth.uid()
        AND fm.family_group_id = {table_name}.family_group_id
        AND fm.role IN ('owner', 'admin')
        AND fm.is_active = TRUE
    )
  );
```

### 4.3 同組織ポリシー (Org)

同じ組織のメンバーが閲覧できるパターン。

```sql
-- テンプレート: same_organization
-- 用途: org_health_notes, org_challenges, org_license_assignments 等

CREATE POLICY "{table}_same_org_read"
  ON {table_name} FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = {table_name}.organization_id
    )
  );

-- org_admin 以上のみ INSERT:
CREATE POLICY "{table}_org_admin_insert"
  ON {table_name} FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = {table_name}.organization_id
        AND ARRAY['org_admin', 'org_manager', 'admin', 'super_admin']::TEXT[] && up.roles
    )
  );
```

### 4.4 監査ログ immutable パターン

一度挿入したら変更・削除を禁止する不可逆ログ用パターン。

```sql
-- テンプレート: immutable_audit_log
-- 用途: admin_audit_logs, family_activity_log, org_license_audit_log 等

-- INSERT: actor_id を WITH CHECK で auth.uid() に固定
-- NOTE: Supabase JWT の 'role' クレームは anon / authenticated / service_role のみ。
--       アプリレベルのロール (admin, super_admin 等) は user_profiles.roles[] で管理する。
CREATE POLICY "{table}_insert"
  ON {table_name} FOR INSERT
  WITH CHECK (
    actor_id = auth.uid()
    OR auth.role() = 'service_role'
  );

-- SELECT: 運営者 (admin+) または自分に関する操作のみ
CREATE POLICY "{table}_admin_read"
  ON {table_name} FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND ARRAY['admin', 'super_admin']::TEXT[] && roles
    )
    OR auth.role() = 'service_role'
  );

-- UPDATE / DELETE: 完全禁止
CREATE POLICY "{table}_no_update"
  ON {table_name} FOR UPDATE USING (false);

CREATE POLICY "{table}_no_delete"
  ON {table_name} FOR DELETE USING (false);
```

### 4.5 公開読み取り専用パターン

マスターテーブル等、全ユーザーに読み取りを許可するパターン。

```sql
-- テンプレート: public_read_only
-- 用途: subscription_plans 等

CREATE POLICY "{table}_public_read"
  ON {table_name} FOR SELECT
  USING (true);

-- INSERT / UPDATE / DELETE は service_role のみ (= Edge Function)
-- ポリシー不要 (service_role はバイパス)
```

### 4.6 産業医ポリシー (Org)

`org_industrial_doctor` が同組織の対象ユーザーの健康データのみ閲覧できるパターン。

```sql
-- テンプレート: industrial_doctor_read
-- 用途: org_health_notes, health_checkups (組織フィルタ)

CREATE POLICY "{table}_industrial_doctor_read"
  ON {table_name} FOR SELECT
  USING (
    -- 本人
    auth.uid() = user_id
    -- または 同組織の産業医
    OR EXISTS (
      SELECT 1 FROM user_profiles doc
      JOIN user_profiles target ON target.user_id = {table_name}.user_id
      WHERE doc.user_id = auth.uid()
        AND 'org_industrial_doctor' = ANY(doc.roles)
        AND doc.organization_id = target.organization_id
    )
    -- または 運営 admin (user_profiles.roles[] で判定)
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND ARRAY['admin', 'super_admin']::TEXT[] && roles
    )
  );
```

---

## 5. 楽観的ロック

### 5.1 概要

状態遷移を伴う API エンドポイント (家族グループ状態遷移 / ライセンス割当 / プラン変更等) では楽観的ロックを適用する。

### 5.2 リクエスト側

```http
PATCH /api/family/groups/{id}/freeze
If-Unmodified-Since: Tue, 06 May 2026 12:00:00 GMT
Content-Type: application/json
```

### 5.3 サーバー側実装

```typescript
// src/lib/optimistic-lock.ts

/**
 * If-Unmodified-Since ヘッダを使った楽観的ロック検証
 * @param tableName テーブル名
 * @param id        レコード ID
 * @param ifUnmodifiedSince リクエストヘッダの値
 * @returns 現在の updated_at (検証成功時)
 * @throws 412 Precondition Failed (競合時)
 */
export async function checkOptimisticLock(
  tableName: string,
  id: string,
  ifUnmodifiedSince: string | null
): Promise<string> {
  if (!ifUnmodifiedSince) {
    throw new ApiError(428, 'CONFLICT_PRECONDITION_REQUIRED',
      'If-Unmodified-Since header is required');
  }

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from(tableName)
    .select('updated_at')
    .eq('id', id)
    .single();

  if (error || !data) throw new ApiError(404, 'NOT_FOUND');

  const serverTime = new Date(data.updated_at).getTime();
  const clientTime = new Date(ifUnmodifiedSince).getTime();

  if (serverTime > clientTime) {
    throw new ApiError(412, 'CONFLICT_OPTIMISTIC_LOCK',
      'Resource was modified by another request');
  }
  return data.updated_at;
}
```

### 5.4 UPDATE での WHERE 句使用例

```sql
-- 楽観的ロック付き UPDATE (SQL レベル)
UPDATE family_groups
SET status = 'frozen',
    updated_at = NOW()
WHERE id = $1
  AND updated_at = $2  -- クライアントが持っている updated_at と一致する場合のみ
RETURNING *;

-- 0 行更新 = 競合発生 → 409 Conflict を返す
```

### 5.5 エラーレスポンス

| 状況 | HTTP ステータス | エラーコード |
|------|--------------|------------|
| `If-Unmodified-Since` ヘッダなし | 428 | `CONFLICT_PRECONDITION_REQUIRED` |
| サーバー側が更新済み (競合) | 412 | `CONFLICT_OPTIMISTIC_LOCK` |
| UPDATE 0 行 (WHERE 不一致) | 409 | `CONFLICT_STALE_DATA` |

---

## 6. Advisory Lock

### 6.1 概要

複数リクエストが同一リソースを同時に状態遷移させる危険な操作には `pg_advisory_xact_lock` で直列化する。  
楽観的ロックと組み合わせて使用する (advisory lock でキュー化し、楽観的ロックで最終確認)。

### 6.2 使用場面

ロックキーの命名は以下のプレフィックス + UUID 形式で統一する。

| 操作 | ロックキー生成 |
|------|-------------|
| ライセンス一括割当 | `hashtext('license_pool:' || pool_id::TEXT)` |
| 家族グループ owner 移譲 | `hashtext('family-group:' || group_id::TEXT)` |
| 退職時 family 凍結 | `hashtext('family-group:' || group_id::TEXT)` |
| Stripe webhook 二重処理防止 | `hashtext('stripe:' || event_id::TEXT)` |

**命名規則**: `{ドメイン}-{エンティティ}:{UUID}` 形式（ハイフン区切り）

### 6.2.1 `acquire_family_group_lock` ヘルパー関数

家族グループ操作 (migrate-to-personal / transfer-ownership / dissolve → archived) に統一して使用するロック取得ヘルパー。

```sql
-- supabase/migrations/2026MMDD012_advisory_lock_helpers.sql

CREATE OR REPLACE FUNCTION acquire_family_group_lock(family_group_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('family-group:' || family_group_id::TEXT));
END;
$$;

COMMENT ON FUNCTION acquire_family_group_lock(UUID) IS
  '家族グループへの排他操作 (凍結/移行/譲渡/解散) 前に呼び出すアドバイザリロック。
   トランザクション終了時に自動解放。プレフィックス: family-group:{UUID}';
```

### 6.3 実装例

```sql
-- supabase/migrations/xxxx_advisory_lock_helper.sql
-- pg_advisory_xact_lock を直接 RPC 呼び出しすることはできないため、
-- ラッパー関数 acquire_advisory_lock を用意する
CREATE OR REPLACE FUNCTION acquire_advisory_lock(lock_key TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(lock_key));
END;
$$;
```

```typescript
// src/lib/advisory-lock.ts

/**
 * acquire_advisory_lock RPC 経由でトランザクション内ロックを取得
 * トランザクション終了時に自動解放される
 * 注意: pg_advisory_xact_lock は Supabase RPC から直接呼び出せないため
 *       必ず acquire_advisory_lock ラッパーを経由すること
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const supabase = createServiceRoleClient(); // Edge Function 内のみ

  await supabase.rpc('acquire_advisory_lock', {
    lock_key: key,
  });

  return fn();
}
```

### 6.4 行ロック (SELECT FOR UPDATE)

競合が高頻度で起きる場面 (ライセンスプールの空き確認 → 割当) では行ロックも使用する。

```sql
-- ライセンスプールを行ロックで取得し、使用済みカウントを更新
BEGIN;

SELECT id, total_licenses, used_licenses
FROM org_license_pools
WHERE id = $1
FOR UPDATE;  -- 他のトランザクションをブロック

-- used_licenses < total_licenses を確認
-- INSERT org_license_assignments
-- UPDATE org_license_pools SET used_licenses = used_licenses + 1

COMMIT;
```

---

## 7. 競合エラーレスポンス仕様

詳細は cross/04-api-conventions.md §4 を参照。ここでは競合系のみ再掲。

```json
// 412 Precondition Failed (楽観的ロック失敗)
{
  "error": {
    "code": "CONFLICT_OPTIMISTIC_LOCK",
    "message": "リソースが別のリクエストによって更新されました。最新のデータを取得して再試行してください。",
    "request_id": "req_abc123"
  }
}

// 409 Conflict (ビジネスルール競合)
{
  "error": {
    "code": "CONFLICT_LICENSE_POOL_EXHAUSTED",
    "message": "ライセンスプールの残席が不足しています。",
    "request_id": "req_def456"
  }
}
```

---

## 8. ドメイン別 RLS 適用方針

### 8.1 Family ドメイン

| テーブル | 適用パターン | 備考 |
|---------|------------|------|
| `family_groups` | same_family_group (owner のみ UPDATE) | status 変更は特定 API のみ |
| `family_members` | same_family_group | owner が CRUD、メンバーは自分の行のみ DELETE |
| `family_invites` | self_ownership + 公開 SELECT (token 突合) | 招待受諾は token 検索 |
| `family_activity_log` | immutable_audit_log | 家族全員 SELECT、INSERT は本人 |
| `family_shopping_items` | same_family_group | チェック済みフラグは全員 UPDATE 可 |
| `family_shared_menus` | same_family_group | 作成者のみ DELETE |
| `family_meal_requests` | same_family_group | 担当者は status UPDATE のみ |

### 8.2 Org ドメイン

| テーブル | 適用パターン | 備考 |
|---------|------------|------|
| `organizations` | self_ownership (org_admin) + admin_read | org_admin は自組織のみ |
| `user_profiles` | self_ownership + same_organization (一部列のみ) | org 内メンバー一覧は制限付き |
| `org_license_pools` | same_organization (org_admin INSERT) | |
| `org_license_assignments` | same_organization | 本人の行は本人も SELECT |
| `org_license_audit_log` | immutable_audit_log | org_admin + admin が SELECT |
| `org_health_notes` | industrial_doctor_read | 本人 + 産業医 + admin のみ |
| `departments` | same_organization | |

### 8.3 Operator ドメイン

| テーブル | 適用パターン | 備考 |
|---------|------------|------|
| `admin_audit_logs` | immutable_audit_log | admin+ が SELECT |
| `subscription_plans` | public_read_only | super_admin が CRUD |
| `feature_flags` | public_read + admin_write | |
| `support_tickets` | self_ownership + support_read | |

---

## 9. マイグレーション: rls_hardening.sql テンプレート

```sql
-- supabase/migrations/2026MMDD007_rls_hardening.sql
-- 全テーブルの RLS 有効化と基本ポリシー設定

BEGIN;

-- ============================================================
-- 1. subscription_plans (公開読み取り)
-- ============================================================
ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subscription_plans_public_read"
  ON subscription_plans FOR SELECT USING (true);

-- ============================================================
-- 2. user_sessions_metadata (本人のみ)
-- ============================================================
ALTER TABLE user_sessions_metadata ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sessions_self_select"
  ON user_sessions_metadata FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "sessions_self_update"
  ON user_sessions_metadata FOR UPDATE
  USING (auth.uid() = user_id);

-- INSERT は Edge Function (service_role) のみ

-- ============================================================
-- 3. admin_audit_logs (immutable)
-- ============================================================
ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_logs_insert"
  ON admin_audit_logs FOR INSERT
  WITH CHECK (
    actor_id = auth.uid()
    OR auth.role() = 'service_role'
  );

CREATE POLICY "audit_logs_admin_select"
  ON admin_audit_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND ARRAY['admin', 'super_admin']::TEXT[] && roles
    )
    OR auth.role() = 'service_role'
  );

CREATE POLICY "audit_logs_no_update"
  ON admin_audit_logs FOR UPDATE USING (false);

CREATE POLICY "audit_logs_no_delete"
  ON admin_audit_logs FOR DELETE USING (false);

-- ============================================================
-- 4. password_history (service_role のみ)
-- ============================================================
ALTER TABLE password_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "password_history_no_direct_access"
  ON password_history FOR ALL
  USING (false);

-- service_role のみアクセス可 (パスワード変更 Edge Function 経由)

COMMIT;
```

---

## 10. テスト方針

| テスト種別 | 対象 | ツール |
|---------|------|------|
| Integration | 各 RLS パターンが意図通り動作するか (SELECT / INSERT / UPDATE / DELETE) | Vitest + Supabase Local |
| Integration | service_role バイパスが Edge Function 以外で使われていないか | CI での grep チェック |
| Security | 別ユーザーが他人の行を読めないことを確認 | Vitest + Supabase Local |
| Security | 監査ログの UPDATE / DELETE が拒否されることを確認 | Vitest + Supabase Local |

### 10.1 RLS テストの基本パターン

```typescript
// tests/integration/rls/family-activity-log.test.ts
import { createClient } from '@supabase/supabase-js';

describe('family_activity_log RLS', () => {
  it('家族メンバーは自グループのログのみ SELECT できる', async () => {
    const memberClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${memberToken}` } },
    });
    const { data } = await memberClient.from('family_activity_log').select('*');
    // 別グループのログは含まれていないことを確認
    expect(data?.every(row => row.family_group_id === memberGroupId)).toBe(true);
  });

  it('監査ログの DELETE は拒否される', async () => {
    const { error } = await memberClient
      .from('family_activity_log')
      .delete()
      .eq('id', logId);
    expect(error?.code).toBe('42501'); // RLS violation
  });
});
```

---

## 11. 既存実装との関連

| 資産 | 状態 | 対応 |
|------|------|------|
| 既存 `rls_hardening.sql` (部分実装) | 置換 | 本設計で全テーブルを網羅するよう再作成 |
| `admin_audit_logs` (既存、一部のみ記録) | 拡張 | immutable ポリシーを追加 |
| `family_groups` 等の中途半端テーブル | 削除→再作成 | `00-existing-cleanup.md` 参照 |

---

## 12. 未解決事項

| 項目 | 状態 | 期限 |
|------|------|------|
| `meals` テーブルへの家族閲覧ポリシー追加 (UC-FAM-06) | family/08-rls-policies.md で確定 | family 設計完成後 |
| `health_checkups` への産業医ポリシー追加 | org/09-rls-policies.md で確定 | org 設計完成後 |
| RLS パフォーマンス: EXISTS サブクエリのインデックス設計 | 要検証 | Phase 1 リリース前 |
| Supabase Realtime と RLS の整合性 (Phase 2) | TODO | Phase 2 着手前 |
