# API 規約設計

## 1. 目的・スコープ

全ドメイン共通の API パス規約・エラーコード体系・レスポンス形状・ページネーション・バージョニングを定義する。  
family / org / operator の各ドメイン設計書はここを参照し、独自規約を定義しない。

**対象外**: 個別エンドポイントの詳細仕様 (各ドメインの api-spec.md で定義)

---

## 2. 関連要件

- 要件定義 03 §19.5 (エラーコード体系)
- 要件定義 03 §19.8 (ページネーション)
- 要件定義 03 §19.9 (OpenAPI)
- 要件定義 03 §19 全般 (通信・データ規約)

---

## 3. API パス規約

### 3.1 パス構成

```
/api/{domain}/{resource}[/{id}][/{action}]
```

**v1 プレフィックス**: Phase 1 では省略可。Phase 2 以降で `/api/v1/` への移行を予定 (後方互換 6 ヶ月保証)。  
現在の canonical パスは `/api/{domain}/` とする。v1 移行戦略は §8 を参照。

| ドメイン | パスプレフィックス | 対象ロール |
|---------|-----------------|----------|
| 家族管理 | `/api/family/` | 認証済みユーザー全般 |
| 組織管理 | `/api/org/` | org_member 以上 |
| 運営管理 | `/api/admin/` | support / admin 以上 |
| super_admin 専用 | `/api/super-admin/` | super_admin のみ |
| Webhook 受信 | `/api/webhooks/` | 署名検証付き |
| 公開 API | `/api/public/` | 認証不要 (rate limit あり) |

### 3.2 パス例

```
GET    /api/family/groups                    # 家族グループ一覧
POST   /api/family/groups                    # 家族グループ作成
GET    /api/family/groups/{groupId}           # 詳細
PATCH  /api/family/groups/{groupId}           # 部分更新
DELETE /api/family/groups/{groupId}           # 削除
POST   /api/family/groups/{groupId}/freeze    # 状態変更アクション
GET    /api/org/members                       # 組織メンバー一覧
POST   /api/org/licenses/{poolId}/assignments/bulk  # バルク操作
POST   /api/admin/users/{userId}/ban          # 管理アクション
POST   /api/super-admin/plans/{id}/publish    # super_admin 専用
POST   /api/webhooks/stripe                   # Stripe Webhook
```

### 3.3 HTTP メソッド規約

| メソッド | 用途 | べき等性 |
|---------|------|---------|
| `GET` | 読み取り | べき等 |
| `POST` | 新規作成 / アクション | 非べき等 |
| `PATCH` | 部分更新 | べき等 (楽観的ロック適用) |
| `PUT` | 完全置換 | べき等 (使用場面限定) |
| `DELETE` | 削除 (soft or hard) | べき等 |

---

## 4. エラーコード体系

### 4.1 プレフィックス定義

| プレフィックス | 意味 | 対応 HTTP Status |
|-------------|------|----------------|
| `AUTH_` | 認証・認可 (セッション / トークン) | 401, 403 |
| `PERM_` | 権限不足 | 403 |
| `VALID_` | バリデーションエラー | 422 |
| `CONFLICT_` | 競合・前提条件エラー | 409, 412 |
| `RATE_` | レート制限 | 429 |
| `EXT_` | 外部サービスエラー | 502, 503 |
| `FAM_` | 家族管理ドメイン固有 | 400, 422 |
| `ORG_` | 組織管理ドメイン固有 | 400, 422 |
| `OP_` | 運営管理ドメイン固有 | 400, 422 |
| `SYS_` | システム内部エラー | 500 |

### 4.2 エラーコード一覧表

この一覧は各ドメイン実装で追記・拡張可能。追加時は PR description で明示すること。

#### AUTH 系

| コード | 説明 | HTTP |
|--------|------|------|
| `AUTH_UNAUTHENTICATED` | 未認証 (Cookie / Token なし) | 401 |
| `AUTH_INVALID_CREDENTIALS` | メール / パスワード不一致 | 401 |
| `AUTH_TOKEN_EXPIRED` | アクセストークン期限切れ | 401 |
| `AUTH_2FA_REQUIRED` | 2FA 認証が必要 (必須ロールで TOTP を登録済み・セッションが aal1)。401 だと画面が未ログインと解釈してログイン画面と往復するので 403 (`cross/12-operator-mfa.md` §7.1・§19) | 403 |
| `AUTH_2FA_INVALID` | 2FA コード (6 桁・バックアップコード) が無効 (`cross/12-operator-mfa.md` §19) | 400 |
| `AUTH_2FA_ENROLLMENT_REQUIRED` | **[NEW]** 2FA の登録が必要 (必須ロールで未登録・猶予なし・セッションが aal1。`cross/12-operator-mfa.md` §19) | 403 |
| `AUTH_2FA_NOT_ENROLLED` | **[NEW]** 2FA の factor が無い・本人のものでない (id 指定は 404・状態の問題は 409。`cross/12-operator-mfa.md` §19) | 404 / 409 |
| `AUTH_2FA_ALREADY_ENROLLED` | **[NEW]** 2FA を登録済みで登録を始めた (先に解除。`cross/12-operator-mfa.md` §19) | 409 |
| `AUTH_2FA_NATIVE_SESSION` | **[NEW]** アプリの WebView の借り物のセッションで、2FA の確認・解除 (セッションの token を発行し直す操作) をしようとした (`cross/12-operator-mfa.md` §16.4・§19) | 409 |
| `AUTH_SESSION_REVOKED` | セッション無効化済み | 401 |
| `AUTH_ACCOUNT_LOCKED` | **使わない (#1165)**: ログインに続けて失敗してもアカウントはロックしない (01-auth-session.md §8)。欠番。別の意味に再利用しない | - |
| `AUTH_PROFILE_NOT_FOUND` | user_profiles が見つからない | 403 |
| `AUTH_IMPERSONATION_DENIED` | **廃止 (#1124)**: impersonate は提供しないため使わない (欠番。別の意味に再利用しない) | - |

#### PERM 系

| コード | 説明 | HTTP |
|--------|------|------|
| `PERM_DENIED` | ロール不足 | 403 |
| `PERM_ORG_MISMATCH` | 別組織へのアクセス | 403 |
| `PERM_NO_ORG` | 組織未所属 | 403 |
| `PERM_FAMILY_NOT_MEMBER` | 家族グループ非メンバー | 403 |
| `PERM_FAMILY_OWNER_REQUIRED` | 家族 owner 権限が必要 | 403 |

#### VALID 系

| コード | 説明 | HTTP |
|--------|------|------|
| `VALID_REQUIRED_FIELD` | 必須フィールド欠如 | 422 |
| `VALID_EMAIL_FORMAT` | メールアドレス形式エラー | 422 |
| `VALID_PASSWORD_TOO_SHORT` | パスワード最小長未満 | 422 |
| `VALID_PASSWORD_BREACHED` | HIBP で漏洩確認済み | 422 |
| `VALID_PASSWORD_HISTORY` | 過去に使用済みパスワード | 422 |
| `VALID_FILE_TOO_LARGE` | ファイルサイズ超過 | 422 |
| `VALID_FILE_TYPE` | 許可されていないファイル形式 | 422 |
| `VALID_CURSOR_INVALID` | cursor パラメータ不正 | 422 |

#### CONFLICT 系

| コード | 説明 | HTTP |
|--------|------|------|
| `CONFLICT_OPTIMISTIC_LOCK` | 楽観的ロック失敗 (競合) | 412 |
| `CONFLICT_PRECONDITION_REQUIRED` | `If-Unmodified-Since` ヘッダ必須 | 428 |
| `CONFLICT_STALE_DATA` | WHERE 条件不一致 (0 行更新) | 409 |
| `CONFLICT_LICENSE_POOL_EXHAUSTED` | ライセンス残席不足 | 409 |
| `CONFLICT_DUPLICATE_EMAIL` | メールアドレス重複 | 409 |
| `CONFLICT_DUPLICATE_INVITE` | 既存招待が有効 | 409 |
| `CONFLICT_FAMILY_MEMBER_LIMIT` | 家族メンバー上限 | 409 |

#### RATE 系

| コード | 説明 | HTTP |
|--------|------|------|
| `RATE_LIMIT_EXCEEDED` | 一般レート制限 | 429 |
| `RATE_LOGIN_EXCEEDED` | ログインレート制限 | 429 |
| `RATE_INVITE_EXCEEDED` | 招待レート制限 | 429 |
| `RATE_AI_EXCEEDED` | AI API レート制限 | 429 |
| `RATE_PASSWORD_RESET_EXCEEDED` | パスワードリセットレート制限 | 429 |

#### EXT 系

| コード | 説明 | HTTP |
|--------|------|------|
| `EXT_STRIPE_WEBHOOK_FAILED` | Stripe Webhook 処理失敗 | 502 |
| `EXT_STRIPE_CHARGE_FAILED` | Stripe 課金失敗 | 502 |
| `EXT_LLM_TIMEOUT` | LLM API タイムアウト | 504 |
| `EXT_LLM_CONTENT_POLICY` | LLM コンテンツポリシー拒否 | 422 |
| `EXT_RESEND_FAILED` | Resend メール送信失敗 | 502 |
| `EXT_PUSH_FAILED` | Push 通知送信失敗 | 502 |
| `EXT_VIRUS_DETECTED` | ウイルス検知 | 422 |

#### FAM 系

| コード | 説明 | HTTP |
|--------|------|------|
| `FAM_GROUP_FROZEN` | 家族グループが凍結中 | 403 |
| `FAM_GROUP_ARCHIVED` | 家族グループがアーカイブ済み | 404 |
| `FAM_INVITE_EXPIRED` | 招待が期限切れ | 410 |
| `FAM_INVITE_USED` | 招待は既に受諾済み | 409 |
| `FAM_INVITE_CANCELLED` | 招待は取り消されている | 410 |
| `FAM_MEAL_REQUEST_INVALID_STATUS` | メールリクエストのステータス遷移エラー | 422 |
| `FAM_CHILD_NO_AUTH_USER` | 子供メンバーは auth.users 不可 | 422 |
| `FAM_PARENTAL_CONSENT_REQUIRED` | 保護者同意が必要 | 403 |
| `FAM_CHILD_PROMOTE_AUTH_REQUIRED` | 子供アカウント独立化には親の再認証が必要 | 401 |

#### LEGAL 系

利用規約・プライバシーポリシーの同意 (`docs/design/cross/08-legal-compliance.md` §7.2・`docs/design/cross/13a-legal-consent-api-server.md`)。

| コード | 説明 | HTTP |
|--------|------|------|
| `LEGAL_CONSENT_REQUIRED` | 規約への同意が必要 (middleware の `/api` の分岐が、未同意の人の API を止める。本文は平たい形 `{ error, code }`) | 403 |
| `LEGAL_VERSION_MISMATCH` | 同意を送った版が、いま有効な版と違う (`POST /api/legal/accept`。本文に `current` を添える) | 409 |
| `LEGAL_BAD_REQUEST` | 同意の記録の入力が不正 (`POST /api/legal/accept`) | 400 |
| `LEGAL_UNSUPPORTED_MEDIA_TYPE` | 同意の記録の Content-Type が JSON でない (`POST /api/legal/accept`) | 415 |

#### ORG 系

| コード | 説明 | HTTP |
|--------|------|------|
| `ORG_NOT_FOUND` | 組織が見つからない | 404 |
| `ORG_LICENSE_NOT_FOUND` | ライセンスが見つからない | 404 |
| `ORG_INACTIVE` | 組織が非アクティブ | 403 |
| `ORG_SSO_REQUIRED` | SSO ログインが必要 | 403 |
| `ORG_PERMISSION_DENIED` | 組織への権限がない | 403 |
| `ORG_OFFBOARD_INVALID_STATUS` | オフボーディング操作の対象グループが不正なステータス | 409 |
| `ORG_LICENSE_ALREADY_REVOKED` | ライセンスは既に取り消されている | 410 |
| `ORG_LICENSE_POOL_EXPIRED` | ライセンスプールが期限切れ | 410 |
| `ORG_LICENSE_POOL_EXHAUSTED` | ライセンスプール枯渇 (容量超過) | 409 |
| `CONFLICT_LICENSE_POOL_EXHAUSTED` | 同上 (CONFLICT_ プレフィックス版、要件記述で混在) | 409 |

#### OP 系

| コード | 説明 | HTTP |
|--------|------|------|
| `OP_PLAN_NOT_FOUND` | プランが見つからない | 404 |
| `OP_FEATURE_FLAG_NOT_FOUND` | 機能フラグが見つからない | 404 |
| `OP_TICKET_NOT_FOUND` | チケットが見つからない | 404 |
| `OP_SUBSCRIPTION_ALREADY_ACTIVE` | サブスクリプションが既にアクティブ | 409 |

---

## 5. レスポンス形状

### 5.1 成功レスポンス

```typescript
// 単一リソース
interface SuccessResponse<T> {
  data: T;
}

// リスト + ページネーション
interface ListResponse<T> {
  data: T[];
  pagination: {
    next_cursor: string | null;  // null = 最終ページ
    has_more: boolean;
  };
}

// アクション結果 (削除・状態変更等)
interface ActionResponse {
  ok: boolean;
  message?: string;
}
```

### 5.2 エラーレスポンス

実装 (`src/lib/api/errors.ts` の `internalError`・`src/lib/rate-limit.ts` の `rateLimitExceededResponse`) に合わせ、本文は 2 つの形に分かれる。`request_id` は本文に入れない (要求の ID は構造化ログ (`app_logs`) にだけ残す)。

**(a) flat (既定)**: 一般の API。画面が `data.error` を文字列として表示するので、`error` は文字列のままにし、`code` を横に添える。

```typescript
interface ErrorResponse {
  error: string;   // 日本語メッセージ (ユーザー向け。こちらで決めた固定の文)
  code: string;    // エラーコード (500 の既定は 'INTERNAL_ERROR')
}
```

```json
// 500 (internalError の既定)
{ "error": "処理中にエラーが発生しました", "code": "INTERNAL_ERROR" }

// 429 (rateLimitExceededResponse。retryAfter は再試行までの秒数)
{ "error": "リクエストが多すぎます。しばらく時間をおいてからお試しください。", "code": "RATE_LIMITED", "retryAfter": 60 }

// 403 (規約への同意が必要。middleware の /api の分岐。packages/shared の legalConsentRequiredBody)
{ "error": "利用規約・プライバシーポリシーへの同意が必要です。同意の画面から内容をご確認ください。", "code": "LEGAL_CONSENT_REQUIRED" }
```

**(b) nested**: `error.message` を読むクライアント向け。運営 API (`/api/super-admin/**` など) は `internalError(..., { shape: 'nested' })` でこの形の 500 を返す。組織・家族の所属の操作の API (招待の承諾・辞退・取り消し・脱退・除名・代表者やオーナーの譲渡など。`/api/org/**`・`/api/family/**` のうち `MembershipErrorCode` を返すもの) の 4xx もこの形で、`code` は `MembershipErrorCode` (`src/lib/errors/membership-errors.ts`) の値 (同じ配下でも、一覧の取得などは (a) flat の `{ error: 'Forbidden' }` などを返す route がある)。`message` は操作ごとの固定の文なので、画面は `membershipErrorMessageOfBody` で `code` から理由の文を引く。

```typescript
interface NestedErrorResponse {
  error: {
    code: string;     // エラーコード (500 の既定は 'INTERNAL_ERROR')
    message: string;  // 日本語メッセージ (ユーザー向け。こちらで決めた固定の文)
  };
}
```

```json
// 500 (internalError(..., { shape: 'nested' }))
{ "error": { "code": "INTERNAL_ERROR", "message": "処理中にエラーが発生しました" } }

// 409 (家族の除名で、代表者を外そうとした。remove_family_member が IS_FAMILY_REPRESENTATIVE を RAISE する)
{ "error": { "code": "IS_FAMILY_REPRESENTATIVE", "message": "メンバーの除名に失敗しました" } }
```

どちらの形でも、本文に DB の生のエラー文・捕まえた例外の文面・`details`・`hint`・スタックを入れない (500 は汎用の文だけにし、元のエラーは構造化ログに残す)。

### 5.3 TypeScript 型定義

```typescript
// src/types/api.ts

export interface ApiResponse<T> {
  data: T;
}

export interface ApiListResponse<T> {
  data: T[];
  pagination: Pagination;
}

export interface Pagination {
  next_cursor: string | null;
  has_more: boolean;
}

// §5.2 (a) flat (既定)
export interface ApiErrorResponse {
  error: string;
  code: string;
}

// §5.2 (b) nested (運営 API の 500・組織・家族の API の 4xx)
export interface ApiNestedErrorResponse {
  error: { code: string; message: string };
}
```

---

## 6. ページネーション

### 6.1 cursor-based (デフォルト)

全エンドポイントのデフォルト。`cursor` は base64 エンコードされた JSON。

```
GET /api/v1/family/groups?cursor=eyJpZCI6IjEyMyJ9&limit=20
```

```typescript
// cursor のエンコード / デコード
type CursorPayload = { id: string } | { created_at: string; id: string };

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
}
```

```sql
-- cursor-based ページネーション SQL パターン
SELECT * FROM {table}
WHERE (created_at, id) < ($cursor_created_at, $cursor_id)  -- ← cursor 値
ORDER BY created_at DESC, id DESC
LIMIT $limit + 1;  -- +1 で has_more を判定
```

### 6.2 offset-based (管理画面のみ)

件数表示が必要な管理画面 (`/admin/*`, `/super-admin/*`) のみ使用可。

```
GET /api/v1/admin/users?page=2&limit=50

Response:
{
  "data": [...],
  "pagination": {
    "total": 1542,
    "page": 2,
    "limit": 50,
    "total_pages": 31
  }
}
```

### 6.3 制限値

```
limit のデフォルト: 20
limit の最大値: API ごとに個別定義 (標準 100、組織メンバー一覧等は 200 まで許容)
```

ドメインごとの例外:
- 家族ドメイン: max 100
- 組織ドメイン (メンバー一覧等): max 200 (org/02-api-spec.md で個別明記)

---

## 7. 共通リクエストヘッダ

| ヘッダ | 必須 | 説明 |
|--------|------|------|
| `Authorization: Bearer {token}` | 認証必須エンドポイントで必須 | Supabase JWT |
| `If-Unmodified-Since: {date}` | 状態変更 API で必須 | 楽観的ロック |
| `X-Request-ID: {uuid}` | 任意 | ログ追跡 (なければサーバーで生成) |
| `Content-Type: application/json` | POST / PATCH で必須 | |

---

## 8. API バージョニング

### 8.1 バージョニング方針

- **Phase 1**: URL パスに v1 プレフィックスは不要 (`/api/family/groups`)
- **Phase 2 以降**: `/v1/` を導入する (`/api/v1/family/groups`)。移行時は旧パスを **最低 6 ヶ月** 並行稼働
- **互換を壊す変更**: メジャーバージョンアップ必須
  - フィールドの削除、型変更、エラーコード変更
- **追加は後方互換**: 新フィールド追加、新エンドポイント追加はバージョンアップ不要

### 8.2 deprecation 手順

1. レスポンスに `Deprecation: true` ヘッダを付与
2. `Link: </api/v2/...>; rel="successor-version"` ヘッダを付与
3. メジャー利用者に事前通知 (メール / API docs)
4. 6 ヶ月後に旧バージョン廃止

---

## 9. OpenAPI Source of Truth

- `docs/api/*.openapi.yaml` が Single Source of Truth
- TypeScript 型は `openapi-typescript` で自動生成
- Swagger UI は `/admin/api-docs` (admin 限定) で閲覧可能

### 9.1 ファイル構成

```
docs/api/
├── family.openapi.yaml       # 家族管理 API
├── org.openapi.yaml          # 組織管理 API
├── admin.openapi.yaml        # 運営管理 API
├── super-admin.openapi.yaml  # super_admin API
└── webhooks.openapi.yaml     # Webhook 受信
```

### 9.2 型生成コマンド

```bash
# package.json scripts
"api:types": "openapi-typescript docs/api/*.openapi.yaml -o src/types/api-generated.ts"
```

---

## 10. Webhook 受信エンドポイント規約

### 10.1 署名検証

全 Webhook エンドポイントは署名検証を **必須** とする。

> **実装との対応**: Resend の受け口は実装済み (#1184)。`src/lib/webhook/verify.ts` に `WebhookSecretMissingError`・`readSvixHeaders`・
> `verifySvixSignature`・`verifyResendWebhook` がある。Resend は Svix の形 (`svix-id`・`svix-timestamp`・`svix-signature`。HMAC-SHA256 の入力は
> 「id.timestamp.生の本文」、時刻の許容幅は前後 5 分) で署名し、`src/app/api/webhooks/resend/route.ts` は署名が合わなければ 401、
> 秘密が未設定なら 503 を返す (下の見本の「本文だけの hex の HMAC」「400 / 500」とは違う。Resend については実装が正)。
> `RESEND_WEBHOOK_SECRET` は `src/lib/env.ts` の一覧 (`SERVER_ENV_VARS`) と `.env.example` にある。
> 未実装なのは Stripe の側だけ: `requireWebhookSecret`・`verifyStripeWebhook` は無く、`STRIPE_WEBHOOK_SECRET` は `.env.example` に行があるが
> `src/lib/env.ts` の一覧に無い (一覧に無い名前は `getOptionalEnv(name)` の引数の型 `OptionalEnvName` に入らないので、下の見本の Stripe の部分は
> そのままでは型が通らない)。Stripe の受け口を作るときに、一覧に任意の変数として足し (`whenMissing` も書く)、src/lib/env.ts の冒頭の
> 「新しい環境変数を足すとき」の手順に従う。

```typescript
// src/lib/webhook/verify.ts (Stripe の部分は未実装。Resend の実装は上の注を参照)
import { getOptionalEnv } from '@/lib/env';

/**
 * 署名の秘密が無いときに投げる。署名の誤り (呼び出し元は 400) と見分けるため、別の型にする。
 * 呼び出し元の route は、これを 500 (設定の不足はシステム側の誤り。§4.1 の SYS_) にし、署名の誤りの 400 と分ける
 * (例: operator/05-stripe-integration.md §4.1)。
 */
export class WebhookSecretMissingError extends Error {
  constructor() {
    super('Webhook の署名の設定がありません');
    this.name = 'WebhookSecretMissingError';
  }
}

/**
 * Webhook の署名の秘密を取り出す。`process.env.<変数名>!` とは書かない (#1182・#1434)。
 * 秘密は src/lib/env.ts の一覧に任意の変数として足し、getOptionalEnv で読む
 * (STRIPE_WEBHOOK_SECRET は、まだ一覧に無い。RESEND_WEBHOOK_SECRET は一覧にある。上の注を参照)。
 * 無ければ署名を確かめられないので、受け付けずに失敗させる (fail-closed)。
 * message に変数名を入れない (500 の本文に出うるため。変数名は getOptionalEnv が警告のログに残す)。
 */
function requireWebhookSecret(name: 'STRIPE_WEBHOOK_SECRET' | 'RESEND_WEBHOOK_SECRET'): string {
  const secret = getOptionalEnv(name);
  if (!secret) throw new WebhookSecretMissingError();
  return secret;
}

export async function verifyStripeWebhook(
  body: string,
  signature: string,
): Promise<Stripe.Event> {
  return stripe.webhooks.constructEventAsync(
    body,
    signature,
    requireWebhookSecret('STRIPE_WEBHOOK_SECRET'),
  );
}

export function verifyResendWebhook(
  body: string,
  signature: string,
): boolean {
  const expected = crypto
    .createHmac('sha256', requireWebhookSecret('RESEND_WEBHOOK_SECRET'))
    .update(body)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expected, 'hex'),
  );
}
```

### 10.2 冪等性保証

Webhook は重複配信されることがある。`event_id` をべき等キーとして使用する。

```sql
-- Stripe webhook 処理済みチェック
SELECT id FROM processed_stripe_events WHERE stripe_event_id = $1;
-- 0行 = 未処理 → 処理実行 + INSERT
-- 1行 = 処理済み → 即 200 OK 返却
```

---

## 11. レート制限レスポンス

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 60

{
  "error": "リクエストが多すぎます。しばらく時間をおいてからお試しください。",
  "code": "RATE_LIMITED",
  "retryAfter": 60
}
```

---

## 12. snake_case 統一規約

- **DB カラム**: snake_case (例: `organization_id`, `created_at`)
- **API リクエスト/レスポンス**: snake_case (camelCase 変換層は廃止)
- **TypeScript 型**: Supabase 自動生成型をそのまま使用 (snake_case)
- **URL パス**: kebab-case (例: `/meal-requests`, `/super-admin`)

変換禁止: `camelCase` への変換ミドルウェアを入れない。フロントエンドも snake_case のまま扱う。

---

## 13. 構造化エラーハンドリング (Next.js)

500 は route ごとに本文を組み立てず、共通ヘルパー `internalError(routeName, error, ctx?, options?)` (`src/lib/api/errors.ts`) を `return` する。構造化ログ (`app_logs`) への記録と、汎用の本文 (§5.2) の返却を一度に行う。

```typescript
// src/app/api/health/goals/route.ts (見本)
import { NextResponse } from 'next/server';
import { internalError } from '@/lib/api/errors';

export async function GET() {
  // ... 認証 (401 は { error: 'Unauthorized' } などこちらで決めた文)
  const { data, error } = await supabase.from('health_goals').select('*').eq('user_id', user.id); // (抜粋)
  if (error) {
    // 本文は { error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' }。DB の生のエラー文はログにだけ残る
    return internalError('GET /api/health/goals', error, { userId: user.id, table: 'health_goals' });
  }
  return NextResponse.json({ goals: data });
}

// 運営 API (クライアントが error.message を読む) は nested の形にする
//   return internalError('GET /api/super-admin/admins', error, {}, { shape: 'nested' });
```

- 4xx で理由を伝えるときは、こちらで決めた固定の文を返す (catch で受けた例外の文面は 4xx でも返さない。返してよいのは `err instanceof AuthError` など文面をこちらで書いている例外のクラスに絞り込んだ分岐の中だけ)。
- 429 は `rateLimitExceededResponse(result)` (`src/lib/rate-limit.ts`) を返す (§11)。
- 本文にエラーの `message` / `details` / `hint` を入れていないかは、`tests/api-raw-error-message-scan.test.ts` が src/app/api の全 route を走査して見張る。

---

## 14. テスト方針

| テスト種別 | 対象 | ツール |
|---------|------|------|
| Unit | `encodeCursor` / `decodeCursor`, `internalError`, `verifyStripeWebhook` | Vitest |
| Integration | cursor-based ページネーション、楽観的ロック 412 応答 | Vitest + Supabase Local |
| E2E | 認証済みエンドポイントへの 401/403 応答確認 | Playwright |
| Contract | OpenAPI スキーマと実 API の差分チェック | CI (`openapi-diff`) |

---

## 15. 既存実装との関連

| 資産 | 状態 | 対応 |
|------|------|------|
| 旧パス API (`/api/org/users`, `/api/org/settings`) | 削除 | `/api/org/members` 等に置換 |
| camelCase 変換ミドルウェア (既存) | 削除 | snake_case 統一 |
| 既存 `/api/family/groups` | 削除→再作成 | `/api/family/groups` で本仕様準拠 |

---

## 16. 未解決事項

| 項目 | 状態 | 期限 |
|------|------|------|
| 公開 SDK 提供時の API Key 認証方式 | Phase 3 | 検討不要 (Phase 1) |
| `openapi-diff` CI 統合の具体的設定 | TODO | CI 整備フェーズ |
| Webhook べき等性テーブル (`processed_stripe_events`) の DDL | TODO | operator/05-stripe-integration.md で定義 |
| レスポンス圧縮 (gzip / Brotli) の Next.js 設定確認 | TODO | Phase 1 リリース前 |
