# operator/ API 仕様

## 1. 目的・スコープ

運営管理ドメインの全 API エンドポイントの I/O 仕様を定義する。対象は `/api/admin/*`, `/api/super-admin/*`, `/api/support/*`, `/api/webhooks/stripe`, `/api/webhooks/resend`, `/api/cron/*`。

## 2. 関連要件

- 要件 03 §8 API 仕様
- cross/04-api-conventions.md (エラーコード体系・認証ヘルパー)

## 3. 共通仕様

### 3.1 認証

```typescript
import { requireRole } from '@/lib/auth/helpers';

// admin 画面
const user = await requireRole(['admin', 'super_admin']);

// super_admin 画面
const user = await requireRole(['super_admin']);

// support 画面
const user = await requireRole(['admin', 'super_admin', 'support']);

// finance 画面
const user = await requireRole(['admin', 'super_admin', 'finance']);

// sales 画面
const user = await requireRole(['admin', 'super_admin', 'sales']);
```

必須ロール (super_admin / admin / finance / org_industrial_doctor) の利用者には、`requireRole` が AAL2 (認証アプリの 6 桁を入れたセッション) を求める (`cross/12-operator-mfa.md` §13.1)。aal1 のセッションは `MfaRequiredError` (`ForbiddenError` の派生。code `AUTH_2FA_REQUIRED` / `AUTH_2FA_ENROLLMENT_REQUIRED`) で、route の既存の `catch (ForbiddenError)` が 403 を返す (cross/12 §19.3)。画面 (layout / page) は `requireRoleForPage` (`src/lib/auth/page-guard.ts`) を呼び、2FA が未完了なら MFA の画面へ回す (cross/12 §13.4)。

**`POST /api/super-admin/admins/{id}/mfa/reset`** (運営の別の人 (super_admin) による二段階認証の解除。cross/12 §14.7・§14.8.2・段 C #1707):
- 認可は `requireRole(['super_admin'])` (AAL2)。自分自身は 403 `OP_SELF_MODIFY`。本文 `{ reason, identity_check, identity_confirmed: true }` (`MfaResetBodySchema`。違えば 400 `OP_INVALID_INPUT`)。対象の `user_profiles` が無ければ 404 `NOT_FOUND`。
- 手順: 消す前の数 (factor の一覧・未使用のバックアップコードの数) を読む → 監査 `super_admin.mfa.reset` (critical。fail-closed) → 対象の全セッションを終える (service_role だけが呼べる SQL の関数 `operator_mfa_end_sessions`。cross/12 §11.5) → factor を消す → バックアップコードを消す → 200 `{ data: { user_id, factors_deleted, backup_codes_deleted } }`。
- 500 のときに済んでいること: 読み取りの失敗・監査の失敗は何もしていない (監査行も無い / 書けていない)。全セッションの終了の失敗は監査行だけが残り、何も消えていない (もう一度実行できる)。factor・コードの削除の失敗はセッションが終わった後で、消せたところまで変わっている (もう一度実行すれば残りを消せる)。

### 3.2 レスポンス形式

成功:
```json
{ "data": { ... }, "meta": { "total": 100, "page": 1, "per_page": 50 } }
```

エラー (例外: 本文の NULL 文字 (U+0000) で断る 400 `INVALID_CHARACTER` は、認証の前に `rejectNullCharacterBody` が flat の `{ "error": "<文>", "code": "INVALID_CHARACTER" }` で返す。`src/lib/api/reject-null-character.ts:32-35`):
```json
{ "error": { "code": "OP_PERMISSION_DENIED", "message": "...", "details": {} } }
```

### 3.3 監査ログ記録

**全破壊的操作に必須**:

```typescript
await supabase.from('admin_audit_logs').insert({
  actor_id: user.id,  // WITH CHECK で強制
  action_type: 'admin.user.ban',
  target_id: userId,
  target_type: 'user',
  details: { reason, ban_type, duration_days },
  severity: 'warn',
  ip_address: request.headers.get('x-forwarded-for'),
});
```

---

## 4. ユーザー管理 API

### GET /api/admin/users
ユーザー一覧・検索

**クエリパラメータ**:

| パラメータ | 型 | 説明 |
|----------|---|------|
| `q` | string | 全文検索 (email/name/user_id)。email の部分一致は `admin` / `super_admin` のみ (`support` は name/user_id のみ)。`%` `_` は文字どおりに一致する |
| `plan` | string | plan_key でフィルタ |
| `role` | string | ロールでフィルタ |
| `status` | `active\|banned\|deleted` | ステータス |
| `registered_from` | date | 登録日 FROM (JST の暦日。その日の JST 0 時以上。実在しない日付・受け付ける範囲 (0101-01-02〜9998-12-30) の外の日付は 400) |
| `registered_to` | date | 登録日 TO (JST の暦日。その日を含む = 翌日の JST 0 時未満。実在しない日付・受け付ける範囲 (0101-01-02〜9998-12-30) の外の日付は 400) |
| `last_login_before` | date | 最終ログイン日がこの日より前 (JST の暦日。その日の JST 0 時より前。未ログインは含まない。実在しない日付・受け付ける範囲 (0101-01-02〜9998-12-30) の外の日付は 400) |
| `sort` | string | `registered_at\|last_login\|meal_count` |
| `order` | `asc\|desc` | ソート方向 |
| `page` | int | ページ番号 (default: 1) |
| `per_page` | int | 件数 (default: 50, max: 200) |

**レスポンス**:
```json
{
  "data": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "display_name": "山田太郎",
      "plan_key": "pro",
      "roles": ["user"],
      "is_banned": false,
      "last_login_at": "2026-05-06T09:00:00Z",
      "registered_at": "2026-01-15T00:00:00Z",
      "meal_count": 342,
      "organization_id": null
    }
  ],
  "meta": { "total": 12450, "page": 1, "per_page": 50 }
}
```

**権限**: `admin`, `super_admin`, `support`

**email の扱い (#1145)**:
- `email` は `auth.users` のメールアドレス。見られるのは `admin` / `super_admin` のみ。`support` は一覧・詳細を見られるが `email` は常に `null` で、`q` によるメール検索も効かない (検索でメールの存在を推測させない)。`support` にも見せる場合は `EMAIL_VIEWER_ROLES` (`src/lib/admin/user-emails.ts`) に足す。
- 一覧は、その 1 ページに出た user_id のぶんだけを `admin_user_emails(p_ids)` (service_role 専用の RPC) で引く。`auth.admin.listUsers()` は先頭 50 件しか引けないため使わない (#1204)。
- `q` のメール検索は `admin_find_user_ids_by_email(p_q, p_limit)` (service_role 専用)。新しいアカウントから最大 100 件までが対象。
- メールを持たないユーザー (電話・匿名) や、取得に失敗したときは `email: null` (失敗はログに残り、API は 200 のまま)。応答は `Cache-Control: no-store`。

---

### GET /api/admin/users/{id}
ユーザー詳細 (`email` の扱いは上の「email の扱い」と同じ。`support` には `null`)

**レスポンス**:
```json
{
  "data": {
    "id": "uuid",
    "email": "user@example.com",
    "display_name": "山田太郎",
    "roles": ["user"],
    "plan_key": "pro",
    "organization_id": null,
    "family_group_ids": ["uuid"],
    "stats": {
      "meal_count": 342,
      "ai_session_count": 87,
      "health_checkup_count": 2,
      "last_meal_at": "2026-05-05T18:30:00Z"
    },
    "ban_history": [],
    "support_ticket_count": 3,
    "active_subscription": { "plan_key": "pro", "status": "active", "next_billing_at": "2026-06-01" }
  }
}
```

---

### PATCH /api/admin/users/{id}
管理ノート (admin note) の追加 (#1103)

**リクエスト**:
```json
{ "admin_note": "要注意ユーザー、規約違反1回目" }
```

**保存先**: `admin_user_notes` に 1 行追加する (`user_id` = 対象、`admin_id` = 操作者、`note` = 前後の空白を除いた `admin_note`)。`user_profiles` に列は持たない (本人の行は本人が全列読めるため、運営の内部メモを置かない)。

**バリデーション**: `admin_note` は前後の空白を除いて 1〜5000 文字。

**レスポンス**: `{ "data": { "success": true, "note_id": "uuid" } }`。対象ユーザーがいない (UUID でない id を含む) ときは 404 `NOT_FOUND`。

**監査ログ**: `admin.user.note_add` (details は `{ note_id }` だけ。本文は入れない)

**権限**: `admin`, `super_admin`

---

### POST /api/admin/users/{id}/ban
ユーザー BAN

**リクエスト**:
```json
{
  "ban_type": "temporary",
  "reason_category": "spam",
  "reason_detail": "大量スパム投稿を確認",
  "duration_days": 7,
  "notify_user": true,
  "notification_message": "規約違反により7日間の利用停止となりました。"
}
```

**バリデーション**:
- `ban_type`: `temporary` | `permanent`
- `reason_category`: `spam` | `abuse` | `policy_violation` | `other`
- `duration_days`: `temporary` の場合必須、1〜365
- super_admin のみ `permanent` BAN 可能

**レスポンス**: `200 { "data": { "ban_id": "uuid", "unban_at": "2026-05-13T00:00:00Z" } }`

**副作用**: `admin_audit_logs` INSERT (severity='warn')。実装は `POST /api/admin/users/{id}/freeze`。対象が super_admin なら 403 `OP_TARGET_PROTECTED`。凍結の UPDATE は読んだ時点の「super_admin でない」状態のままのときだけ書く条件つき (読んだ `roles` が NULL なら `roles IS NULL`、そうでなければ `roles` が `super_admin` を含まない。`src/lib/admin/user-ban.ts` の `SUPER_ADMIN_ROLES_LITERAL`。PostgREST の or は UPDATE で 42703 になるので使わない)。読んでから書くまでに変わっていたら 0 行 → 読み直して、無ければ 404 `NOT_FOUND`、あれば 409 `CONFLICT_STALE_DATA` (書かず、監査も残さない)。モデレーションの BAN (`applyUserBan`) も同じ条件で、0 行なら読み直して kind `not_found` / `super_admin` / `internal`

---

### POST /api/admin/users/{id}/unban
BAN 解除

**リクエスト**: `{ "reason": "誤検知と判断" }`

**権限**: `admin`, `super_admin`

---

### PATCH / PUT /api/admin/users/{id}/role
ロール付与・剥奪 (実装は `src/app/api/admin/users/[id]/role/route.ts`。PUT は PATCH と同じ (E2E 互換)。応答は `{ data: { success: true, roles } }`)

**リクエスト**:
```json
{
  "roles": ["admin", "support"],
  "reauth_token": "(任意。受け取るが検証しない)"
}
```

**バリデーション**:
- 呼べるのは `super_admin` だけ (`admin` は 403 `OP_PERMISSION_DENIED`)。自分自身のロールは変えられない (403 `OP_SELF_MODIFY`)。対象が無ければ 404 `NOT_FOUND`
- 付与可能ロール: `ALLOWED_ROLES` の 11 種 (`src/lib/admin/users-schemas.ts`)。1 つ以上
- 更新は RPC `admin_set_user_roles` (本人の client)。監査 `admin.user.role_change` の `previous_roles` は、RPC が対象の行をロックして読んだ変える前の roles (戻り値。#1917。operator/07 §4.1)。パスワードの再認証はしない

**権限**: `super_admin` だけ

---

### GET /api/admin/users/{id}/login-history
利用者のログイン履歴 (直近 20 回。#1720 段 D。canonical は `docs/design/cross/16-auth-history-sessions.md` §14.9)

**権限**: `admin`, `super_admin` (`support` は 403)

**レスポンス** (各行は `LoginHistoryEntrySchema` (cross/16 §12.5)。created_at の降順。`ended_at` は `revoked_at`):
```json
{
  "data": {
    "entries": [
      {
        "session_id": "uuid",
        "created_at": "2026-10-15T01:00:00+00:00",
        "last_active_at": "2026-10-15T02:00:00+00:00",
        "device_label": "iPhone・iPad の Safari",
        "device_name": null,
        "ip_address": "203.0.113.7",
        "country_code": "JP",
        "ended_at": null,
        "ended_reason": null,
        "is_new_device": false,
        "is_new_ip": false,
        "is_new_country": false,
        "alert_sent_at": null
      }
    ]
  }
}
```

- 行は service_role で読む。1 件以上返したときだけ `admin.user.view_login_history` を監査に 1 行 (details: `returned_count`。0 件は記録しない)
- UUID でない id は 404 `NOT_FOUND`。401 / 403 は `{ error: { code, message } }` (`AUTH_UNAUTHENTICATED` / `OP_PERMISSION_DENIED`)。`Cache-Control: private, no-store`

---

### GET /api/admin/users/{id}/audit-logs
ユーザーへの操作履歴

**クエリ**: `?page=1&per_page=50&from=2026-01-01`

**権限**: `super_admin`

---

### POST /api/admin/users/{id}/notes
管理ノート追加

**リクエスト**: `{ "body": "サポート対応履歴..." }`

---

### GET /api/super-admin/users/{id}/manual-plan
手動のプラン付与の節の表示の内容 (今の契約・付与できるプラン・付与の履歴 10 件)。設計: `billing/02-manual-plan-grant.md` §9.1

**権限**: `super_admin` のみ (AAL2)。個人情報を返さないので監査は書かない

**レスポンス 200**: `{ "data": { "current": { subscription_id, plan_key, status, source: "stripe" | "manual", starts_at, expires_at } | null, "plans": [{ plan_key, display_name, plan_type, max_members }], "history": [{ id, action_type, actor_id, created_at, plan_key, expires_at, reason }] } }`

**エラー**: 401 `AUTH_UNAUTHENTICATED` / 403 `OP_PERMISSION_DENIED` / 404 `NOT_FOUND` (UUID の形でない・利用者がいない)

---

### POST /api/super-admin/users/{id}/manual-plan
運営者による手動のプラン付与。Stripe は呼ばない。設計: `billing/02-manual-plan-grant.md` §9.2

**権限**: `super_admin` のみ (AAL2)。自分自身は 403 `OP_SELF_MODIFY` (本文の検証より前)

**リクエスト**: `{ "plan_key": "pro", "expires_on": "2026-12-31" | null, "reason": "..." }` (`expires_on` は JST の暦日で今日より後。省略 / null = 期限なし。`reason` は 1〜500 文字)

**レスポンス 200**: `{ "data": { subscription_id, user_id, plan_key, status: "active", expires_at } }`

**エラー**: 400 `OP_INVALID_INPUT` / `INVALID_CHARACTER`・401・403 `OP_PERMISSION_DENIED` / `OP_SELF_MODIFY`・404 `NOT_FOUND`・409 `OP_SUBSCRIPTION_ALREADY_ACTIVE` (live な契約がある)・422 `OP_PLAN_NOT_GRANTABLE`

**監査**: `admin.billing.manual_grant` (warn。details: subscription_id / plan_key / expires_at / reason)

---

### DELETE /api/super-admin/users/{id}/manual-plan
手動付与の取り消し (行を `cancelled` に)。設計: `billing/02-manual-plan-grant.md` §9.3

**権限**: `super_admin` のみ (AAL2)。自分自身は 403 `OP_SELF_MODIFY`

**リクエスト**: `{ "reason": "..." }` (1〜500 文字)

**レスポンス 200**: `{ "data": { subscription_id, user_id, plan_key, status_from, status_to: "cancelled" } }`

**エラー**: 400 `OP_INVALID_INPUT` / `INVALID_CHARACTER`・401・403 `OP_PERMISSION_DENIED` / `OP_SELF_MODIFY`・404 `NOT_FOUND`・409 `OP_NO_MANUAL_SUBSCRIPTION` (手動で付与した live な契約が無い)

**監査**: `admin.billing.manual_revoke` (warn。details: subscription_id / plan_key / reason)

---

### POST /api/admin/users/{id}/impersonate — 提供しない (#1124)
なりすまし (impersonate)。**提供しない** (オーナー判断 2026-10-08)。旧設計の `POST /api/super-admin/impersonate/{userId}` も作らない。

以前は `super_admin` にだけ、トークンを発行する API があった。ただしトークンは `admin_audit_logs.details` に平文で書かれるだけで、
受け取って使う側がどこにも無かったため、API ごと削除した (呼ぶと 404)。サポートは、読み取り専用のユーザー画面
(`GET /api/admin/users/{id}` を使う `/admin/users/{id}` と、サポートコンソール) で対応する。詳細は `cross/01-auth-session.md` §11。

---

### GET /api/admin/organizations
組織の一覧 (運営)。実装は `src/app/api/admin/organizations/route.ts:36-107`

**クエリパラメータ**: `q` (組織名の部分一致)・`plan` (`ORG_PLAN_VALUES` のどれか。`src/lib/org-plans.ts:22`)・`page` (default: 1)・`per_page` (default: 30, max: 100)。不正なら 400 `VALIDATION_ERROR` (:60-65)

**レスポンス**: `{ "organizations": [{ "id", "name", "plan", "created_at", "updated_at" }], "meta": { "total", "page", "per_page" } }` (新しい順)。件数より後ろのページ (PostgREST の 416 / PGRST103) は、同じ絞り込みで件数だけを数え直して、空の一覧と本当の件数 (`meta.total`) を 200 で返す (画面は件数から最後のページへ取り直す。:80-89・:279-297)。それ以外の読み出しの失敗・想定外の例外と、件数を数え直せないときは 500 `INTERNAL_ERROR` (空の一覧にしない。:91-96・:102-106・:299-305)

**権限**: `admin`, `super_admin` (未ログインは 401 `AUTH_UNAUTHENTICATED` :43・ほかの利用者は 403 `OP_PERMISSION_DENIED` :49)

---

### POST /api/admin/organizations
組織の作成 (運営)。実装は `src/app/api/admin/organizations/route.ts:109-242`

**リクエスト**:
```json
{ "name": "株式会社〇〇", "plan": "standard", "owner_id": "uuid" }
```
- `name`: 1〜200 文字 (必須)
- `plan`: `ORG_PLAN_VALUES` (`standard` / `premium` / `enterprise`) のどれか。省略すると `ORG_PLAN_DEFAULT` (`standard`)
- `owner_id`: 省略すると呼び出した運営をオーナーにする (作る組織は active なので `organizations.owner_id` は NOT NULL)

**処理**: service_role (`getSupabaseAdmin`) で、organizations の行・`org_license_pools` の行 (`total_licenses` = NULL・`used_licenses` = 0。失敗してもログだけで続ける)・オーナーの `user_profiles` (`organization_id` と `org_role = 'owner'`) を書く。オーナーにする人が退会の途中 (退会の本体が findBlocker の前に付ける退会の印が新しい) なら、organizations の行の INSERT を DB のトリガー `trg_organizations_owner_not_deleting` (関数 `organizations_owner_not_deleting()`) が止め、何も書かずに 409 `OWNER_ACCOUNT_DELETING` を返す (#1917 の続き。退会の最後の `deleteUser` が `organizations_owner_id_fkey` (RESTRICT) で失敗しないように。退会が `deleteUser` の前に止まると (409・途中の失敗)、退会の本体が返す前に印を消すので、そのあとは作れる。`20261024120000`)

**レスポンス**: `{ "organization": { "id", "name", "plan", "owner_id", "created_at", "updated_at" } }`

**監査ログ**: `admin.organization.create` (details は `{ name, plan }`。operator/07 §4.1)

**エラー**:

| ステータス | コード | 場合 (route.ts の行) |
|---|---|---|
| 400 | `VALIDATION_ERROR` / `INVALID_JSON` / `INVALID_CHARACTER` | 本文が JSON でない (:136-139)・Zod の検査に通らない (:144-147)・本文に NULL 文字がある (:111-112) |
| 401 | `AUTH_UNAUTHENTICATED` | 未ログイン (:119) |
| 403 | `OP_PERMISSION_DENIED` | `admin` / `super_admin` でない (:125) |
| 409 | `OWNER_ALREADY_IN_ORG` / `OWNER_ACCOUNT_DELETING` | オーナーにする人がすでに別の組織に所属している (:167-170) / オーナーにする人が退会の手続き中 (退会の印 `account_deletion_guards` があり、DB のトリガー `trg_organizations_owner_not_deleting` (関数 `organizations_owner_not_deleting()`) が組織の行の INSERT を止めた。`supabase/migrations/20261023130000_account_deletion_owner_guard.sql`。:182-187。文は「指定した owner は退会の手続き中です」。#1917 の続き) |
| 500 | `INTERNAL_ERROR` | 組織の行の作成 (:189-192)・オーナーの `user_profiles` の更新 (:222-225) に失敗 |

**権限**: `admin`, `super_admin`

---

### PATCH /api/admin/organizations/{id}
組織のプラン (`organizations.plan`) の変更 (運営)。実装は `src/app/api/admin/organizations/[id]/route.ts`。組織のプランの段階は運営だけが変える (#1912。組織の管理者の `PUT /api/org/settings` は `plan` を受け取らず、`authenticated` / `anon` の `plan` の変更は DB のトリガー `guard_organizations_plan_value` が `ORG_PLAN_OPERATOR_ONLY` (42501) で拒む。`20261022170000_org_plan_operator_only.sql`)

**リクエスト**:
```json
{ "plan": "premium" }
```
- 本文は `plan` だけ (`ORG_PLAN_VALUES` のどれか。ほかのキーは 400。`.strict()` :46-50)

**処理**:
- service_role (`getSupabaseAdmin`) で書く (運営の JWT も `authenticated` なので、利用者の client ではトリガーに止められる)
- 書く前に今の行を読み (:107-111)、送られたプランが今と同じなら書かず、記録もしない (200 で今の行を返す :129-131)
- 更新は「直前に読んだ `plan` のままなら書く」条件つきの UPDATE (:135-144。読んだ値が NULL なら `.is('plan', null)`)。0 行なら読み直し (:156-160)、今の値が送られたプランと同じなら書かず記録もしない (200 :175-177)、違えば 409 `CONFLICT_STALE_DATA` (:178。cross/04 §4.2)

**レスポンス**: `{ "organization": { "id", "name", "plan", "created_at", "updated_at" } }`

**監査ログ**: `admin.organization.plan_change` (details は `{ from, to }` = 変える前と後のプラン。severity `warn`。今と同じプランなら記録しない。operator/07 §4.1)

**エラー**:

| ステータス | コード | 場合 (route.ts の行) |
|---|---|---|
| 400 | `VALIDATION_ERROR` / `INVALID_JSON` / `INVALID_CHARACTER` | `{id}` が UUID でない (:80)・本文が JSON でない (:91)・Zod の検査に通らない (:99)・本文に NULL 文字がある (:56-57) |
| 401 | `AUTH_UNAUTHENTICATED` | 未ログイン (:64) |
| 403 | `OP_PERMISSION_DENIED` | `admin` / `super_admin` でない (:70) |
| 404 | `NOT_FOUND` | 組織が無い (:123)・読み直したときに組織が無い (:170) |
| 409 | `CONFLICT_STALE_DATA` | 読んでから書くまでに別の運営が別のプランへ変えた (:40・:178) |
| 500 | `INTERNAL_ERROR` | 読み出し (:117)・更新 (:149)・読み直し (:164) に失敗 |

**権限**: `admin`, `super_admin`

---

## 5. モデレーション API

### GET /api/admin/moderation/{type}
モデレーション対象一覧

`type`: `food` | `recipe` | `ai_content`

> **現状 (2026-10, #1128・#1911)**: `ai_content` (AI コンテンツ) の審査は**できない (未対応)**。バックエンドのテーブルが無いため、
> `ai_content` を指定した一覧 (`/queue?type=ai_content`)・個別取得・解決 (`PUT` / `POST` `/{type}/{id}`) は
> 空や 404 ではなく **501 `OP_NOT_SUPPORTED`** を返す。画面 (`/admin/moderation`) の絞り込みに `ai_content` の選択肢は出さず
> (#1911: 未完成の機能は画面に出さない)、URL で `ai_content` を指定されたときは種類を絞らない一覧として扱う。
> 集約 API `GET /api/admin/moderation` の `aiFlags` は空配列のままで、`aiFlagsSupported: false` を添える
> (空は「通報 0 件」ではなく「未対応」の意味。配布済みの古いモバイルアプリの運営画面 (リポジトリからは #1389 で削除済み) が
> `...(res.aiFlags ?? [])` と配列として展開するため、形は変えない)。

**クエリ**: `?status=pending&page=1&per_page=30`

**レスポンス**:
```json
{
  "data": [
    {
      "id": "uuid",
      "type": "food",
      "content_url": "https://storage.../meal-photos/xxx.jpg",
      "reporter_count": 3,
      "user_id": "uuid",
      "hidden_at": null,
      "created_at": "2026-05-06T10:00:00Z"
    }
  ]
}
```

`hidden_at`: 通報されたコンテンツが運営に隠されている (#1101) ときの日時 (ISO)。隠れていない・コンテンツが無いときは `null` (#1538)。`GET /api/admin/moderation/queue` と `GET /api/admin/moderation/{type}/{id}` の応答にも同じ項目がある。

---

### PUT /api/admin/moderation/{type}/{id}
モデレーション解決

**リクエスト**:
```json
{
  "action": "delete_and_temp_ban",
  "ban_duration_days": 7,
  "resolution_note": "明らかな規約違反画像"
}
```

`action`: `approve` | `delete_only` | `delete_and_warn` | `delete_and_temp_ban` | `delete_and_perm_ban` | `escalate`

**`delete_*` の意味 (#1101)**: `delete_only` / `delete_and_warn` / `delete_and_temp_ban` / `delete_and_perm_ban` は、通報されたコンテンツ
(食事 `meals` / レシピ `recipes`) の行を**消さずに隠す**。`hidden_at` / `hidden_by` / `hidden_reason` を書き、RLS により本人以外
(家族・ほかのユーザー・未ログイン) には見えなくなる (本人には見える)。完全な削除は、保管期間のあとに別のジョブで行う。
保管期間は 90 日 (オーナーの選択 2026-10-15、#1538)。隠してから 90 日を過ぎた行と画像は、pg_cron のジョブ `purge-hidden-content`
(毎日 03:25 JST) が Edge Function `purge-hidden-content` を呼んで完全に消す (08-cron-batches.md §3.0)。

**完全削除で消えるもの・残るもの (#1538)**:
- 行は `DELETE` で消す。関連の行は外部キーの `ON DELETE` のとおりに動く (退会 #1175 で食事・レシピが消えるときと同じ):
  通報 (`moderation_flags.meal_id` / `recipe_flags.recipe_id`) は CASCADE でコンテンツと一緒に消える (誰が通報したかも消える)。
  食事の AI の評価・栄養の推定・レシピのコレクションの項目・コメント・いいねも CASCADE で消える。
  献立の実績 (`planned_meals.actual_meal_id`)・レシピの依頼 (`recipe_requests.base_meal_id`) は SET NULL で行が残る
- 通報は残さない: 外部キーを変えると、持ち主の削除・退会でコンテンツが消えたときの動きまで変わる。運営の判断の記録は
  監査ログ (`admin_audit_logs`。通報の ID・コンテンツの持ち主・コンテンツの ID・隠した行の ID。07-audit-monitoring.md の 7 年保管) に残る
- 画像は、行の持ち主のフォルダにあるもので、ほかの行 (隠していない行・まだ 90 日たっていない隠した行・献立・健診など) が使っていないものだけを
  Storage API で消す (DB の関数 `hidden_content_purge_referenced_needles` で確かめる)。他人のフォルダの画像・持ち主の無い行の画像は消さない
- 退会と矛盾しない: 持ち主が退会すると、隠した食事は退会の CASCADE で先に消える (画像は退会の Storage の掃除が消す)。
  公開のまま隠したレシピは退会で `user_id` が外れて残り (隠したままなので誰にも見えない)、90 日後に完全削除のジョブが行を消す

- 実行の順番は「コンテンツを隠す → 判定の保存 → BAN」。隠せなかったときは判定を保存せず (通報は `pending` のまま)、BAN もせずに
  `500 OP_CONTENT_HIDE_FAILED` を返す。通報が審査待ちのまま残るので、画面を開き直しても審査のフォームから同じ操作をやり直せる
  (判定を先に保存すると、隠せなかった通報が審査済みになって一覧からもフォームからも消え、違反コンテンツが見えたまま残る)
- 隠したあとで判定の保存に失敗したときも、BAN をせず `500 INTERNAL_ERROR` を返す (通報は `pending` のまま)。隠すのは冪等
  (すでに隠れている行は上書きしない。保管期間の起点も延びない) なので、同じ操作をやり直せばよい
- 通報にコンテンツが紐づかない (レスポンスの `content_id` が null。持ち主が先に消した等) ときは、隠す対象が無いので隠さずに続行する
- `approve` / `escalate` は何も隠さない。隠した行を元に戻すのは `POST /api/admin/moderation/{type}/{id}/restore` (隠してから 89 日以内。`operator/13-hidden-content-restore.md`)
- 食事は、家族へのペースト (`paste_meal_to_family`) で作られた複製 (同じ `paste_group_id` の行) のうち、中身 (`photo_url` と `memo`) が
  通報された行と同じもの (NULL どうしも同じとみなす) もまとめて隠す。ペーストのあとで持ち主が中身を書き換えた行は隠さない
  (違反していない他人の行を、通報の結果として隠さない)。複製の持ち主には自分の行として見えたまま、ほかの人には見えなくなる。
  隠した食事 (複製を含む) はペーストの元にできない (`403 MEAL_HIDDEN`)
- `meals.paste_group_id` は、ログインユーザー・anon が書き換えられない (トリガー `guard_meal_paste_group_id`。書けるのは
  `paste_meal_to_family` と service_role だけ)。他人の行を自分のまとまりに入れる・まとまりから外す、はできない
- 監査ログ (`admin_audit_logs.details`) に `content_id` (隠す対象) と `hidden` (隠したか)、この操作で新しく隠した行の ID の一覧 `hidden_ids`、
  隠せなかったときは `hide_error`、判定を保存したか `status_saved` (保存できなかった理由は `status_error`) を記録する。
  隠す対象の行があったかを `content_found` に記録する (#1445。隠す操作をして行の有無が分かったときだけ true / false、それ以外は null)。
  行がもう無い (持ち主が先に消した) ときは `hidden: false` / `content_found: false`。すでに隠れていた行は `hidden: true` / `content_found: true`
  で、`hidden_ids` は空
  隠せなかったとき・隠したあとで判定を保存できなかったときも、監査ログ (severity `warn`) を残す
- 画像ファイルそのものは隠さない。バケットは非公開 (#1365 段 2) で、保存された URL は本人の署名付き URL でしか読めない (隠す前に見た人が署名付き URL を持っていても、期限 + 1 時間で使えなくなる)。保管期間 (90 日) を過ぎたら、完全削除のジョブが画像も消す (上記)
- `hidden_reason` は持ち主も読める列なので、解決メモ (`resolution_note`) は入れず、`moderation:<action>` の識別子を書く

### POST /api/admin/moderation/{type}/{id}/restore
運営が隠したコンテンツを戻す (#1538 の項目 4)。`{id}` は通報 (`moderation_flags` / `recipe_flags`) の id。権限は `PUT` と同じ (admin / super_admin / content_moderator)。

**リクエスト**:
```json
{ "restore_note": "申し立てを確認。規約違反ではなかった" }
```
`restore_note` は必須 (前後の空白を除いて 1〜5000 字)。

- 戻せるのは、隠されていて (`hidden_at` が入っている)、隠してから 89 日以内で、行がある場合だけ。行が無い (持ち主が消した・完全削除された) → 410 `OP_CONTENT_GONE`、隠れていない → 409 `OP_CONTENT_NOT_HIDDEN`、89 日を過ぎた → 409 `OP_CONTENT_RESTORE_WINDOW_EXPIRED`
- `hidden_at` / `hidden_by` / `hidden_reason` を NULL に戻す。食事は、同じ操作で隠した複製と、あとから同じ中身のまま隠れた複製をまとめて戻す (`operator/13-hidden-content-restore.md` §6.3)。レシピはその行だけ
- 戻す行を指す `rejected` の通報を `approved` にする (`pending` / `escalated` / `approved` は触らない)。順は「通報 → 行」。通報の更新に失敗したら 500 `INTERNAL_ERROR`、通報の更新のあとで行の更新に失敗したら 500 `OP_CONTENT_RESTORE_FAILED` (行は隠れたまま。同じ操作をやり直せる)。読んでから書くまでに状態が変わったときは 409 / 410 (別の時刻で隠し直されていたときは 409 `CONFLICT_STALE_DATA`)
- 応答: `{ "data": { "success": true, "content_hidden": false, "restored_ids": ["uuid"], "approved_flag_ids": ["uuid"] } }`
- 監査ログ `admin.moderation.restore` (07-audit-monitoring.md §4.1)。BAN には触れない (解除は `DELETE /api/admin/users/{id}/freeze`)
- 正本は `operator/13-hidden-content-restore.md` §8

---

### POST /api/admin/moderation/auto-rules
自動モデレーションルール作成

**権限**: `super_admin`

---

## 6. 監査ログ API

### GET /api/admin/audit-logs
監査ログ一覧

**クエリ**:

| パラメータ | 説明 |
|----------|------|
| `actor_id` | 操作者 ID |
| `target_id` | 対象 ID |
| `action_type` | アクション種別 |
| `severity` | `info\|warn\|critical` |
| `from` | 期間 FROM |
| `to` | 期間 TO |
| `page`, `per_page` | ページネーション |

**権限**: `super_admin` のみ

---

### POST /api/admin/audit-logs/export
監査ログ CSV エクスポート

**リクエスト**: `{ "from": "2026-01-01", "to": "2026-05-06", "format": "csv" }`

**レスポンス**: `{ "data": { "export_id": "uuid", "status": "processing" } }`

**副作用**: `admin_audit_logs` に `admin.export.request` を記録

---

## 7. 機能フラグ API

> 実装のパスは `/api/super-admin/flags` (一覧・作成) と `/api/super-admin/flags/{key}` (更新・削除) で、更新は PATCH。
> この章は以前 `/api/super-admin/feature-flags` (更新は PUT) と書かれていたが、そのパスの route は存在しない。
> Web の運営画面 (`src/app/super-admin/flags`)・結合テスト・E2E・モバイルの機能フラグ画面は、すべて `/flags` を使う (#1137)。
> エラー本文は他の運営 API と同じ `{ "error": { "code": "...", "message": "..." } }`。
>
> 機能フラグの置き場は `feature_flags` テーブルの 1 つに一本化した (#1148)。以前、献立生成のエンジン切り替えだけは
> `system_settings` の `feature_flags` 行を読んでいた (一般ユーザーには RLS で読めず、いつも既定値だった)。今は
> アプリのどこでも `src/lib/feature-flags.ts` の `isFeatureEnabled(key, userId)` で判定する。
> `system_settings` の `feature_flags` 行はもう何も読まない。運営のシステム設定 (`GET / PUT /api/super-admin/settings`) では
> 読み取り専用で、GET は `read_only: true` と `note` を付け、PUT は 409 `SETTING_READ_ONLY` で断る (#1457。行は消していない)。
> GET の各行は `key` / `value` / `description` / `updated_at` (DB の列の名前のまま) と `read_only` / `note`。PUT は `description` を
> 省略でき、送れば保存する (空の文字列は `null`。#1486)。
>
> アプリが読んでいるフラグ (`FEATURE_FLAG_DEFAULTS`)。行が無い・読み出しに失敗したときは「止めない側」の既定値で動く:
>
> | key | 用途 | 既定値 (行が無い・読めない) |
> |-----|------|------------------------------|
> | `menu_generation_v5_wrapped` | 献立生成 (週間・1 日・1 食・AI 相談のアクション) のエンジン。ON で v5、OFF で v4 | ON |
> | `menu_generation_v5_direct` | 汎用の献立生成 API (`/api/ai/menu/v4/generate`) のエンジン | ON |
> | `ai_chat_enabled` | AI 相談の緊急停止スイッチ。OFF のとき AI を呼ぶ API (`/api/ai/consultation/**` の POST) と、利用者の JWT で直接呼ばれた Edge Function `knowledge-gpt` が 503 + やさしい文面。通常は ON のまま | ON |
> | `maintenance_mode` | ON のとき、ミドルウェアが admin / super_admin 以外にメンテナンス中の画面 (API は 503 `MAINTENANCE_MODE`) を出す。切り替えは運営画面 `/super-admin/flags` | OFF |
>
> フラグの値はサーバーのメモリに最大 30 秒覚えるため、PATCH で切り替えてから全員に反映されるまで最大 30 秒かかる
> (下の PATCH の「即座に」は、この遅れを除いた意味)。proxy (`src/proxy.ts`。#1744 で middleware から改名し、Node.js の runtime で動く) と API route は、メモリを共有するとは限らない。

### GET /api/super-admin/flags
フラグ一覧

`active_user_count` は、そのフラグが今 ON になっているユーザーの数。アプリの判定 (`evaluateFlag`) を全ユーザーの
`user_profiles` に対して実行して数える (OFF は 0、全員が対象で条件の無いフラグはユーザー総数)。
ユーザーが 20,000 人 (既定。環境変数 `FEATURE_FLAG_ACTIVE_USER_SCAN_LIMIT` で変えられる) を超えるときは、1 人ずつ判定が要るフラグ (段階公開・条件つき) だけ `null`。
全員が対象で条件の無いフラグは、上限を超えても総数を返す (件数だけを数えるため)。
集計に失敗したときは、すべてのフラグが `null` (一覧そのものは返す)。

**レスポンス**:
```json
{
  "data": [
    {
      "key": "new_meal_ai_v2",
      "description": "新しい食事 AI V2",
      "enabled": true,
      "rollout_strategy": { "type": "percentage", "value": 25 },
      "constraints": { "min_user_age_days": 7, "exclude_plans": ["free"] },
      "active_user_count": 3200,
      "updated_at": "2026-05-06T00:00:00Z"
    }
  ],
  "meta": { "total": 1, "page": 1, "per_page": 1 }
}
```

---

### PATCH /api/super-admin/flags/{key}
フラグ更新 (送った項目だけを更新する。ON/OFF の切り替えは `{ "enabled": true }` だけでよい)

**リクエスト**:
```json
{
  "enabled": true,
  "rollout_strategy": { "type": "percentage", "value": 50 },
  "constraints": {}
}
```

**レスポンス**: `{ "data": { "key": "...", "description": "...", "enabled": true, "rollout_strategy": {}, "constraints": {}, "updated_at": "..." } }`
(存在しないキーは 404 `OP_FEATURE_FLAG_NOT_FOUND`)

**副作用**: 全ユーザーへ反映 (サーバーのメモリの更新で最大 30 秒)、監査ログ記録

---

### POST /api/super-admin/flags
フラグ新規作成 (キーが重複すると 409 `OP_FEATURE_FLAG_IN_USE`)

### DELETE /api/super-admin/flags/{key}
フラグ削除 (利用中の場合は `OP_FEATURE_FLAG_IN_USE` で 409)

### GET /api/feature-flags
画面が前もって「AI 相談は使えるか」「メンテナンス中か」を知るための窓口。認証は不要 (未ログインでも答える。メンテナンス中かどうかは、ログイン前の画面でも要る)。

いま、この API を呼んでいる画面 (Web・モバイル) は無い (#1457)。画面は前もって確かめず、止められたときの 503 の応答の code
(`AI_CHAT_DISABLED` / `MAINTENANCE_MODE`) で緊急停止中・メンテナンス中を知り、本文の文字列ではなく固定の文を出す
(文と code の置き場は `packages/shared/src/service-unavailable.ts`。Web は `src/lib/ai/ai-chat-unavailable.ts`、モバイルは
`apps/mobile/src/lib/service-unavailable.ts`)。フラグはサーバーのメモリに最大 30 秒覚えるので、前もって確かめても送る時点の判定とずれることがあり、
503 の扱いはどのみち要る。この API は、画面で前もって知らせたくなったときの窓口として残してある。

返すのは、画面に見せてよいフラグだけの許可リスト (`CLIENT_FEATURE_FLAG_KEYS`: `ai_chat_enabled` / `maintenance_mode`)。
運営が作った別のフラグの名前は返さない。値は、ログイン中のユーザーにとっての ON/OFF (段階公開があれば、そのユーザーでの判定)。
運営 (admin / super_admin) には、メンテナンス中でも `maintenance_mode: false` を返す (運営はメンテナンス中も使えるため)。
メンテナンス中でも、この API は止まらない。`Cache-Control: private, no-store`。

**レスポンス**: `{ "data": { "flags": { "ai_chat_enabled": true, "maintenance_mode": false } } }`

### メンテナンスモード (`maintenance_mode` が ON のとき)
ミドルウェア (`lib/supabase/middleware.ts`) が、admin / super_admin 以外に次を返す。
- ページ: 503 の HTML (「ただいまメンテナンス中です」。`Retry-After: 300`。ログイン画面へは回さない)
- API: 503 `{ "error": "<固定の文>", "code": "MAINTENANCE_MODE", "retryAfter": 300 }` (`Retry-After: 300`)。
  AI 相談の緊急停止の 503 と同じ平らな形。`error` は文字列で、本文の `error` をそのまま出す画面でも固定の文になる (#1486。
  それより前は `{ "error": { "code": "MAINTENANCE_MODE", "message": "..." } }` の入れ子で、Web の画面が描画で落ちた)。
  文と code の置き場は `packages/shared/src/service-unavailable.ts` (読む側の `serviceUnavailableMessageOfBody` は以前の入れ子の形も受ける)

止めないもの: 運営ロール、`/login`・`/auth/*` (運営がログインし直せるように)、`/terms`・`/privacy`、
`/legal` (特定商取引法に基づく表記)・`/contact` (お問い合わせ) の画面 (#1486。未ログインでも読める公開の文面。
その画面の下の API は止める: お問い合わせの送信 `POST /api/contact` は 503 で、画面には固定の文が出る。画面に出ているメールアドレスは使える)、
`/api/health` (死活監視)、`/api/auth/*`、`/api/cron/*`、`/api/feature-flags`、`/_next/*`、
Resend の Webhook の受け口 `POST /api/webhooks/resend` (#1577 の 4。cron と同じ機械からの呼び出しで、止めると長いメンテナンスのあいだに
知らせを失うか、Svix が宛先を無効にする恐れがあるため。完全一致の 1 本だけで、`/api/webhooks/stripe` などほかの Webhook は 503。
`src/lib/maintenance-mode.ts` の `RESEND_WEBHOOK_API_PATH`。§21 の `POST /api/webhooks/resend`)、
通知のトークンの claim `POST /api/push-tokens/claim` (#1636。端末の後片付けで、利用者の操作ではないため。完全一致の 1 本だけで、
セッション無しの後片付け `POST /api/push-tokens/release` は止める。`src/lib/push-tokens.ts` の `isPushTokenClaimApiPath`。
`mobile/03-push-notification.md` §3.2)。
`/signup` (新規登録) は止める。
`/legal`・`/contact` を通すのはメンテナンスの判定だけで、ほかの差し戻し (初期設定の途中の人を `/onboarding/*` へ、凍結中の人を
`/frozen` へ。凍結中でも `/contact` は通る) はメンテナンス中でないときと同じに掛かり、差し戻した先はメンテナンス中の画面になる。
画像・manifest・robots・サービスワーカーなどの静的ファイルは、ミドルウェアの `matcher` (`src/proxy.ts`) が外していて、そもそもミドルウェアが走らない。
拡張子で通す処理は持たないので、動的なページのパスは、末尾が `.json` や `.txt` に見えても (`/meals/abc.json` など) 止める。
フラグを読めない・行が無いときは止めない (OFF 扱い)。

### AI 相談の緊急停止 (`ai_chat_enabled` が OFF のとき)
`POST /api/ai/consultation/sessions`・`/sessions/{id}/messages`・`/sessions/{id}/summarize`・`/sessions/{id}/close`・
`/actions/{id}/execute` が 503 `{ "error": "<やさしい文面>", "code": "AI_CHAT_DISABLED", "retryAfter": 60 }` を返す。
利用者の JWT で直接呼べる Edge Function `knowledge-gpt` (#1153) も、JWT の経路で認証の直後・同意の判定の前にスイッチを見て、
OFF なら同じ 503 を返す (#1486。`supabase/functions/_shared/ai-chat-flag.ts`。判定は Next.js と共用で、段階公開・条件も同じに効く。
読めない・行が無いときは ON)。service role の経路 (AI 相談の API が呼ぶもの) は、呼び出し元がスイッチを見たあとなので見ない。
過去の相談の閲覧 (GET)・提案の却下 (DELETE)・重要マークは止めない。通常は ON のままにする非常ボタン。
利用者の同意の有無で AI への送信を止めるのはこのスイッチではなく、同意の判定 (`requireAiConsent` / `checkUserAiConsent`、#1154) が担う
(スイッチが ON でも、未同意なら AI へ送らない)。

---

## 8. LLM 使用量 API

### GET /api/super-admin/llm/usage
LLM 使用量ダッシュボード (super_admin のみ)

**クエリ**: `?period=7d&model=grok-4-fast&function=knowledge-gpt&provider=xai`
(`period` は `1d` / `7d` / `30d` / `custom`。既定は `7d`。`from` / `to` は JST の暦日 `YYYY-MM-DD`。`provider` は `gemini` / `xai` / `anthropic` / `openai`)

**レスポンス**:
```json
{
  "data": {
    "total_cost_usd": 1234.56,
    "total_cost_jpy": 187653,
    "total_requests": 52000,
    "total_tokens": 14000000,
    "by_model": [
      { "model": "grok-4-fast", "provider": "xai", "requests": 45000, "tokens": 12000000, "cost_usd": 800 }
    ],
    "by_function": [
      { "function": "knowledge-gpt", "requests": 30000, "cost_usd": 600 }
    ],
    "top_users": [
      { "user_id": "uuid", "email": null, "requests": 1200, "cost_usd": 50, "is_anomaly": false }
    ],
    "timeseries": [
      { "date": "2026-05-06", "cost_usd": 180, "requests": 7400 }
    ],
    "anomalies": [],
    "period": { "from": "2026-04-30", "to": "2026-05-06" }
  }
}
```

> **現状 (2026-10, #1498)**: 実装のパスは `GET /api/super-admin/llm/usage` (super_admin のみ)。集計は DB の関数 `llm_usage_summary`
> (migration `20261011110000_llm_usage_summary.sql`。service_role だけが実行できる) が `llm_usage_logs` の全行を DB の中で集計し、
> 1 つの JSONB で返す (行を API で読まないので、PostgREST の `max_rows` で打ち切られない)。集計するのは LLM 呼び出しごとの行
> (`is_summary = false`) だけ。日次の系列 (`timeseries`) は JST の暦日。`top_users` は呼び出し回数の多い順に 50 人。
> `anomalies` は、JST の 1 日に 5,000 回を超えて呼んだ日があるユーザー全員 (`top_users` に入らない人も含む。operator/03-ui-spec.md の異常アラート)。
> `anomalies` の各要素は `top_users` と同じ形 (`user_id` / `email` / `requests` / `cost_usd` / `is_anomaly`)。`email` は常に `null` (結合しない)。
> `total_cost_jpy` は `total_cost_usd` × 152 (概算) を四捨五入したもの。応答の型は `src/lib/super-admin/llm-usage-summary.ts` の `LlmUsageResponseData` (画面も同じ型を使う。#1524)。

---

### GET /api/super-admin/llm-usage/users/{id}
ユーザー別 LLM 使用量詳細

> **現状 (2026-10, #1524)**: このパスは実装に無い (`/api/super-admin/llm/usage/users/{id}` も無い)。ユーザー別の数字は、
> `GET /api/super-admin/llm/usage` の `top_users` (呼び出し回数の多い順に 50 人) と `anomalies` だけで返す。

---

### POST /api/super-admin/llm-usage/quota-update
クォータ更新

> **現状 (2026-10, #1149)**: プランごとの AI の 1 日の上限 (全機能の合計・JST の暦日) は、`/api/super-admin/llm/quotas` で読み書きする
> (見出しの `POST /api/super-admin/llm-usage/quota-update` というパスは無い)。保存先は DB の `ai_daily_limits` で、保存した値は次の AI の利用の判定 (`consume_ai_usage`) から効く
> (詳細は operator/06-ai-llm.md §5)。super_admin のみ。
>   - `GET`: プランごとの行 (`subscription_plans` と `ai_daily_limits` を合わせたもの)・`default_plan_key` (`free`)・`enforced: true`・`note`。
>     組織のプランの値 (`organizations.plan` に書ける `standard` / `premium` / `enterprise`。`src/lib/org-plans.ts` の `ORG_PLAN_VALUES`) の行も出す
>     (`plan_source: 'org_plan'`・表示名「<値>（組織のプラン）」。#1912)。どちらにも無いキーの行は `plan_source: 'unknown'` で、画面は保存させない。
>     `subscription_plans` の組織のプランの行 (`plan_type = 'org'` の `org_starter` / `org_standard` / `org_pro` / `org_enterprise`) も一覧に出すが、
>     その値は判定に使われない (組織の利用者の上限は `organizations.plan` の値の行で決まる。`get_effective_plan` がその値を返す) ので、画面は保存させない (#1912)
>   - `PATCH`: 1 つのプランの上限を保存する。保存すると監査ログ `super_admin.llm_quota.update` を残す
>   - 上限に達した AI の呼び出しは 429 `AI_DAILY_LIMIT` (§23)
>   - 利用者ごとの上限と月次の上限は無い。上限に数えない機能の安全弁 (`ai_unmetered_daily_caps`) は DB の行で変える (API・画面は無い)
> AI プロバイダーへ送る前の同意の判定は `requireAiConsent` / `checkUserAiConsent` (`src/lib/ai/consent-guard.ts`、#1154) が担い、同意が無ければ送らない。

**リクエスト** (`PATCH /api/super-admin/llm/quotas`):
```json
{
  "plan_key": "free",
  "daily_limit": 10,
  "reason": "1 日の上限の見直し"
}
```
- `plan_key`: `subscription_plans` にあるプラン、または組織のプランの値 (`ORG_PLAN_VALUES`。行が無ければ作る。#1912)。どちらでもなければ 404 `PLAN_NOT_FOUND`。
  `subscription_plans` の組織のプランの行 (`plan_type = 'org'` で、`ORG_PLAN_VALUES` でないキー = `org_*`) は 409 `PLAN_READ_ONLY` で断る
  (保存しない・監査ログを残さない。判定の `src/lib/super-admin/ai-daily-limits.ts` の `isOrgSubscriptionPlanRow`。#1912)。`ORG_PLAN_VALUES` の行は保存できる
- `daily_limit`: 0 以上 10,000 以下の整数。`null` は無制限
- `reason`: 変更の理由 (監査ログに残す)
- 同時の保存: 監査ログの `before` は保存の前に読んだ値なので、保存は「読んだ値のままなら書く」条件つきにする (行があれば読んだ `daily_limit` のままのときだけ更新、無ければ作るだけ = 同じキーの行が先にできていたら何もしない)。
  0 行なら読み直し、今の値が送られた値と同じなら 200 (書かず、監査ログも残さない)、違えば 409 `CONFLICT_STALE_DATA` (cross/04 §4.2)。`before` は書いた時点の実際の直前の値と必ず一致する。画面 (`/super-admin/llm/quotas`) は 409 `CONFLICT_STALE_DATA` を受けたら一覧を読み直していまの上限を出し、行に画面の文を出す (書きかけの行は残す。#1917)

---

## 9. 売上・経理 API

> **現状 (2026-10, #1125)**: Stripe の Webhook の受け口と契約の写しは billing/01 (`docs/design/billing/01-billing-core.md`) で入った。
> 収益の日次スナップショットなどの集計バッチと、請求書・収益推移・Stripe 整合チェックの画面の実データ化は配線の冊で作る。
> それまで画面 (`/admin/finance/invoices` `/revenue` `/reconciliation`) は出さない: URL で開かれたら 404 にし、
> 売上・経理のクイックリンクにも並べない。売上ダッシュボードの MRR / ARR / Churn Rate / LTV / 契約数のカードも出さない
> (#1911: 未完成の機能は画面に出さない。「準備中」とも出さない。MAU は `daily_active_users` の実データなのでそのまま出す)。API は残してある。

### GET /api/admin/finance/dashboard
売上ダッシュボード

**レスポンス**:
```json
{
  "data": {
    "current_mrr_jpy": 4580000,
    "current_arr_jpy": 54960000,
    "churn_rate": 2.3,
    "ltv_jpy": 18500,
    "new_mrr_jpy": 280000,
    "expansion_mrr_jpy": 45000,
    "contraction_mrr_jpy": 12000,
    "churned_mrr_jpy": 35000
  }
}
```

**権限**: `admin`, `super_admin`, `finance`

---

### GET /api/admin/finance/mrr
MRR 時系列

**クエリ**: `?from=2025-01-01&to=2026-05-01&granularity=month`

---

### GET /api/admin/finance/cohorts
コホート分析

**クエリ**: `?cohort_by=registered_month&retention_months=12`

---

### POST /api/admin/finance/invoices/generate
請求書一括生成

**リクエスト**: `{ "billing_period": "2026-04", "org_ids": ["uuid1", "uuid2"] }`

**レスポンス**: `{ "data": { "job_id": "uuid", "invoice_count": 45, "status": "processing" } }`

**権限**: `finance`, `admin`, `super_admin`

---

### GET /api/admin/finance/invoices
請求書一覧

### POST /api/admin/finance/invoices/{id}/resend
請求書再送

### POST /api/admin/finance/refunds
返金の記録 (監査ログ) と Stripe ダッシュボードへの誘導 (#1185)

このアプリは返金を実行しない。担当者が Stripe ダッシュボードで返金する前に、この API で
`admin_audit_logs` に `admin.refund.issue` (severity=`warn`) を記録する。**記録できたときだけ**
Stripe ダッシュボードのリンクを返す。記録できなかったときは 500 を返し、リンクは返さない。

**リクエスト**:
```json
{
  "user_id": "uuid",
  "stripe_invoice_id": "in_xxx",
  "amount": 1200,
  "currency": "JPY",
  "reason": "二重に請求されたため"
}
```

- `stripe_invoice_id` (`in_...`) と `stripe_charge_id` (`ch_...` / `py_...`) は**どちらか一方だけ**を指定する
- `amount` は通貨の最小単位の整数 (JPY は円そのもの、USD はセント)。1 〜 99,999,999
- `currency` は ISO 4217 の 3 文字。省略時は `JPY`。大文字にそろえて保存する
- `reason` は必須。前後の空白を除いて 1 〜 500 文字

**レスポンス**:
```json
{ "data": { "stripe_dashboard_url": "https://dashboard.stripe.com/invoices/in_xxx" } }
```
決済 (`stripe_charge_id`) の場合は `.../payments/ch_xxx`。開発環境ではテストモード (`/test`) のリンクになる。

**監査ログ**: `action_type=admin.refund.issue` / `target_type=user` / `target_id=user_id` / `severity=warn` /
`details={ amount, currency, reason, stripe_charge_id, stripe_invoice_id }` (使わない側の ID は `null`) / `ip_address` / `user_agent`

**権限**: `finance`, `admin`, `super_admin`

**エラー**: `400 VALIDATION_ERROR` (入力不正) / `401 AUTH_UNAUTHENTICATED` / `403 OP_PERMISSION_DENIED` / `500 INTERNAL_ERROR` (監査ログに記録できなかった)

2 名承認 (`finance.refund.approve`) と `charge.refunded` Webhook との突き合わせは Stripe 連携 (#1125) 側で後続。

---

## 10. サポート API

### GET /api/support/tickets
チケット一覧

**クエリ**: `?status=open&priority=high&assignee_id=uuid&page=1`

**権限**: `support`, `admin`, `super_admin`

---

### POST /api/support/tickets
チケット作成 (ユーザー側から)

**リクエスト**:
```json
{
  "subject": "ログインできません",
  "category": "account",
  "body": "昨日からログインできなくなりました。",
  "priority": "high"
}
```

---

### GET /api/support/tickets/{id}
チケット詳細 (メッセージ一覧含む)

---

### POST /api/support/tickets/{id}/messages
メッセージ追加

**リクエスト**:
```json
{
  "body": "ご不便をおかけしております。パスワードリセットをお試しください。",
  "is_internal": false,
  "attachments": []
}
```

**レスポンス** (201): `{ "data": { ...メッセージ }, "email": { "status": "sent" } }`

- `body` は前後の空白 (全角スペース・改行・タブを含む) を除いて 1 文字以上であること。空白だけの本文は 400 (`VALIDATION_ERROR`) で、保存もメールもしない。保存される本文も前後の空白を除いたもの。
- 顧客向けメッセージ (`is_internal=false`) は、チケットの顧客本人へメールで知らせる (顧客がチケットを閲覧できる画面は無く、このメールが唯一の通知経路)。内部メモ (`is_internal=true`) はメールにせず、`email` も含めない。
- `email.status` は `sent` (送信待ちに受け付けた。送るのは worker) / `skipped` (メール送信の設定が無く未送信) / `failed` (宛先を取得できない、または送信待ちに登録できない・宛先停止リスト・文面の不備)。登録したあとの送信の失敗は `email` に出ず、届けられなければ dead の通知と `/super-admin/email-outbox` で運営が扱う (`10-logs-and-mail-retry.md` §6.6・§7.2)。`sent` 以外は `email.reason` (`not_configured` / `no_recipient` / `send_failed`) も返す。
- メールが送れなくてもメッセージは保存済みなので、ステータスは 201 のまま。失敗は `app_logs` に記録する。
- 宛先は `auth.admin.getUserById(ticket.user_id)` で取得し、`sendEmail` で送信待ち (`email_outbox`・`template = 'support_ticket_reply'`) に登録する (`email_delivery_logs` には書かない。#1193)。返信先は環境変数 `SUPPORT_REPLY_TO` (任意)。

---

### PATCH /api/support/tickets/{id}
ステータス・担当者変更

**リクエスト**: `{ "status": "resolved", "assignee_id": "uuid" }`

---

### GET /api/admin/inquiries
問い合わせ (`/api/contact` が `inquiries` に保存したもの。チケットとは別物) の一覧 (#1121)

**クエリ**: `?status=pending|in_progress|resolved|closed&limit=1〜100(既定50)&page=1〜(既定1)`
(`limit` / `page` は `clampIntParam` で丸める。`status` が上の 4 値以外なら 400)

**レスポンス**: `{ "inquiries": [InquirySummary], "total": 120, "page": 1, "limit": 50 }`
(新しい順。範囲外のページは `inquiries: []` / `total: null`。DB の読み込みに失敗したときは空配列ではなく 500)

> 既存の Web (`/support/inquiries`) とモバイルの問い合わせ画面がこの形 (camelCase、`{ data, meta }` ではない) で読むため、
> この API だけは §3.2 の標準形ではなく画面側の形に合わせている。

一覧は **概要だけ** を返す。問い合わせ本文 (`message`) と管理者メモ (`adminNotes`) は詳細でだけ返し、詳細を返すときに閲覧を監査ログへ記録する (#1200)。

```json
{
  "id": "uuid", "userId": "uuid|null", "userName": "ニックネーム|null",
  "inquiryType": "general|support|bug|feature", "email": "...", "subject": "...",
  "status": "pending|in_progress|resolved|closed",
  "createdAt": "...", "updatedAt": "...", "resolvedAt": "...|null"
}
```

`userName` は `user_profiles.nickname` (RLS では本人の行しか読めないため、`requireRole` 通過後に service_role で解決)。
ゲストの問い合わせ、または解決できなかったときは `null` で、画面は `email` を表示する。

**権限**: `support`, `admin`, `super_admin` (未ログインは 401、それ以外のロールと凍結中は 403)

---

### GET /api/admin/inquiries/{id}
問い合わせ詳細。レスポンスは `{ "inquiry": InquiryDetail }` (= InquirySummary + `message` + `adminNotes`)。
`id` が UUID でなければ 400、無ければ 404、DB の読み込みに失敗したときは 500 (404 にしない)。

返すたびに `admin.inquiry.view` を `admin_audit_logs` へ記録する (記録のルールは 07-audit-monitoring.md §4.1.1)。

---

### PATCH /api/admin/inquiries/{id} (PUT も同じ処理)
ステータス・管理者メモの更新。Web は PUT、モバイルは PATCH で同じボディを送る。

**リクエスト**: `{ "status": "resolved", "adminNotes": "回答済み" }` (どちらか一方だけでもよい。両方無いと 400。メモは空文字か `null` で消える。最大 5000 文字)

- `resolved_at` は API が決める: `resolved` / `closed` になるとき現在時刻 (解決済みから `closed` へは最初の時刻を保つ)、`pending` / `in_progress` に戻すと `null`
- 書き込む列は `status` / `admin_notes` / `resolved_at` だけ。本文・メールアドレス・問い合わせ者などがボディに入っていても無視する。変更が無いときは書き込まない (`updated_at` を動かさない)
- レスポンスは更新後の `{ "inquiry": InquiryDetail }`
- 更新後の問い合わせ (本文を含む) を返すので、変更が無い更新を含めて毎回 `admin.inquiry.update` を記録する
- 同時の更新: 書くときは「直前に読んだ `status` と `updated_at` のままなら書く」条件つきにする (`updated_at` は UPDATE のたびにトリガーで進む。`NULL` なら `.is` で比べる)。
  0 行なら読み直し、送った項目 (`status` / 正規化した `adminNotes`) がどれも今の値と同じなら 200 で今の行を返し (書かない。本文を返すので `changed: false` として記録する)、
  違えば 409 `CONFLICT_STALE_DATA` (書かず、記録もしない)。監査の `status_from` と `resolved_at` の元にした値は、書いた時点の実際の直前の値と必ず一致し、
  読んでから書くまでの間に別の運営が書いた管理者メモを上書きしない (条件は API が読んだ値で、画面を開いてから保存するまでの変更は見分けない)。読み直しの失敗は 500、行が消えていれば 404。Web の画面 (`/support/inquiries`) は 409 `CONFLICT_STALE_DATA` を受けたら一覧と開いている問い合わせの詳細を読み直し、画面の文 (読み込み直した旨) を出す。管理者メモの入力欄は、書きかけ (開いた・読み直した・保存したときのメモから変えている) なら読み直しで消さず、保存されているメモと違えば入力欄の下に出す。書きかけでなければ入力欄を読み直したメモにする (開いたときの古いメモを次の更新で送り、別の運営が書いたメモを上書きしないため。#1917。`src/app/(support)/support/inquiries/page.tsx`)

エラーコードは `VALIDATION_ERROR` / `INVALID_JSON` (400)、`AUTH_UNAUTHENTICATED` (401)、`OP_PERMISSION_DENIED` (403)、`NOT_FOUND` (404)、`CONFLICT_STALE_DATA` (409)、`INTERNAL_ERROR` (500)。

---

### GET /api/admin/data-requests
個人情報の請求 (開示・訂正・利用停止・消去。`data_subject_requests`) の一覧 (#1178 / #1702)。中身は `docs/design/cross/15-data-subject-requests.md` §7.4 を canonical とする。

**クエリ**: `?status=&request_type=&overdue=1&page=&per_page=` (`page` / `per_page` は `clampIntParam` で丸める。`overdue=1` は受付済み・対応中で応答期限を過ぎたもの)

**レスポンス**: §3.2 の `{ "data": [DsrAdminSummary], "meta": { "total", "page", "per_page" } }`。並びは応答期限の昇順 (期限の無いものは最後)。範囲外のページは空のページ (`total: null`)。一覧は概要だけで、請求の内容・本人への応答・内部メモは詳細でだけ返す。1 件以上返したときに `admin.dsr.list` を記録する (07-audit-monitoring.md §4.1.1)。

**権限**: `admin`, `super_admin` (未ログインは 401、それ以外のロールは 403 `OP_PERMISSION_DENIED`)

---

### GET /api/admin/data-requests/{id}
個人情報の請求の詳細。レスポンスは `{ "data": DsrAdminDetail }` (概要 + 内容・本人への応答・内部メモ・請求者のニックネームとメールアドレス。退会済みなら請求者は `null`)。`id` が UUID でなければ 400、無ければ 404。返すたびに `admin.dsr.view` を記録する。中身は cross/15 §7.4 を canonical とする。

**権限**: `admin`, `super_admin`

---

### PATCH /api/admin/data-requests/{id}
個人情報の請求の対応 (状態・本人への応答・内部メモの更新)。中身は cross/15 §7.4・§8.3 (状態遷移表) を canonical とする。

**ヘッダ**: `If-Unmodified-Since` (GET が返した `updated_at` の文字列をそのまま。HTTP-date ではない)

**リクエスト**: `{ "status": "in_progress|fulfilled|rejected", "response_note": "...", "admin_notes": "..." }` (どれか 1 つ以上)

**レスポンス**: 更新後の `{ "data": DsrAdminDetail }`。200 のたびに `admin.dsr.update` を記録する (変更が無くても)。

エラーコードは `INVALID_CHARACTER` / `INVALID_JSON` / `VALIDATION_ERROR` (400)、`AUTH_UNAUTHENTICATED` (401)、`OP_PERMISSION_DENIED` (403)、`NOT_FOUND` (404)、`DSR_INVALID_TRANSITION` / `CONFLICT_STALE_DATA` (409)、`CONFLICT_OPTIMISTIC_LOCK` (412)、`DSR_RESPONSE_NOTE_REQUIRED` (422)、`CONFLICT_PRECONDITION_REQUIRED` (428)、`INTERNAL_ERROR` (500)。

**権限**: `admin`, `super_admin`

---

## 11. 通知配信 API

### GET /api/admin/notifications/campaigns
キャンペーン一覧

**権限**: `admin`, `super_admin`

---

### POST /api/admin/notifications/campaigns
キャンペーン作成

**リクエスト**:
```json
{
  "name": "5月キャンペーン",
  "channel": "push",
  "target_filter": {
    "plan_keys": ["free"],
    "last_login_before_days": 14
  },
  "variants": [
    {
      "key": "A",
      "title": "久しぶりですね！",
      "body": "今日の食事を記録してみましょう",
      "deep_link": "homegohan://meals/new"
    }
  ],
  "scheduled_at": "2026-05-10T09:00:00+09:00"
}
```

---

### POST /api/admin/notifications/campaigns/{id}/send
キャンペーン配信実行

**権限**: `admin`, `super_admin`

---

### GET /api/admin/notifications/campaigns/{id}/stats
配信統計

**レスポンス**:
```json
{
  "data": {
    "total_recipients": 15000,
    "sent_count": 14987,
    "open_count": 4500,
    "click_count": 890,
    "open_rate": 30.0,
    "click_rate": 5.9
  }
}
```

---

## 12. 不正検知 API

### GET /api/super-admin/abuse/rules
ルール一覧

### POST /api/super-admin/abuse/rules
ルール作成

**リクエスト**:
```json
{
  "name": "BOT 大量登録",
  "rule_type": "multi_account",
  "threshold": { "ip_accounts_per_10min": 10 },
  "action_type": "perm_ban",
  "action_config": { "auto_execute": true }
}
```

**権限**: `super_admin`

---

### PATCH /api/super-admin/abuse/rules/{id}
ルール更新 (有効化/無効化含む)

### GET /api/super-admin/abuse/detections
検知一覧

**クエリ**: `?review_status=auto&page=1`

---

### POST /api/super-admin/abuse/detections/{id}/review
手動レビュー

**リクエスト**: `{ "review_status": "false_positive", "note": "テストユーザーの誤検知" }`

---

## 13. インフラ監視 API

> **現状 (2026-10, #1180)**: `infra_metrics` / `infra_alerts` に書き込む処理 (監視データの収集) が**無い**ため、
> `/api/super-admin/infra/metrics` と `/alerts` は常に空を返す。画面は、空を「問題なし」と見せず
> 「未接続: 監視データの収集は設定されていません」と表示し、Vercel / Supabase のダッシュボードへのリンクを出す。
> `/alerts` の応答にあった `external_sources` (SENTRY_DSN / BETTER_STACK_TOKEN の有無) は、どちらもコードで使われておらず
> 接続状態を表さないため廃止した。

### GET /api/super-admin/infra/dashboard
統合監視ダッシュボード

**レスポンス**:
```json
{
  "data": {
    "vercel": { "error_rate": 0.01, "p95_ms": 320, "deploy_status": "healthy" },
    "supabase": { "db_connections": 45, "p95_query_ms": 28, "edge_fn_status": "healthy" },
    "llm_apis": {
      "xai": { "p95_ms": 450, "error_rate": 0.002 },
      "gemini": { "p95_ms": 380, "error_rate": 0.001 }
    },
    "cache_hit_rate": 0.82,
    "active_incidents": 0
  }
}
```

**権限**: `super_admin`

---

### GET /api/super-admin/infra/metrics
メトリクス時系列

**クエリ**: `?metric=vercel_error_rate&from=2026-05-01&to=2026-05-06`

---

### GET /api/super-admin/infra/alerts
アラート一覧

### POST /api/super-admin/infra/alerts/{id}/acknowledge
アラート確認

### GET /api/super-admin/email-outbox
メールの送信待ち (`email_outbox`) の一覧 (送信待ち / 送信済み / 届けられなかったもの。宛先はマスクし、件名・本文は返さない。#1193・#1708)。

super_admin だけ。I/O・エラー・監査は `10-logs-and-mail-retry.md` §9.2・§10・§11

### POST /api/super-admin/email-outbox/{id}/requeue
届けられなかったメール (dead) を送信待ちに戻す (再送。#1193・#1708)。

super_admin だけ。I/O・エラー・監査は `10-logs-and-mail-retry.md` §9.2・§10・§11

### GET /api/super-admin/backups
DB バックアップの取得の状態と DR 訓練の記録の読み取り (層ごとの最新・鮮度・取得と訓練の一覧。#1129・#1191)。

super_admin だけ。I/O・エラー・監査は `cross/17-backup-automation.md` §7.1 を canonical とする (行は action_type だけで信じず、書いた経路の印で絞る)

### POST /api/super-admin/backups/dr-tests
DR 訓練の結果を `dr.test.<種類>` で記録 (#1191)。

super_admin だけ。I/O・エラー・監査は `cross/17-backup-automation.md` §7.2 を canonical とする (本文は同 §5.3 の `drTestRecordBodySchema`。記録できなければ 500 を返し、201 は返さない)

---

## 14. 営業 CRM API

### GET /api/admin/sales/leads
見込み客一覧

**クエリ**: `?stage=meeting&assigned_to=uuid&page=1`

**権限**: `sales`, `admin`, `super_admin`

---

### POST /api/admin/sales/leads
見込み客作成

**リクエスト**:
```json
{
  "company_name": "株式会社テスト",
  "industry": "manufacturing",
  "employee_count": 500,
  "contact_name": "佐藤部長",
  "contact_email": "sato@test.co.jp",
  "source": "referral",
  "estimated_acv": 1200000
}
```

---

### PATCH /api/admin/sales/leads/{id}
リード更新 (ステージ変更含む)

- ステージを変えると、活動履歴 (`sales_lead_activities`) に `stage_change` (`details: { from_stage, to_stage }`) を残す (この書き込みに失敗しても、リードは更新できているので 200 のまま (監査ログと同じ fail-open)。失敗は db-logger に error で残す。#1917)
- 同時の更新: 本文に `stage` があるときは「直前に読んだ `stage` のままなら書く」条件つきにする。0 行なら読み直し、リードがあれば 409 `CONFLICT_STALE_DATA`
  (書かず、活動履歴も監査ログも残さない)、無ければ 404。`from_stage` は書いた時点の実際の直前のステージと必ず一致する。`stage` が無い更新には条件を付けず、更新が 0 行 (読んでから書くまでにリードが消えた) なら 404 (`src/app/api/admin/sales/leads/[id]/route.ts:228-231`)
- 読み込み・更新・読み直しの DB の失敗は 500 `INTERNAL_ERROR` (404 にしない)。UUID の形でない id は DB に渡さず 404 `NOT_FOUND` (本文の検査の 400 のあと。uuid 型の列に渡すと 22P02 で「DB の失敗」に入るため。#1917)。詳細の `GET /api/admin/sales/leads/{id}` も同じで、リード・活動履歴の読み込みの DB の失敗は 500 (404 は行が無いとき (UUID の形でない id を含む) だけ。活動履歴の読み込みの失敗を空の履歴にしない。#1917)

---

### GET / POST /api/admin/sales/leads/{id}/activities
`GET` は活動履歴の一覧 (`{ data: [{ id, lead_id, actor_id, activity_type, details, created_at }] }`。新しい順。権限は `sales` / `admin` / `super_admin`。UUID の形でない id は DB に渡さず 404 `NOT_FOUND`、読み込みの DB の失敗は 500 `INTERNAL_ERROR`。監査ログは残さない。`src/app/api/admin/sales/leads/[id]/activities/route.ts:53-95`)。`POST` は活動記録追加。リードの読み込みの DB の失敗は 500 `INTERNAL_ERROR` (404 は行が無いとき (UUID の形でない id を含む。DB に渡さず、本文の検査の 400 のあとに 404) だけ)。追加のあとのリードの `updated_at` の更新に失敗しても、活動は追加できているので 201 のまま (失敗は db-logger に error で残す。#1917)

**リクエスト**:
```json
{
  "activity_type": "meeting",
  "details": {
    "date": "2026-05-08",
    "participants": ["田中部長", "鈴木GM"],
    "summary": "デモ実施、次回提案書提出予定",
    "next_action": "提案書を5/15までに送付"
  }
}
```

---

### POST /api/admin/sales/leads/{id}/proposal-pdf
提案書 PDF 生成

**レスポンス**: `{ "data": { "pdf_url": "https://storage.../proposals/xxx.pdf" } }`

---

## 15. A/B テスト API

### GET /api/super-admin/experiments
実験一覧

**権限**: `super_admin`

---

### POST /api/super-admin/experiments
実験作成

**リクエスト**:
```json
{
  "key": "new_chat_ui_2026_05",
  "name": "新チャット UI テスト",
  "hypothesis": "新 UI でメッセージ送信率 +20%",
  "variants": [
    { "key": "control", "weight": 50 },
    { "key": "new_ui", "weight": 50 }
  ],
  "primary_metric": "message_send_rate",
  "start_date": "2026-05-10",
  "end_date": "2026-05-24"
}
```

---

### PATCH /api/super-admin/experiments/{id}
実験更新 (start/stop/cancel)

### GET /api/super-admin/experiments/{id}/results
実験結果 (p値、信頼区間、サブグループ分析)

---

## 16. データエクスポート API

> **現状 (2026-10, #1126・#1911)**: データエクスポートは**使えない (未対応)**。ファイルを作る処理 (cron / worker) と専用の
> `exports` テーブルが無いため、`/api/super-admin/exports` と `/exports/{id}` は全メソッドが 501 `OP_NOT_SUPPORTED` を返し、
> DB には触れない。画面 (`/super-admin/exports`, `/new`) は出さない: サイドバーに並べず、URL で開かれたら 404 にする
> (#1911: 未完成の機能は画面に出さない。「準備中」とも出さない)。依頼フォームは無い。
> 以前は、利用者本人の GDPR 削除要求の表 (`gdpr_deletion_requests`) を代用していたが、これは本人の削除要求を
> 取り消す事故につながるため止めた。実装するときは、専用テーブルを先に用意すること。

### POST /api/super-admin/exports
エクスポートリクエスト

**リクエスト**:
```json
{
  "export_type": "user_data",
  "format": "csv",
  "filters": { "registered_from": "2026-01-01", "plan_key": "pro" },
  "mask_pii": true
}
```

**権限**: `super_admin`

---

### GET /api/super-admin/exports/{id}
エクスポートステータス確認

### GET /api/super-admin/exports/{id}/download
エクスポートファイルダウンロード (署名付き URL を返す)

---

## 17. プラン定義 API

### GET /api/super-admin/plans
プラン一覧

**クエリ**: `?type=org&status=public`

**権限**: `super_admin`

---

### POST /api/super-admin/plans
プラン新規作成 (draft で作成)

**リクエスト**:
```json
{
  "plan_key": "org_pro_2027",
  "display_name": "Org Pro 2027",
  "plan_type": "org",
  "monthly_price_jpy": 2200,
  "yearly_price_jpy": 22000,
  "max_members": 500,
  "trial_days": 0,
  "feature_package_ids": ["uuid1", "uuid2"]
}
```

**バリデーション** (`src/lib/super-admin/plans-schemas.ts` の `PlanCreateSchema`): `plan_key` の形を `plan_type` に揃える (#1912)。`personal` / `family` は組織のプランの値 (`isOrgPlanKey` = `standard` / `premium` / `enterprise`・`org_` で始まる key) を使えず、`org` は `org_` で始まる key にする。食い違いは 400 `OP_INVALID_INPUT` (利用者の画面の表示名 `planDisplayName` は key の形だけで「組織のプラン」/「有料プラン」を決めるため)。`PATCH /api/super-admin/plans/{id}` は `plan_key` / `plan_type` を受けない (送っても行は変わらない)

---

### GET /api/super-admin/plans/{id}
プラン詳細

### PATCH /api/super-admin/plans/{id}
プラン編集 (draft のみ自由編集、public 以降は価格変更 API 経由)。同時の変更: 遷移の可否・status ごとに変えてよい項目・廃止の `ends_at` の要否は直前に読んだ `status` (と `ends_at`) で決め、更新はその `status` のまま (廃止で既存の `ends_at` に頼るときは `ends_at` が NULL でないことも) のときだけ書く条件つき。0 行なら読み直し、送った変更がもう入っていれば 200 (書かず記録もしない)、入っていなければ 409 `CONFLICT_STALE_DATA`、行が無ければ 404 `OP_PLAN_NOT_FOUND` (cross/04 §4.2)。廃止の `ends_at` の要否は書いた後の値で決める (本文の `ends_at: null` は既存の値があっても 400 `OP_PLAN_DEPRECATE_ENDS_AT_REQUIRED`)。監査 `update_plan` は `status` を変えたときだけ `status_from` / `status_to` を持ち、`status_from` は書いた時点の実際の直前の値。削除 (`DELETE /api/super-admin/plans/{id}`。draft のみ・それ以外は 422 `OP_PLAN_NOT_DRAFT`) も `status = 'draft'` のままのときだけ消し、0 行なら読み直して、無ければ 404 `OP_PLAN_NOT_FOUND`、あれば 409 `CONFLICT_STALE_DATA` (どちらも記録しない)

**廃止の安全弁** (`status: 'deprecated'` への遷移。#1127・#1912。実装 `src/lib/super-admin/plan-subscribers.ts` の `countPlanSubscribers`): 廃止の前に、契約が終わっていない契約者を service_role で数え、1 件でもいれば 409 `OP_PLAN_HAS_SUBSCRIBERS` で止める (数えられなかったときは 500 `OP_PLAN_SUBSCRIBER_CHECK_FAILED`)。

| 内訳 (`error.counts` のキー) | 数える行 | 組織のプランの行 (`plan_type = 'org'` の `org_*`) |
|---|---|---|
| `personal_subscriptions` | `plan_key` が一致し、status が trialing / active / paused / past_due / grace | 数える |
| `family_groups` | `plan_key` が一致し、status = active | 数える |
| `organizations` | `plan` が `plan_key` と一致し、status = active | **数えない** (キーを出さない。0 件として判定にも入れない) |

- 組織のプランの行 (`isOrgSubscriptionPlanRow`: `plan_type = 'org'` かつ `plan_key` が組織の段階 (`ORG_PLAN_VALUES` = standard / premium / enterprise) でない行) は、組織の段階とは無関係で、組織の利用者の判定 (`get_effective_plan` は `organizations.plan` を使う) に使われない。`organizations.plan` が `org_*` と一致することは無く、数えると常に 0 件になって「組織の契約者は 0 件だから廃止してよい」と読めてしまうため、組織の件数は数えない (#1912。オーナーの選択 (2026-10-22・選択式)「org_* は数えないと明記 (推奨)」)
- この行の 409 は `error.counts` に `organizations` を入れず、`error.organizations_note` に注記 (`ORG_SUBSCRIPTION_PLAN_ROW_NOTE`) を返す。`error.message` にも同じ注記を入れ、組織の件数は書かない。個人・家族のプランの数え方・判定・応答は変えない (`organizations` を数え、`organizations_note` は返さない)

---

### POST /api/super-admin/plans/{id}/publish
`draft` → `public` 公開

**バリデーション**: `plan_key` が 9 種公式リストに含まれるか、または super_admin が意図的に追加したものか確認

---

### POST /api/super-admin/plans/{id}/unpublish
`public` → `private`

---

### POST /api/super-admin/plans/{id}/deprecate
廃止

**リクエスト**:
```json
{
  "superseded_by_plan_id": "uuid",
  "ends_at": "2026-08-31T23:59:59Z",
  "migration_message": "このプランは2026年9月1日に終了します。新プランへの移行をお願いします。"
}
```

**副作用**:
- 関連 `org_license_pools.auto_renew = FALSE` に強制更新
- `admin_audit_logs` に severity='critical' で記録
- 90/30/7 日前通知ジョブをキュー投入

---

### POST /api/super-admin/plans/{id}/un-deprecate
deprecated → private にロールバック (緊急用)

**権限**: `super_admin` のみ

**副作用**:
- `org_license_pools.auto_renew_was_force_disabled_at IS NOT NULL` のレコードを `auto_renew = TRUE` に復元
- 影響組織管理者へ通知
- 監査ログに severity='critical'

---

### POST /api/super-admin/plans/{id}/price-change
価格変更 (新規契約のみに適用。#1102)

**リクエスト**:
```json
{
  "new_monthly_price_jpy": 1180,
  "new_yearly_price_jpy": 11800,
  "applies_to": "new_only",
  "reason": "物価上昇に伴うインフレ調整",
  "effective_at": "2026-06-01T00:00:00Z"
}
```

- `new_monthly_price_jpy` / `new_yearly_price_jpy`: 変える方だけを指定する (どちらか一方、または両方)。両方指定しても 1 回のリクエストで Stripe へ同期できる。
- `applies_to`: `new_only` だけ (省略時も `new_only`)。`on_renewal` / `immediately` は 400 `OP_INVALID_INPUT` (オーナー判断 2026-10-08: 価格変更は新規契約だけに適用し、既存の契約者の請求額は変えない)。

**処理フロー**:
1. 入力の検証 (`applies_to` が `new_only` 以外なら 400。DB にも Stripe にも触れない)
2. Stripe (Edge Function `stripe-price-sync`): 変えた interval ごとに `prices.create` で新 Price object を作り、**同じ interval の旧 Price だけ** `active=false` にする。`{ month, year }` を返す (変えなかった方は null)
3. DB: `plan_price_history` INSERT (service-role。月額の Stripe Price ID を記録) → `subscription_plans` 更新 (変えた interval の列だけ: 月額 = `stripe_price_id` / 年額 = `stripe_yearly_price_id`) → `admin_audit_logs` INSERT (年額の Price ID と、interval ごとの旧 Price 無効化結果を含む)
4. 既存サブスクリプションの Price は切り替えない (既存の契約者は旧 Price のまま請求される)

**エラー**: `STRIPE_SECRET_KEY` と `stripe_product_id` がある (Stripe 同期が必須の) プランで同期に失敗したら 502 `OP_STRIPE_SYNC_FAILED` (Edge Function 未デプロイは 503 `OP_STRIPE_SYNC_UNAVAILABLE`)。DB は更新しない (fail-closed)。月額・年額の両方を変えたのに片方の新 Price ID が返らなかった場合も 502 で、DB は更新しない。`STRIPE_SECRET_KEY` 未設定の環境は mock モード (DB だけ更新、`stripe_mock: true`)。

---

### GET /api/super-admin/plans/{id}/price-impact
価格変更影響シミュレーション (実装パスは `price-impact`)

**クエリ**: `?new_monthly_price_jpy=1180&applies_to=new_only`
- `applies_to`: `new_only` だけ (省略時も `new_only`)。`on_renewal` / `immediately` は 400 `OP_INVALID_QUERY` (#1102)

**レスポンス**:
```json
{
  "data": {
    "affected_subscription_count": 0,
    "affected_mrr_change_jpy": 0,
    "current_monthly_price_jpy": 980,
    "new_monthly_price_jpy": 1180,
    "applies_to": "new_only",
    "effective_timing": "none",
    "affected_user_sample": []
  }
}
```

**既存契約への影響** (#1102。詳細は `04-plan-management.md` §3.3):

価格変更は新規契約のみに適用されるため、既存契約 (`personal_subscriptions`) は集計せず、影響は常にゼロ。

| applies_to | 既存契約への影響 | `affected_subscription_count` / `affected_mrr_change_jpy` | `effective_timing` |
|-----------|----------------|-----------------------------------------------------------|--------------------|
| `new_only` | なし (既存契約は現行価格のまま) | 件数 0、MRR 変化 0。`affected_user_sample` は空配列 | `none` |

- 返す形は #1212 のときのまま (画面の型と互換)。#1212 では `on_renewal` / `immediately` で既存契約を集計して MRR 変化を返していたが、既存サブスクリプションへの反映が実装されていなかったため、#1102 で廃止した。
- 組織のプランの行 (`plan_type = 'org'` の `org_*`) では、`data.organizations_note` に注記 (`ORG_SUBSCRIPTION_PLAN_ROW_NOTE`。組織の段階とは無関係で、組織の利用者の判定に使われないので組織の件数は数えない) を足す (#1912)。個人・家族のプランには付けない。ほかのキーは変えない

---

### GET /api/super-admin/plans/{id}/price-history
価格変更履歴

### GET /api/super-admin/plans/{id}/downgrade-impact
ダウングレード機能消失シミュレーション

**クエリ**: `?to_plan_id=uuid`

**レスポンス**:
```json
{
  "data": {
    "lost_features": ["industrial_doctor_access", "ai_doctor_advice"],
    "affected_member_count": 87,
    "affected_members_sample": [ { "user_id": "uuid", "email": "..." } ]
  }
}
```

---

## 18. 機能パッケージ API

### GET /api/super-admin/feature-packages
パッケージ一覧

### POST /api/super-admin/feature-packages
パッケージ作成

**リクエスト**:
```json
{
  "package_key": "advanced_analytics",
  "display_name": "高度分析",
  "feature_flags": ["cohort_analysis_v2", "ab_test_dashboard"],
  "display_order": 80
}
```

**権限**: `super_admin`

---

### PATCH /api/super-admin/feature-packages/{id}
パッケージ更新

### DELETE /api/super-admin/feature-packages/{id}
パッケージ削除

**バリデーション**: 利用中プランがある場合は `OP_PACKAGE_IN_USE` で 409

---

## 19. クーポン管理 API

**権限**: すべて `super_admin` だけ (それ以外は 403 `OP_PERMISSION_DENIED`、未ログインは 401 `AUTH_UNAUTHENTICATED`)。運営の画面 `/super-admin/coupons` から使う。

**400 の本文の形** (入力の誤り `OP_INVALID_INPUT` = POST・PATCH・apply / クエリの誤り `OP_INVALID_QUERY` = 一覧 GET・適用履歴 GET。#1534 / #1641):
```json
{ "error": { "code": "OP_INVALID_INPUT", "message": "最初の issue の文", "details": [ { "path": ["valid_until"], "message": "最初の issue の文", "code": "custom" } ] } }
```
- `message` は `details` の先頭 (最初の issue) の `message` そのもの (issues を JSON にした文字列ではない)。画面は `message` をそのまま出す。#1917: issue の文が日本語でない (Zod の既定の英語の文) ときは、`message` と `details[].message` を「入力値が不正です (<path>)」/「クエリパラメータが不正です (<path>)」にする (path が空なら括弧を付けない。`src/lib/super-admin/validation-errors.ts` の `validationMessageOf`。schema に書いた日本語の文はそのまま)
- `details` は Zod の issues の全件 (`path` は誤りのある欄)
- 本文は `src/lib/super-admin/coupon-errors.ts` の `couponInvalidInputResponse` / `couponInvalidQueryResponse` が作る。`OP_INVALID_QUERY` も `code` 以外は同じ形

### GET /api/super-admin/coupons
クーポン一覧

**クエリ**: `?status=active&applicable_to=all&page=1&per_page=50` (どれも省略可。`per_page` は 1〜200)。形の誤りは 400 `OP_INVALID_QUERY` (本文の形は §19 冒頭)

**レスポンス**: `{ "data": [ coupons の行 ], "meta": { "total": 12, "page": 1, "per_page": 50 } }`

---

### POST /api/super-admin/coupons
クーポン作成

**リクエスト**:
```json
{
  "code": "ENTERPRISE2026",
  "display_name": "法人営業キャンペーン2026",
  "discount_type": "percentage",
  "discount_value": 20,
  "applicable_to": "org",
  "valid_from": "2026-05-01",
  "valid_until": "2026-12-31",
  "max_uses": 100,
  "per_user_limit": 1,
  "duration_months": 3
}
```

**バリデーション**:
- `valid_from` / `valid_until` は JST の暦日 (YYYY-MM-DD の実在する日付。存在しない日付は 400 `OP_INVALID_INPUT`)。`valid_from <= valid_until` (同じ日は可)
- DB には開始日の JST 0:00・期限の日の JST 23:59:59.999999 の時刻にして書く (#1483。`apply_coupon` の `now() > valid_until` は端を含むので、期限の日の終わりまで使える)。PATCH の `valid_until` も同じ
- `code` が既にあるときは 409 `OP_COUPON_CODE_DUPLICATE`

**レスポンス**: 201 `{ "data": 作った coupons の行 }` (`status` は `active`)

---

### GET /api/super-admin/coupons/{id}
クーポン詳細。`{ "data": coupons の行 }`。無ければ 404 `OP_COUPON_NOT_FOUND`

---

### PATCH /api/super-admin/coupons/{id}
クーポン編集 (送った欄だけを変える。どれも省略可)

**リクエスト**:
```json
{
  "display_name": "法人営業キャンペーン2026 (延長)",
  "status": "paused",
  "valid_until": "2027-03-31",
  "max_uses": 200,
  "applicable_plans": ["uuid"],
  "applicable_to": "org",
  "gross_margin_preview_jpy": 1200
}
```

- `display_name`: 200 文字まで (`null` で消す)
- `status`: `active` / `paused` / `expired`。一時停止は `paused` にする (専用の API は無い)
- `valid_until`: JST の暦日 (YYYY-MM-DD の実在する日付)。DB にはその日の JST 23:59:59.999999 にして書く (#1483。POST と同じ)
- `max_uses`: 1 以上の整数 (`null` で無制限)
- `applicable_plans`: プランの id (UUID) の配列 / `applicable_to`: `all` / `personal` / `family` / `org`
- `code` / `discount_type` / `discount_value` / `valid_from` / `per_user_limit` / `duration_months` は変えられない (送っても無視する)

**バリデーション**:
- 形の誤り (上の各欄) は 400 `OP_INVALID_INPUT`
- 変える欄が 1 つも無いときは 400 `OP_NO_UPDATE`
- クーポンが無いときは 404 `OP_COUPON_NOT_FOUND`
- `valid_until` を送ったときは、保存済みの `valid_from` を JST の暦日に戻して比べ、`valid_until` の日がそれより前なら 400 `OP_INVALID_INPUT` (`details[].path` は `["valid_until"]`)。同じ日は可 (POST の `valid_from <= valid_until` と同じ決まり。#1510)。`valid_until` を送らないときは比べない

**レスポンス**: 200 `{ "data": 変えたあとの coupons の行 }`。監査ログに `update_coupon` (`details.changes` に書いた値) を残す

---

### DELETE /api/super-admin/coupons/{id}
クーポン削除。204。利用実績がある (`uses_count > 0`) ときは 409 `OP_COUPON_IN_USE` (`paused` にする)。無ければ 404 `OP_COUPON_NOT_FOUND`

---

### POST /api/super-admin/coupons/{id}/apply
契約へのクーポンの適用 (super_admin の承認で遡及して適用する)。operator/04-plan-management.md §4.1

- リクエストの形の誤り (`subscription_target` / `subscription_id` / `reason`) は 400 `OP_INVALID_INPUT` (本文の形は §19 冒頭。POST・PATCH と同じ)

---

### GET /api/super-admin/coupons/{id}/redemptions
適用履歴 (coupon_redemptions の行。新しい順 = `redeemed_at` の降順)

**クエリ**: `?page=1&per_page=50` (`per_page` は 1〜200)。形の誤りは 400 `OP_INVALID_QUERY` (本文の形は §19 冒頭)

**レスポンス**:
```json
{
  "data": [ { "coupon_id": "uuid", "user_id": "uuid", "discount_amount_jpy": 500, "redeemed_at": "2026-05-01T00:00:00Z" } ],
  "meta": { "total": 45, "page": 1, "per_page": 50, "coupon_code": "ENTERPRISE2026" }
}
```

---

## 20. 収益管理 API

### GET /api/admin/finance/revenue/snapshot
最新収益スナップショット

### GET /api/admin/finance/revenue/timeseries
MRR / ARR 時系列

**クエリ**: `?from=2025-01-01&to=2026-05-01&segment=personal`

---

### GET /api/admin/finance/revenue/forecast
収益予測

**クエリ**: `?horizon=6` (6ヶ月予測)

**レスポンス**:
```json
{
  "data": {
    "forecast": [
      { "month": "2026-06", "mrr_jpy": 5100000, "confidence_low": 4800000, "confidence_high": 5400000 }
    ],
    "assumptions": { "churn_rate": 2.3, "growth_rate": 5.1 }
  }
}
```

---

### GET /api/admin/finance/licenses
組織ライセンス販売一覧

**クエリ**: `?status=active&expiring_within_days=30`

### GET /api/admin/finance/personal
個人課金者リスト

**クエリ**: `?plan_key=pro&status=active&page=1`

---

## 21. Webhook API

### POST /api/webhooks/stripe
Stripe Webhook 受信 (idempotent)

**ヘッダー**: `Stripe-Signature: t=xxxx,v1=xxxx`

**処理フロー**: 正本は `docs/design/billing/01-billing-core.md` §9.6 (実装は `src/app/api/webhooks/stripe/route.ts`)。
```
1. 署名の確認 (src/lib/webhook/verify.ts の verifyStripeWebhook。SDK を使わない。秘密なし 503 / 不一致 401)
2. 処理の権利を取る: billing_claim_stripe_event (stripe_webhook_events。id = event.id)
   → completed (処理済み) → 200
   → in_progress (ほかが処理中・15 分以内) → 409 (Stripe が再送する)
   → claimed → 3 へ
3. 契約を Stripe から取り直して写像 (billing_apply_stripe_subscription) に渡す。イベントの中身で直接 UPDATE しない
4. billing_finish_stripe_event: 成功 → completed (200) / 失敗 → failed + error_message (固定のコード) (500。Stripe が再送する)
```

**冪等性保証**: `billing_claim_stripe_event` (`stripe_webhook_events.id` = Stripe の event.id)。2xx を返すのは処理済み (`completed`) になったときだけで、
処理中は 409・失敗は 500 で Stripe に再送させる (`failed` と、15 分を過ぎた `processing` は再送で取り直せる)。
試用終了のリマインダー (`trial_will_end`) は Stripe の顧客向けメールに任せ、チャージバック (`charge.dispute.created`) の処理は配線の冊で足す (billing/01 §12)

---

### POST /api/webhooks/resend
Resend Webhook 受信 (ハードバウンス・苦情の宛先を宛先停止リストに入れる。#1184。記述は実装に合わせた: #1577 の 5)

**処理フロー** (`src/app/api/webhooks/resend/route.ts`):
```
1. 本文の大きさ (256 KB まで。超えたら 413) → 署名 (svix-id / svix-timestamp / svix-signature) を RESEND_WEBHOOK_SECRET で検証
   (秘密が未設定なら 503・合わなければ 401。src/lib/webhook/verify.ts) → JSON と形の検証 (読めなければ 400)
2. event.type に応じて (src/lib/emails/resend-webhook-event.ts の classifyResendEvent):
   email.bounced で bounce.type が Permanent (ハードバウンス) → 1 回で email_blacklist に追加 (reason 'bounce')
   email.bounced のそれ以外 (Temporary などのソフトバウンス) → 何もしない (200)
   email.complained → email_blacklist に追加 (reason 'complaint')
   それ以外 (email.sent / delivered / opened / clicked など) → 何もしない (200)
3. 追加は小文字にそろえた宛先で ON CONFLICT DO NOTHING (冪等。最初の理由と時刻が残る。src/lib/emails/suppression.ts)。
   書き込みの失敗は 500 (Resend が送り直す)。成功は app_logs に info (宛先はマスク)
```

- 停止リストに載っている宛先へは `sendEmail` (登録時) と worker (送信の直前) が送らない。送らなかった記録は、どちらで当たったかで違う (`10-logs-and-mail-retry.md` §7.3):
  - `sendEmail` の登録時: `app_logs` の warn (`function_name = 'email'`) と、`email_outbox` の dead の行 (`last_error_code = 'suppressed'`)。`redact_after_send` の登録 (退会の完了メール・秘密を含む文面) は行を作らない (warn だけ)。
  - worker の送信の直前 (登録のあとで停止リストに載った宛先と、登録時に停止リストを引けずに確かめないまま登録した行): `fail_email_outbox` でその行を dead (`last_error_code = 'suppressed'`) にし、`app_logs` に error (`function_name = 'cron/email-outbox'`、「メールを届けられませんでした (dead)」)。error なので、エラー急増の通知の数には入る。
  - どちらの dead の行も、届けられなかったメールの通知 (`10-logs-and-mail-retry.md` §8) の数には入れない。
- `email_delivery_logs` には書かない (§3.19 の表は残すが書かない。#1193)。
- **実装しない (将来の検討)**: Hard bounce の回数の数え上げ (3 回で停止など)、停止した宛先への送信の Slack への通知、`delivered` / `opened` / `clicked` の配信の状態の記録 (`email_delivery_logs` / `email_outbox` のどちらにも書かない)。
- メンテナンス中も、この Webhook は止めない (#1577 の 4。`src/lib/maintenance-mode.ts` の `isMaintenanceExemptPath` が完全一致の `RESEND_WEBHOOK_API_PATH` を通す。§7 のメンテナンスモード)。
  Resend (Svix) は 2xx でなければ送り直すが、約 1 日を超えるメンテナンスでは知らせを失うか、宛先を無効にされる恐れがあるため。ほかの Webhook (`/api/webhooks/stripe`) は 503 のまま (billing/01 §9.6)。
- `sendEmail` を呼んだ側 (退会の完了・除名と脱退・譲渡・運営による譲渡と解散の通知、子の追加の控え、昇格の依頼、代表者の譲渡の提案、サポートの返信) が
  「送れなかった」と残す追加のログは、理由がすべて停止リスト (`suppressed`) なら warn・ほかの理由が 1 つでもあれば error (#1577 の 7。
  `src/lib/emails/send-result.ts` の `logEmailFailures`。止めた宛先へ送らないのは意図した動きで、エラー急増の通知の数に入れないため)。
  worker の送信の直前で止めたときの error (上の 2 つ目) は変えない。

---

## 22. Cron API

### POST /api/cron/stripe-reconcile
Stripe 整合性チェック (日次 12:00 JST)

**処理**:
1. Stripe API: subscriptions 全件 paginate
2. personal_subscriptions と status を比較
3. 不一致 → `admin_audit_logs` に記録 + Slack アラート
4. 自動修復禁止 (人間確認後 super_admin が手動修正)

**認証**: `CRON_SECRET` ヘッダー

---

### POST /api/cron/trial-reminder
試用終了リマインダー (日次 09:00 JST)

**処理**:
1. `personal_subscriptions WHERE status='trialing' AND trial_ends_at BETWEEN NOW() AND NOW()+3d`
2. Push + Email 送信
3. メール件名: 「【ほめゴハン】無料トライアルが X 日後に終了します」

---

### POST /api/cron/deprecate-plan-notice
deprecated プラン通知 (日次 11:00 JST)

**処理**:
1. `subscription_plans WHERE status='deprecated' AND ends_at IS NOT NULL`
2. 90/30/7 日前に該当する全ユーザー・組織へ通知

---

### POST /api/cron/re-engagement-email
再エンゲージメントメール (日次 13:00 JST)。当面は送らない (operator/11 §8)。route は無い

**処理**:
1. 7/14/30 日間ログインなし かつ `plan_key != 'free'` のユーザー
2. 段階的メール送信 (7日目: 軽いリマインダー / 30日目: 解約防止オファー)

---

### POST /api/cron/nps-survey-sender
NPS サーベイ送信 (日次 14:00 JST)。当面は送らない (operator/11 §8)。route は無い

**処理**: 登録 30 日経過 + 前回 NPS から 90 日経過のユーザーに送信

---

### POST /api/cron/license-renewal-reminder
ライセンス更新リマインダー (日次 10:00 JST)

**処理**: 30/14/7 日前の `org_license_pools` に対し、`org_admin` へ更新通知

---

### GET /api/cron/email-outbox
メールの送信待ちを送る worker (毎分。Vercel Cron。#1193)。処理・応答・環境変数は `10-logs-and-mail-retry.md` §6.5。

**認証**: `CRON_SECRET` ヘッダー

---

### GET /api/cron/push-outbox
Push 通知の送信待ちを Expo に送る worker (毎分。Vercel Cron。#1136)。処理・応答・環境変数は `mobile/06-push-send.md` §6.6。

**認証**: `CRON_SECRET` ヘッダー

---

## 23. エラーコード一覧

| コード | HTTP | 意味 |
|--------|------|------|
| `OP_PERMISSION_DENIED` | 403 | ロール不足 |
| `OP_TARGET_PROTECTED` | 403 | 保護ユーザーへの操作不可 (super_admin BAN 等) |
| `OP_AUDIT_LOG_IMMUTABLE` | 403 | 監査ログ書き換え不可 |
| `OP_FEATURE_FLAG_IN_USE` | 409 | 削除しようとしたフラグが利用中 |
| `PLAN_NOT_FOUND` | 404 | AI の利用上限の保存 (`PATCH /api/super-admin/llm/quotas`) で、`plan_key` のプランが `subscription_plans` に無く、組織のプランの値 (`ORG_PLAN_VALUES`) でもない (§8) |
| `PLAN_READ_ONLY` | 409 | AI の利用上限の保存 (`PATCH /api/super-admin/llm/quotas`) で、`plan_key` が `subscription_plans` の組織のプランの行 (`plan_type = 'org'` の `org_*`)。組織の上限は `standard` / `premium` / `enterprise` の行で決まり、`org_*` の行の値は判定に使われない (§8。#1912) |
| `SETTING_READ_ONLY` | 409 | システム設定の保存 (`PUT /api/super-admin/settings`) で、使われていない key (旧 `feature_flags` 行) を書き換えようとした (§7。#1457) |
| `OP_PACKAGE_IN_USE` | 409 | 削除しようとしたパッケージが利用中 |
| `AI_DAILY_LIMIT` | 429 | 今日の AI の利用回数の上限に達した (利用者の AI の呼び出し。本文は `{ error, code, limit, retryAfter }`、`Retry-After` は次の JST 0 時までの秒数。operator/06-ai-llm.md §5) |
| `OP_RE_AUTH_REQUIRED` | 401 | 再認証必須 |
| `OP_PLAN_KEY_CONFLICT` | 409 | plan_key 重複 |
| `OP_PLAN_DEPRECATED` | 422 | deprecated プランへの新規加入不可 |
| `OP_COUPON_ALREADY_ACTIVE` | 409 | 1 契約に対し有効クーポンが既に存在 |
| `OP_SUBSCRIPTION_ALREADY_ACTIVE` | 409 | active/trialing が既に存在 |
| `OP_PLAN_NOT_GRANTABLE` | 422 | [NEW] 手動付与できないプラン (`POST /api/super-admin/users/{id}/manual-plan`。billing/02 §12.1) |
| `OP_NO_MANUAL_SUBSCRIPTION` | 409 | [NEW] 取り消す手動付与の行が無い (`DELETE /api/super-admin/users/{id}/manual-plan`。billing/02 §12.1) |
| `OP_SELF_MODIFY` | 403 | [NEW] 自分自身を対象にできない運営の操作 (`POST /api/super-admin/admins/{id}/mfa/reset`・`POST` / `DELETE /api/super-admin/users/{id}/manual-plan`) |
| `OP_STRIPE_SYNC_FAILED` | 502 | Stripe API 呼び出し失敗 |
| `OP_COUPON_EXPIRED` | 422 | クーポン期限切れ |
| `OP_TRIAL_ALREADY_USED` | 422 | 同一プランの試用は 1 回のみ |
| `OP_NOT_SUPPORTED` | 501 | [NEW] 未対応の機能 (本文は予定を書かず、いまの事実だけを言う。#1911)。認可を通った人にだけ返す (データエクスポート・AI コンテンツの審査) |
| `DSR_INVALID_TRANSITION` | 409 | [NEW] 個人情報の請求の更新 (`PATCH /api/admin/data-requests/{id}`) が状態遷移表に無い (同じ状態の指定・本人確認待ち / 終わった請求への更新を含む。cross/15 §7.4・§13) |
| `DSR_RESPONSE_NOTE_REQUIRED` | 422 | [NEW] 個人情報の請求を対応済み・対応できずにするのに本人への応答が空 (`PATCH /api/admin/data-requests/{id}`。cross/15 §13) |
| `CONFLICT_PRECONDITION_REQUIRED` / `CONFLICT_OPTIMISTIC_LOCK` / `CONFLICT_STALE_DATA` | 428 / 412 / 409 | 楽観的ロック (cross/04 §4.2)。`PATCH /api/admin/data-requests/{id}` で、`If-Unmodified-Since` が無い / GET が返した `updated_at` と違う / 条件つきの UPDATE が 0 行。`CONFLICT_STALE_DATA` は組織のプランの変更 (`PATCH /api/admin/organizations/{id}`) でも使う: 直前に読んだ `plan` のままなら書く条件つきの UPDATE が 0 行で、読み直した `plan` が送られたプランと違う (同じなら 200 で書かず記録もしない。#1912)。同じ形で、問い合わせの更新 (`PATCH` / `PUT /api/admin/inquiries/{id}`。条件は読んだ `status` と `updated_at`)・AI の 1 日の上限の保存 (`PATCH /api/super-admin/llm/quotas`。条件は読んだ `daily_limit`、行が無かったときは作るだけ)・リードのステージの変更 (`PATCH /api/admin/sales/leads/{id}`。条件は読んだ `stage`。読み直してリードがあれば常に 409)・プランの編集と削除 (`PATCH` / `DELETE /api/super-admin/plans/{id}`。条件は読んだ `status` (削除は `draft`)、廃止で既存の `ends_at` に頼るときは `ends_at` が NULL でないことも。編集は送った変更がもう入っていれば 200)・利用者の凍結 (`POST /api/admin/users/{id}/freeze`。条件は読んだ時点の super_admin でない状態のまま。読み直して対象があれば常に 409) でも使う。送った値が今の値と同じだったときの扱いは違う: 組織のプラン・AI の 1 日の上限・プランの編集 (読み直した行に送った変更がもう入っていたとき) は 200 で書かず記録もしないが、問い合わせの更新は 200 で書かずに今の行 (本文を含む) を返すので、`changed: false` として記録する (:984) |
| `OP_EMAIL_OUTBOX_NOT_FOUND` | 404 | [NEW] 再送 (`POST /api/super-admin/email-outbox/{id}/requeue`) の行が無い (`10-logs-and-mail-retry.md` §11) |
| `OP_EMAIL_OUTBOX_NOT_REQUEUEABLE` | 409 | [NEW] 再送できない行。`details.reason` が `not_dead` (届けられなかった行でない) か `redacted` (宛先を伏せた行) (`10-logs-and-mail-retry.md` §11) |
| `AUTH_2FA_REQUIRED` | 403 | 二段階認証の確認が要る (必須ロールで認証アプリを登録済み・セッションが aal1)。`requireRole` が `MfaRequiredError` (`ForbiddenError` の派生) を投げ、運営の API は route の既存の 403 の code (`FORBIDDEN` / `OP_PERMISSION_DENIED` / `PERM_DENIED`) で返す (本文の message は、`authFailureNested` を通す route では「二段階認証の確認が必要です」、403 を固定のリテラルで返す route では「権限がありません」。`cross/12-operator-mfa.md` §19.3)。この code を本文に出すのは自己サービスの `/api/auth/mfa/*` だけ。画面 (layout / page) は `requireRoleForPage` が MFA の画面へ回す (`cross/12-operator-mfa.md` §13.4・§19.3) |
| `AUTH_2FA_ENROLLMENT_REQUIRED` | 403 | [NEW] 二段階認証の登録が要る (必須ロールで未登録・猶予なし・セッションが aal1)。扱いは `AUTH_2FA_REQUIRED` と同じ (`cross/12-operator-mfa.md` §19) |

## 24. テスト方針

主要テストケース:

1. `it('rejects webhook with invalid Stripe signature')` → billing/01 §14.1 のテスト 19・38 (`src/__tests__/lib/webhook/verify.test.ts`・`tests/webhooks-stripe-route.test.ts`)
2. `it('returns already_processed on second webhook with same event_id')` → billing/01 §14.1 のテスト 40 (`tests/webhooks-stripe-route.test.ts`) と §14.2 のテスト 65
3. `it('applies coupon discount correctly to subscription price')`
4. `it('returns 403 when non-super_admin calls POST /api/super-admin/plans')`
5. `it('updates plan status to deprecated and triggers migration job')`
6. `it('E2E: super_admin creates plan, publishes, user purchases, webhook updates DB')`

なりすまし (impersonate) の API は提供しない (#1124) ため、403 や監査ログのテストは書かない。
代わりに、`POST /api/admin/users/{id}/impersonate` が super_admin でも 404 になり、監査ログが増えないことを
`tests/integration/operator/admin-users.test.ts` で確認している。

```typescript
// Stripe の Webhook の署名の確認のテストは src/__tests__/lib/webhook/verify.test.ts にある (billing/01 §8.3・§14.1 のテスト 17〜19)。
// Stripe の SDK を入れないので、署名の確認は src/lib/webhook/verify.ts の verifyStripeSignature / verifyStripeWebhook (t=/v1= の HMAC を自前で確かめる)。

// tests/unit/operator/coupon-calculation.test.ts
import { applyCoupon } from '@/lib/operator/coupon';

describe('クーポン適用計算', () => {
  it('applies percentage discount correctly', () => {
    const result = applyCoupon({
      original_price_jpy: 980,
      coupon: { discount_type: 'percent', discount_value: 20 },
    });
    expect(result.discounted_price_jpy).toBe(784); // 980 * 0.8
    expect(result.discount_amount_jpy).toBe(196);
  });

  it('applies fixed amount discount correctly', () => {
    const result = applyCoupon({
      original_price_jpy: 980,
      coupon: { discount_type: 'fixed', discount_value: 300 },
    });
    expect(result.discounted_price_jpy).toBe(680); // 980 - 300
  });

  it('clamps discounted price to 0 when fixed discount exceeds original price', () => {
    const result = applyCoupon({
      original_price_jpy: 300,
      coupon: { discount_type: 'fixed', discount_value: 500 },
    });
    expect(result.discounted_price_jpy).toBe(0); // 0 以下にならない
  });
});

// tests/integration/operator/api-permissions.integration.test.ts
describe('operator API 権限テスト', () => {
  it('returns 403 when non-super_admin calls POST /api/super-admin/plans', async () => {
    const adminToken = await signInAsUser('admin@test.local'); // finance ロール
    const res = await fetch(`${BASE_URL}/api/super-admin/plans`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ plan_key: 'test_plan', display_name: 'テスト' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });
});
```

## 25. 既存実装との関連

- `/api/admin/*`, `/api/super-admin/*` は commit `32d13e1` で全削除済み → 完全新規実装
- Stripe webhook ハンドラ (`/api/webhooks/stripe`) の実装は billing/01 (`docs/design/billing/01-billing-core.md` §9.6)

## 26. 未解決事項

- `POST /api/super-admin/plans/{id}/deprecate` の通知ジョブは Vercel Queue (Phase 2) か Supabase Edge Function か → 08-cron-batches.md で決定
- `GET /api/admin/finance/revenue/forecast` の ML モデルは Phase 4 実装、現在は線形外挿のみ
- Resend Webhook の署名検証方式 (HMAC-SHA256) は Resend ドキュメント準拠で実装
