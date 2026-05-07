# 17 — セキュリティ

> 関連: [09-api-spec](./09-api-spec.md) / [08-state-db](./08-state-db.md) / cross/02-rls-patterns.md / cross/04-api-conventions.md

---

## 1. 脅威モデル

### 1.1 攻撃シナリオ

| 攻撃 | 影響 | 対策 |
|---|---|---|
| 悪意ユーザーが `sandbox: true` を偽装 → meal_logs に sandbox 行を量産 | DB 汚染、KPI 計測歪み | サーバー側で偽装防止チェック (§2) |
| admin が誤って一般ユーザー扱いで sandbox 行を作成 | データ整合性 | ロール check (§2.2) |
| 第三者が他人の `handson_tour_completed_at` を読み取り | プライバシー | RLS で防御 (§5) |
| 第三者が他人の user_badges に INSERT | バッジ偽装 | RLS で防御 (server_role 専用 INSERT) |
| Bot が `/api/handson-tour/complete` を連打 | リソース消費 | Rate limit (§3) |
| sandbox 中にユーザーが ipa を逆解析して mock を改変 | 体験崩壊のみ | クライアント mock の信頼性は問わない (実害なし) |
| force=1 で何度も卒業して analytics を歪める | KPI 信頼性低下 | already_completed: true で実バッジは付与しない、analytics 側で entry_source='settings_force' を除外集計 (§4) |

### 1.2 脅威の重要度

| 脅威 | 確率 | 影響度 | 重要度 |
|---|---|---|---|
| sandbox 偽装 (一般ユーザーから) | 中 | 中 (DB 汚染) | **高** |
| admin role での sandbox 作成 | 低 | 低 | 中 |
| 他人データ閲覧 | 低 | 高 (プライバシー) | **高** |
| バッジ偽装 INSERT | 中 | 中 (報酬の信頼性) | **高** |
| /complete 連打 | 中 | 低 (rate limit で防御) | 中 |
| KPI 歪曲 (force=1 連打) | 低 | 低 | 低 |

---

## 2. sandbox=true 偽装防止

### 2.1 攻撃方法

```bash
# 通常の保存リクエスト
curl -X POST https://homegohan.app/api/meal-plans/add-from-photo?source=handson_tour \
  -H "Authorization: Bearer $JWT" \
  -d '{"dishName":"任意の料理","calories":1000,"sandbox":true}'
```

通常ユーザーが既に何度もハンズオン経験 → completed_at セット済 → でも sandbox=true を送って `is_sandbox=true` で挿入できると DB が汚れる。

### 2.2 サーバー側防御

`sandbox: true` リクエスト受信時、以下を全部 check:

```ts
async function validateSandboxEligibility(userId: string): Promise<{ ok: true } | { ok: false; reason: string; status: number }> {
  const profile = await getProfile(userId);
  if (!profile) return { ok: false, reason: 'profile_not_found', status: 404 };

  // (a) 完了済 → sandbox 不要
  if (profile.handson_tour_completed_at) {
    return { ok: false, reason: 'already_completed', status: 409 };
  }

  // (b) 明示スキップ済
  if (profile.handson_tour_skipped_at) {
    return { ok: false, reason: 'already_skipped', status: 409 };
  }

  // (c) 特権ロール
  const adminRoles = ['admin', 'super_admin', 'org_admin', 'org_industrial_doctor'];
  if (profile.roles?.some(r => adminRoles.includes(r))) {
    return { ok: false, reason: 'admin_role', status: 403 };
  }

  // (d) condition C: 既存 non-sandbox 活動
  const hasActivity = await rpcUserHasNonSandboxActivity(userId);
  if (hasActivity) {
    return { ok: false, reason: 'existing_user', status: 409 };
  }

  return { ok: true };
}

// API ハンドラ内
if (body.sandbox === true) {
  const validation = await validateSandboxEligibility(userId);
  if (!validation.ok) {
    return Response.json({
      error: 'sandbox_not_eligible',
      reason: validation.reason,
    }, { status: validation.status });
  }
}
```

### 2.3 中断時の二重 INSERT 対策

§08-state-db.md §4.2 の「Step 1 完了後の中断」シナリオ:

```ts
// クライアント: Step 1 サブステップ 1.6 で API 呼び出し前に check
const recent = await fetch('/api/meal-logs?recent=5min&sandbox=true').then(r => r.json());
if (recent.length > 0) {
  fireAnalytics('handson_tour_step_skipped_due_to_existing_sandbox', { step: 1 });
  advanceToStep2();  // 二重 INSERT せずに進む
  return;
}
// 通常の保存フロー
```

これは攻撃ではなく UX 整合性の問題だが、サーバー側でも追加チェック:

```ts
// サーバー側: sandbox=true で 5 分以内に同 user の sandbox 行があれば warn (拒否はしない)
if (body.sandbox === true) {
  const recentSandbox = await db.query(`
    SELECT id FROM meal_logs
    WHERE user_id = $1 AND is_sandbox = true AND created_at > now() - INTERVAL '5 minutes'
    LIMIT 1
  `, [userId]);
  if (recentSandbox.length > 0) {
    // 二重作成は許容 (UX を壊さない) が ログに残す
    logSandboxDoubleCreation(userId);
  }
}
```

---

## 3. Rate Limiting

### 3.1 制限値

| Endpoint | user 単位 | IP 単位 |
|---|---|---|
| `/api/handson-tour/status` | 60 / 60 s | 600 / 60 s |
| `/api/handson-tour/complete` | 6 / 60 s | 60 / 60 s |
| `/api/handson-tour/skip` | 12 / 60 s | 120 / 60 s |
| `/api/meal-plans/add-from-photo?source=handson_tour` | 既存制限 (10 / 60 s) | 既存 |
| `/api/menu-plans/add?source=handson_tour` | 既存制限 (10 / 60 s) | 既存 |

### 3.2 実装

cross/04 既存の Upstash Redis ベース rate limit を流用:

```ts
import { rateLimit } from '@/lib/rate-limit';

export async function POST(req: Request) {
  const userId = await getAuthUserId(req);
  const limited = await rateLimit({
    identifier: `handson-tour-complete:${userId}`,
    limit: 6,
    window: '60 s',
  });
  if (!limited.success) {
    return Response.json({ error: 'rate_limited' }, { status: 429, headers: {
      'X-RateLimit-Limit': '6',
      'X-RateLimit-Remaining': String(limited.remaining),
      'X-RateLimit-Reset': String(limited.reset),
    }});
  }
  // 通常処理
}
```

### 3.3 IP-based bot 防御

ハンズオン関連 API は認証必須なので、IP 制限は緩め (= 大きなオフィスから複数ユーザーがアクセス可能)。
`Cloudflare Turnstile` が必要なら 100 req / 60 s / IP で発動 (cross/04 既存 mechanism)。

---

## 4. CSRF / 認証

### 4.1 認証

すべてのハンズオン API は **Supabase Auth Bearer token 必須**。

```ts
const { data: { user } } = await supabase.auth.getUser();
if (!user) return new Response('Unauthorized', { status: 401 });
```

JWT 検証は Supabase が自動。失効した token は 401 で reject。

### 4.2 CSRF

- HTTP method: POST / DELETE のみ書込み
- SameSite=Lax cookie (既定)
- Bearer token を Header に置く (Cookie でない)
- web の CSRF リスクは低い

mobile は Bearer token のみで認証、CSRF 問題なし。

### 4.3 CORS

```
Access-Control-Allow-Origin: https://homegohan.app, exp://192.168.x.x:8081 (dev)
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type, X-Idempotency-Key
Access-Control-Allow-Credentials: false
```

production では `https://homegohan.app` のみ。

---

## 5. RLS (Row Level Security)

### 5.1 既存 RLS の流用

`user_profiles` の既存 RLS で新規列も保護:

```sql
-- 既存 (推測)
CREATE POLICY user_profiles_owner_rw ON user_profiles
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

新規 2 列 (`handson_tour_completed_at`, `handson_tour_skipped_at`) は既存 RLS で:
- 自分のみ SELECT 可
- 自分のみ UPDATE 可 (ただし API 経由のみ、direct UPDATE は API 側で防ぐ)

`meal_logs` / `weekly_menus` の `is_sandbox` 列も同様。

### 5.2 user_badges の INSERT 制限

```sql
-- 既存 (推測)
CREATE POLICY user_badges_owner_r ON user_badges
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY user_badges_server_only_w ON user_badges
  FOR INSERT WITH CHECK (false);  -- クライアント直接 INSERT 不可
```

これにより:
- クライアントは badges を直接 INSERT できない (= バッジ偽装防止)
- サーバー (service_role JWT) のみ INSERT 可能
- API ハンドラで service_role を使って挿入

### 5.3 service_role 使用箇所

| API | service_role 使用 | 理由 |
|---|---|---|
| `/api/handson-tour/complete` | YES | tutorial_complete バッジ INSERT |
| `/api/meal-plans/add-from-photo` | YES (バッジ付与時) | first_bite |
| `/api/menu-plans/add` | YES (バッジ付与時) | planner |
| `/api/handson-tour/status` | NO (read only、user JWT で OK) | - |
| `/api/handson-tour/skip` | NO (user_profiles の自己 UPDATE は user JWT で可) | - |

### 5.4 service_role の保護

service_role の secret key は **環境変数のみ**:
- `SUPABASE_SERVICE_ROLE_KEY`
- `.env.example` に記載 (値は空)
- Vercel / Expo の secret 設定で本番値配布
- リポにコミットしない (既存運用)

---

## 6. データ閲覧制限 (admin 含む)

### 6.1 admin が他人のハンズオン状態を閲覧する正当性

- 顧客サポートで「ハンズオン進捗確認」が必要な場合あり
- ただしユーザーの体重・栄養目標等は別 RLS で保護

### 6.2 RLS 拡張案 (family/08-rls-policies.md 既存があれば併存)

```sql
CREATE POLICY user_profiles_admin_r ON user_profiles
  FOR SELECT USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.user_id = auth.uid()
      AND up.roles && ARRAY['admin','super_admin']::text[]
    )
  );
```

これは family/08 既存の RLS とコンフリクトしないよう実装時に確認。

### 6.3 監査ログ

admin が他人の profile を閲覧した場合、`audit_logs` に記録:

```sql
INSERT INTO audit_logs (actor_user_id, action, target_user_id, payload)
VALUES (auth.uid(), 'admin_view_user_profile', $target_user_id, jsonb_build_object('source', 'handson-tour-status'));
```

実装は operator/07-audit-monitoring.md で canonical 化。

---

## 7. PII (個人情報) 保護

### 7.1 ハンズオン中で扱う PII

| データ | 保管場所 | 保護方法 |
|---|---|---|
| nickname | profile (DB) | RLS で保護 |
| weight_kg / height_cm / age | profile (DB) | 同上 |
| target_kcal_per_day (計算結果) | profile (DB) | 同上 |
| allergies / dislikes | profile (DB) | 同上 |
| ハンズオン中の表示テキスト | クライアント memory | DOM 上に出るが他人は見えない |
| Analytics events | external | user_id (UUID) のみ、PII 含めない (§22) |

### 7.2 PII を含めないルール

| 場所 | ルール |
|---|---|
| Analytics events | PII 含めない (= nickname 等を properties に入れない) |
| Sentry / Bugsnag | PII 含めない (error_message に nickname 等を含めない) |
| サーバーログ | PII を含む場合はマスキング (例: `nickname: "***"`) |
| URL クエリ | PII 含めない (= `?nickname=...` はダメ) |
| 共有可能な link | PII 含めない |

### 7.3 GDPR / 個人情報保護法対応

- ユーザーの「アカウント削除」リクエスト時、`user_profiles` の `handson_tour_*` 列も削除される (既存 cascade delete) → 追加対応不要
- 30 日 cooling period (操作可能性) は既存運用に従う

---

## 8. SQL Injection 対策

### 8.1 prepared statement

すべての DB クエリは prepared statement / parameterized query:

```ts
// ✅ OK
await db.query('SELECT * FROM user_profiles WHERE user_id = $1', [userId]);

// ❌ NG
await db.query(`SELECT * FROM user_profiles WHERE user_id = '${userId}'`);
```

Supabase JS client は自動的に prepared statement 使用。

### 8.2 RPC 関数

`SECURITY DEFINER` の RPC 関数は `search_path` を固定:

```sql
CREATE OR REPLACE FUNCTION complete_handson_tour(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public  -- ← 重要 (search_path 攻撃防止)
AS $$ ... $$;
```

---

## 9. XSS 対策

### 9.1 nickname 等の DOM 表示

React の自動エスケープに依存:

```tsx
// ✅ OK (React が自動エスケープ)
<h1>{nickname} さん、ようこそ!</h1>

// ❌ NG (dangerouslySetInnerHTML 使用)
<h1 dangerouslySetInnerHTML={{ __html: `${nickname} さん、ようこそ!` }} />
```

ハンズオンでは `dangerouslySetInnerHTML` は **一切使わない**。

### 9.2 メーカー側 HTML escape (mock データ含む)

`MOCK_PHOTO_RESPONSE.dishName` 等の固定値は静的なので XSS リスクなし。
ただし将来 mock データを動的取得する場合は要検証。

---

## 10. クライアント側 mock の扱い

### 10.1 信頼性のレベル

クライアント側 mock データ (`MOCK_PHOTO_RESPONSE`, `MOCK_MENU_RESPONSE`) は **信頼境界の外**。

ユーザーが ipa を逆解析してデバッグツールで値を改変しても、サーバー側で何も起きない (= mock は表示用のみ)。

### 10.2 サーバー側で受け取る値

`/api/meal-plans/add-from-photo` 呼び出し時、クライアントから送られる:
- dishName / calories / etc

これらは **必ず Zod schema で検証**:

```ts
const RequestSchema = z.object({
  dishName: z.string().min(1).max(100),
  calories: z.number().int().min(0).max(10000),
  // ...
});

const parsed = RequestSchema.safeParse(await req.json());
if (!parsed.success) {
  return Response.json({ error: 'validation_error', details: parsed.error }, { status: 400 });
}
```

仮にユーザーが `calories: 999999999` を送っても、Zod で 弾かれる。

---

## 11. ログとモニタリング

### 11.1 ログイベント

| event | level |
|---|---|
| `sandbox_eligibility_failed` | warn (admin / 既存ユーザーが sandbox=true 試行) |
| `complete_api_invoked_already_completed` | info (force=1 再実行) |
| `complete_api_500` | error (DB 異常) |
| `bbadge_insert_conflict_unexpected` | warn (重複付与試行、本来 ON CONFLICT で吸収) |
| `rate_limit_exceeded` | warn |

### 11.2 アラート

| 条件 | 通知先 |
|---|---|
| sandbox_eligibility_failed が 5 分以内に 10 件以上 | Slack #app-alerts |
| complete_api_500 が 1 件以上 | Slack #app-alerts |
| sandbox=true で is_sandbox=false の行が紛れ込む (= バグ) | PagerDuty |

---

## 12. 監査チェックリスト

リリース前に以下を確認:

- [ ] `/api/handson-tour/*` のすべてに認証チェック (Bearer token 必須)
- [ ] sandbox=true 偽装防止が機能 (admin / 既存ユーザーで 403/409 返す integration テスト)
- [ ] Rate limit が動作 (連打で 429 返す)
- [ ] RLS で他人データ閲覧不可 (テスト)
- [ ] user_badges の direct INSERT 不可 (RLS テスト)
- [ ] Analytics events に PII 含まれていない (Code review)
- [ ] Sentry breadcrumb に PII 含まれていない (Code review)
- [ ] dangerouslySetInnerHTML 使用なし (grep)
- [ ] Zod schema で全 request 検証
- [ ] SQL injection 防止 (prepared statement のみ、grep で文字列結合 DB クエリチェック)
- [ ] XSS 防止 (React 自動エスケープのみ依存、unsafe な innerHTML なし)

---

## 13. ペネトレーションテスト

v1 リリース前に外部セキュリティチームによる pen test を **任意で** 実施:

- sandbox=true 偽装の各種パターン
- Rate limit 回避試行 (異なる JWT / 異なる IP)
- RLS 抜け穴
- SQL injection 試行 (calories=`-1` 等)
- XSS payload 試行 (nickname に `<script>alert(1)</script>` 入力)

外部チーム雇用は v2 で検討。v1 は内部監査のみ。

---

## 14. インシデント対応

万が一のセキュリティインシデント発生時の手順 (operator/09-runbook と連携):

### 14.1 sandbox 偽装による DB 汚染

1. `meal_logs` から `is_sandbox=true AND user_id IN (admin_users)` を SELECT
2. 該当行を SOFT-DELETE (`is_deleted=true` 列がある場合) or hard-delete
3. KPI ダッシュボードを再計算
4. 再発防止: API 側のロジック確認

### 14.2 バッジ偽装

1. `user_badges` に不正な行があるか SELECT
2. 該当行を DELETE
3. ユーザーに通知 (慎重に、過敏反応を避ける)
4. RLS 設定を再確認

### 14.3 機密漏洩

1. 即座に該当 API を 503 で stop
2. JWT 全件 invalidate (Supabase で `auth.signOut()` 全 user)
3. 影響ユーザーに通知
4. CTO + 法務に escalation

---

## 15. 残不確実性 (§99 連携)

- [ ] family/08-rls-policies.md の既存 admin 閲覧 RLS の確認
- [ ] cross/04-api-conventions.md の rate limit デフォルト値の確認
- [ ] Cloudflare Turnstile が現状運用されているか (cross/04 確認)
- [ ] `audit_logs` テーブルが既存か新規作成か (operator/07 確認)
- [ ] PagerDuty / Slack alert チャネルの命名規約 (cross/07 / operator/07 確認)
