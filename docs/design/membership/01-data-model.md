# 01. Data Model — Canonical Schema

**コードファースト原則**: 本ファイルの DDL / 型 / Zod スキーマがすべての真実の出処。自然言語の補足は最小限。

---

## 0. 型生成パイプライン (絶対遵守)

### 0.1 Supabase 型自動生成
```bash
# package.json に script として登録 (毎 migration 後に実行)
npm run types:supabase

# 内部で実行
npx supabase gen types typescript --linked > src/types/database.types.ts
```

### 0.2 全コードでの利用方針
```ts
// 必ず src/types/database.types.ts から import する
import type { Database } from '@/types/database.types';

type FamilyGroup       = Database['public']['Tables']['family_groups']['Row'];
type FamilyGroupInsert = Database['public']['Tables']['family_groups']['Insert'];
type FamilyGroupUpdate = Database['public']['Tables']['family_groups']['Update'];

// ★ 禁止事項
// - any / as any / as unknown as X (型エスケープ)
// - 手書きで Row 型を定義する (gen types と乖離)
// - Pick<> や Omit<> で Row を加工した「アプリ用型」を src/lib に置く (代わりに Zod で定義し infer する)
```

### 0.3 Zod スキーマ配置規約
```
src/schemas/membership/
├── index.ts                          # 全 export
├── organization-invite.ts            # POST/GET/DELETE /api/org/invites
├── organization-invite-action.ts     # POST /api/org/invites/{token}/accept|reject
├── organization-member.ts            # PATCH/DELETE /api/org/members/{user_id}
├── organization-owner-transfer.ts    # POST /api/org/owner-transfer
├── family-group.ts                   # POST/GET /api/family/groups
├── family-invite.ts                  # POST/GET /api/family/invites
├── family-invite-action.ts           # POST /api/family/invites/{token}/accept|reject
├── family-member.ts                  # POST/PATCH/DELETE /api/family/members
├── family-representative-transfer.ts # POST /api/family/representative-transfer
├── meal-paste.ts                     # POST /api/meals/paste
├── share-settings.ts                 # PATCH /api/family/members/me/share
└── operator-membership.ts            # POST /api/operator/membership/{scope}/{id}/transfer|dissolve
```

各スキーマは:
- `*Body` (Request body)
- `*Query` (URL query)
- `*Params` (path params)
- `*Response` (Response shape — `{ data: T, error?: ApiError }` 形式に統一)

---

## 1. 共通定義

### 1.1 ApiError + Response wrapper (Zod)
```ts
// src/schemas/common.ts
import { z } from 'zod';

export const ApiErrorSchema = z.object({
  code: z.string(),                    // 'NOT_FOUND', 'CONFLICT', 'FORBIDDEN', ...
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

export const apiSuccess = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ data, error: z.undefined().optional() });

export const apiFailure = z.object({
  data: z.undefined().optional(),
  error: ApiErrorSchema,
});

export const apiResponse = <T extends z.ZodTypeAny>(data: T) =>
  z.union([apiSuccess(data), apiFailure]);

export type ApiError = z.infer<typeof ApiErrorSchema>;
```

**全 API レスポンスはこの wrapper を使う**。`{ data: T }` か `{ error: ApiError }` のどちらかを必ず返す。

### 1.2 共通エラーコード enum (TypeScript)
```ts
// src/lib/errors/membership-errors.ts
export const MembershipErrorCode = {
  // 招待
  INVITE_NOT_FOUND:           'INVITE_NOT_FOUND',
  INVITE_EXPIRED:             'INVITE_EXPIRED',
  INVITE_ALREADY_USED:        'INVITE_ALREADY_USED',
  INVITE_REVOKED:             'INVITE_REVOKED',
  INVITE_EMAIL_MISMATCH:      'INVITE_EMAIL_MISMATCH',

  // 競合
  ALREADY_IN_ORG:             'ALREADY_IN_ORG',
  ALREADY_IN_FAMILY:          'ALREADY_IN_FAMILY',
  IS_ORG_OWNER:               'IS_ORG_OWNER',
  IS_FAMILY_REPRESENTATIVE:   'IS_FAMILY_REPRESENTATIVE',

  // 権限
  NOT_AUTHENTICATED:          'NOT_AUTHENTICATED',
  NOT_ORG_ADMIN:              'NOT_ORG_ADMIN',
  NOT_FAMILY_ADULT:           'NOT_FAMILY_ADULT',
  NOT_OPERATOR:               'NOT_OPERATOR',

  // 制限
  SEAT_LIMIT_EXCEEDED:        'SEAT_LIMIT_EXCEEDED',
  MEMBER_LIMIT_EXCEEDED:      'MEMBER_LIMIT_EXCEEDED',

  // 内部
  RPC_FAILED:                 'RPC_FAILED',
  EMAIL_SEND_FAILED:          'EMAIL_SEND_FAILED',
} as const;

export type MembershipErrorCode = typeof MembershipErrorCode[keyof typeof MembershipErrorCode];
```

---

## 2. organization 関連 DDL

### 2.1 organizations テーブル ALTER
```sql
-- migration: 20260511000000_membership_org_extensions.sql

-- owner 列 (canonical な single owner)
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE RESTRICT;

-- DB 不変条件: owner は必ず存在 (NOT NULL は backfill 後に付与)
-- backfill: 既存 organizations.user_profiles で org_admin role を持つ最古のユーザを owner として設定
UPDATE organizations o
SET owner_id = (
  SELECT up.id FROM user_profiles up
  WHERE up.organization_id = o.id
    AND 'org_admin' = ANY(up.roles)
  ORDER BY up.created_at ASC
  LIMIT 1
)
WHERE owner_id IS NULL;

ALTER TABLE organizations
  ALTER COLUMN owner_id SET NOT NULL;

-- 検索用 index
CREATE INDEX IF NOT EXISTS idx_organizations_owner_id ON organizations(owner_id);
```

### 2.2 user_profiles 拡張 (org_role)
```sql
-- migration: 20260511000001_membership_user_profiles.sql

CREATE TYPE org_role_enum AS ENUM ('owner', 'admin', 'member');

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS org_role org_role_enum;

-- 整合性: organization_id IS NULL ⇔ org_role IS NULL
ALTER TABLE user_profiles
  ADD CONSTRAINT user_profiles_org_consistency CHECK (
    (organization_id IS NULL AND org_role IS NULL)
    OR (organization_id IS NOT NULL AND org_role IS NOT NULL)
  );

-- backfill: 既存 organization_id 持ちは role='member' でデフォルト
UPDATE user_profiles
SET org_role = 'member'
WHERE organization_id IS NOT NULL AND org_role IS NULL;

-- owner backfill: organizations.owner_id と一致する user は role='owner' に上書き
UPDATE user_profiles up
SET org_role = 'owner'
FROM organizations o
WHERE up.id = o.owner_id;

CREATE INDEX IF NOT EXISTS idx_user_profiles_org ON user_profiles(organization_id) WHERE organization_id IS NOT NULL;
```

### 2.3 organization_invites (既存テーブル拡張)
```sql
-- migration: 20260511000002_membership_org_invites.sql

-- status enum を CHECK 制約として標準化
ALTER TABLE organization_invites
  DROP CONSTRAINT IF EXISTS organization_invites_status_check;

ALTER TABLE organization_invites
  ADD CONSTRAINT organization_invites_status_check
  CHECK (status IN ('pending','accepted','rejected','expired','revoked'));

-- 招待時に決定する役割
ALTER TABLE organization_invites
  ADD COLUMN IF NOT EXISTS invited_role org_role_enum NOT NULL DEFAULT 'member';

-- 招待者から受領者へのカスタムメッセージ (任意)
ALTER TABLE organization_invites
  ADD COLUMN IF NOT EXISTS custom_message TEXT;

-- 受領者が確定したタイミング
ALTER TABLE organization_invites
  ADD COLUMN IF NOT EXISTS accepted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- 同一 email の pending 招待は 1 organization 1 件まで
CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_invites_pending
  ON organization_invites(organization_id, lower(email))
  WHERE status = 'pending';

-- token は当然 UNIQUE
-- 既存 schema にあれば skip、無ければ:
CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_invites_token
  ON organization_invites(token);
```

### 2.4 RLS policy (organizations / user_profiles / organization_invites)
```sql
-- migration: 20260511000003_membership_org_rls.sql

-- organizations: メンバ自身は SELECT 可、owner/admin は UPDATE 可、owner だけ DELETE 可
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organizations_select_member ON organizations;
CREATE POLICY organizations_select_member ON organizations
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid() AND up.organization_id = organizations.id
    )
  );

DROP POLICY IF EXISTS organizations_update_admin ON organizations;
CREATE POLICY organizations_update_admin ON organizations
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = organizations.id
        AND up.org_role IN ('owner','admin')
    )
  );

DROP POLICY IF EXISTS organizations_delete_owner ON organizations;
CREATE POLICY organizations_delete_owner ON organizations
  FOR DELETE USING (organizations.owner_id = auth.uid());

-- organization_invites: pending 確認は token 持ちなら誰でも (受諾画面で表示するため)
-- 一覧は admin/owner のみ
ALTER TABLE organization_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_invites_select_admin ON organization_invites;
CREATE POLICY org_invites_select_admin ON organization_invites
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = organization_invites.organization_id
        AND up.org_role IN ('owner','admin')
    )
  );

DROP POLICY IF EXISTS org_invites_insert_admin ON organization_invites;
CREATE POLICY org_invites_insert_admin ON organization_invites
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = organization_invites.organization_id
        AND up.org_role IN ('owner','admin')
    )
  );

-- DELETE/UPDATE は admin/owner のみ (revoke 用)
DROP POLICY IF EXISTS org_invites_update_admin ON organization_invites;
CREATE POLICY org_invites_update_admin ON organization_invites
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = organization_invites.organization_id
        AND up.org_role IN ('owner','admin')
    )
  );
```

### 2.5 organizations 操作 RPC
```sql
-- migration: 20260511000004_membership_org_rpc.sql

-- 招待発行 (server-side でのみ呼ぶ前提、SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.create_org_invite(
  p_organization_id UUID,
  p_email TEXT,
  p_role org_role_enum DEFAULT 'member',
  p_custom_message TEXT DEFAULT NULL
) RETURNS organization_invites
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public AS $$
DECLARE
  v_invite organization_invites;
  v_token TEXT;
  v_caller_org_id UUID;
  v_caller_role org_role_enum;
  v_seat_limit INT;
  v_used_seats INT;
BEGIN
  -- 呼び出し元が同 org の admin/owner か検証
  SELECT organization_id, org_role INTO v_caller_org_id, v_caller_role
    FROM user_profiles WHERE id = auth.uid();

  IF v_caller_org_id IS DISTINCT FROM p_organization_id OR v_caller_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'NOT_ORG_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  -- seat 上限チェック (org_license_pools)
  SELECT total_licenses, used_licenses INTO v_seat_limit, v_used_seats
    FROM org_license_pools WHERE organization_id = p_organization_id;

  IF v_seat_limit IS NOT NULL AND v_used_seats >= v_seat_limit THEN
    RAISE EXCEPTION 'SEAT_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  -- token 生成
  v_token := encode(gen_random_bytes(32), 'hex');

  -- 既存 pending を invalidate (revoke)
  UPDATE organization_invites
    SET status = 'revoked', revoked_at = NOW(), revoked_by = auth.uid()
    WHERE organization_id = p_organization_id
      AND lower(email) = lower(p_email)
      AND status = 'pending';

  INSERT INTO organization_invites (
    organization_id, email, token, invited_role, custom_message,
    status, expires_at, created_at, invited_by
  ) VALUES (
    p_organization_id, lower(p_email), v_token, p_role, p_custom_message,
    'pending', NOW() + INTERVAL '14 days', NOW(), auth.uid()
  )
  RETURNING * INTO v_invite;

  RETURN v_invite;
END $$;

REVOKE EXECUTE ON FUNCTION public.create_org_invite FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_org_invite TO authenticated;

-- 招待受諾 (token 持ちユーザが呼ぶ)
CREATE OR REPLACE FUNCTION public.accept_org_invite(p_token TEXT)
RETURNS user_profiles
LANGUAGE plpgsql
SECURITY DEFINER  -- ★ 受諾は user_profiles を SET するため DEFINER 必須
SET search_path = public AS $$
DECLARE
  v_invite organization_invites;
  v_user_profile user_profiles;
  v_caller_email TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- 招待 fetch
  SELECT * INTO v_invite FROM organization_invites WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- 状態チェック
  IF v_invite.status = 'expired' OR v_invite.expires_at < NOW() THEN
    UPDATE organization_invites SET status = 'expired' WHERE id = v_invite.id;
    RAISE EXCEPTION 'INVITE_EXPIRED' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.status IN ('accepted','rejected','revoked') THEN
    RAISE EXCEPTION 'INVITE_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  -- email 一致チェック (auth.users から caller の email 取得)
  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF lower(v_caller_email) <> lower(v_invite.email) THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  -- 既に他組織所属チェック
  SELECT * INTO v_user_profile FROM user_profiles WHERE id = auth.uid();
  IF v_user_profile.organization_id IS NOT NULL
     AND v_user_profile.organization_id <> v_invite.organization_id THEN
    RAISE EXCEPTION 'ALREADY_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  -- 自身が別 org の owner か (owner は脱退不可)
  IF EXISTS (SELECT 1 FROM organizations WHERE owner_id = auth.uid()
             AND id <> v_invite.organization_id) THEN
    RAISE EXCEPTION 'IS_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  -- メンバ化
  UPDATE user_profiles
    SET organization_id = v_invite.organization_id,
        org_role = v_invite.invited_role,
        joined_org_at = CURRENT_DATE,
        is_active_in_org = TRUE
    WHERE id = auth.uid()
    RETURNING * INTO v_user_profile;

  -- 招待消化
  UPDATE organization_invites
    SET status = 'accepted', accepted_at = NOW(), accepted_by = auth.uid()
    WHERE id = v_invite.id;

  -- 監査ログ
  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', v_invite.organization_id, 'invite_accepted', auth.uid(), auth.uid(),
          jsonb_build_object('invite_id', v_invite.id, 'role', v_invite.invited_role));

  RETURN v_user_profile;
END $$;

REVOKE EXECUTE ON FUNCTION public.accept_org_invite FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_org_invite TO authenticated;

-- 招待拒否
CREATE OR REPLACE FUNCTION public.reject_org_invite(p_token TEXT)
RETURNS organization_invites
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_invite organization_invites;
  v_caller_email TEXT;
BEGIN
  SELECT * INTO v_invite FROM organization_invites WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.status NOT IN ('pending') THEN
    RAISE EXCEPTION 'INVITE_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
    IF lower(v_caller_email) <> lower(v_invite.email) THEN
      RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE organization_invites
    SET status = 'rejected', rejected_at = NOW()
    WHERE id = v_invite.id
    RETURNING * INTO v_invite;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', v_invite.organization_id, 'invite_rejected', auth.uid(), NULL,
          jsonb_build_object('invite_id', v_invite.id));

  RETURN v_invite;
END $$;

REVOKE EXECUTE ON FUNCTION public.reject_org_invite FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_org_invite TO anon, authenticated;

-- メンバ除名 (admin/owner のみ)
CREATE OR REPLACE FUNCTION public.remove_org_member(p_organization_id UUID, p_user_id UUID)
RETURNS user_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_caller_role org_role_enum;
  v_target user_profiles;
BEGIN
  SELECT org_role INTO v_caller_role FROM user_profiles
    WHERE id = auth.uid() AND organization_id = p_organization_id;
  IF v_caller_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'NOT_ORG_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_target FROM user_profiles WHERE id = p_user_id;
  IF v_target.organization_id <> p_organization_id THEN
    RAISE EXCEPTION 'USER_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  -- owner は除名不可 (まず譲渡)
  IF v_target.org_role = 'owner' THEN
    RAISE EXCEPTION 'CANNOT_REMOVE_OWNER' USING ERRCODE = 'P0001';
  END IF;

  -- admin → admin の除名は禁止 (owner のみが admin を除名可)
  IF v_target.org_role = 'admin' AND v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'NOT_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  UPDATE user_profiles
    SET organization_id = NULL, org_role = NULL,
        is_active_in_org = FALSE, joined_org_at = NULL
    WHERE id = p_user_id
    RETURNING * INTO v_target;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('organization', p_organization_id, 'member_removed', auth.uid(), p_user_id);

  RETURN v_target;
END $$;

REVOKE EXECUTE ON FUNCTION public.remove_org_member FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_org_member TO authenticated;

-- 自発脱退
CREATE OR REPLACE FUNCTION public.leave_org()
RETURNS user_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE v_user user_profiles; v_org_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_user FROM user_profiles WHERE id = auth.uid();
  IF v_user.organization_id IS NULL THEN
    RAISE EXCEPTION 'NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;
  IF v_user.org_role = 'owner' THEN
    RAISE EXCEPTION 'IS_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  v_org_id := v_user.organization_id;

  UPDATE user_profiles
    SET organization_id = NULL, org_role = NULL,
        is_active_in_org = FALSE, joined_org_at = NULL
    WHERE id = auth.uid()
    RETURNING * INTO v_user;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('organization', v_org_id, 'member_left', auth.uid(), auth.uid());

  RETURN v_user;
END $$;

REVOKE EXECUTE ON FUNCTION public.leave_org FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.leave_org TO authenticated;

-- owner 譲渡 (2 step: propose → accept)
CREATE OR REPLACE FUNCTION public.propose_org_owner_transfer(p_organization_id UUID, p_to_user_id UUID)
RETURNS UUID  -- proposal id
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_caller_role org_role_enum; v_target_role org_role_enum; v_proposal_id UUID;
BEGIN
  SELECT org_role INTO v_caller_role FROM user_profiles
    WHERE id = auth.uid() AND organization_id = p_organization_id;
  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'NOT_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  SELECT org_role INTO v_target_role FROM user_profiles
    WHERE id = p_to_user_id AND organization_id = p_organization_id;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'TARGET_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  v_proposal_id := gen_random_uuid();
  INSERT INTO membership_audit (id, scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES (v_proposal_id, 'organization', p_organization_id, 'owner_transfer_proposed',
          auth.uid(), p_to_user_id,
          jsonb_build_object('proposal_id', v_proposal_id, 'expires_at', NOW() + INTERVAL '7 days'));

  RETURN v_proposal_id;
END $$;

REVOKE EXECUTE ON FUNCTION public.propose_org_owner_transfer FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.propose_org_owner_transfer TO authenticated;

CREATE OR REPLACE FUNCTION public.accept_org_owner_transfer(p_proposal_id UUID)
RETURNS organizations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_proposal membership_audit; v_org_id UUID; v_old_owner_id UUID;
BEGIN
  SELECT * INTO v_proposal FROM membership_audit
    WHERE id = p_proposal_id AND action = 'owner_transfer_proposed' AND target_user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF (v_proposal.metadata->>'expires_at')::TIMESTAMPTZ < NOW() THEN
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  v_org_id := v_proposal.scope_id;
  v_old_owner_id := v_proposal.actor_id;

  -- role swap
  UPDATE user_profiles SET org_role = 'admin' WHERE id = v_old_owner_id;
  UPDATE user_profiles SET org_role = 'owner' WHERE id = auth.uid();
  UPDATE organizations SET owner_id = auth.uid() WHERE id = v_org_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', v_org_id, 'owner_transferred', auth.uid(), v_old_owner_id,
          jsonb_build_object('proposal_id', p_proposal_id));

  RETURN (SELECT * FROM organizations WHERE id = v_org_id);
END $$;

REVOKE EXECUTE ON FUNCTION public.accept_org_owner_transfer FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_org_owner_transfer TO authenticated;
```

### 2.6 organization 関連 Zod スキーマ
```ts
// src/schemas/membership/organization-invite.ts
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';

export const OrgRoleSchema = z.enum(['owner','admin','member']);
export const OrgInviteStatusSchema = z.enum(['pending','accepted','rejected','expired','revoked']);

export const CreateOrgInviteBodySchema = z.object({
  organization_id: z.string().uuid(),
  email: z.string().email().toLowerCase(),
  role: OrgRoleSchema.default('member'),
  custom_message: z.string().max(500).optional(),
});

export const OrgInviteSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  email: z.string().email(),
  token: z.string(),
  invited_role: OrgRoleSchema,
  custom_message: z.string().nullable(),
  status: OrgInviteStatusSchema,
  expires_at: z.string().datetime(),
  created_at: z.string().datetime(),
  invited_by: z.string().uuid(),
  accepted_at: z.string().datetime().nullable(),
  accepted_by: z.string().uuid().nullable(),
  rejected_at: z.string().datetime().nullable(),
  revoked_at: z.string().datetime().nullable(),
  revoked_by: z.string().uuid().nullable(),
});

export const CreateOrgInviteResponseSchema = apiResponse(z.object({
  invite: OrgInviteSchema,
  invite_url: z.string().url(),  // クライアントがコピー/メール表示するための URL
}));

export type CreateOrgInviteBody = z.infer<typeof CreateOrgInviteBodySchema>;
export type OrgInvite = z.infer<typeof OrgInviteSchema>;
```

```ts
// src/schemas/membership/organization-invite-action.ts
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';
import { OrgInviteSchema } from './organization-invite';

export const InviteTokenParamsSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/, 'invalid token format'),
});

export const AcceptOrgInviteResponseSchema = apiResponse(z.object({
  organization_id: z.string().uuid(),
  org_role: z.enum(['owner','admin','member']),
}));

export const RejectOrgInviteResponseSchema = apiResponse(OrgInviteSchema);

export type InviteTokenParams = z.infer<typeof InviteTokenParamsSchema>;
```

(他の org スキーマも同パターンで定義 — 簡潔化のため省略、`src/schemas/membership/` で実装時に網羅)

---

## 3. family 関連 DDL

### 3.1 family_groups
```sql
-- migration: 20260511000010_membership_family_groups.sql

CREATE TABLE family_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  representative_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  plan_key TEXT NOT NULL DEFAULT 'free' REFERENCES subscription_plans(plan_key),
  member_limit INT NOT NULL DEFAULT 4 CHECK (member_limit > 0 AND member_limit <= 20),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dissolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dissolved_at TIMESTAMPTZ
);

CREATE INDEX idx_family_groups_representative ON family_groups(representative_id);
CREATE INDEX idx_family_groups_status ON family_groups(status);
```

### 3.2 family_members
```sql
-- migration: 20260511000011_membership_family_members.sql

CREATE TYPE family_role_enum AS ENUM ('representative','adult','child');

CREATE TABLE family_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,  -- NULL は子供の auth account なし
  role family_role_enum NOT NULL,
  display_name TEXT,                           -- family 内での呼称 (例: 「お母さん」「長男」)
  relationship TEXT,                            -- 'spouse','child','parent','grandparent','sibling','partner','roommate','other'
  tags TEXT[] NOT NULL DEFAULT '{}',           -- ['cooks_main','has_allergy','diet_restricted','needs_proxy_care','lives_apart','pet']
  -- 共有設定 (本メンバの記録を他家族メンバに見せるか)
  share_meals BOOLEAN NOT NULL DEFAULT TRUE,
  share_health BOOLEAN NOT NULL DEFAULT FALSE,
  share_menu BOOLEAN NOT NULL DEFAULT TRUE,
  -- 子供 (auth account なし) のプロフィール
  child_profile JSONB,
  -- avatar 表示用色 (#RRGGBB)
  avatar_color TEXT NOT NULL DEFAULT '#FF6B6B' CHECK (avatar_color ~ '^#[0-9A-Fa-f]{6}$'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed','left')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ
);

-- 1 user は 1 family のみ (NULL の子供は除外)
CREATE UNIQUE INDEX uniq_family_members_user
  ON family_members(user_id)
  WHERE user_id IS NOT NULL AND status = 'active';

-- 1 family につき representative は 1 名のみ
CREATE UNIQUE INDEX uniq_family_representative
  ON family_members(family_id)
  WHERE role = 'representative' AND status = 'active';

CREATE INDEX idx_family_members_family ON family_members(family_id);
CREATE INDEX idx_family_members_user ON family_members(user_id) WHERE user_id IS NOT NULL;

-- 整合性: child_profile は role='child' AND user_id IS NULL のときのみ
ALTER TABLE family_members
  ADD CONSTRAINT family_members_child_profile_consistency CHECK (
    (role = 'child' AND user_id IS NULL AND child_profile IS NOT NULL)
    OR (user_id IS NOT NULL AND child_profile IS NULL)
  );
```

### 3.3 family_invites
```sql
-- migration: 20260511000012_membership_family_invites.sql

CREATE TABLE family_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  invited_role family_role_enum NOT NULL DEFAULT 'adult'
    CHECK (invited_role IN ('adult')),  -- ★ 招待で child は不可 (子は親が直接追加)
  custom_message TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected','expired','revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invited_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  accepted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX uniq_family_invites_pending
  ON family_invites(family_id, lower(email))
  WHERE status = 'pending';

CREATE INDEX idx_family_invites_token ON family_invites(token);
```

### 3.4 user_profiles に family_id 追加
```sql
-- migration: 20260511000013_membership_user_profiles_family.sql

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS family_id UUID REFERENCES family_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_user_profiles_family ON user_profiles(family_id) WHERE family_id IS NOT NULL;
```

### 3.5 RLS policy (family ドメイン)
```sql
-- migration: 20260511000014_membership_family_rls.sql

ALTER TABLE family_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_invites ENABLE ROW LEVEL SECURITY;

-- family_groups
DROP POLICY IF EXISTS family_groups_select_member ON family_groups;
CREATE POLICY family_groups_select_member ON family_groups
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM family_members fm
      WHERE fm.family_id = family_groups.id AND fm.user_id = auth.uid() AND fm.status = 'active'
    )
  );

DROP POLICY IF EXISTS family_groups_update_adult ON family_groups;
CREATE POLICY family_groups_update_adult ON family_groups
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM family_members fm
      WHERE fm.family_id = family_groups.id AND fm.user_id = auth.uid()
        AND fm.role IN ('representative','adult') AND fm.status = 'active'
    )
  );

DROP POLICY IF EXISTS family_groups_delete_representative ON family_groups;
CREATE POLICY family_groups_delete_representative ON family_groups
  FOR DELETE USING (family_groups.representative_id = auth.uid());

-- family_members
DROP POLICY IF EXISTS family_members_select_self_or_family ON family_members;
CREATE POLICY family_members_select_self_or_family ON family_members
  FOR SELECT USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM family_members fm
      WHERE fm.family_id = family_members.family_id AND fm.user_id = auth.uid() AND fm.status = 'active'
    )
  );

DROP POLICY IF EXISTS family_members_update_self_or_adult ON family_members;
CREATE POLICY family_members_update_self_or_adult ON family_members
  FOR UPDATE USING (
    user_id = auth.uid()  -- 自身の share_* / display_name 等更新
    OR EXISTS (  -- adult/representative は他メンバの role/tags 更新可
      SELECT 1 FROM family_members fm
      WHERE fm.family_id = family_members.family_id AND fm.user_id = auth.uid()
        AND fm.role IN ('representative','adult') AND fm.status = 'active'
    )
  );

-- family_invites
DROP POLICY IF EXISTS family_invites_select_adult ON family_invites;
CREATE POLICY family_invites_select_adult ON family_invites
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM family_members fm
      WHERE fm.family_id = family_invites.family_id AND fm.user_id = auth.uid()
        AND fm.role IN ('representative','adult') AND fm.status = 'active'
    )
  );
```

### 3.6 family 操作 RPC (主要分のみ抜粋、残りは org と同パターン)
```sql
-- migration: 20260511000015_membership_family_rpc.sql

-- 家族グループ作成 (作成者が自動的に representative)
CREATE OR REPLACE FUNCTION public.create_family_group(p_name TEXT, p_plan_key TEXT DEFAULT 'free')
RETURNS family_groups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_group family_groups;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO family_groups (name, representative_id, plan_key)
  VALUES (p_name, auth.uid(), p_plan_key)
  RETURNING * INTO v_group;

  INSERT INTO family_members (family_id, user_id, role, display_name)
  VALUES (v_group.id, auth.uid(), 'representative',
          (SELECT nickname FROM user_profiles WHERE id = auth.uid()));

  UPDATE user_profiles SET family_id = v_group.id WHERE id = auth.uid();

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('family', v_group.id, 'group_created', auth.uid(), auth.uid());

  RETURN v_group;
END $$;

REVOKE EXECUTE ON FUNCTION public.create_family_group FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_family_group TO authenticated;

-- 子供メンバ追加 (auth account なし)
CREATE OR REPLACE FUNCTION public.add_family_child(
  p_family_id UUID,
  p_display_name TEXT,
  p_child_profile JSONB
) RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_caller_role family_role_enum; v_member family_members; v_count INT; v_limit INT;
BEGIN
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = p_family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  SELECT member_limit INTO v_limit FROM family_groups WHERE id = p_family_id;
  SELECT COUNT(*) INTO v_count FROM family_members
    WHERE family_id = p_family_id AND status = 'active';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'MEMBER_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO family_members (family_id, user_id, role, display_name, child_profile)
  VALUES (p_family_id, NULL, 'child', p_display_name, p_child_profile)
  RETURNING * INTO v_member;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', p_family_id, 'child_added', auth.uid(),
          jsonb_build_object('member_id', v_member.id, 'display_name', p_display_name));

  RETURN v_member;
END $$;

REVOKE EXECUTE ON FUNCTION public.add_family_child FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_family_child TO authenticated;

-- 子供を実 user に promote
CREATE OR REPLACE FUNCTION public.promote_child_to_user(p_member_id UUID, p_user_id UUID)
RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_caller_role family_role_enum; v_member family_members;
BEGIN
  SELECT * INTO v_member FROM family_members WHERE id = p_member_id;
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = v_member.family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;
  IF v_member.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_PROMOTED' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = p_user_id AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_members SET user_id = p_user_id, child_profile = NULL WHERE id = p_member_id
    RETURNING * INTO v_member;
  UPDATE user_profiles SET family_id = v_member.family_id WHERE id = p_user_id;

  -- meals/health_records の child_profile_id 参照を user_id に書き換え (別途 promotion script)
  -- ここでは family_members 行の更新のみ
  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_member.family_id, 'child_promoted', auth.uid(), p_user_id,
          jsonb_build_object('member_id', p_member_id));

  RETURN v_member;
END $$;

REVOKE EXECUTE ON FUNCTION public.promote_child_to_user FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.promote_child_to_user TO authenticated;

-- 招待発行 / 受諾 / 拒否 / 除名 / 脱退 / 代表者譲渡 RPC は org と同パターンで省略
-- 命名: create_family_invite, accept_family_invite, reject_family_invite,
--       remove_family_member, leave_family,
--       propose_family_representative_transfer, accept_family_representative_transfer
```

---

## 4. meals レコード — paste_group_id 追加

```sql
-- migration: 20260511000020_meals_paste_group.sql

ALTER TABLE meals
  ADD COLUMN IF NOT EXISTS paste_group_id UUID;

-- 同一ペーストグループの全レコードに対して bulk update 可能にする index
CREATE INDEX IF NOT EXISTS idx_meals_paste_group ON meals(paste_group_id) WHERE paste_group_id IS NOT NULL;

-- meals の閲覧 RLS — 自分 + 家族 (share_meals=TRUE のメンバ) の meals を見る
CREATE OR REPLACE FUNCTION public.can_view_user_meals(p_target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT
    auth.uid() = p_target_user_id
    OR EXISTS (
      SELECT 1 FROM family_members vm
      JOIN family_members tm ON vm.family_id = tm.family_id
      WHERE vm.user_id = auth.uid() AND vm.status = 'active'
        AND tm.user_id = p_target_user_id AND tm.status = 'active'
        AND tm.share_meals = TRUE
    );
$$;

REVOKE EXECUTE ON FUNCTION public.can_view_user_meals FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_view_user_meals TO authenticated;

-- meals RLS の SELECT policy を上記関数で置換
DROP POLICY IF EXISTS meals_select_owner ON meals;
DROP POLICY IF EXISTS meals_select_family ON meals;
CREATE POLICY meals_select_owner_or_family ON meals
  FOR SELECT USING (public.can_view_user_meals(meals.user_id));

-- INSERT/UPDATE/DELETE は本人 (またはペースト関数経由) のみ
DROP POLICY IF EXISTS meals_modify_owner ON meals;
CREATE POLICY meals_insert_owner ON meals
  FOR INSERT WITH CHECK (meals.user_id = auth.uid());
CREATE POLICY meals_update_owner ON meals
  FOR UPDATE USING (meals.user_id = auth.uid());
CREATE POLICY meals_delete_owner ON meals
  FOR DELETE USING (meals.user_id = auth.uid());
```

### 4.1 ペースト RPC
```sql
CREATE OR REPLACE FUNCTION public.paste_meal_to_family(
  p_source_meal_id UUID,
  p_target_user_ids UUID[]
) RETURNS UUID  -- paste_group_id
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_source meals;
  v_paste_group_id UUID;
  v_target UUID;
  v_caller_family_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_source FROM meals WHERE id = p_source_meal_id;
  IF v_source.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'NOT_MEAL_OWNER' USING ERRCODE = 'P0001';
  END IF;

  SELECT family_id INTO v_caller_family_id FROM user_profiles WHERE id = auth.uid();
  IF v_caller_family_id IS NULL THEN
    RAISE EXCEPTION 'NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  v_paste_group_id := COALESCE(v_source.paste_group_id, gen_random_uuid());

  -- source 自身を group に紐付け (まだなら)
  IF v_source.paste_group_id IS NULL THEN
    UPDATE meals SET paste_group_id = v_paste_group_id WHERE id = p_source_meal_id;
  END IF;

  FOREACH v_target IN ARRAY p_target_user_ids LOOP
    -- target が同 family のメンバか検証
    IF NOT EXISTS (
      SELECT 1 FROM family_members
      WHERE family_id = v_caller_family_id AND user_id = v_target AND status = 'active'
    ) THEN
      RAISE EXCEPTION 'TARGET_NOT_IN_FAMILY' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO meals (user_id, paste_group_id, /* ...全カラム... */)
    SELECT v_target, v_paste_group_id, /* 同じ値 */
    FROM meals WHERE id = p_source_meal_id;
  END LOOP;

  RETURN v_paste_group_id;
END $$;

REVOKE EXECUTE ON FUNCTION public.paste_meal_to_family FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.paste_meal_to_family TO authenticated;
```

### 4.2 ペースト Zod
```ts
// src/schemas/membership/meal-paste.ts
import { z } from 'zod';
import { apiResponse } from '@/schemas/common';

export const PasteMealBodySchema = z.object({
  source_meal_id: z.string().uuid(),
  target_user_ids: z.array(z.string().uuid()).min(1).max(20),
});

export const PasteMealResponseSchema = apiResponse(z.object({
  paste_group_id: z.string().uuid(),
  inserted_count: z.number().int().nonnegative(),
}));
```

---

## 5. 監査ログ

```sql
-- migration: 20260511000030_membership_audit.sql

CREATE TABLE membership_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('organization','family')),
  scope_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'group_created','group_dissolved',
    'invite_created','invite_accepted','invite_rejected','invite_revoked','invite_expired',
    'member_added','member_removed','member_left','child_added','child_promoted',
    'role_changed',
    'owner_transfer_proposed','owner_transferred',
    'representative_transfer_proposed','representative_transferred',
    'operator_force_owner_transfer','operator_force_representative_transfer',
    'operator_force_dissolve',
    'paste_executed'
  )),
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,  -- NULL = system / operator
  target_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_membership_audit_scope ON membership_audit(scope, scope_id);
CREATE INDEX idx_membership_audit_actor ON membership_audit(actor_id);
CREATE INDEX idx_membership_audit_target ON membership_audit(target_user_id);
CREATE INDEX idx_membership_audit_action ON membership_audit(action);
CREATE INDEX idx_membership_audit_created_at ON membership_audit(created_at DESC);

ALTER TABLE membership_audit ENABLE ROW LEVEL SECURITY;

-- メンバ自身は自身に関するログのみ閲覧可
CREATE POLICY membership_audit_select_self ON membership_audit
  FOR SELECT USING (actor_id = auth.uid() OR target_user_id = auth.uid());

-- admin/owner は自 scope の全ログ閲覧可
CREATE POLICY membership_audit_select_admin ON membership_audit
  FOR SELECT USING (
    (scope = 'organization' AND EXISTS (
      SELECT 1 FROM user_profiles WHERE id = auth.uid()
        AND organization_id = scope_id AND org_role IN ('owner','admin')
    ))
    OR (scope = 'family' AND EXISTS (
      SELECT 1 FROM family_members WHERE family_id = scope_id AND user_id = auth.uid()
        AND role IN ('representative','adult') AND status = 'active'
    ))
  );

-- 運営管理者は全ログ閲覧可 (super_admin role)
CREATE POLICY membership_audit_select_operator ON membership_audit
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM user_profiles WHERE id = auth.uid()
        AND ('super_admin' = ANY(roles) OR 'admin' = ANY(roles))
    )
  );

-- INSERT は SECURITY DEFINER 経由のみ (直接 INSERT は service_role のみ)
-- 通常のユーザは INSERT 不可
```

---

## 6. 型生成 + Zod 整合性テスト

```ts
// src/__tests__/schemas/membership-types.test.ts
import type { Database } from '@/types/database.types';
import { OrgInviteSchema } from '@/schemas/membership/organization-invite';
import { z } from 'zod';

// DB の Row 型と Zod スキーマが整合することを型レベルで保証
type DbOrgInvite = Database['public']['Tables']['organization_invites']['Row'];
type ZodOrgInvite = z.infer<typeof OrgInviteSchema>;

// このアサインが通れば schema と DB 型は互換
const _typecheck: DbOrgInvite = {} as ZodOrgInvite;
const _reverse: ZodOrgInvite = {} as DbOrgInvite;

// 検出すべきケース: DB に新カラム追加 → Zod 未更新 → このファイルでコンパイルエラー
```

---

## 7. migration ファイル命名

```
20260511000000_membership_org_extensions.sql      # organizations.owner_id
20260511000001_membership_user_profiles.sql       # user_profiles.org_role
20260511000002_membership_org_invites.sql         # organization_invites 拡張
20260511000003_membership_org_rls.sql             # org RLS
20260511000004_membership_org_rpc.sql             # org RPC
20260511000010_membership_family_groups.sql       # family_groups 新規
20260511000011_membership_family_members.sql      # family_members 新規
20260511000012_membership_family_invites.sql      # family_invites 新規
20260511000013_membership_user_profiles_family.sql # user_profiles.family_id
20260511000014_membership_family_rls.sql          # family RLS
20260511000015_membership_family_rpc.sql          # family RPC
20260511000020_meals_paste_group.sql              # meals.paste_group_id + RLS 更新 + RPC
20260511000030_membership_audit.sql               # membership_audit
```

13 ファイル、すべて 20260511 prefix で同日 apply 想定。逐次依存があるため番号順 apply。
