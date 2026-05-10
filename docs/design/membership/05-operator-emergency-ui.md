# 05. Operator Emergency UI — 運営管理者 緊急介入

代表/owner 不在時 (死亡, アカウント削除, 90 日 inactive) で family/org が運営不能になった時の救済 UI。`super_admin` role を持つ運営者だけが操作可能。

---

## 1. 権限定義

```ts
// src/lib/auth/operator-permissions.ts
export type OperatorPermission =
  | 'membership:org:transfer'        // org owner 強制譲渡
  | 'membership:org:dissolve'        // org 強制解散
  | 'membership:family:transfer'     // family 代表強制譲渡
  | 'membership:family:dissolve'     // family 強制解散
  | 'membership:audit:read';         // 監査ログ閲覧

export const SUPER_ADMIN_PERMISSIONS: OperatorPermission[] = [
  'membership:org:transfer',
  'membership:org:dissolve',
  'membership:family:transfer',
  'membership:family:dissolve',
  'membership:audit:read',
];

export function canOperate(roles: string[], permission: OperatorPermission): boolean {
  if (roles.includes('super_admin')) return true;
  if (roles.includes('admin') && permission === 'membership:audit:read') return true;
  return false;
}
```

`user_profiles.roles TEXT[]` に `'super_admin'` を含むユーザのみが強制操作 RPC を実行可能。

---

## 2. inactive メンバ判定 RPC

```sql
-- migration: 20260511000040_membership_operator_helpers.sql

CREATE OR REPLACE FUNCTION public.is_inactive_user(p_user_id UUID, p_days INT DEFAULT 90)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT
    NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id)  -- アカウント削除済
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = p_user_id
        AND (last_login_at IS NULL OR last_login_at < NOW() - (p_days || ' days')::INTERVAL)
    );
$$;

GRANT EXECUTE ON FUNCTION public.is_inactive_user TO authenticated;

-- inactive owner の org 一覧 (operator 用)
CREATE OR REPLACE FUNCTION public.list_orgs_with_inactive_owner(p_days INT DEFAULT 90)
RETURNS TABLE (organization_id UUID, name TEXT, owner_id UUID, owner_email TEXT, last_login_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.id, o.name, o.owner_id, au.email, up.last_login_at
  FROM organizations o
  LEFT JOIN auth.users au ON au.id = o.owner_id
  LEFT JOIN user_profiles up ON up.id = o.owner_id
  WHERE public.is_inactive_user(o.owner_id, p_days);
$$;

REVOKE EXECUTE ON FUNCTION public.list_orgs_with_inactive_owner FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_orgs_with_inactive_owner TO authenticated;
-- API 側で super_admin 検証

-- 同様に list_families_with_inactive_representative
CREATE OR REPLACE FUNCTION public.list_families_with_inactive_representative(p_days INT DEFAULT 90)
RETURNS TABLE (family_id UUID, name TEXT, representative_id UUID, representative_email TEXT, last_login_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT fg.id, fg.name, fg.representative_id, au.email, up.last_login_at
  FROM family_groups fg
  LEFT JOIN auth.users au ON au.id = fg.representative_id
  LEFT JOIN user_profiles up ON up.id = fg.representative_id
  WHERE fg.status = 'active' AND public.is_inactive_user(fg.representative_id, p_days);
$$;

REVOKE EXECUTE ON FUNCTION public.list_families_with_inactive_representative FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_families_with_inactive_representative TO authenticated;
```

---

## 3. 強制譲渡 RPC

```sql
CREATE OR REPLACE FUNCTION public.force_transfer_org_owner(
  p_organization_id UUID,
  p_new_owner_id UUID,
  p_reason TEXT
) RETURNS organizations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org organizations; v_old_owner_id UUID; v_caller_roles TEXT[];
BEGIN
  -- 認可: super_admin のみ
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;

  -- 整合性: new_owner が同 org メンバ
  IF NOT EXISTS (
    SELECT 1 FROM user_profiles WHERE id = p_new_owner_id AND organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'TARGET_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  SELECT owner_id INTO v_old_owner_id FROM organizations WHERE id = p_organization_id;

  -- role swap
  UPDATE user_profiles SET org_role = 'admin' WHERE id = v_old_owner_id;
  UPDATE user_profiles SET org_role = 'owner' WHERE id = p_new_owner_id;
  UPDATE organizations SET owner_id = p_new_owner_id WHERE id = p_organization_id RETURNING * INTO v_org;

  -- 監査ログ (actor_id = NULL で system, metadata.operator_id = auth.uid())
  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', p_organization_id, 'operator_force_owner_transfer',
          NULL, p_new_owner_id,
          jsonb_build_object(
            'operator_id', auth.uid(),
            'old_owner_id', v_old_owner_id,
            'reason', p_reason
          ));

  RETURN v_org;
END $$;

REVOKE EXECUTE ON FUNCTION public.force_transfer_org_owner FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.force_transfer_org_owner TO authenticated;

-- family 代表強制譲渡 同パターン
CREATE OR REPLACE FUNCTION public.force_transfer_family_representative(
  p_family_id UUID,
  p_new_rep_id UUID,
  p_reason TEXT
) RETURNS family_groups LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fam family_groups; v_old_rep_id UUID; v_caller_roles TEXT[];
BEGIN
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE family_id = p_family_id AND user_id = p_new_rep_id AND status = 'active' AND role IN ('representative','adult')
  ) THEN
    RAISE EXCEPTION 'TARGET_NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  SELECT representative_id INTO v_old_rep_id FROM family_groups WHERE id = p_family_id;

  UPDATE family_members SET role = 'adult' WHERE family_id = p_family_id AND user_id = v_old_rep_id;
  UPDATE family_members SET role = 'representative' WHERE family_id = p_family_id AND user_id = p_new_rep_id;
  UPDATE family_groups SET representative_id = p_new_rep_id WHERE id = p_family_id RETURNING * INTO v_fam;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', p_family_id, 'operator_force_representative_transfer',
          NULL, p_new_rep_id,
          jsonb_build_object('operator_id', auth.uid(), 'old_rep_id', v_old_rep_id, 'reason', p_reason));

  RETURN v_fam;
END $$;

REVOKE EXECUTE ON FUNCTION public.force_transfer_family_representative FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.force_transfer_family_representative TO authenticated;
```

---

## 4. 強制解散 RPC

```sql
CREATE OR REPLACE FUNCTION public.force_dissolve_family(p_family_id UUID, p_reason TEXT)
RETURNS family_groups LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fam family_groups; v_caller_roles TEXT[];
BEGIN
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;

  -- 全メンバを離脱状態に
  UPDATE family_members SET status = 'left' WHERE family_id = p_family_id AND status = 'active';
  UPDATE user_profiles SET family_id = NULL WHERE family_id = p_family_id;
  UPDATE family_groups SET status = 'dissolved', dissolved_at = NOW() WHERE id = p_family_id RETURNING * INTO v_fam;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', p_family_id, 'operator_force_dissolve', NULL,
          jsonb_build_object('operator_id', auth.uid(), 'reason', p_reason));

  RETURN v_fam;
END $$;

-- force_dissolve_org 同パターン
```

---

## 5. UI ページ構造

### 5.1 ナビ
**file (新規)**: `src/app/(operator)/operator/membership/layout.tsx`

サイドバーに以下リンク:
- ダッシュボード
- 組織一覧
  - inactive owner 検索
  - 全組織検索
- 家族一覧
  - inactive representative 検索
  - 全家族検索
- 監査ログ
  - 全 membership_audit 閲覧 + フィルタ

### 5.2 inactive owner 一覧
**file**: `src/app/(operator)/operator/membership/orgs/inactive/page.tsx`

```
┌──────────────────────────────────────────────────┐
│ オーナー長期不在の組織                            │
├──────────────────────────────────────────────────┤
│ 組織名     オーナー         最終ログイン  操作   │
│ ABC社      tanaka@a.com    2026-01-15  [対応]  │
│ XYZ施設    sato@x.com      未ログイン   [対応]  │
└──────────────────────────────────────────────────┘
```

「対応」クリック → `/operator/membership/orgs/{id}/transfer` へ。

### 5.3 強制譲渡画面
**file**: `src/app/(operator)/operator/membership/orgs/[id]/transfer/page.tsx`

```
┌──────────────────────────────────────────────────┐
│ 組織オーナー 強制譲渡                             │
├──────────────────────────────────────────────────┤
│ 対象組織: ABC社                                  │
│ 現オーナー: tanaka@a.com (90日未ログイン)       │
│                                                  │
│ 新オーナー候補:                                  │
│ ○ suzuki@a.com (管理者) - 2026-04-30 ログイン  │
│ ○ sato@a.com   (管理者) - 2026-05-08 ログイン  │
│ ○ yamada@a.com (メンバー) - 2026-05-09 ログイン │
│                                                  │
│ 理由 (必須、メンバ全員に通知メールに記載):       │
│ ┌────────────────────────────────────────────┐ │
│ │ オーナーが90日以上未ログインのため、       │ │
│ │ 運営側で次期オーナーへ譲渡します。         │ │
│ └────────────────────────────────────────────┘ │
│                                                  │
│ [キャンセル]                  [強制譲渡を実行]  │
└──────────────────────────────────────────────────┘
```

実行前に確認 dialog:
```
┌────────────────────────────────────────┐
│ 確認                                    │
├────────────────────────────────────────┤
│ ABC社 のオーナーを                      │
│ tanaka@a.com → suzuki@a.com に         │
│ 強制譲渡します。                        │
│                                        │
│ 全メンバに通知メールが送信されます。   │
│ この操作は取り消せません。              │
│                                        │
│ [キャンセル]  [実行する]                │
└────────────────────────────────────────┘
```

### 5.4 監査ログ閲覧
**file**: `src/app/(operator)/operator/membership/audit/page.tsx`

```
┌──────────────────────────────────────────────────────────┐
│ メンバシップ監査ログ                                      │
├──────────────────────────────────────────────────────────┤
│ Filter:                                                  │
│  Scope:  [All ▼]   Action: [All ▼]   日付: [from-to]   │
│                                                          │
│ Time             Scope     Action                Actor   │
│ 2026-05-10 22:00 family    invite_accepted      花子    │
│ 2026-05-10 21:55 family    paste_executed       花子    │
│ 2026-05-09 18:00 org       owner_transferred    田中    │
│ 2026-05-08 09:30 org       operator_force_      [SYS]  │
│                            owner_transfer       (op:佐藤) │
│ ...                                                      │
└──────────────────────────────────────────────────────────┘
```

クリックで詳細 modal (metadata JSON 表示)。

---

## 6. UI コンポーネント

### 6.1 強制操作確認 modal
**file (新規)**: `src/components/operator/membership/ForceActionConfirmModal.tsx`

```tsx
type Props = {
  scope: 'organization' | 'family';
  scopeName: string;
  action: 'transfer' | 'dissolve';
  newAssignee?: { id: string; label: string };
  reason: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
};
```

実行ボタンを押すと API 呼び出し → 成功時に audit log entry + 全メンバ通知メール (運営強制操作通知, 04-email-templates.md §7)。

### 6.2 inactive list table
**file (新規)**: `src/components/operator/membership/InactiveOwnerTable.tsx`

```tsx
type InactiveOwner = {
  scope_id: string;
  scope_name: string;
  owner_id: string;
  owner_email: string;
  last_login_at: Date | null;
};
```

---

## 7. API endpoints

```
GET  /api/operator/membership/orgs/inactive?days=90
GET  /api/operator/membership/families/inactive?days=90
GET  /api/operator/membership/audit?scope=&action=&from=&to=&page=&limit=
POST /api/operator/membership/org/{id}/transfer    body: { new_owner_id, reason }
POST /api/operator/membership/org/{id}/dissolve    body: { reason }
POST /api/operator/membership/family/{id}/transfer body: { new_rep_id, reason }
POST /api/operator/membership/family/{id}/dissolve body: { reason }
```

各 endpoint で `requireRole(['super_admin'])` を最初に check。

---

## 8. 通知ロジック

強制操作実行 → server side で:
1. 影響メンバ全員の email を取得 (org: organization_members 全員、family: family_members 全員)
2. テンプレート 04-§7 の運営強制操作通知メールを Resend で並列送信
3. 失敗してもログ残しのみで成功扱い (操作自体は成功)
4. 通知の retry は別 cron (TODO: P7 後期で追加)

---

## 9. 24h 待機オプション (運用ベストプラクティス)

将来 (P7 以降) 追加する機能:
- 強制操作実行を「24h 待機」モードで予約
- 該当 owner に「運営側で操作予定」通知 → 24h 以内にログインがあれば自動キャンセル
- これは「実は生きていた」ケースの safeguard
- DB: `operator_pending_actions` テーブルを追加 (action, scope, scope_id, scheduled_at, status)

P0-P6 ではこのモードは実装しない (即時実行のみ)。
