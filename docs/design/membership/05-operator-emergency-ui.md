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
> 現在形: 実在する関数は `operator_force_owner_transfer` / `operator_force_representative_transfer` で、最新の定義は `supabase/migrations/20261030120000_operator_force_transfer_reject_same.sql` (`:37`・`:102`。どちらも `jsonb` を返す (`20261023140000_operator_transfer_return_old_owner.sql` から)。譲渡先がすでに今のオーナー / 代表者なら、行のロックの下で何も書かずに `ALREADY_OWNER` / `ALREADY_REPRESENTATIVE` で止める (#2093 W5))。下の SQL は設計時の案の記録で、関数名 (`force_transfer_*`) と戻り値 (`organizations` / `family_groups`) は実装と違う。
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

> 現在形 (#1917。family/11 §11.1 の 4): 強制解散 RPC (`operator_force_dissolve_family` / `operator_force_dissolve_org`) の本体は、後始末の関数 `family_dissolve_apply` / `org_dissolve_apply` を呼ぶ形になり、`representative_id` / `owner_id` を NULL にする。下の SQL は当時の設計の記録 (メンバーの離脱と `status = 'dissolved'` の並びは後始末の関数に移った)。

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
│ メンバシップ 監査ログ                                     │
├──────────────────────────────────────────────────────────┤
│ 絞り込み:                                                │
│  対象: [すべて ▼]  操作: [すべて ▼]  開始日 〜 終了日    │
│                                                          │
│ 日時             対象  操作                  操作した人  │
│ 2026-05-10 22:00 家族  招待の承諾            acacacac... │
│ 2026-05-10 21:55 家族  食事の家族への貼り付け acacacac...│
│ 2026-05-09 18:00 組織  オーナーの譲渡        1a2b3c4d... │
│ 2026-05-08 09:30 組織  運営によるオーナーの  運営        │
│                        強制譲渡              (0e0e0e0e)  │
│ ...                                                      │
└──────────────────────────────────────────────────────────┘
```

クリックで詳細 modal (metadata JSON 表示)。操作 (`action`)・対象 (`scope`) は内部の英字の値を出さず、`src/lib/membership/audit-labels.ts` の表示名を一覧の列・絞り込みの選択肢・詳細 modal に出す (表に無い値は「不明な操作」「不明な対象」の固定の文で、内部の値は添えない。表のキーは `membership_audit_action_check`・`membership_audit_scope_check` の全値で、`tests/membership-audit-labels-contract-2086.test.ts` が突き合わせる。操作の絞り込みの選択肢は全値。#2086 V5)。

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

実行ボタンを押すと API 呼び出し → 成功時に audit log entry + 全メンバ通知メール (運営強制操作通知, 04-email-templates.md §7)。 失敗の文 (#2080 U5): 枠は画面が投げた日本語の文 (`OperatorScreenError`。`src/lib/membership/operator-screen-messages.ts`) だけを出し、それ以外の例外 (ブラウザの英字の文) は「<強制譲渡|強制解散>に失敗しました」。失敗の応答は API の文、本文に文が無ければ「<操作>に失敗しました (HTTP <番号>)」。ただし 401 (ログインが切れた) は、API の 401 の本文の文 (例: 「ログインが必要です」) ではなく、画面の読み込みの 401 と同じ「ログインし直してください」にする (`UNAUTHENTICATED_SCREEN_MESSAGE`。`postOperatorForceAction`。#2112 Z4)。通信そのものが失敗した (fetch の reject) ときは「<操作>の応答を受け取れませんでした（通信エラー）」に続けて対象を読み直す: 強制譲渡は譲渡の候補 (選んだメンバーが候補から外れていれば済んだとみなして一覧 `/operator/membership/{orgs|families}/inactive` へ戻す)・強制解散は一覧 (対象が解散されずに残っていなければ済んだとみなして枠を閉じる。組織の一覧は `dissolved: true` の行を残っていないと数える)。済んでいなければ「譲渡されていません / まだ解散されていません」(`FORCE_TRANSFER_NOT_DONE_GUIDE`・`FORCE_DISSOLVE_NOT_DONE_GUIDE`) の文を出し、読み直せなければ下記 (#2086 V1) のとおり枠を閉じて「済んだか分かりません」の文を画面に出す。画面の読み込み (候補・一覧・監査ログ) の失敗は、失敗の応答の本文に API の文があればその文、無ければ「<対象>を読み込めませんでした (HTTP <番号>)」、通信の失敗は「<対象>を読み込めませんでした（通信エラー）」(`fetchOperatorJson`)。読み込みの 401 (ログインが切れた) は、本文の文や「(HTTP 401)」ではなく、ほかの運営の画面の読み直しと同じ「ログインし直してください」にする (`UNAUTHENTICATED_SCREEN_MESSAGE`。#2093 W6)。 本文に API の文が無い 502 / 503 / 504 (手前のプロキシ・ホスティングの応答。route は RPC の commit のあとに監査と通知メールを待つので、その間の時間切れでは操作は済んでいる) も応答を受け取れなかったものとして、「<操作>の応答を受け取れませんでした (HTTP <番号>)」に続けて同じく対象を読み直す (#2086 V1。`OPERATOR_FORCE_ACTION_NO_RESPONSE_STATUSES`)。読み直しにも失敗したら、済んだか分からないまま押し直させない: 枠を閉じ、強制譲渡の画面は候補と「強制譲渡を実行」を出さずに「再試行」を出し (読み直して選んだメンバーが候補から外れていれば一覧へ戻し、まだ候補にいれば済んでいない旨を出して候補を戻す)、強制解散の一覧は一覧を出さずに「更新」で読み直せるまで止める (#2086 V1)。読み直しが 401 / 403 で断られたときは、読み込み直しても変わらないので「再試行」を出さず、理由の文 (401 は「ログインし直してください」) を出す (`OperatorLoadUnavailableError`・`operatorForceActionReloadFailure`。#2101 X4)。強制解散の一覧も 401 / 403 では「更新」で待たせず理由の文を出す。強制譲渡の 409 `ALREADY_REPRESENTATIVE` / `ALREADY_OWNER` (§7。押し直しを route が止めた) は済んでいたものとして一覧へ戻す。

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
POST /api/operator/membership/org/{id}/transfer    body: { to_user_id, reason }  (to_user_id がすでに今のオーナーなら 409 ALREADY_OWNER。監査・通知を出さない。#2086 V1)
POST /api/operator/membership/org/{id}/dissolve    body: { reason }
POST /api/operator/membership/family/{id}/transfer body: { to_user_id, reason }  (to_user_id が退会の手続き中なら 409 REPRESENTATIVE_ACCOUNT_DELETING。20261023150000。すでに今の代表者なら 409 ALREADY_REPRESENTATIVE。監査・通知を出さない。#2086 V1)
POST /api/operator/membership/family/{id}/dissolve body: { reason }
```

各 endpoint で `requireRole(['super_admin'])` を最初に check。

RPC が `RAISE EXCEPTION '<コード>'` で返す既知のコードは汎用の 500 にせず、4xx と日本語の固定の文で返す (#1917 の続き。RPC ごとのコードの表は `src/lib/membership/operator-rpc-errors.ts`・強制の譲渡の 2 本は route が個別に写す):

- `OPERATOR_MFA_REQUIRED` → 403 (ゲートが二段階認証で止めたときと同じ code と文。`operatorMfaRequiredNested`)
- 権限の判定 (`OPERATOR_PERMISSION_REQUIRED`・`NOT_OPERATOR`・`INSUFFICIENT_PERMISSION`) → 403 `FORBIDDEN`「この操作を行う権限がありません」
- 組織の強制解散の `ORG_ALREADY_DISSOLVED` → 409・`ORG_NOT_FOUND` → 404 (`src/lib/errors/membership-errors.ts` の `ErrorStatusMap` と `MEMBERSHIP_ERROR_MESSAGES`)
- 家族の強制解散の `FAMILY_ALREADY_DISSOLVED` → 409・`FAMILY_NOT_FOUND` → 404 (同じ表。`supabase/migrations/20261026100000_operator_force_dissolve_family_missing.sql` から RPC が RAISE する。それより前は無い家族・解散済みの家族でも RPC が成功し、route が監査を書いて 200 を返していた)
- それ以外 → 500 `INTERNAL_ERROR` (RPC の文面は本文に入れない)
- 強制譲渡の 2 本は、譲渡先がすでに今の代表者 / オーナーなら 409 `ALREADY_REPRESENTATIVE` / `ALREADY_OWNER`「この人はすでに代表者です / オーナーです。一覧で今の状態を確かめてください」で止め、運営の監査 (`admin_audit_logs`) も通知メールも出さない (#2086 V1。`src/lib/membership/operator-force-transfer-result.ts`)。判定は 2 か所: RPC の前に読む今の代表者 / オーナー (一致すれば RPC を呼ばない。読めなければ止めずに RPC へ進む) と、RPC がロックの下で読んで返す旧代表者 / 旧オーナー (戻り値の `old_rep_id` / `old_owner_id`。一致すれば監査・通知の前に止め、warn のログに残す)。RPC の最新の定義 (`supabase/migrations/20261030120000_operator_force_transfer_reject_same.sql`。#2093 W5) は、行のロックの下で読んだ旧代表者 / 旧オーナーが譲渡先と同じなら、役割・`representative_id` / `owner_id`・`membership_audit` のどれも書かずに `ALREADY_REPRESENTATIVE` / `ALREADY_OWNER` (P0001) で止め、route はそれを同じ 409 に写す (warn のログに残す)。戻り値で一致を見る判定は、その migration を当てる前の DB (RPC が断らずに `membership_audit` に旧 = 新の行を 1 行書く) のために残す

---

## 8. 通知ロジック

強制操作実行 → server side で:
1. 影響メンバ全員の email を取得 (org: organization_members 全員、family: family_members 全員)
2. テンプレート 04-§7 の運営強制操作通知メールを Resend で並列送信
3. 失敗してもログ残しのみで成功扱い (操作自体は成功)
4. 通知の retry は別 cron (TODO: P7 後期で追加)

**transfer (譲渡) の注意: 旧オーナー / 旧代表者は RPC が行のロックの下で読んで返した値を使う (#1209・#1917)**

`operator_force_owner_transfer` / `operator_force_representative_transfer` は `owner_id` / `representative_id` を
新オーナーへ書き換えた後の行と、組織 / 家族の行を `FOR NO KEY UPDATE` でロックして読んだ旧オーナー / 旧代表者を jsonb で返す (`{"organization": 行, "old_owner_id": 旧オーナー}` / `{"family_group": 行, "old_rep_id": 旧代表者}`。membership_audit の `old_owner_id` / `old_rep_id` と同じ値。`supabase/migrations/20261023140000_operator_transfer_return_old_owner.sql`。#1917)。実行後に読み直す (または返った行の `owner_id` を使う) と「旧オーナー」が新オーナー自身になり、
本当の旧オーナーに「権限が移譲されました」通知が届かず、新オーナー宛の「旧オーナー」欄も自分のアドレスになる。RPC の前にロックの外で読んだ値は、運営 2 人がほぼ同時に同じ組織 / 家族を譲渡すると、この譲渡の直前のオーナー (先の譲渡の相手) と食い違う。
そのため route は戻り値の旧オーナー / 旧代表者と、返った行の scope 名で、監査 (`from_user_id`) と通知を出す。RPC の前に service-role で読む控えは、戻り値が古い形 (migration の前の DB) のときだけ使い、食い違いうることを構造化ログに残す
(dissolve が実行前にメンバーを取得するのと同じ考え方)。
旧オーナーが分からない場合 (戻り値が古い形で、控えも読めない) は誤った宛先・本文を送らないよう通知だけを省略し、構造化ログ (`app_logs`) に残す。操作自体は止めない。

**宛先のメールアドレスの引き方 (#1204)**

メールアドレスは `auth.users` にしか無い (`user_profiles` に email 列は無い)。`auth.admin.listUsers()` は page / perPage を
渡さないと先頭 50 件しか返さず、登録ユーザーが 50 人を超えると宛先が一覧に載らず、通知が例外もログもなく
スキップされていた。そのため、通知先の user_id だけを `src/lib/membership/resolve-auth-emails.ts` の
`resolveAuthEmails` で引く (`getUserById` を同時実行数の上限つきで呼ぶ。全体の登録人数に依存しない)。
取得できなかった人には送らず、件数と user_id を警告ログ (`app_logs`) に残す (メールアドレスはログに残さない)。
候補者一覧 (`candidates`) も同じ関数で email を引き、取得できなかった人は `email: null` で返す。

---

## 9. 24h 待機オプション (運用ベストプラクティス)

将来 (P7 以降) 追加する機能:
- 強制操作実行を「24h 待機」モードで予約
- 該当 owner に「運営側で操作予定」通知 → 24h 以内にログインがあれば自動キャンセル
- これは「実は生きていた」ケースの safeguard
- DB: `operator_pending_actions` テーブルを追加 (action, scope, scope_id, scheduled_at, status)

P0-P6 ではこのモードは実装しない (即時実行のみ)。
