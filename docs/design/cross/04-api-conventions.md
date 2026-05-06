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
POST   /api/super-admin/impersonate/{userId}  # super_admin 専用
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
| `AUTH_2FA_REQUIRED` | 2FA 認証が必要 | 401 |
| `AUTH_2FA_INVALID` | 2FA コードが無効 | 401 |
| `AUTH_SESSION_REVOKED` | セッション無効化済み | 401 |
| `AUTH_ACCOUNT_LOCKED` | アカウントロック中 | 403 |
| `AUTH_PROFILE_NOT_FOUND` | user_profiles が見つからない | 403 |
| `AUTH_IMPERSONATION_DENIED` | impersonate 対象ユーザーが拒否設定 | 403 |

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

#### ORG 系

| コード | 説明 | HTTP |
|--------|------|------|
| `ORG_NOT_FOUND` | 組織が見つからない | 404 |
| `ORG_LICENSE_NOT_FOUND` | ライセンスが見つからない | 404 |
| `ORG_INACTIVE` | 組織が非アクティブ | 403 |
| `ORG_SSO_REQUIRED` | SSO ログインが必要 | 403 |
| `ORG_OFFBOARD_INVALID_STATUS` | オフボーディング操作の対象グループが不正なステータス | 409 |
| `ORG_LICENSE_ALREADY_REVOKED` | ライセンスは既に取り消されている | 410 |
| `ORG_LICENSE_POOL_EXPIRED` | ライセンスプールが期限切れ | 410 |

#### OP 系

| コード | 説明 | HTTP |
|--------|------|------|
| `OP_PLAN_NOT_FOUND` | プランが見つからない | 404 |
| `OP_FEATURE_FLAG_NOT_FOUND` | 機能フラグが見つからない | 404 |
| `OP_TICKET_NOT_FOUND` | チケットが見つからない | 404 |

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

```typescript
interface ErrorResponse {
  error: {
    code: string;           // エラーコード (上記一覧より)
    message: string;        // 日本語メッセージ (ユーザー向け)
    request_id: string;     // ログ追跡用 ID
    details?: unknown;      // 開発環境のみ (本番では omit)
    field?: string;         // バリデーションエラー時: 対象フィールド名
  };
}
```

```json
// 単一エラー例
{
  "error": {
    "code": "PERM_DENIED",
    "message": "この操作には org_admin 権限が必要です",
    "request_id": "req_abc123"
  }
}

// バリデーションエラー例 (複数フィールド)
{
  "error": {
    "code": "VALID_REQUIRED_FIELD",
    "message": "入力内容に誤りがあります",
    "request_id": "req_def456",
    "fields": [
      { "field": "email", "code": "VALID_EMAIL_FORMAT", "message": "有効なメールアドレスを入力してください" },
      { "field": "role",  "code": "VALID_REQUIRED_FIELD", "message": "役割を選択してください" }
    ]
  }
}
```

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

export interface ApiError {
  code: string;
  message: string;
  request_id: string;
  field?: string;
  fields?: { field: string; code: string; message: string }[];
}

export interface ApiErrorResponse {
  error: ApiError;
}

export function isApiError(response: unknown): response is ApiErrorResponse {
  return typeof response === 'object'
    && response !== null
    && 'error' in response
    && typeof (response as ApiErrorResponse).error.code === 'string';
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

```typescript
// src/lib/webhook/verify.ts

export async function verifyStripeWebhook(
  body: string,
  signature: string,
): Promise<Stripe.Event> {
  return stripe.webhooks.constructEventAsync(
    body,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET!,
  );
}

export function verifyResendWebhook(
  body: string,
  signature: string,
): boolean {
  const expected = crypto
    .createHmac('sha256', process.env.RESEND_WEBHOOK_SECRET!)
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
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1746619200

{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "リクエスト数が上限に達しました。しばらく経ってから再試行してください。",
    "request_id": "req_xyz789"
  }
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

```typescript
// src/lib/api/error-handler.ts

export function handleApiError(error: unknown): NextResponse<ApiErrorResponse> {
  // 認証エラー
  if (error instanceof AuthError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, request_id: getRequestId() } },
      { status: 401 }
    );
  }
  // 権限エラー
  if (error instanceof PermError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, request_id: getRequestId() } },
      { status: 403 }
    );
  }
  // Zod バリデーションエラー
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      {
        error: {
          code: 'VALID_REQUIRED_FIELD',
          message: '入力内容に誤りがあります',
          request_id: getRequestId(),
          fields: error.errors.map(e => ({
            field: e.path.join('.'),
            code: 'VALID_' + e.code.toUpperCase(),
            message: e.message,
          })),
        }
      },
      { status: 422 }
    );
  }
  // 予期しないエラー
  Sentry.captureException(error);
  return NextResponse.json(
    { error: { code: 'SYS_INTERNAL_ERROR', message: '内部エラーが発生しました', request_id: getRequestId() } },
    { status: 500 }
  );
}
```

---

## 14. テスト方針

| テスト種別 | 対象 | ツール |
|---------|------|------|
| Unit | `encodeCursor` / `decodeCursor`, `handleApiError`, `verifyStripeWebhook` | Vitest |
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
