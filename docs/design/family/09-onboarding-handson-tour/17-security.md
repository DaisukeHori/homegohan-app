# 17 — セキュリティ

> 関連: [09-api-spec](./09-api-spec.md) / [08-state-db](./08-state-db.md) / [21-migration-sql](./21-migration-sql.md)

---

## 1. 脅威モデル

### 1.1 想定される攻撃

| 脅威 | 影響 | 重大度 |
|---|---|---|
| sandbox=true 偽装でバッジ不正獲得 | 既存ユーザーが容易に first_bite/planner/tutorial_complete を再取得 | 中 |
| `/api/handson-tour/complete` を無制限連打 | DB UPDATE 連打で性能影響 | 低 |
| 他人の handson_tour 状態を読む | プライバシー漏洩 | 中 |
| 他人の user_badges に INSERT | バッジ偽造 | 中 |
| CSRF (web) | 状態改変 | 低 |
| force=1 を悪用してバッジ複数回獲得 | バッジ count を膨らませる | 低 (ON CONFLICT で防御) |
| Tour 中の sandbox_meal_log を unlimited INSERT | DB 容量肥大化 | 低 |
| 中断で API リトライ攻撃 | meal_logs に大量 INSERT | 中 |

### 1.2 防御方針

- 多層防御 (defense in depth):
  - クライアント側 validation
  - API レイヤー認証 + 認可
  - サーバー側 sandbox 偽装防止
  - DB RLS
  - DB CHECK 制約

---

## 2. sandbox=true 偽装防止

### 2.1 攻撃シナリオ

通常ユーザー (handson_tour 完了済) が:
1. `/api/meal-plans/add-from-photo?source=handson_tour` に `sandbox: true` を含む POST
2. 期待: 拒否 (sandbox_not_eligible)、`is_sandbox=true` で INSERT されない

### 2.2 サーバー側防御 (3 段階)

#### 段階 1: 完了/スキップ済 ユーザーの拒否

```ts
if (body.sandbox) {
  const profile = await getProfile(userId);
  if (profile.handson_tour_completed_at || profile.handson_tour_skipped_at) {
    return Response.json(
      { error: { code: 'sandbox_not_eligible', reason: 'already_finished' } },
      { status: 409 }
    );
  }
}
```

#### 段階 2: 特権ロールの拒否

```ts
const adminRoles = ['admin', 'super_admin', 'org_admin', 'org_industrial_doctor'];
if (profile.roles?.some(r => adminRoles.includes(r))) {
  return Response.json(
    { error: { code: 'sandbox_not_eligible', reason: 'admin_role' } },
    { status: 403 }
  );
}
```

#### 段階 3: 既存ユーザー (condition C) の拒否

```ts
const { data: hasActivity } = await supabase.rpc('user_has_non_sandbox_activity', {
  p_user_id: userId,
});
if (hasActivity) {
  return Response.json(
    { error: { code: 'sandbox_not_eligible', reason: 'existing_user' } },
    { status: 409 }
  );
}
```

### 2.3 DB トリガー (defense in depth、optional)

API バイパスへの保険として DB トリガー:

```sql
CREATE OR REPLACE FUNCTION check_meal_logs_sandbox_eligibility()
RETURNS trigger AS $$
DECLARE
  v_completed timestamptz;
  v_skipped timestamptz;
  v_has_admin boolean;
BEGIN
  IF NEW.is_sandbox = true THEN
    SELECT handson_tour_completed_at, handson_tour_skipped_at,
           (roles && ARRAY['admin','super_admin','org_admin','org_industrial_doctor']::text[])
    INTO v_completed, v_skipped, v_has_admin
    FROM user_profiles WHERE user_id = NEW.user_id;

    IF v_completed IS NOT NULL OR v_skipped IS NOT NULL OR v_has_admin THEN
      RAISE EXCEPTION 'sandbox not eligible for this user';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER meal_logs_sandbox_check
  BEFORE INSERT ON meal_logs
  FOR EACH ROW
  EXECUTE FUNCTION check_meal_logs_sandbox_eligibility();
```

v1 ではトリガー実装は **任意** (API レベルで十分)。v2 で攻撃事例が出たら追加検討。

---

## 3. 中断時の二重 INSERT 防止

### 3.1 攻撃 / 事故シナリオ

ユーザーが Step 1 で【保存】タップ → API 成功 → アプリ kill → 再起動 → ハンズオン Step 0 から再開 → Step 1 で再度【保存】

問題:
- `meal_logs` に sandbox=true で 2 件目 INSERT
- `first_bite` バッジは ON CONFLICT で 1 件のみ (これは OK)
- ただし sandbox 行が増える (DB 容量、UI 表示混乱)

### 3.2 クライアント側防御

Step 1 のサブステップ 1.6 で API 呼び出し前にチェック:

```ts
async function handleSaveSandbox() {
  // 直近 5 分以内に sandbox meal_log があれば skip
  const recent = await fetch('/api/meal-logs?limit=5&user_only=true&since=5min&is_sandbox=true');
  const data = await recent.json();
  if (data.length > 0) {
    fireAnalytics('handson_tour_step_skipped_due_to_existing_sandbox', { step: 1 });
    advanceToStep2();
    return;
  }
  // 通常の保存 API
  await fetch('/api/meal-plans/add-from-photo?source=handson_tour', { method: 'POST', body: ... });
  advanceToStep2();
}
```

ただし、同じ機構の API (`/api/meal-logs?since=5min&is_sandbox=true`) を新規追加する必要がある。

### 3.3 シンプル代替案 (v1)

5 分チェックを実装せず、**unique 制約で防ぐ**:

```sql
-- meal_logs に partial unique index
CREATE UNIQUE INDEX uniq_user_sandbox_meal
  ON meal_logs (user_id, is_sandbox)
  WHERE is_sandbox = true;
```

これで `(user_id, is_sandbox=true)` の組み合わせは 1 行のみ。Step 1 で 2 回呼んでも 2 件目は ON CONFLICT で reject。

ただし、Step 1 の API は今 ON CONFLICT 句なし。実装で:

```ts
const { error } = await supabase.from('meal_logs').insert({
  user_id, is_sandbox: true, ...
});
if (error?.code === '23505') {  // unique violation
  // 既存あり、無視して advance
  return;
}
```

ただ unique 制約は `weekly_menus` にも追加する必要があり、メニュー側はもう少し複雑。

#### v1 推奨方針

- Step 1: meal_logs unique 制約 (`user_id, is_sandbox=true` で 1 行)
- Step 2: weekly_menus unique 制約 (同上)
- 中断後再起動時、Step 0 から再開 → Step 1 で API 呼ぶが unique violation → クライアント catch して advance

§21 の migration SQL に unique 制約も含める。

---

## 4. 認証 / 認可

### 4.1 全 API でJWT 必須

すべての /api/handson-tour/* API は `Authorization: Bearer <jwt>` 必須。

```ts
const supabase = await getSupabaseServerClient();
const { data: { user } } = await supabase.auth.getUser();
if (!user) return new Response('Unauthorized', { status: 401 });
```

### 4.2 認可 (role-based)

| API | admin | super_admin | org_admin | org_industrial_doctor | user (一般) |
|---|---|---|---|---|---|
| GET /status | OK (false 返す) | OK | OK | OK | OK |
| POST /complete | 403 | 403 | 403 | 403 | OK |
| POST /skip | OK (但し effect 限定) | OK | OK | OK | OK |
| POST /meal-plans/add-from-photo (sandbox=true) | 403 | 403 | 403 | 403 | OK |
| POST /meal-plans/add-from-photo (sandbox=false) | OK | OK | OK | OK | OK |

特権ロールは sandbox 経由の動作不可、通常 API は使用可。

---

## 5. RLS (Row Level Security)

### 5.1 user_profiles

```sql
-- 既存
CREATE POLICY user_profiles_owner_rw ON user_profiles
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- admin / super_admin の閲覧 (family/08 既存)
CREATE POLICY user_profiles_admin_r ON user_profiles
  FOR SELECT USING (
    auth.uid() = user_id OR EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.user_id = auth.uid()
      AND up.roles && ARRAY['admin','super_admin']::text[]
    )
  );
```

新規 2 列もこれで保護。

### 5.2 meal_logs / weekly_menus

既存 RLS:

```sql
CREATE POLICY meal_logs_owner_rw ON meal_logs
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

`is_sandbox` 列も同 RLS で保護される。クライアントは自分の sandbox 行しか読み書きできない。

### 5.3 user_badges

```sql
-- 読み取り: 本人のみ
CREATE POLICY user_badges_owner_r ON user_badges
  FOR SELECT USING (auth.uid() = user_id);

-- INSERT: クライアント直接禁止
CREATE POLICY user_badges_no_client_insert ON user_badges
  FOR INSERT WITH CHECK (false);
```

`POST /api/handson-tour/complete` は service_role キーで INSERT (RLS bypass)。

### 5.4 RLS テスト

```ts
// __tests__/rls/handson-tour-rls.test.ts
describe('Handson Tour RLS', () => {
  it('User A cannot read User B handson_tour_completed_at', async () => {
    const userB = await createUser({});
    await setHandsonTourCompleted(userB.id);

    const supabaseA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { ... } // userA jwt
    });
    const { data, error } = await supabaseA
      .from('user_profiles')
      .select('handson_tour_completed_at')
      .eq('user_id', userB.id);
    expect(data).toEqual([]);  // RLS でフィルタ
  });

  it('User A cannot insert into user_badges directly', async () => {
    const supabaseA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { /* userA jwt */ }
    });
    const { error } = await supabaseA.from('user_badges').insert({
      user_id: userA.id,
      badge_id: 'tutorial_complete-badge-id',
      obtained_at: new Date().toISOString(),
    });
    expect(error).toBeTruthy();  // RLS で reject
  });
});
```

---

## 6. CSRF / XSS

### 6.1 CSRF (web)

#### 防御
- SameSite=Lax cookie + Bearer token (cross/04 既定)
- 重要操作は必ず POST + Authorization header
- GET は状態変更しない

#### テスト
- 別オリジンから fetch で CSRF トークンなしで POST → 401 (or CORS reject)

### 6.2 XSS

#### 入力箇所
- ハンズオン中はユーザー入力なし (ほぼ tap 操作のみ)
- 例外: Step 2 の `v4-note-textarea` (= 自由メモ)
  - mock 完結なので入力値は破棄
  - 実 API には送らない
  - 表示もしない (= XSS リスクなし)

#### nickname
- profile から取得
- 表示時は React の自動 escape で HTML タグ無効化
- innerHTML や dangerouslySetInnerHTML は **使わない**

```tsx
// OK
<h1>{nickname} さん、ようこそ!</h1>

// NG (使わない)
<h1 dangerouslySetInnerHTML={{ __html: `${nickname} さん` }} />
```

---

## 7. force=1 の悪用防止

### 7.1 シナリオ
ユーザーが /handson-tour?force=1 を何度も実行 → tutorial_complete バッジを複数回獲得?

### 7.2 防御

`POST /api/handson-tour/complete` で:
- `user_badges` の ON CONFLICT DO NOTHING で重複 INSERT を防ぐ
- `already_completed: true` を返す
- バッジ count は 1 個のまま

```sql
INSERT INTO user_badges (user_id, badge_id, obtained_at)
SELECT $1, b.id, now() FROM badges b WHERE b.code = 'tutorial_complete'
ON CONFLICT (user_id, badge_id) DO NOTHING;
```

### 7.3 first_bite / planner も同様
- 最初の sandbox 投稿で付与、2 回目以降は ON CONFLICT で skip

### 7.4 Rate limit
`/api/handson-tour/complete`: 6 req / 60s / user で過度な連打を防ぐ。

---

## 8. データ漏洩防止

### 8.1 Analytics events に PII を含めない

**禁止**:
- nickname / weight / age / height / 個人情報そのもの
- email / phone / address

**許可**:
- user_id (UUID、内部 identifier)
- step (0-4)
- duration (numeric)
- error_code (enum)

### 8.2 Server logs に PII を含めない

```ts
// NG
logger.info(`User ${nickname} completed tour`);

// OK
logger.info(`User ${userId} completed tour`);
```

### 8.3 Client logs (Sentry / Bugsnag)
- breadcrumb: step / sub-step / error_code
- user.id: user_id (UUID) のみ
- user.email: 設定しない

---

## 9. dependency セキュリティ

### 9.1 新規 dependency

| package | 用途 | リスク |
|---|---|---|
| `@homegohan/handson-tour-shared` | 共通 type / mock | 内部 package、リスク低 |
| `react-confetti` (web) | 紙吹雪 | npm audit で脆弱性 0 確認 |
| `@react-native-masked-view/masked-view` (mobile) | Spotlight | 公式 React Native コミュニティ管理 |

### 9.2 dependency audit

CI で:
```bash
npm audit --audit-level=high  # high 以上で fail
```

### 9.3 lockfile commit
- `package-lock.json` を commit
- yarn 使ってる場合は `yarn.lock`

---

## 10. テストデータ・シークレット管理

### 10.1 E2E テストユーザー

`tests/e2e/fixtures/test-users.ts` に user 一覧:
- `e2e-tour-new-user-{timestamp}@homegohan.test`
- `e2e-tour-completed@homegohan.test`
- `e2e-tour-admin@homegohan.test`

パスワードはローカル + CI Secret から取得 (cross/04 既定)。

### 10.2 シークレット管理

- ハンズオン専用シークレットは無し (既存の SUPABASE_URL 等を使用)
- 新規追加なら GitHub Actions Secret + .env.example 反映 (Apple TestFlight 等は別件)

### 10.3 ローカル開発で安全に試す

```bash
# .env.local に E2E user の credentials
E2E_USER_TOUR_NEW=...
E2E_USER_TOUR_COMPLETED=...
```

`.env.local` は .gitignore 済。

---

## 11. テストケース (セキュリティ)

### 11.1 sandbox 偽装

```ts
describe('sandbox=true 偽装防止', () => {
  it('完了済ユーザーが sandbox=true → 409', async () => {
    await markHandsonTourCompleted(userId);
    const res = await postMealPhoto(userId, { sandbox: true, ... });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: 'sandbox_not_eligible', reason: 'already_finished' },
    });
  });

  it('admin が sandbox=true → 403', async () => {
    await setUserRoles(userId, ['user', 'admin']);
    const res = await postMealPhoto(userId, { sandbox: true, ... });
    expect(res.status).toBe(403);
  });

  it('既存ユーザー (meal_logs あり) が sandbox=true → 409', async () => {
    await insertMealLog(userId, { is_sandbox: false });
    const res = await postMealPhoto(userId, { sandbox: true, ... });
    expect(res.status).toBe(409);
  });

  it('通常新規ユーザー sandbox=true → 200', async () => {
    const res = await postMealPhoto(userId, { sandbox: true, ... });
    expect(res.status).toBe(200);
  });
});
```

### 11.2 中断後の二重 INSERT 防止

```ts
it('連続 2 回 sandbox=true POST → unique 制約で 2 回目失敗', async () => {
  await postMealPhoto(userId, { sandbox: true, dishName: 'A', ... });
  const res2 = await postMealPhoto(userId, { sandbox: true, dishName: 'B', ... });
  // unique violation 検出
  expect(res2.status).toBe(409);
});
```

### 11.3 RLS

```ts
it('User A cannot read User B handson_tour_completed_at', async () => {
  // §5.4 に詳述
});
```

### 11.4 force=1 連打

```ts
it('force=1 で 5 回 complete API 呼出 → user_badges 1 行のみ', async () => {
  for (let i = 0; i < 5; i++) {
    await fetch('/api/handson-tour/complete', { method: 'POST', ... });
  }
  const badges = await getUserBadges(userId);
  expect(badges.filter(b => b.code === 'tutorial_complete')).toHaveLength(1);
});
```

---

## 12. 監査 (operator/07-audit-monitoring 連携)

### 12.1 audit_logs に記録するイベント

| event | trigger |
|---|---|
| `handson_tour_completed_server` | API 成功時 |
| `handson_tour_skipped_server` | skip API 成功時 |
| `sandbox_not_eligible_attempt` | 偽装試行検出 (warn level) |
| `force_replay_attempted` | force=1 で再実行 |

### 12.2 不正検出 alert
- `sandbox_not_eligible_attempt` が 1 user で 5 回 / 60s 超 → Slack #security-alerts
- `force_replay_attempted` が 50 回 / day 超 (= 異常) → 同上

---

## 13. インシデント対応

### 13.1 sandbox 行の不正大量増殖

#### 検出
- 監視: meal_logs WHERE is_sandbox=true のレコード数を 1 hour 毎に集計
- 閾値: 通常の 100 倍超で alert

#### 対応
- 該当 user_id の sandbox 行を一括削除 (operator/09-runbook 経由):
  ```sql
  DELETE FROM meal_logs WHERE user_id = $1 AND is_sandbox = true;
  ```

### 13.2 バッジ不正獲得

#### 検出
- audit_logs で `tutorial_complete` バッジ取得時刻と handson_tour_completed_at の整合性チェック
- 不一致 → 不正の可能性

#### 対応
- 該当 user_badges 行を削除
- ハンズオンを reset (skipped_at と completed_at を NULL に)
- audit_logs に対応記録

---

## 14. 残不確実性 (§99 連携)

- [ ] DB トリガー (defense in depth) を v1 で実装するか、API 層のみで止めるか
- [ ] `meal_logs.is_sandbox` の partial unique index で v1 の二重 INSERT 防止が十分か
- [ ] `weekly_menus.is_sandbox` も同様 unique 制約か (= Step 2 の sandbox 二重 INSERT 防止)
- [ ] force=1 連打の rate limit 値 (6/60s が適切か)
- [ ] sandbox=true 偽装試行の alert 閾値 (5 回 / 60s が適切か)
- [ ] PII 含めないログ実装の確認 (既存ログコードにユーザーが何箇所 PII 入れているか grep)
