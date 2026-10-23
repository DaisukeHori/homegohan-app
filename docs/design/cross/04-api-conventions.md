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
| `OP_` | 運営管理ドメイン固有 | 400, 403, 404, 409, 410, 422, 500 |
| `BILL_` | 課金の自己サービス (購入・解約の予約・Billing Portal。`docs/design/billing/01-billing-core.md` §13.1) | 400, 403, 404, 409, 422 |
| `DSR_` | 個人情報の請求 (開示・訂正・利用停止・消去。`docs/design/cross/15-data-subject-requests.md` §13) | 400, 409, 410, 422 |
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
| `AUTH_SESSION_NOT_FOUND` | **[NEW]** 指定した端末のログイン (セッション) が無い・終わっている・本人のものでない (`DELETE /api/auth/sessions/{id}`・`PATCH /api/auth/sessions/current`。`cross/16-auth-history-sessions.md` §19) | 404 |
| `AUTH_SESSION_IS_CURRENT` | **[NEW]** いま使っている端末のセッションを一覧から失効させようとした (ログアウトを使う。`cross/16-auth-history-sessions.md` §19) | 409 |
| `AUTH_CURRENT_PASSWORD_MISMATCH` | **[NEW]** パスワードの変更で、現在のパスワードが違う (`POST /api/auth/password/change`。`cross/16-auth-history-sessions.md` §19) | 400 |
| `AUTH_RECOVERY_SESSION_REQUIRED` | **[NEW]** パスワードの再設定を、再設定メールのリンク / コードで作ったセッション (amr に 60 分以内の recovery / otp) 以外から呼んだ (`POST /api/auth/password/reset`。`cross/16-auth-history-sessions.md` §14.7・§19) | 403 |
| `AUTH_REAUTHENTICATION_REQUIRED` | **[NEW]** GoTrue が再認証 (nonce) を求めた (`secure_password_change` が ON のとき。`POST /api/auth/password/change`・`/reset`。`cross/16-auth-history-sessions.md` §19) | 403 |
| `AUTH_PASSWORD_NOT_SET` | **[NEW]** パスワードでログインしていない (Google / Apple だけ) か、比べられない形のパスワードで、変更できない (`POST /api/auth/password/change` だけ。再設定は返さない。`cross/16-auth-history-sessions.md` §11.5・§19) | 409 |
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
| `AI_FEATURE_NOT_IN_PLAN` | **[NEW]** ご利用中のプランでは使えない AI の機能 (`ai_plan_feature_caps` の daily_cap = 0。本文は平たい `{ error, code, feature }`・Retry-After なし。`docs/design/billing/03-paid-plans-and-iap.md` §13.1) | 403 |

#### VALID 系

| コード | 説明 | HTTP |
|--------|------|------|
| `VALID_REQUIRED_FIELD` | 必須フィールド欠如 | 422 |
| `VALID_EMAIL_FORMAT` | メールアドレス形式エラー | 422 |
| `VALID_PASSWORD_TOO_SHORT` | パスワード最小長未満 | 422 |
| `VALID_PASSWORD_BREACHED` | HIBP で漏洩確認済み | 422 |
| `VALID_PASSWORD_HISTORY` | 過去に使用済みパスワード | 422 |
| `VALID_PASSWORD_WEAK` | **[NEW]** パスワードが規則 (8 文字以上・英字と数字を含む・UTF-8 で 72 バイトまで (GoTrue の bcrypt の上限 #1864)。`validatePassword`) を満たさない、または GoTrue が弱いと判断した (`POST /api/auth/password/change`・`/reset`。`cross/16-auth-history-sessions.md` §19) | 422 |
| `VALID_FILE_TOO_LARGE` | ファイルサイズ超過 | 422 |
| `VALID_FILE_TYPE` | 許可されていないファイル形式 | 422 |
| `VALID_CURSOR_INVALID` | cursor パラメータ不正 | 422 |

#### CONFLICT 系

| コード | 説明 | HTTP |
|--------|------|------|
| `CONFLICT_OPTIMISTIC_LOCK` | 楽観的ロック失敗 (競合) | 412 |
| `CONFLICT_PRECONDITION_REQUIRED` | `If-Unmodified-Since` ヘッダ必須 | 428 |
| `CONFLICT_STALE_DATA` | WHERE 条件不一致 (0 行更新) | 409 |
| `CONFLICT_LICENSE_POOL_EXHAUSTED` | ライセンス残席不足 (ORG 系の `ORG_LICENSE_POOL_EXHAUSTED` と同じ意味。要件の記述で 2 つの名前が混在) | 409 |
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
| `EXT_STRIPE_API_FAILED` | **[NEW]** Stripe の API の呼び出しに失敗した (課金の自己サービスの API。`docs/design/billing/01-billing-core.md` §13.1) | 502 |
| `EXT_STRIPE_NOT_CONFIGURED` | **[NEW]** Stripe の秘密鍵 (`STRIPE_SECRET_KEY`) が未設定で、Stripe を呼ぶ課金の API を受け付けない (`docs/design/billing/01-billing-core.md` §13.1)。文は「お支払いを受け付けていません」(#1911) | 503 |
| `EXT_REVENUECAT_API_FAILED` | **[NEW]** RevenueCat の REST の呼び出しに失敗した (2xx 以外・応答の形の違い・時間切れ・接続の失敗。`POST /api/billing/iap/sync`。`docs/design/billing/03-paid-plans-and-iap.md` §13.1) | 502 |
| `EXT_REVENUECAT_NOT_CONFIGURED` | **[NEW]** RevenueCat の秘密の API キー (`REVENUECAT_SECRET_API_KEY`) が未設定で、ストアの契約を取り直せない (`POST /api/billing/iap/sync`。billing/03 §13.1) | 503 |
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

注: 家族の API の実コードは接頭辞なしの `MembershipErrorCode` (`src/lib/errors/membership-errors.ts`) を使う。保護者の同意は `PARENTAL_CONSENT_REQUIRED` (403)。ほかに `CHILD_BIRTH_DATE_REQUIRED` / `CHILD_BIRTH_DATE_INVALID` (400)・`PARENTAL_CONSENT_VERSION_MISMATCH` (409)・`PARENTAL_CONSENT_SIGNER_NOT_ADULT` (403)・`PROMOTION_UNDER_COPPA_AGE` (403)・`MINOR_ACCOUNT_NOT_ALLOWED` (403。家族と組織の API) (設計書 `docs/design/cross/14-parental-consent.md`)。家族プランの契約の無い代表者のグループの作成・メンバーの追加は `FAMILY_PLAN_REQUIRED` (**[NEW]** 402。`POST /api/family/groups`・`POST /api/family/invites/[id]/accept`・`POST /api/family/members/child`。`docs/design/billing/03-paid-plans-and-iap.md` §9.5・§13.1)。

#### LEGAL 系

利用規約・プライバシーポリシーの同意 (`docs/design/cross/08-legal-compliance.md` §7.2・`docs/design/cross/13a-legal-consent-api-server.md`)。

| コード | 説明 | HTTP |
|--------|------|------|
| `LEGAL_CONSENT_REQUIRED` | 規約への同意が必要 (middleware の `/api` の分岐が、未同意の人の API を止める。生年月日の未入力・保護者の同意とのつながりの無い 18 歳未満も止める (設計書 14)。本文は平たい形 `{ error, code }`) | 403 |
| `LEGAL_VERSION_MISMATCH` | 同意を送った版が、いま有効な版と違う (`POST /api/legal/accept`。本文に `current` を添える) | 409 |
| `LEGAL_BAD_REQUEST` | 同意の記録の入力が不正 (`POST /api/legal/accept`) | 400 |
| `LEGAL_UNSUPPORTED_MEDIA_TYPE` | 同意の記録の Content-Type が JSON でない (`POST /api/legal/accept`) | 415 |
| `LEGAL_BIRTH_DATE_REQUIRED` | 生年月日が未記録で、body に `birth_date` が無い (`POST /api/legal/accept`。設計書 14) | 400 |
| `LEGAL_BIRTH_DATE_INVALID` | 生年月日が暦に無い日・未来・120 年超 (`POST /api/legal/accept`。設計書 14) | 400 |
| `LEGAL_MINOR_SELF_SIGNUP_REFUSED` | 13 歳未満、または保護者の同意とのつながりの無い 18 歳未満の自己登録 (`POST /api/legal/accept`。何も記録しない。設計書 14) | 403 |
| `CSP_REPORT_INVALID` | **[NEW]** CSP の違反の報告の本文の形が不正 (`POST /api/csp-report`。cross/18 §9.10) | 400 |
| `CSP_REPORT_TOO_LARGE` | **[NEW]** CSP の違反の報告の本文が大きすぎる (`POST /api/csp-report`。cross/18 §9.10) | 413 |
| `CSP_REPORT_UNSUPPORTED_MEDIA_TYPE` | **[NEW]** CSP の違反の報告の Content-Type が `application/csp-report` / `application/json` でない (`POST /api/csp-report`。cross/18 §9.10) | 415 |

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

#### CHALLENGE 系

組織チャレンジ (`/api/org/challenges`・`/api/org/challenges/[id]`・`/api/org/challenges/[id]/join`。`docs/design/org/07-challenge.md` §15・`docs/design/org/10-challenge-diff-privacy.md` §11 が canonical)。接頭辞は `ORG_` ではなく `CHALLENGE_`。管理者向けの route (`src/app/api/org/challenges/route.ts`) は平たい形 `{ error, code }`、メンバー向けの route (`[id]`・`[id]/join`) は nested `{ error: { code, message } }` (`src/lib/org-challenge-api.ts` の `challengeError`)。

| コード | 説明 | HTTP |
|--------|------|------|
| `CHALLENGE_TYPE_DISABLED` | 食事の記録から計算できない種類 (歩数・体重・カスタム) のチャレンジの作成・開始・参加 (`POST /api/org/challenges` の作成 `route.ts:163`・`PUT /api/org/challenges` の active への変更 `route.ts:284`・`POST /api/org/challenges/[id]/join` の参加 `[id]/join/route.ts:55`) | 400 (作成・開始) / 409 (参加) |
| `CHALLENGE_STATUS_LOCKED` | **[NEW]** 状態の変更が遷移表 (draft → active / completed / cancelled、active → completed / cancelled) に無い (終わった状態から・active → draft・NULL へ)。`PUT /api/org/challenges` は今の行を読んで先に断り (`route.ts:277`)、読んでから書くまでに変わった場合は DB のトリガー `org_challenge_guard_update` の RAISE (P0001。`supabase/migrations/20261016240000_org_challenge_diff_privacy.sql:151`) を写す (`route.ts:306`〜`:308`。`mapChallengeLockError`)。PostgREST の直接の UPDATE では RAISE の文のまま 4xx。API の PUT は NULL を先に `INVALID_STATUS` (400) で断る | 409 (API) |
| `CHALLENGE_PERIOD_LOCKED` | **[NEW]** draft 以外での `start_date` / `end_date` / `challenge_type` / `department_id` の変更と、常時の `organization_id` の変更 (DB のトリガー `org_challenge_guard_update` の RAISE。P0001。`20261016240000_org_challenge_diff_privacy.sql:157`・`:166`)。PostgREST の直接の UPDATE では RAISE の文のまま 4xx。`PUT /api/org/challenges` は止める列を書かないので実際には返らないが、返ったときは 409 に写す (`route.ts:306`〜`:308`) | 409 (API) |
| `CHALLENGE_NOT_FOUND` | チャレンジが無い・id が uuid でない・別の組織のもの (`POST /api/org/challenges/[id]/join` `[id]/join/route.ts:36`)。`GET /api/org/challenges/[id]` (`[id]/route.ts:49`) は、active / completed でないもの・食事の記録から計算できない種類のもの・別の部署向けのものも同じ 404 にする (`[id]/route.ts:63`。`isVisibleToMember`) | 404 |
| `CHALLENGE_NOT_ACTIVE` | 開催中 (active) でないチャレンジへの参加 (`[id]/join/route.ts:58`) | 409 |
| `CHALLENGE_ENDED` | 終了日 (JST) を過ぎたチャレンジへの参加 (`[id]/join/route.ts:62`) | 409 |

注: 状態・期間の変更を断る 2 つのコードの本文の文は同じ (`このチャレンジの状態は変えられません`。`route.ts:24` の `CHALLENGE_LOCKED_MESSAGE`)。409 は `src/lib/org-challenge-privacy.ts` の `ORG_CHALLENGE_LOCK_HTTP_STATUS`。

注: 同じ route は、上の表の `CHALLENGE_` のコードのほかに、次の接頭辞の無いコードを返す。route と、route が呼ぶ共通の関数が本文の `code` に入れるものは、上の表とこの一覧で全部:

- 管理者向けの route (`route.ts`。平たい形 `{ error, code }`):
  - `INVALID_CHARACTER` (400): 本文の文字列に NULL 文字 (U+0000) がある。作成・更新の最初に断る (`route.ts:134`・`:236` の `rejectNullCharacterBody`。コードは `src/lib/api/null-character.ts` の `NULL_CHARACTER_ERROR_CODE`)
  - `INVALID_PERIOD` (400): 作成の開始日・終了日が `YYYY-MM-DD` の形でない・開始日が終了日より後・タイトルが文字列でない (`route.ts:167`〜`:171`)
  - `INVALID_TARGET` (400): 作成で目標値を指定したとき、数でない・種類ごとの範囲 (`ORG_CHALLENGE_TYPE_META` の `targetMin`〜`targetMax`) の外 (`route.ts:177`)
  - `INVALID_STATUS` (400): 更新の status が DB の受け付けない値・NULL (`route.ts:256`)
  - このほかの 4xx・5xx (未ログインの 401・管理者でないときの 403・本文が JSON として読めないときなどの 400・500) は `code` の無い `{ error }` だけ (`route.ts:42`〜`:51` の `handleError` ほか)。`error` は日本語の固定の文 (401 / 403 / 500 は `src/lib/org-api-errors.ts` の `orgAuthFailureFlat` と定数。例外の文面は入れない)
- メンバー向けの route (`[id]/route.ts`・`[id]/join/route.ts`。nested の形 `{ error: { code, message } }`):
  - `PERM_DEPARTMENT_MISMATCH` (403): 別の部署の人向けのチャレンジへの参加 (`[id]/join/route.ts:52`)
  - `FORBIDDEN` (403): 参加の INSERT が行レベルセキュリティに拒否された (42501。確認のあとで所属・部署・状態が変わったとき。`[id]/join/route.ts:75`)
  - 共通の `handleMemberError` (`src/lib/org-challenge-api.ts:209`) が返す `UNAUTHORIZED` (401。未ログイン)・`FORBIDDEN` (403。組織に所属していない)・`INTERNAL_ERROR` (500)

#### OP 系

| コード | 説明 | HTTP |
|--------|------|------|
| `OP_PLAN_NOT_FOUND` | プランが見つからない | 404 |
| `OP_FEATURE_FLAG_NOT_FOUND` | 機能フラグが見つからない | 404 |
| `OP_TICKET_NOT_FOUND` | チケットが見つからない | 404 |
| `OP_SUBSCRIPTION_ALREADY_ACTIVE` | サブスクリプションが既にアクティブ | 409 |
| `OP_PLAN_NOT_GRANTABLE` | **[NEW]** 手動付与できないプラン (`free`・`org`・`private` のアドオン・`draft`・`deprecated`・存在しない `plan_key`。`POST /api/super-admin/users/{id}/manual-plan`。`billing/02-manual-plan-grant.md` §12.1) | 422 |
| `OP_NO_MANUAL_SUBSCRIPTION` | **[NEW]** 取り消す手動付与の行が無い (Stripe の契約だけ・契約なし・取り消し済み。`DELETE /api/super-admin/users/{id}/manual-plan`。`billing/02-manual-plan-grant.md` §12.1) | 409 |
| `OP_SELF_MODIFY` | **[NEW]** 自分自身を対象にできない運営の操作 (`POST /api/super-admin/admins/{id}/mfa/reset` と `POST` / `DELETE /api/super-admin/users/{id}/manual-plan`。実コードが先に使っていた。`cross/12-operator-mfa.md`・`billing/02-manual-plan-grant.md` §12.1) | 403 |
| `OP_EMAIL_OUTBOX_NOT_FOUND` | **[NEW]** 再送するメール (送信待ちの行) が見つからない (`operator/10-logs-and-mail-retry.md` §11) | 404 |
| `OP_EMAIL_OUTBOX_NOT_REQUEUEABLE` | **[NEW]** 再送できないメール (届けられなかった行でない `not_dead`・宛先を伏せた行 `redacted`。`details.reason`。`operator/10-logs-and-mail-retry.md` §11) | 409 |
| `OP_CONTENT_HIDE_FAILED` | **[NEW]** 通報されたコンテンツを隠せなかった。判定を保存せず BAN もしない (`POST` / `PUT /api/admin/moderation/{type}/{id}`。`operator/02-api-spec.md` §5) | 500 |
| `OP_CONTENT_GONE` | **[NEW]** 戻す対象のコンテンツが無い (通報に紐づかない・持ち主が消した・完全削除された) (`POST /api/admin/moderation/{type}/{id}/restore`。`operator/13-hidden-content-restore.md` §11) | 410 |
| `OP_CONTENT_NOT_HIDDEN` | **[NEW]** 戻す対象がすでに表示されている | 409 |
| `OP_CONTENT_RESTORE_WINDOW_EXPIRED` | **[NEW]** 隠してから 89 日を過ぎて戻せない (保管期間 90 日の完全削除を待つ) | 409 |
| `OP_CONTENT_RESTORE_FAILED` | **[NEW]** 通報は承認済みにしたが行を戻せなかった。やり直せる | 500 |

#### BILL 系

課金の自己サービス (`/api/billing/*`。`docs/design/billing/01-billing-core.md` §9・§13.1)。本文の文は `src/lib/billing/core.ts` の `BILLING_ERROR_MESSAGES`。

| コード | 説明 | HTTP |
|--------|------|------|
| `BILL_INVALID_INPUT` | **[NEW]** 入力が不正 (Zod。`details` に全件) | 400 |
| `BILL_CHECKOUT_SESSION_MISMATCH` | **[NEW]** 戻り画面の同期 (`POST /api/billing/checkout/sync`) で、Checkout Session が本人のものでない | 403 |
| `BILL_CUSTOMER_NOT_FOUND` | **[NEW]** Stripe の顧客がまだ無い (一度も購入していない。`POST /api/billing/portal`) | 404 |
| `BILL_NO_LIVE_SUBSCRIPTION` | **[NEW]** 解約の予約・取り消しの対象になる、有効で Stripe の契約がある行が無い (`POST /api/billing/subscription/cancel` / `resume`) | 409 |
| `BILL_CANCEL_NOT_SCHEDULED` | **[NEW]** 解約が予約されていないのに取り消そうとした (`POST /api/billing/subscription/resume`) | 409 |
| `BILL_PLAN_NOT_PURCHASABLE` | **[NEW]** 買えないプラン (無い・公開でない・個人 / 家族でない・free・その期間の Price が無い・金額 0。`POST /api/billing/checkout`・`GET /api/billing/checkout/preview`) | 422 |
| `BILL_IAP_INVALID_INPUT` | **[NEW]** アプリ内課金のカタログのクエリ `store` が無い・`app_store` / `play_store` 以外 (`GET /api/billing/iap/catalog`。`docs/design/billing/03-paid-plans-and-iap.md` §13.1) | 400 |
| `BILL_IAP_SYNC_CONFLICT` | **[NEW]** ストアの契約を写そうとしたが、同じ利用者に別の live な契約 (Stripe・手動付与・別のストア) がある (`POST /api/billing/iap/sync`。DB の `BILL_LIVE_ROW_CONFLICT` の写し。billing/03 §13.1) | 409 |
| `BILL_IAP_UNKNOWN_PRODUCT` | **[NEW]** ストアの live な商品が `plan_store_products` に無く、利用者の行も無い (`POST /api/billing/iap/sync`。billing/03 §13.1) | 422 |

#### DSR 系

個人情報の請求 (`/api/account/data-requests/**`・`/api/admin/data-requests/**`。`docs/design/cross/15-data-subject-requests.md` §7・§13 が canonical)。本人向けの route は平たい形 `{ error, code }`、運営向けの route は nested `{ error: { code, message } }`。

| コード | 説明 | HTTP |
|--------|------|------|
| `DSR_ALREADY_OPEN` | **[NEW]** 同じ種類の請求がすでに開いている (本人の作成。部分一意索引の 23505) | 409 |
| `DSR_INVALID_STATE` | **[NEW]** 請求の状態がその操作を受け付けない (本人の確認・再送・取り下げ。判定の後に状態が変わって UPDATE が 0 行のときも) | 409 |
| `DSR_VERIFICATION_INVALID` | **[NEW]** 本人確認のリンクのトークンが一致しない | 400 |
| `DSR_VERIFICATION_EXPIRED` | **[NEW]** 本人確認のリンクの期限が切れている | 410 |
| `DSR_VERIFICATION_LIMIT` | **[NEW]** 本人確認のメールの送信回数の上限 | 409 |
| `DSR_INVALID_TRANSITION` | **[NEW]** 運営の更新が状態遷移表に無い (同じ状態の指定・本人確認待ち / 終わった請求への更新を含む。`PATCH /api/admin/data-requests/{id}`) | 409 |
| `DSR_RESPONSE_NOTE_REQUIRED` | **[NEW]** 対応済み・対応できずにするのに本人への応答が空 (`PATCH /api/admin/data-requests/{id}`) | 422 |

運営の更新 (`PATCH /api/admin/data-requests/{id}`) は、上の CONFLICT 系の 3 コードを楽観的ロックに使う: `If-Unmodified-Since` が無い → `CONFLICT_PRECONDITION_REQUIRED` (428)、GET が返した `updated_at` と行が違う → `CONFLICT_OPTIMISTIC_LOCK` (412)、条件つきの UPDATE が 0 行 → `CONFLICT_STALE_DATA` (409)。ヘッダの値は GET が返した `updated_at` の文字列そのまま (HTTP-date ではない。cross/15 §7.4)。

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

**(b) nested**: `error.message` を読むクライアント向け。運営 API (`/api/super-admin/**` など) は `internalError(..., { shape: 'nested' })` でこの形の 500 を返す。組織・家族の所属の操作の API (招待の承諾・辞退・取り消し・脱退・除名・代表者やオーナーの譲渡など。`/api/org/**`・`/api/family/**` のうち `MembershipErrorCode` を返すもの) の 4xx もこの形で、`code` は `MembershipErrorCode` (`src/lib/errors/membership-errors.ts`) の値 (同じ配下でも、一覧の取得などは (a) flat の `{ error: 'この操作を行う権限がありません' }` などを返す route がある。`/api/org/**` の失敗の文はどちらの形でも日本語の固定の文で、英語の文・例外の文面 (`err.message`) を入れない。一覧の取得などの route (flat・nested の両方) は 401 / 403 / 500 の文を `src/lib/org-api-errors.ts` から取る。招待の作成・取り消し・除名など所属の操作の route (`src/app/api/org/invites/route.ts:84`・`:88`・`invites/[id]/revoke/route.ts:25`・`:31`・`members/route.ts:57`・`:61`・`members/[user_id]/remove/route.ts:21`・`:27`) は、401 `NOT_AUTHENTICATED`「認証が必要です」・403 `INSUFFICIENT_PERMISSION` (操作ごとの文) を route に直書きし、`org-api-errors.ts` を通らない (500 の文はどちらも同じ汎用の文。`src/lib/api/errors.ts` の `INTERNAL_ERROR_MESSAGE`)。見張りは `tests/org-api-error-japanese.test.ts`)。`message` は操作ごとの固定の文なので、画面は `membershipErrorMessageOfBody` で `code` から理由の文を引く。

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

認可の失敗 (401 / 403) の本文で例外の文面 (`err.message`) や英語の文を返している route は、直すときに共通の関数 `authFailureFlat` / `authFailureNested` (`src/lib/api/error-responses.ts`。#1917) で作る (既に日本語の固定の文を返している route (`OP_PERMISSION_DENIED` に `権限がありません` など) はそのままでよい。`message` / `error` は日本語の固定の文で、`AuthError` / `ForbiddenError` の文面 (`requireRole` の `Requires one of: …` など) は入れない。403 の文は `ForbiddenError` の `code` ごとの表で決め、既定の表は凍結・二段階認証・組織に所属していないの文を持つ。nested の `code` は従来の route の code を変えないように、401 と 403 で別々に `'http'` (`UNAUTHORIZED` / `FORBIDDEN`)・`'error'` (例外の `code`)・`{ fixed: '<コード>' }` (`UNAUTHENTICATED`・`OP_PERMISSION_DENIED` など) から選ぶ (admin の営業・問い合わせの形 = 401 は例外の `code`・403 は `OP_PERMISSION_DENIED`、会計の形 = 401 は `UNAUTHENTICATED`・403 は `OP_PERMISSION_DENIED` は同じファイルの定数)。400 (JSON が読めない)・404・409・500 の固定の文の定数も同じファイル。`src/lib/org-api-errors.ts` はこの上に載せた /api/org の包み)。英語だけの文・例外の文面が本文に無いことは、`tests/api-error-japanese-scan.test.ts` が直し終えた配下 (`tests/helpers/api-error-japanese-scope.ts` の `JAPANESE_ERROR_API_DIRS`) の route を走査して見張り、一覧の外の配下の違反の件数は同じファイルの基線と一致することを番兵が確かめる (走査の部品は `tests/helpers/api-error-text-scan.ts`)。

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
> Stripe の受け口 (`src/app/api/webhooks/stripe/route.ts`) も実装済み。正本は `docs/design/billing/01-billing-core.md` §8.3 (署名) と §9.6 (受け口)。
> 署名はヘッダー `Stripe-Signature` の `t=<UNIX 秒>,v1=<hex>` の形で、HMAC-SHA256 の入力は「t.受け取った本文そのまま」、鍵は署名の秘密
> (`whsec_…`) の文字列のまま (Svix と違い base64 に戻さない)。時刻の許容幅は Resend と同じ前後 5 分。`src/lib/webhook/verify.ts` の
> `parseStripeSignatureHeader`・`verifyStripeSignature`・`verifyStripeWebhook` が受け持ち、Stripe の SDK は使わない。route は秘密
> (`STRIPE_WEBHOOK_SECRET`。`src/lib/env.ts` の一覧にある) が無ければ 503、署名が合わなければ 401 を返す。下の見本の Stripe の部分は使わない。

```typescript
// src/lib/webhook/verify.ts の見本 (Resend と Stripe の実装は上の注を参照。実装が正)
import { getOptionalEnv } from '@/lib/env';

/**
 * 署名の秘密が無いときに投げる。署名の誤り (呼び出し元は 400) と見分けるため、別の型にする。
 * 呼び出し元の route は、これを 503 にし、署名の誤りの 401 と分ける
 * (Resend と Stripe の受け口。上の注・billing/01-billing-core.md §9.6)。
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
 * (STRIPE_WEBHOOK_SECRET・RESEND_WEBHOOK_SECRET とも一覧にある。上の注を参照)。
 * 無ければ署名を確かめられないので、受け付けずに失敗させる (fail-closed)。
 * message に変数名を入れない (500 の本文に出うるため。変数名は getOptionalEnv が警告のログに残す)。
 */
function requireWebhookSecret(name: 'STRIPE_WEBHOOK_SECRET' | 'RESEND_WEBHOOK_SECRET'): string {
  const secret = getOptionalEnv(name);
  if (!secret) throw new WebhookSecretMissingError();
  return secret;
}

// Stripe: verifyStripeWebhook(payload, header) は SDK を使わず t=/v1= の HMAC を自前で確かめる (billing/01-billing-core.md §8.3)。
// 見本は置かない (実装 src/lib/webhook/verify.ts が正)

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

Stripe は `stripe_webhook_events` (主キー = Stripe の `event.id`) に対して、DB 関数 `billing_claim_stripe_event` で処理の権利を取ってから処理する
(`docs/design/billing/01-billing-core.md` §9.6)。

```sql
-- Stripe webhook の処理の権利を取る (service_role だけが EXECUTE できる)
SELECT public.billing_claim_stripe_event($1 /* event.id */, $2 /* event.type */, $3 /* 最小化した写し */);
-- 'claimed'     = この呼び出しが処理する → 処理のあと billing_finish_stripe_event で completed / failed を記録
-- 'completed'   = 処理済み → 200 OK 返却
-- 'in_progress' = ほかが処理中 (15 分以内) → 409 (Stripe が後で再送する)
```

2xx を返すのは、イベントが処理済み (`completed`) になったときだけ (この呼び出しで処理を終えた・すでに処理済み。鍵とモードの違うイベントを DB に書かずに無視するときも 200)。
ほかが処理中なら 409、処理に失敗したら 500 を返して Stripe に再送させる (`failed` と、15 分を過ぎた `processing` の行は再送で権利を取り直せる)。

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
| Webhook べき等性テーブル (`processed_stripe_events`) の DDL | 済み | `stripe_webhook_events` と `billing_claim_stripe_event` で入った (billing/01-billing-core.md §6.3・§6.4・§9.6) |
| レスポンス圧縮 (gzip / Brotli) の Next.js 設定確認 | TODO | Phase 1 リリース前 |
