# 09 — API 詳細仕様

> 関連: [01-trigger-flow](./01-trigger-flow.md) / [08-state-db](./08-state-db.md) / [17-security](./17-security.md) / [22-analytics](./22-analytics.md)

---

## 1. エンドポイント一覧

family/02-api-spec.md (canonical) に追記する API の **proposal**。実装時は family/02 に書き、本ファイルは詳細補助とする。

| Method | Path | 用途 | 新規/拡張 |
|---|---|---|---|
| GET | `/api/handson-tour/status` | 表示可否判定 | **新規** |
| POST | `/api/handson-tour/complete` | 完了登録 + tutorial_complete 付与 | **新規** |
| POST | `/api/handson-tour/skip` | 明示スキップ登録 | **新規** |
| POST | `/api/meal-plans/add-from-photo` | sandbox 対応拡張 (`?source=handson_tour`, `body.sandbox=true`) | **拡張** |
| POST | `/api/menu-plans/add` | 同上 | **拡張** |
| GET | `/api/badges` | tutorial_complete を含む 14 件返却 (新規バッジ追加のみ、API は変更なし) | **データ変更のみ** |
| POST | `/api/onboarding/complete` | レスポンスに `next_route` 追加 | **拡張** |

---

## 2. `GET /api/handson-tour/status`

### 2.1 役割
表示可否判定。クライアントはマウント時にこの API を呼び、`should_show=false` なら即 `/home` へリダイレクト。

### 2.2 Request

```http
GET /api/handson-tour/status HTTP/1.1
Authorization: Bearer <jwt>
```

- Headers: `Authorization` (Supabase auth)
- Query: なし
- Body: なし

### 2.3 Response 200 schema

```ts
import { z } from 'zod';

export const HandsonTourStatusResponseSchema = z.object({
  should_show: z.boolean(),
  completed_at: z.string().datetime().nullable(),
  skipped_at: z.string().datetime().nullable(),
  /** 何故表示しないかの理由 (analytics 用) */
  reason: z.enum([
    'eligible',           // should_show: true
    'onboarding_not_completed',
    'already_completed',
    'already_skipped',
    'admin_role',
    'existing_user_auto_skip',
    'feature_disabled',   // §19-rollout: Feature flag OFF
    'not_in_rollout',     // §19-rollout: 段階公開対象外
  ]),
});

export type HandsonTourStatusResponse = z.infer<typeof HandsonTourStatusResponseSchema>;
```

### 2.4 Response 例

```json
{
  "should_show": true,
  "completed_at": null,
  "skipped_at": null,
  "reason": "eligible"
}
```

```json
{
  "should_show": false,
  "completed_at": "2026-05-08T10:30:00.000Z",
  "skipped_at": null,
  "reason": "already_completed"
}
```

### 2.5 サーバー処理

```ts
// src/app/api/handson-tour/status/route.ts
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase/server';

export async function GET(req: Request) {
  const supabase = await getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  // profile 取得
  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('onboarding_completed_at, handson_tour_completed_at, handson_tour_skipped_at, roles')
    .eq('user_id', user.id)
    .single();

  if (error || !profile) {
    return Response.json({ error: { code: 'profile_not_found' } }, { status: 404 });
  }

  // ロール判定 (D)
  const adminRoles = ['admin', 'super_admin', 'org_admin', 'org_industrial_doctor'];
  const hasAdminRole = profile.roles?.some((r: string) => adminRoles.includes(r));
  if (hasAdminRole) {
    return Response.json({
      should_show: false,
      completed_at: profile.handson_tour_completed_at,
      skipped_at: profile.handson_tour_skipped_at,
      reason: 'admin_role',
    });
  }

  // onboarding 未完 (A)
  if (!profile.onboarding_completed_at) {
    return Response.json({
      should_show: false,
      completed_at: null,
      skipped_at: null,
      reason: 'onboarding_not_completed',
    });
  }

  // 完了済 / スキップ済 (B)
  if (profile.handson_tour_completed_at) {
    return Response.json({
      should_show: false,
      completed_at: profile.handson_tour_completed_at,
      skipped_at: null,
      reason: 'already_completed',
    });
  }
  if (profile.handson_tour_skipped_at) {
    return Response.json({
      should_show: false,
      completed_at: null,
      skipped_at: profile.handson_tour_skipped_at,
      reason: 'already_skipped',
    });
  }

  // 既存ユーザー (C) チェック
  const { data: existingActivity } = await supabase
    .rpc('user_has_non_sandbox_activity', { p_user_id: user.id });

  if (existingActivity) {
    // auto-skip
    await supabase
      .from('user_profiles')
      .update({ handson_tour_skipped_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .is('handson_tour_skipped_at', null);

    return Response.json({
      should_show: false,
      completed_at: null,
      skipped_at: new Date().toISOString(),
      reason: 'existing_user_auto_skip',
    });
  }

  return Response.json({
    should_show: true,
    completed_at: null,
    skipped_at: null,
    reason: 'eligible',
  });
}
```

### 2.6 補助 SQL 関数 (Supabase RPC)

```sql
CREATE OR REPLACE FUNCTION user_has_non_sandbox_activity(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM meal_logs WHERE user_id = p_user_id AND is_sandbox = false LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM weekly_menus WHERE user_id = p_user_id AND is_sandbox = false LIMIT 1
  );
END;
$$;
```

### 2.7 Rate Limit

| 観点 | 値 |
|---|---|
| user 単位 | 60 req / 60 s (cross/04 デフォルト) |
| IP 単位 | 600 req / 60 s (cross/04 デフォルト) |

### 2.8 エラーレスポンス

| status | code | 状況 |
|---|---|---|
| 401 | unauthorized | JWT 不正 |
| 404 | profile_not_found | profile 未作成 (= sign up 直後で profile 行未生成) |
| 429 | rate_limited | rate limit 超過 |
| 500 | internal_error | DB エラー等 |

---

## 3. `POST /api/handson-tour/complete`

### 3.1 役割
Step 4 卒業時の完了登録 + `tutorial_complete` バッジ付与。

### 3.2 Request

```http
POST /api/handson-tour/complete HTTP/1.1
Authorization: Bearer <jwt>
Content-Type: application/json

{}
```

- Body: 空オブジェクト (将来拡張のため)
- Idempotency-Key: 不要 (UPDATE 自体が冪等)

### 3.3 Response 200 schema

```ts
export const HandsonTourCompleteResponseSchema = z.object({
  completed_at: z.string().datetime(),
  badge_awarded: z.object({
    code: z.literal('tutorial_complete'),
    name: z.string(),
    obtained_at: z.string().datetime(),
    icon_url: z.string().nullable(),
  }),
  /** 既に過去に完了済だったか (force=1 再実行時 true) */
  already_completed: z.boolean(),
  /** ハンズオン全体の所要時間 (Step 0 開始から API 受信時刻まで、クライアント計測) */
  total_duration_ms: z.number().int().optional(),
});
```

### 3.4 Response 例 (新規完了)

```json
{
  "completed_at": "2026-05-08T10:31:30.123Z",
  "badge_awarded": {
    "code": "tutorial_complete",
    "name": "使い方マスター",
    "obtained_at": "2026-05-08T10:31:30.123Z",
    "icon_url": null
  },
  "already_completed": false
}
```

### 3.5 Response 例 (force=1 再実行)

```json
{
  "completed_at": "2026-05-08T10:31:30.123Z",
  "badge_awarded": {
    "code": "tutorial_complete",
    "name": "使い方マスター",
    "obtained_at": "2026-05-08T10:31:30.123Z",
    "icon_url": null
  },
  "already_completed": true
}
```

### 3.6 サーバー処理 (トランザクション)

```ts
export async function POST(req: Request) {
  const supabase = await getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  // ロール / condition C 確認 (POST は status と同じガード)
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('roles, handson_tour_completed_at')
    .eq('user_id', user.id)
    .single();
  if (!profile) return Response.json({ error: { code: 'profile_not_found' } }, { status: 404 });

  const adminRoles = ['admin', 'super_admin', 'org_admin', 'org_industrial_doctor'];
  if (profile.roles?.some((r: string) => adminRoles.includes(r))) {
    return Response.json({ error: { code: 'not_eligible', reason: 'admin_role' } }, { status: 403 });
  }

  // condition C はオプショナル: 既存ユーザーが force=1 でハンズオンした場合は許容する判断もあり
  // v1: condition C 違反は 409 (= ハンズオン対象外)
  const { data: existingActivity } = await supabase
    .rpc('user_has_non_sandbox_activity', { p_user_id: user.id });
  if (existingActivity && !profile.handson_tour_completed_at) {
    return Response.json({ error: { code: 'not_eligible', reason: 'existing_user' } }, { status: 409 });
  }

  // 一括トランザクション (RPC 関数で実装)
  const { data: result, error } = await supabase.rpc('complete_handson_tour', {
    p_user_id: user.id,
  });

  if (error) {
    return Response.json({ error: { code: 'internal_error', message: error.message } }, { status: 500 });
  }

  return Response.json(result);
}
```

### 3.7 `complete_handson_tour` RPC (Supabase function)

```sql
CREATE OR REPLACE FUNCTION complete_handson_tour(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_completed_at timestamptz;
  v_was_already boolean;
  v_badge_id uuid;
  v_badge_obtained_at timestamptz;
  v_badge_icon_url text;
  v_badge_name text;
BEGIN
  -- 1. profile UPDATE (冪等)
  UPDATE user_profiles
  SET handson_tour_completed_at = COALESCE(handson_tour_completed_at, now())
  WHERE user_id = p_user_id
  RETURNING handson_tour_completed_at INTO v_completed_at;

  v_was_already := (v_completed_at < now() - INTERVAL '1 second');

  -- 2. badge INSERT (冪等)
  SELECT id, name, icon_url INTO v_badge_id, v_badge_name, v_badge_icon_url
  FROM badges WHERE code = 'tutorial_complete';

  INSERT INTO user_badges (user_id, badge_id, obtained_at)
  VALUES (p_user_id, v_badge_id, now())
  ON CONFLICT (user_id, badge_id) DO NOTHING;

  SELECT obtained_at INTO v_badge_obtained_at
  FROM user_badges WHERE user_id = p_user_id AND badge_id = v_badge_id;

  RETURN jsonb_build_object(
    'completed_at', v_completed_at,
    'badge_awarded', jsonb_build_object(
      'code', 'tutorial_complete',
      'name', v_badge_name,
      'obtained_at', v_badge_obtained_at,
      'icon_url', v_badge_icon_url
    ),
    'already_completed', v_was_already
  );
END;
$$;
```

### 3.8 Response 4xx / 5xx

| status | code | 状況 |
|---|---|---|
| 401 | unauthorized | JWT 不正 |
| 403 | not_eligible (admin_role) | 特権ロール |
| 404 | profile_not_found | profile 未作成 |
| 409 | not_eligible (existing_user) | 既存ユーザー (condition C) |
| 429 | rate_limited | rate limit 超過 |
| 500 | internal_error | DB エラー等 |

### 3.9 Rate Limit

```
6 req / 60 s / user
```

通常は 1 回のみ呼ばれる API。連打しても 6 回までで 429 を返す。

---

## 4. `POST /api/handson-tour/skip`

### 4.1 役割
明示スキップ (【あとで】タップ) の登録。

### 4.2 Request

```http
POST /api/handson-tour/skip HTTP/1.1
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "step": 0,
  "reason": "user_action"
}
```

```ts
export const HandsonTourSkipRequestSchema = z.object({
  step: z.number().int().min(0).max(4),  // どこでスキップしたか
  reason: z.enum(['user_action', 'hard_back']),
});
```

### 4.3 Response 200

```ts
export const HandsonTourSkipResponseSchema = z.object({
  skipped_at: z.string().datetime(),
});
```

### 4.4 サーバー処理

```ts
export async function POST(req: Request) {
  const body = HandsonTourSkipRequestSchema.parse(await req.json());
  const supabase = await getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const skippedAt = new Date().toISOString();

  await supabase
    .from('user_profiles')
    .update({ handson_tour_skipped_at: skippedAt })
    .eq('user_id', user.id)
    .is('handson_tour_skipped_at', null)
    .is('handson_tour_completed_at', null);  // 完了済なら skipped_at セットしない

  // skip event は API 内でも fire (analytics 自前)
  await logSkipEvent(user.id, body.step, body.reason);

  return Response.json({ skipped_at: skippedAt });
}
```

### 4.5 Rate Limit

```
12 req / 60 s / user
```

### 4.6 Response 4xx / 5xx

| status | code | 状況 |
|---|---|---|
| 401 | unauthorized | JWT 不正 |
| 400 | validation_error | body schema 不正 (step / reason の値が範囲外等) |
| 404 | profile_not_found | profile 未作成 |
| 429 | rate_limited | rate limit 超過 |
| 500 | internal_error | DB エラー等 |

注: admin / org_admin 等の特権ロールでも skip API は呼べる (= UI 上の skip 動線は出さないが、サーバー側でのスキップ登録は許容)。403 を返さない。

---

## 5. 既存 API 拡張

### 5.1 `POST /api/meal-plans/add-from-photo`

#### 既存 Request (推測)

```ts
type ExistingRequest = {
  dishName: string;
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  photo_url?: string | null;
  eaten_at?: string;
  meal_type?: 'breakfast' | 'lunch' | 'dinner' | 'snack';
};
```

#### 拡張後

```ts
type ExtendedRequest = ExistingRequest & {
  /** ハンズオンサンドボックス用フラグ */
  sandbox?: boolean;
};

// query
?source=normal | handson_tour | manual  // analytics 用
```

#### サーバー側変更

```ts
// 既存ロジック
const insertData = {
  user_id: userId,
  dish_name: body.dishName,
  // ...
  is_sandbox: body.sandbox === true,  // 追加
  source: searchParams.get('source') ?? 'normal',  // 追加
};

// sandbox=true の偽装防止
if (body.sandbox === true) {
  // ユーザーがハンズオン対象でなければ拒否
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('handson_tour_completed_at, handson_tour_skipped_at, roles')
    .eq('user_id', userId)
    .single();

  if (profile.handson_tour_completed_at || profile.handson_tour_skipped_at) {
    // 完了済 or skipped 済なら sandbox 不要
    return Response.json({ error: 'sandbox_not_eligible' }, { status: 409 });
  }

  const adminRoles = ['admin', 'super_admin', 'org_admin', 'org_industrial_doctor'];
  if (profile.roles?.some(r => adminRoles.includes(r))) {
    return Response.json({ error: 'sandbox_not_eligible', reason: 'admin_role' }, { status: 403 });
  }

  // condition C 違反 (既存活動あり) も拒否
  const { data: hasActivity } = await supabase.rpc('user_has_non_sandbox_activity', { p_user_id: userId });
  if (hasActivity) {
    return Response.json({ error: 'sandbox_not_eligible', reason: 'existing_user' }, { status: 409 });
  }
}

// 通常の INSERT 処理 + first_bite バッジ付与 (既存)
```

### 5.2 `POST /api/menu-plans/add`

同様の拡張 (sandbox + source query)。バッジは `planner` (既存付与ロジック流用)。

### 5.3 `POST /api/onboarding/complete`

レスポンスに `next_route` 追加:

```ts
type OnboardingCompleteResponse = {
  ok: true;
  // ... 既存フィールド
  next_route: '/handson-tour' | '/home';
};

// サーバー
const tourStatus = await getHandsonTourStatusInternal(userId);
return Response.json({
  ok: true,
  // ...
  next_route: tourStatus.should_show ? '/handson-tour' : '/home',
});
```

クライアントは `next_route` を読んで遷移。

---

## 6. エラーレスポンス共通形式

cross/04-api-conventions §error-format に準拠 (canonical):

```ts
{
  error: {
    code: string;       // 'rate_limited', 'unauthorized', 'not_eligible', etc
    message: string;    // ユーザー向けメッセージ (任意で i18n key)
    reason?: string;    // 細部 (analytics 用)
    details?: unknown;  // 開発者向け詳細
  };
}
```

ハンズオン固有 error_code 一覧:

| code | 意味 | HTTP status |
|---|---|---|
| `unauthorized` | JWT 不正 | 401 |
| `profile_not_found` | profile 未作成 | 404 |
| `not_eligible` | 表示対象外 | 403/409 |
| `sandbox_not_eligible` | sandbox=true 拒否 | 403/409 |
| `rate_limited` | 過剰リクエスト | 429 |
| `internal_error` | サーバー側エラー | 500 |
| `validation_error` | body schema 不正 | 400 |

`reason` フィールド (任意):
- `admin_role` (特権ロールで対象外)
- `existing_user` (condition C 違反、既存 non-sandbox 活動あり)
- `onboarding_not_completed` (onboarding 未完)
- `already_completed` (既に完了済)
- `already_skipped` (既にスキップ済)
- `already_finished` (= already_completed OR already_skipped、sandbox=true 拒否時に使用)
- `feature_disabled` (Feature flag OFF)
- `not_in_rollout` (段階公開対象外)

---

## 7. Authorization

すべてのハンズオン関連 API は **Supabase Auth Bearer token 必須**。

```
Authorization: Bearer <jwt>
```

JWT 検証は `getSupabaseServerClient().auth.getUser()` で行う。失敗時 401。

CSRF: SameSite=Lax cookie + Bearer token なので CSRF リスクは低い (cross/04 既定通り)。

---

## 8. CORS

ハンズオン API は web/mobile 両方からアクセスされるため、cross/04 既定の CORS 設定で対応:

```
Access-Control-Allow-Origin: https://homegohan.app, https://mobile-callback (Expo)
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
```

---

## 9. テストケース (API)

### 9.1 `/api/handson-tour/status`
- 通常新規ユーザー → `should_show: true, reason: 'eligible'`
- onboarding 未完 → `should_show: false, reason: 'onboarding_not_completed'`
- 完了済 → `should_show: false, reason: 'already_completed'`
- スキップ済 → `should_show: false, reason: 'already_skipped'`
- admin role → `should_show: false, reason: 'admin_role'`
- 既存ユーザー → `should_show: false, reason: 'existing_user_auto_skip'` (& side effect)
- 401 (no auth)

### 9.2 `/api/handson-tour/complete`
- 新規ユーザー → 200, `already_completed: false`, バッジ付与
- 連続 2 回呼出 → 2 回目 `already_completed: true`, user_badges は 1 行のみ
- admin role → 403
- existing user → 409
- 401, 429, 500

### 9.3 `/api/handson-tour/skip`
- 通常 → 200, skipped_at セット
- 完了済 → 200 だが skipped_at セットされない (= condition で除外)
- 401, 429

### 9.4 拡張 `/api/meal-plans/add-from-photo`
- sandbox=true で正常 INSERT (is_sandbox=true)
- sandbox=true で admin → 403
- sandbox=true で 既存ユーザー → 409
- sandbox=false (= 通常) は既存仕様通り

### 9.5 `/api/onboarding/complete` 拡張
- 完了時 `next_route` が含まれる
- ハンズオン対象なら `'/handson-tour'`, 非対象なら `'/home'`

---

## 10. 残不確実性 (§99 連携)

- [ ] Supabase RPC `user_has_non_sandbox_activity` を新規作成するか、既存を流用するか
- [ ] `complete_handson_tour` RPC を Supabase function で実装するか、Edge Function (TS) で実装するか
- [ ] sandbox=true 偽装防止のサーバー側チェックは API レイヤーで OK か、DB トリガーも入れるか (defense in depth)
- [ ] `/api/handson-tour/skip` で `step: -1` を許容するか (auto-skip 内部呼び出し用)
- [ ] Rate limit 値 (60/60/12 req per minute) が UX 上問題ないか
- [ ] `next_route` をレスポンスに含めるのは onboarding/complete だけで OK か (login API でも返すべきか)
