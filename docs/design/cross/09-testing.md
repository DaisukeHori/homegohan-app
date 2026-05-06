# cross/ テスト戦略 (統合)

全ドメイン横断のテスト戦略。各ドメイン設計書末尾の「テスト方針」セクションを統合・補完する。

> **コード例の扱い (重要)**
>
> 本ドキュメント内の TypeScript / SQL コード例 (factory 関数 / テストケース / モック等) は **概念サンプル** です。
> 列名・型・FK 制約の **正は各ドメイン設計書の DDL** (operator/01-data-model.md / family/01-data-model.md / org/01-data-model.md):
> - `subscription_plans`: operator/01 §3.1
> - `personal_subscriptions`: operator/01 §3.2
> - `org_license_pools` / `org_license_assignments`: org/01 §3.2-3.3
> - `family_groups` / `family_members` / `family_meal_requests`: family/01 §3-4
>
> 実装時は `supabase gen types typescript` で生成された型を直接使い、本ドキュメントのフィールド名と乖離があっても **DDL 側を真とする**。
> 本ドキュメントのサンプルが古い場合は PR で更新するが、実装の正常動作の judgment は型生成結果優先。

## 1. 目的・スコープ

- ピラミッド戦略 (Unit > Integration > E2E) の徹底
- テストカバレッジ目標値の明示
- CI/CD パイプラインでの実行順序
- モック戦略 (Stripe / LLM / Push)
- E2E シナリオの網羅 (100-scenarios.md と紐付け)
- 視覚回帰テスト (Visual regression)

## 2. 関連要件

- 要件 03 §16.4 パフォーマンス目標
- 要件 03 §22.3 CI/CD パイプライン
- 要件 01 §15.6 既存テスト破壊への対応
- `docs/requirements/100-scenarios.md` 110 シナリオ

## 3. テストピラミッド

```
         /\
        /  \   E2E (~30 spec)
       /────\  Critical user journeys
      /      \  
     /────────\ Integration (~150 spec)
    /          \ DB + RLS + Edge Function
   /────────────\
  /              \ Unit (~500 spec)
 /                \ Pure logic, helpers, components
/──────────────────\
```

### 3.1 比率

| 種別 | 比率 | 目安 spec 数 |
|-----|------|--------|
| Unit | 70% | 500 |
| Integration | 25% | 150 |
| E2E | 5% | 30 |

### 3.2 実行時間目標

| 種別 | per spec | 全体 |
|-----|----------|------|
| Unit | < 100ms | < 60s |
| Integration | < 1s | < 300s |
| E2E (smoke) | < 30s | < 300s |
| E2E (full) | < 60s | < 1800s (30 分) |

## 4. テストカバレッジ目標

| カテゴリ | カバレッジ目標 | 計測 |
|---------|------------|------|
| Unit (`src/lib/`) | 90% line / 85% branch | Vitest coverage |
| Unit (`src/components/`) | 80% line | Vitest + RTL |
| API routes (`src/app/api/`) | 100% (status code + happy path) | Vitest + Supabase Local |
| RLS ポリシー | 100% (各 policy で allow/deny 確認) | Vitest + Supabase Local |
| E2E 主要フロー | 100% (110 シナリオの ★ 1-2 すべて) | Playwright |
| a11y | violations = 0 (全画面) | @axe-core/playwright |

CI では 85% 未満で merge ブロック。

## 5. ツールスタック

| 用途 | ツール | 設定 |
|-----|------|------|
| Unit | Vitest + jsdom | `vitest.config.ts` |
| React コンポーネント | Vitest + React Testing Library | `vitest-setup.ts` |
| Integration (DB) | Vitest + Supabase Local | `tests/integration/setup.ts` |
| Integration (Edge Function) | Vitest + Deno test | `supabase/functions/_tests/` |
| E2E | Playwright | `playwright.config.ts` |
| a11y | @axe-core/playwright | E2E spec 内 |
| Visual Regression | Playwright + percy.io (or Chromatic) | `tests/visual/` |
| 負荷 | k6 Cloud | `tests/load/k6/` |
| API スキーマ | OpenAPI + dredd / vacuum | `tests/contract/` |
| Mobile | Maestro (or Detox) | `apps/mobile/.maestro/` |

## 6. モック戦略

### 6.1 Stripe

```typescript
// tests/mocks/stripe.ts
import { vi } from 'vitest';
export const mockStripe = {
  customers: { create: vi.fn(), retrieve: vi.fn() },
  subscriptions: { create: vi.fn(), update: vi.fn(), cancel: vi.fn() },
  prices: { create: vi.fn() },
  webhooks: { constructEvent: vi.fn() },
};

// E2E: Stripe Test Mode で実 API 呼び出し
// Unit/Integration: 上記モック
```

### 6.2 LLM (xAI / Gemini / Claude)

```typescript
// tests/mocks/llm.ts
export const mockLLM = {
  knowledgeGpt: vi.fn().mockResolvedValue({
    proposed_recipe: { dish_name: '鶏胸肉のサラダ', /* ... */ },
  }),
  industrialDoctorAdvice: vi.fn().mockResolvedValue({
    advice: 'バランスの取れた食事を心がけてください。',
  }),
};
```

LLM は決定的でないため、Unit/Integration ではモック必須。E2E でも基本モック (実 API は週次 nightly run のみ)。

### 6.3 Push 通知 (Expo Push)

```typescript
// tests/mocks/push.ts
export const mockExpoPush = {
  sendPushNotificationsAsync: vi.fn().mockResolvedValue([{ status: 'ok' }]),
};
```

### 6.4 Resend

Test mode の API キーで実送信 → サンドボックスのインボックスに届く。

### 6.5 認証 (Supabase Auth)

```typescript
// tests/helpers/auth.ts
export async function createTestUser(role: UserRole = 'user') {
  const { user } = await supabase.auth.admin.createUser({
    email: `test-${randomUUID()}@example.com`,
    password: 'TestPass123!',
  });
  await supabase.from('user_profiles').insert({
    id: user.id,
    roles: [role],
  });
  return user;
}
```

## 7. E2E シナリオ (100-scenarios.md と対応)

### 7.1 必須実装 (Phase 1、~30 spec)

| ペルソナ | シナリオ | spec ファイル |
|---------|---------|------------|
| 個人 | A1: 新規登録 → 初回食事写真 | `e2e/individual/onboarding.spec.ts` |
| 個人 | A2: AI 解析 | `e2e/individual/ai-analysis.spec.ts` |
| 個人 | A5: Pro アップグレード | `e2e/individual/upgrade.spec.ts` |
| 個人 | A14: GDPR 削除 | `e2e/individual/gdpr-delete.spec.ts` |
| 家族 | B1: グループ作成 → 招待 | `e2e/family/create-and-invite.spec.ts` |
| 家族 | B6: 共有献立生成 | `e2e/family/shared-menu.spec.ts` |
| 家族 | B7-B10: 個別献立 4 パターン | `e2e/family/meal-request-{1,2,3,4}.spec.ts` |
| 家族 | B11: 共有買い物リスト | `e2e/family/shopping-list.spec.ts` |
| 家族 | B16: owner 退会 → 引き継ぎ | `e2e/family/owner-leave.spec.ts` |
| 組織 | D1: 契約 → CSV 一括招待 | `e2e/org/onboarding.spec.ts` |
| 組織 | D5-D6: ライセンス配布 + 同梱 | `e2e/org/license-distribute.spec.ts` |
| 組織 | D8: 退職 → 家族凍結 | `e2e/org/offboarding.spec.ts` |
| 組織 | D11: 産業医招待 | `e2e/org/invite-doctor.spec.ts` |
| 組織 | D14: 月次レポート PDF | `e2e/org/monthly-report.spec.ts` |
| 産業医 | E6: AI アドバイス | `e2e/doctor/ai-advice.spec.ts` |
| 産業医 | E7: 別組織アクセス試行 → 403 | `e2e/doctor/cross-org-deny.spec.ts` |
| 運営 | F1: プラン作成 | `e2e/operator/plan-create.spec.ts` |
| 運営 | F2-F3: 価格変更 + 影響シミュ | `e2e/operator/price-change.spec.ts` |
| 運営 | F4-F5: deprecate + rollback | `e2e/operator/deprecate.spec.ts` |
| 運営 | F19: impersonate | `e2e/operator/impersonate.spec.ts` |

### 7.2 Phase 2 (~50 spec 追加)

エッジケース、特殊家族構成、複雑なフロー (グループ分割、子供 18 歳到達等)。

## 8. CI/CD パイプライン (cross/06-perf-cache.md と整合)

```yaml
# .github/workflows/ci.yml
name: CI
on: [pull_request, push]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - run: pnpm lint
      - run: pnpm typecheck

  test-unit:
    needs: lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - run: pnpm test:unit -- --coverage
      - uses: codecov/codecov-action@v4

  test-integration:
    needs: lint
    runs-on: ubuntu-latest
    services:
      supabase:
        image: supabase/postgres:15.1.0.117
        ports: ['54322:5432']
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - run: supabase start
      - run: pnpm test:integration

  test-e2e-smoke:
    needs: [test-unit, test-integration]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - run: pnpm playwright install
      - run: pnpm test:e2e -- --grep '@smoke'

  test-a11y:
    needs: test-e2e-smoke
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test:a11y

  test-e2e-full:
    needs: test-e2e-smoke
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test:e2e

  lighthouse:
    needs: test-e2e-smoke
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: treosh/lighthouse-ci-action@v11

  visual-regression:
    needs: test-e2e-smoke
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test:visual
```

### 8.1 PR 時 vs main マージ時

| ステージ | PR | main |
|---------|----|------|
| Lint / Typecheck | ✅ | ✅ |
| Unit | ✅ | ✅ |
| Integration | ✅ | ✅ |
| E2E smoke | ✅ | ✅ |
| a11y | ✅ | ✅ |
| E2E full | - | ✅ |
| Lighthouse | - | ✅ |
| Visual Regression | - | ✅ |

### 8.2 Nightly Run

毎日 03:00 JST に実行:
- E2E full (実 LLM API 含む)
- 負荷テスト (k6)
- DR 復元テスト (月 1 回、staging に PITR)

## 9. テストデータ seed 戦略

```typescript
// scripts/seed-test-data.ts
export async function seedTestData() {
  // 1. subscription_plans 9 種
  await seedSubscriptionPlans();

  // 2. テスト組織 3 件
  const orgs = await seedOrganizations(3);

  // 3. テストユーザー
  await seedUsers([
    { role: 'super_admin', email: 'super@test.local' },
    { role: 'admin', email: 'admin@test.local' },
    { role: 'finance', email: 'finance@test.local' },
    { role: 'org_admin', email: 'org-admin@test.local', orgId: orgs[0].id },
    { role: 'org_member', email: 'org-member@test.local', orgId: orgs[0].id },
    { role: 'org_industrial_doctor', email: 'doctor@test.local', orgId: orgs[0].id },
    { role: 'user', email: 'user@test.local' },
  ]);

  // 4. テスト家族グループ
  await seedFamilyGroups();

  // 5. テスト食事記録 (planned_meals 30 日分)
  await seedMeals();
}
```

各 E2E spec の `beforeAll` で独立した seed (テナント分離)。

## 10. Visual Regression

Playwright の `toMatchSnapshot()` または Percy.io / Chromatic で:
- 主要画面の差分検出
- ダークモード切替時の差分 (Phase 2)
- レスポンシブブレークポイント別

baseline は main ブランチで自動更新、PR では差分レビュー必須。

## 11. テスト破壊リスト (要件 01 §15.6 と統合)

clean-build 後に既存テストが壊れているリスト:
- `tests/e2e/r10-org-pantry-deep.spec.ts` (旧 /api/org/users 参照)
- `tests/e2e/w5-13-new-features-adversarial.spec.ts` (旧 /api/org/settings)
- `tests/e2e/w5-12-admin-adversarial.spec.ts` (旧 /api/admin/* 参照)
- `tests/e2e/wave5-w56-settings-account-profile-adversarial.spec.ts` (旧 plan-limits 経由)

これらは **設計書実装後に書き直し** (新 API 仕様に対応)。

## 12. 既存実装との関連

### 12.1 削除済 (clean-build)
- `src/app/api/admin/*`, `super-admin/*` 等の既存テストは無効化済

### 12.2 保持 (既存維持)
- `tests/e2e/smoke.spec.ts` (LP + ログイン、新 API に依存しない)
- `apps/mobile/__tests__/lib/deeplink.test.ts` (新規 deeplink ロジックで再利用可能)

### 12.3 新規追加
- 上記 §7 の E2E spec 30 件
- 各ドメイン設計書末尾の「テスト方針」セクションで定義された Unit/Integration

## 13. 未解決事項

- Visual Regression のベンダー選定 (Percy vs Chromatic)
- Mobile E2E の自動化 (Maestro vs Detox)
- 実 LLM を使った E2E nightly のコスト試算
- staging 環境でのデータマスキング戦略 (cross/22 と整合)

---

## 14. テスト命名規則

### 14.1 ファイル名規則

| 種別 | 拡張子 | 例 |
|------|--------|---|
| Unit | `*.test.ts` | `allergen-checker.test.ts` |
| Integration | `*.integration.test.ts` | `family-groups-rls.integration.test.ts` |
| E2E | `*.spec.ts` | `family-01-create-and-invite.spec.ts` |
| Edge Function (Deno) | `*.test.ts` | `family-meal-ai-propose.test.ts` |

### 14.2 describe / it 命名: 「対象 + 条件 + 期待結果」

```typescript
// 推奨パターン: 対象 > 条件 > 期待結果
describe('FamilyGroupService', () => {
  describe('createGroup', () => {
    it('returns created group when valid payload is given');
    it('returns 409 when user already owns a group');
    it('returns 422 when name exceeds 100 characters');
  });

  describe('freezeGroup', () => {
    it('sets status to frozen when HR webhook triggers revocation');
    it('sets freeze_grace_until to 30 days later');
    it('returns 403 when caller is not the owner');
  });
});

// RLS テスト
describe('family_groups RLS', () => {
  it('owner can SELECT own group');
  it('returns 403 when user is not a family member');
  it('returns 403 when user is org_industrial_doctor');
});

// API テスト
describe('POST /api/family/groups', () => {
  it('returns 201 with group object when request is valid');
  it('returns 401 when Authorization header is missing');
  it('returns 409 when user already owns a group');
  it('returns 422 when plan_key is invalid');
});
```

### 14.3 日本語 it 文字列について

日本語 it 文字列は**許容する**。ただし一貫性のため以下のルールを守る:

- RLS テスト: 英語 (DB レベルのテストはエンジニア全員が読む)
- Unit/Integration のビジネスロジック: 日本語可 (プロダクトオーナーが読む可能性あり)
- E2E spec: 英語推奨 (Playwright レポートを英語で確認するケースが多い)

```typescript
// 日本語 it の例 (ビジネスロジック系)
describe('アレルゲン突合ロジック', () => {
  it('卵アレルギーを持つメンバーがいる場合、卵を含むレシピを除外する');
  it('3 回リトライしてもアレルゲンが除去できない場合は 422 を返す');
  it('アレルゲンが空配列の場合は全レシピが候補になる');
});
```

---

## 15. テストデータ Factory パターン

Factory 関数は `faker` ライブラリ (`@faker-js/faker`) を使い、テストごとに独立したデータを生成する。

### 15.1 family_groups Factory

```typescript
// tests/factories/family-group.factory.ts
import { faker } from '@faker-js/faker/locale/ja';
import { SupabaseClient } from '@supabase/supabase-js';

export interface FamilyGroupOverrides {
  name?: string;
  owner_id?: string;
  plan_key?: string;
  status?: 'active' | 'frozen' | 'archived';
  member_limit?: number;
}

export const familyGroupFactory = (overrides?: FamilyGroupOverrides) => ({
  id: faker.string.uuid(),
  name: faker.company.name() + '家',
  description: faker.lorem.sentence(),
  owner_id: faker.string.uuid(),
  plan_key: 'family_basic',
  source_org_assignment_id: null,
  member_limit: 4,
  settings: { share_meal_records: 'false', weekly_menu_day: 'monday' },
  status: 'active' as const,
  frozen_at: null,
  freeze_grace_until: null,
  archived_at: null,
  ...overrides,
});

export async function createFamilyGroupInDB(
  supabase: SupabaseClient,
  overrides?: FamilyGroupOverrides,
) {
  const payload = familyGroupFactory(overrides);
  const { data, error } = await supabase
    .from('family_groups')
    .insert(payload)
    .select()
    .single();
  if (error) throw new Error(`createFamilyGroupInDB failed: ${error.message}`);
  return data;
}
```

### 15.2 family_members Factory

```typescript
// tests/factories/family-member.factory.ts
export const familyMemberFactory = (overrides?: Partial<FamilyMember>) => ({
  id: faker.string.uuid(),
  family_group_id: faker.string.uuid(),
  user_id: faker.string.uuid(),
  name: faker.person.firstName(),
  relation: 'spouse' as const,
  birth_date: faker.date.birthdate({ min: 20, max: 60, mode: 'age' })
    .toISOString().split('T')[0],
  gender: 'prefer_not_to_say' as const,
  allergies: [],
  dislikes: [],
  favorite_foods: [],
  diet_style: 'omnivore' as const,
  spice_tolerance: 'medium' as const,
  health_conditions: [],
  medications: [],
  role: 'member' as const,
  is_active: true,
  proxy_required: false,
  privacy_settings: { share_meals: false, share_health: false },
  ...overrides,
});

// 子供メンバー (user_id なし)
export const childMemberFactory = (overrides?: Partial<FamilyMember>) =>
  familyMemberFactory({
    user_id: null,
    name: faker.person.firstName(),
    relation: 'child',
    birth_date: faker.date.birthdate({ min: 5, max: 15, mode: 'age' })
      .toISOString().split('T')[0],
    role: 'child',
    ...overrides,
  });
```

### 15.3 organizations Factory

```typescript
// tests/factories/organization.factory.ts
export const organizationFactory = (overrides?: Partial<Organization>) => ({
  id: faker.string.uuid(),
  name: faker.company.name(),
  domain: faker.internet.domainName(),
  plan_key: 'org_standard',
  status: 'active' as const,
  settings: {
    freeze_grace_days: 30,
    allow_family_addon: true,
    sso_enabled: false,
  },
  ...overrides,
});
```

### 15.4 org_license_pools Factory

```typescript
// tests/factories/org-license-pool.factory.ts
// DDL は org/01-data-model.md §3.2 を参照
export const orgLicensePoolFactory = (overrides?: Partial<OrgLicensePool>) => ({
  id: faker.string.uuid(),
  organization_id: faker.string.uuid(),
  plan_key: 'org_pro',
  total_licenses: 10,
  used_licenses: 0,
  // NOT NULL 必須列
  starts_at: new Date().toISOString(),
  ends_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  unit_price_jpy: 1980,
  billing_cycle: 'monthly',
  auto_renew: true,
  ...overrides,
});
```

### 15.5 personal_subscriptions Factory

```typescript
// tests/factories/personal-subscription.factory.ts
export const personalSubscriptionFactory = (
  overrides?: Partial<PersonalSubscription>,
) => ({
  id: faker.string.uuid(),
  user_id: faker.string.uuid(),
  plan_key: 'pro',  // operator/01 §3 公式 plan_key seed と整合
  stripe_subscription_id: `sub_${faker.string.alphanumeric(14)}`,
  stripe_customer_id: `cus_${faker.string.alphanumeric(14)}`,
  status: 'active' as const,
  current_period_start: new Date().toISOString(),
  current_period_end: new Date(
    Date.now() + 30 * 24 * 60 * 60 * 1000,
  ).toISOString(),
  cancel_at_period_end: false,
  trial_end: null,
  ...overrides,
});
```

### 15.6 subscription_plans Factory

```typescript
// tests/factories/subscription-plan.factory.ts
export const subscriptionPlanFactory = (
  overrides?: Partial<SubscriptionPlan>,
) => ({
  plan_key: `test_plan_${faker.string.alphanumeric(6)}`,
  display_name: faker.commerce.productName(),
  plan_type: 'personal' as const,  // CHECK 制約値: personal / family / org (operator/01)
  monthly_price_jpy: 980,
  yearly_price_jpy: 9800,  // DDL は yearly_price_jpy (annual ではない)
  feature_packages: [] as string[],  // UUID[] (operator/01 §3.x)、features ではない
  max_members: null,  // 家族: 4-8、組織: メンバー上限
  max_family_seats: null,  // 組織同梱の家族 seat 数
  trial_days: 14,
  status: 'public' as const,
  ...overrides,
});

// 9 種公式 plan_key (operator/01-data-model.md §3 の seed と完全一致)
export const STANDARD_PLANS = [
  { plan_key: 'free', display_name: '無料プラン', monthly_price_jpy: 0 },
  { plan_key: 'pro', display_name: 'Pro', monthly_price_jpy: 980 },
  { plan_key: 'family_basic', display_name: 'Family Basic', monthly_price_jpy: 1480 },
  { plan_key: 'family_pro', display_name: 'Family Pro', monthly_price_jpy: 2480 },
  { plan_key: 'family_addon', display_name: 'Family Addon', monthly_price_jpy: 280 },
  { plan_key: 'org_starter', display_name: 'Org Starter', monthly_price_jpy: 580 },
  { plan_key: 'org_standard', display_name: 'Org Standard', monthly_price_jpy: 980 },
  { plan_key: 'org_pro', display_name: 'Org Pro', monthly_price_jpy: 1980 },
  { plan_key: 'org_enterprise', display_name: 'Org Enterprise', monthly_price_jpy: null },
] as const;
```

---

## 16. テストデータベース Seed 戦略 (詳細実装)

```typescript
// scripts/seed-test-data.ts
import { createClient } from '@supabase/supabase-js';
import { faker } from '@faker-js/faker/locale/ja';
import { STANDARD_PLANS } from '../tests/factories/subscription-plan.factory';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function seedSubscriptionPlans() {
  const { error } = await supabase
    .from('subscription_plans')
    .upsert(STANDARD_PLANS, { onConflict: 'plan_key' });
  if (error) throw error;
  console.log('[seed] subscription_plans: 9 件');
}

async function seedOrganizations(count = 3) {
  const orgs = Array.from({ length: count }, (_, i) => ({
    id: faker.string.uuid(),
    name: `テスト組織 ${i + 1}`,
    domain: `test-org-${i + 1}.example.com`,
    plan_key: ['org_starter', 'org_standard', 'org_enterprise'][i],
    status: 'active',
    settings: { freeze_grace_days: 30 },
  }));
  const { data, error } = await supabase
    .from('organizations')
    .insert(orgs)
    .select();
  if (error) throw error;
  console.log(`[seed] organizations: ${count} 件`);
  return data;
}

async function seedUsers(
  users: Array<{
    role: string;
    email: string;
    orgId?: string;
  }>,
) {
  const results: Array<{ id: string; email: string; role: string }> = [];
  for (const u of users) {
    const { data: authUser, error: authError } =
      await supabase.auth.admin.createUser({
        email: u.email,
        password: 'TestPass123!',
        email_confirm: true,
      });
    if (authError) throw authError;
    await supabase.from('user_profiles').upsert({
      id: authUser.user.id,
      roles: [u.role],
      organization_id: u.orgId ?? null,
    });
    results.push({ id: authUser.user.id, email: u.email, role: u.role });
  }
  console.log(`[seed] users: ${users.length} 件`);
  return results;
}

async function seedFamilyGroups() {
  // オーナーユーザーを取得
  const { data: ownerProfile } = await supabase
    .from('user_profiles')
    .select('id')
    .eq('roles', ['user'])
    .single();

  if (!ownerProfile) return;

  // 家族グループ 1: active
  await supabase.from('family_groups').insert({
    name: '田中家',
    owner_id: ownerProfile.id,
    plan_key: 'family_basic',
    status: 'active',
    member_limit: 4,
  });

  // 家族グループ 2: frozen (退職シナリオ用)
  await supabase.from('family_groups').insert({
    name: '山田家',
    owner_id: ownerProfile.id,
    plan_key: 'family_addon',
    status: 'frozen',
    frozen_at: new Date().toISOString(),
    freeze_grace_until: new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString(),
    member_limit: 4,
  });
  console.log('[seed] family_groups: 2 件');
}

async function seedMeals() {
  // planned_meals 30 日分
  const records = Array.from({ length: 30 }, (_, i) => ({
    user_id: faker.string.uuid(),
    date: new Date(Date.now() - i * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0],
    meal_type: ['breakfast', 'lunch', 'dinner'][i % 3],
    dish_name: faker.food.dish(),
  }));
  await supabase.from('planned_meals').insert(records);
  console.log('[seed] planned_meals: 30 件');
}

export async function seedTestData() {
  console.log('[seed] テストデータ投入開始...');
  await seedSubscriptionPlans();
  const orgs = await seedOrganizations(3);
  await seedUsers([
    { role: 'super_admin', email: 'super@test.local' },
    { role: 'admin', email: 'admin@test.local' },
    { role: 'finance', email: 'finance@test.local' },
    { role: 'org_admin', email: 'org-admin@test.local', orgId: orgs[0].id },
    { role: 'org_member', email: 'org-member@test.local', orgId: orgs[0].id },
    {
      role: 'org_industrial_doctor',
      email: 'doctor@test.local',
      orgId: orgs[0].id,
    },
    { role: 'user', email: 'user@test.local' },
  ]);
  await seedFamilyGroups();
  await seedMeals();
  console.log('[seed] 完了');
}

// CLI から実行: npx tsx scripts/seed-test-data.ts
if (require.main === module) {
  seedTestData().catch(console.error);
}
```

---

## 17. RLS 網羅テスト パターン

各 RLS ポリシーに対して allow / deny の両方を確認する。テストには Supabase Local の `service_role` と `auth.uid()` を切り替えたクライアントを使用する。

```typescript
// tests/integration/family/family-groups-rls.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createTestUser } from '../../helpers/auth';
import { createFamilyGroupInDB } from '../../factories/family-group.factory';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ユーザーとして操作するクライアントを生成
async function createUserClient(userId: string) {
  const { data } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: `${userId}@test.local`,
  });
  // 実際の実装では signInWithPassword を使用
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${data?.properties?.access_token}` } } },
  );
}

describe('family_groups RLS', () => {
  let owner: { id: string; client: ReturnType<typeof createClient> };
  let nonMember: { id: string; client: ReturnType<typeof createClient> };
  let group: { id: string };

  beforeAll(async () => {
    const ownerUser = await createTestUser('user');
    const nonMemberUser = await createTestUser('user');
    owner = { id: ownerUser.id, client: await createUserClient(ownerUser.id) };
    nonMember = {
      id: nonMemberUser.id,
      client: await createUserClient(nonMemberUser.id),
    };
    group = await createFamilyGroupInDB(supabaseAdmin, {
      owner_id: ownerUser.id,
    });
  });

  it('owner can SELECT own group', async () => {
    const { data, error } = await owner.client
      .from('family_groups')
      .select('*')
      .eq('id', group.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(group.id);
  });

  it('member can SELECT (in same group)', async () => {
    // member を family_members に追加
    await supabaseAdmin.from('family_members').insert({
      family_group_id: group.id,
      user_id: nonMember.id,
      name: 'テストメンバー',
      relation: 'spouse',
      role: 'member',
    });
    const { data, error } = await nonMember.client
      .from('family_groups')
      .select('*')
      .eq('id', group.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('non-member cannot SELECT', async () => {
    const stranger = await createTestUser('user');
    const strangerClient = await createUserClient(stranger.id);
    const { data, error } = await strangerClient
      .from('family_groups')
      .select('*')
      .eq('id', group.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(0); // RLS: 0 行返却 (404 相当)
  });

  it('only owner can UPDATE group name', async () => {
    // owner は OK
    const { error: ownerError } = await owner.client
      .from('family_groups')
      .update({ name: '新しい名前' })
      .eq('id', group.id);
    expect(ownerError).toBeNull();

    // member は NG
    const memberUser = await createTestUser('user');
    await supabaseAdmin.from('family_members').insert({
      family_group_id: group.id,
      user_id: memberUser.id,
      name: 'メンバー2',
      relation: 'parent',
      role: 'member',
    });
    const memberClient = await createUserClient(memberUser.id);
    const { error: memberError } = await memberClient
      .from('family_groups')
      .update({ name: '不正な変更' })
      .eq('id', group.id);
    expect(memberError).not.toBeNull(); // RLS 拒否
  });

  it('frozen group: cannot INSERT family_meal_requests', async () => {
    const frozenGroup = await createFamilyGroupInDB(supabaseAdmin, {
      owner_id: owner.id,
      status: 'frozen',
    });
    const { error } = await owner.client
      .from('family_meal_requests')
      .insert({
        family_group_id: frozenGroup.id,
        requester_id: owner.id,
        target_member_id: faker.string.uuid(),
        date: '2026-06-01',
        meal_type: 'dinner',
      });
    expect(error).not.toBeNull(); // RLS: frozen グループへの INSERT 禁止
  });

  it('DELETE is denied for all roles', async () => {
    const { error } = await owner.client
      .from('family_groups')
      .delete()
      .eq('id', group.id);
    expect(error).not.toBeNull(); // RLS: DELETE 禁止
  });
});

describe('family_activity_log RLS', () => {
  it('owner can SELECT own group activity log', async () => { /* ... */ });
  it('UPDATE is denied for all roles (immutable log)', async () => { /* ... */ });
  it('DELETE is denied for all roles (immutable log)', async () => { /* ... */ });
});
```

---

## 18. Edge Function テスト戦略

Edge Function (Deno) のテストは `supabase/functions/_tests/` に配置し、Deno の標準テストランナーで実行する。

### 18.1 family-meal-ai-propose テスト

```typescript
// supabase/functions/family-meal-ai-propose/test.ts
import {
  assertEquals,
  assertExists,
  assertRejects,
} from 'https://deno.land/std@0.208.0/testing/asserts.ts';
import { stub } from 'https://deno.land/std@0.208.0/testing/mock.ts';
import { handler } from './index.ts';
import { xaiGrokClient } from '../_shared/llm-usage.ts';

Deno.test('AI 提案 - 正常系: 有効なレシピを返す', async () => {
  const stubChat = stub(
    xaiGrokClient,
    'chat',
    () =>
      Promise.resolve({
        proposed_recipe: {
          dish_name: '鶏胸肉のハーブグリル',
          ingredients: [
            { name: '鶏胸肉', quantity: '200g' },
            { name: 'オリーブオイル', quantity: '大さじ1' },
          ],
          instructions: ['①鶏胸肉を下味をつける', '②グリルで焼く'],
          nutrition: { calories: 320, protein: 42, carbs: 3, fat: 15 },
          cooking_time_min: 20,
          allergens: [],
        },
      }),
  );

  try {
    const result = await handler({
      constraints: { max_calories: 400, exclude_ingredients: [] },
      member_context: { dietary_restrictions: [], allergies: [] },
      date: '2026-06-01',
      meal_type: 'dinner',
    });

    assertExists(result.proposed_recipe);
    assertEquals(result.proposed_recipe.dish_name, '鶏胸肉のハーブグリル');
    assertEquals(result.proposed_recipe.allergens.length, 0);
  } finally {
    stubChat.restore();
  }
});

Deno.test('AI 提案 - アレルゲン除外: 卵アレルギー', async () => {
  let callCount = 0;
  const stubChat = stub(xaiGrokClient, 'chat', () => {
    callCount++;
    if (callCount <= 2) {
      // 最初の 2 回はアレルゲンヒット
      return Promise.resolve({
        proposed_recipe: {
          dish_name: '卵焼き',
          ingredients: [{ name: '卵', quantity: '3個' }],
          allergens: ['卵'],
        },
      });
    }
    // 3 回目は OK
    return Promise.resolve({
      proposed_recipe: {
        dish_name: '鶏胸肉の照り焼き',
        ingredients: [{ name: '鶏胸肉', quantity: '200g' }],
        allergens: [],
      },
    });
  });

  try {
    const result = await handler({
      constraints: { excluded_ingredients: ['卵', '乳製品'] },
      member_context: { dietary_restrictions: ['卵アレルギー'], allergies: ['卵'] },
      date: '2026-06-01',
      meal_type: 'lunch',
    });

    assertEquals(callCount, 3); // 3 回リトライ
    assertEquals(result.proposed_recipe.dish_name, '鶏胸肉の照り焼き');
    const ingredientNames = result.proposed_recipe.ingredients.map(
      (i: { name: string }) => i.name,
    );
    assertEquals(ingredientNames.includes('卵'), false);
  } finally {
    stubChat.restore();
  }
});

Deno.test('AI 提案 - 3 回リトライ後もアレルゲンヒット → 422 を返す', async () => {
  const stubChat = stub(
    xaiGrokClient,
    'chat',
    () =>
      Promise.resolve({
        proposed_recipe: {
          dish_name: '卵焼き',
          ingredients: [{ name: '卵', quantity: '3個' }],
          allergens: ['卵'],
        },
      }),
  );

  try {
    await assertRejects(
      () =>
        handler({
          constraints: { excluded_ingredients: ['卵'] },
          member_context: { allergies: ['卵'] },
          date: '2026-06-01',
          meal_type: 'lunch',
        }),
      Error,
      'MAX_RETRY_EXCEEDED',
    );
  } finally {
    stubChat.restore();
  }
});
```

### 18.2 industrial-doctor-advice テスト

```typescript
// supabase/functions/industrial-doctor-advice/test.ts
Deno.test('産業医 AI アドバイス - 家族データが除外されること', async () => {
  const stubChat = stub(xaiGrokClient, 'chat', () =>
    Promise.resolve({ advice: 'バランスの取れた食事を心がけてください。' }),
  );

  try {
    // 家族グループ由来の食事記録 (source_family_group_id IS NOT NULL) は
    // 集計から除外されて LLM に渡されないことを確認
    const callArgs = stubChat.calls[0]?.args[0];
    assertExists(callArgs);
    // meals に家族データが含まれていないことを検証
    assertEquals(
      callArgs.meals.filter((m: { source_family_group_id: string | null }) =>
        m.source_family_group_id !== null
      ).length,
      0,
    );
  } finally {
    stubChat.restore();
  }
});
```

---

## 19. 並行性テスト (Race Condition)

データベースレベルでの並行制御が正しく機能することを検証する。

### 19.1 ライセンスプール容量テスト

```typescript
// tests/integration/org/license-pool-concurrency.integration.test.ts
describe('License pool capacity (concurrency)', () => {
  it('10 concurrent INSERTs do not exceed total_licenses=5', async () => {
    const pool = await createOrgLicensePoolInDB(supabaseAdmin, {
      total_licenses: 5,
      used_licenses: 5, // 既に満杯
    });

    // 10 件を同時にリクエスト
    const promises = Array.from({ length: 10 }, (_, i) =>
      supabaseAdmin.from('org_license_assignments').insert({
        pool_id: pool.id,
        organization_id: pool.organization_id,
        user_id: faker.string.uuid(),
        plan_key: pool.plan_key,
      }),
    );

    const results = await Promise.allSettled(promises);
    const successCount = results.filter((r) => {
      if (r.status !== 'fulfilled') return false;
      return r.value.error === null;
    }).length;

    // total=5, used=5 なら 10 件全て失敗するはず
    expect(successCount).toBe(0);

    // used_licenses が増えていないことを確認
    const { data: updated } = await supabaseAdmin
      .from('org_license_pools')
      .select('used_licenses')
      .eq('id', pool.id)
      .single();
    expect(updated?.used_licenses).toBe(5);
  });

  it('5 concurrent INSERTs succeed when total_licenses=10 and used=5', async () => {
    const pool = await createOrgLicensePoolInDB(supabaseAdmin, {
      total_licenses: 10,
      used_licenses: 5,
    });

    const promises = Array.from({ length: 5 }, () =>
      supabaseAdmin.from('org_license_assignments').insert({
        pool_id: pool.id,
        organization_id: pool.organization_id,
        user_id: faker.string.uuid(),
        plan_key: pool.plan_key,
      }),
    );

    const results = await Promise.allSettled(promises);
    const successCount = results.filter((r) => {
      if (r.status !== 'fulfilled') return false;
      return r.value.error === null;
    }).length;

    expect(successCount).toBe(5);

    const { data: updated } = await supabaseAdmin
      .from('org_license_pools')
      .select('used_licenses')
      .eq('id', pool.id)
      .single();
    expect(updated?.used_licenses).toBe(10);
  });
});
```

### 19.2 グループ分割の Advisory Lock テスト

```typescript
// tests/integration/family/lifecycle-advisory-lock.integration.test.ts
describe('家族グループ分割 Advisory Lock', () => {
  it('2 concurrent split requests: only one succeeds', async () => {
    const group = await createFamilyGroupInDB(supabaseAdmin, {
      status: 'active',
    });

    // 同時に 2 つの分割リクエストを送信
    const [result1, result2] = await Promise.allSettled([
      fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/family/groups/${group.id}/split`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'If-Unmodified-Since': new Date().toISOString(),
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({ member_ids_to_split: [memberId] }),
      }),
      fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/family/groups/${group.id}/split`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'If-Unmodified-Since': new Date().toISOString(),
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({ member_ids_to_split: [memberId] }),
      }),
    ]);

    const statuses = await Promise.all(
      [result1, result2].map(async (r) => {
        if (r.status === 'fulfilled') return (await r.value.json()).status;
        return 'error';
      }),
    );

    // 1 つは成功、1 つは 412 または 409
    const successCount = statuses.filter((s) => s === 200 || s === 201).length;
    const failCount = statuses.filter((s) => s === 412 || s === 409).length;
    expect(successCount).toBe(1);
    expect(failCount).toBe(1);
  });
});
```

---

## 20. Stripe Webhook テスト (Idempotency)

```typescript
// tests/integration/operator/stripe-webhook-idempotency.integration.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY_TEST!, {
  apiVersion: '2024-11-20.acacia',
});

// テスト用 Stripe Fixture (Stripe Test Mode のイベント)
function createSubscriptionCreatedEvent(subscriptionId: string) {
  return {
    id: `evt_test_${faker.string.alphanumeric(16)}`,
    type: 'customer.subscription.created',
    data: {
      object: {
        id: subscriptionId,
        customer: `cus_test_${faker.string.alphanumeric(14)}`,
        status: 'active',
        items: {
          data: [
            {
              price: {
                id: 'price_pro',
                metadata: { plan_key: 'pro' },
              },
            },
          ],
        },
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        cancel_at_period_end: false,
        trial_end: null,
      },
    },
    created: Math.floor(Date.now() / 1000),
  };
}

describe('Stripe webhook idempotency', () => {
  it('same event_id processed only once', async () => {
    const subscriptionId = `sub_test_${faker.string.alphanumeric(14)}`;
    const event = createSubscriptionCreatedEvent(subscriptionId);

    // 署名付きペイロードを生成
    const payload = JSON.stringify(event);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET!,
    });

    const headers = {
      'Content-Type': 'application/json',
      'stripe-signature': signature,
    };

    // 1 回目の POST
    const res1 = await fetch(
      `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/stripe`,
      { method: 'POST', headers, body: payload },
    );
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.processed).toBe(true);

    // 2 回目の POST (同じ event_id)
    const res2 = await fetch(
      `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/stripe`,
      { method: 'POST', headers, body: payload },
    );
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.processed).toBe(false); // 冪等処理済み
    expect(body2.reason).toBe('already_processed');

    // DB に 1 件のみ存在することを確認
    const { count } = await supabaseAdmin
      .from('personal_subscriptions')
      .select('*', { count: 'exact', head: true })
      .eq('stripe_subscription_id', subscriptionId);
    expect(count).toBe(1);
  });

  it('invoice.payment_failed changes status to past_due', async () => {
    const subscriptionId = `sub_test_${faker.string.alphanumeric(14)}`;
    // まず active なサブスクを作成
    await supabaseAdmin.from('personal_subscriptions').insert(
      personalSubscriptionFactory({ stripe_subscription_id: subscriptionId }),
    );

    const failedEvent = {
      id: `evt_test_${faker.string.alphanumeric(16)}`,
      type: 'invoice.payment_failed',
      data: {
        object: {
          subscription: subscriptionId,
          attempt_count: 1,
        },
      },
      created: Math.floor(Date.now() / 1000),
    };

    const payload = JSON.stringify(failedEvent);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET!,
    });

    await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': signature,
      },
      body: payload,
    });

    const { data: sub } = await supabaseAdmin
      .from('personal_subscriptions')
      .select('status')
      .eq('stripe_subscription_id', subscriptionId)
      .single();
    expect(sub?.status).toBe('past_due');
  });
});
```

---

## 21. AI 出力スキーマ検証テスト

```typescript
// tests/unit/operator/ai-schema-validation.test.ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

// 共有スキーマ定義 (src/shared/schemas/proposed-recipe.ts と同期)
const ProposedRecipeSchema = z.object({
  dish_name: z.string().min(1).max(200),
  ingredients: z.array(
    z.object({
      name: z.string(),
      quantity: z.string(),
      unit: z.string().optional(),
    }),
  ),
  instructions: z.array(z.string()).min(1),
  nutrition: z.object({
    calories: z.number().positive(),
    protein: z.number().nonnegative(),
    carbs: z.number().nonnegative(),
    fat: z.number().nonnegative(),
  }),
  cooking_time_min: z.number().positive().max(300),
  allergens: z.array(z.string()),
  servings: z.number().positive().default(2),
});

describe('family-meal-ai-propose スキーマ検証', () => {
  it('returns valid ProposedRecipeSchema on success', async () => {
    const mockResult = {
      proposed_recipe: {
        dish_name: '鶏胸肉の照り焼き',
        ingredients: [
          { name: '鶏胸肉', quantity: '200g' },
          { name: '醤油', quantity: '大さじ2' },
        ],
        instructions: ['①鶏胸肉を切る', '②焼く', '③タレを絡める'],
        nutrition: { calories: 350, protein: 40, carbs: 12, fat: 10 },
        cooking_time_min: 25,
        allergens: ['小麦', '大豆'],
        servings: 2,
      },
    };

    expect(() =>
      ProposedRecipeSchema.parse(mockResult.proposed_recipe),
    ).not.toThrow();
  });

  it('throws ZodError when LLM returns missing nutrition fields', () => {
    const invalidResult = {
      dish_name: '鶏胸肉の照り焼き',
      ingredients: [],
      instructions: ['①焼く'],
      nutrition: { calories: 350 }, // protein, carbs, fat が欠損
      cooking_time_min: 25,
      allergens: [],
    };

    expect(() => ProposedRecipeSchema.parse(invalidResult)).toThrow(z.ZodError);
  });

  it('retries 3 times on allergen hit, succeeds on 3rd attempt', async () => {
    const xaiGrok = { chat: vi.fn() };

    xaiGrok.chat
      .mockResolvedValueOnce({
        proposed_recipe: {
          dish_name: '卵焼き',
          ingredients: [{ name: '卵', quantity: '3個' }],
          allergens: ['卵'], // 1 回目ヒット
        },
      })
      .mockResolvedValueOnce({
        proposed_recipe: {
          dish_name: 'マヨネーズ炒め',
          ingredients: [{ name: 'マヨネーズ', quantity: '大さじ2' }],
          allergens: ['卵'], // 2 回目ヒット
        },
      })
      .mockResolvedValueOnce({
        proposed_recipe: {
          dish_name: '鶏胸肉の照り焼き',
          ingredients: [{ name: '鶏胸肉', quantity: '200g' }],
          instructions: ['①焼く'],
          nutrition: { calories: 350, protein: 40, carbs: 5, fat: 8 },
          cooking_time_min: 20,
          allergens: [], // 3 回目は OK
          servings: 2,
        },
      });

    // proposeMealWithRetry は内部で xaiGrok.chat を呼ぶ関数とする
    const { proposeMealWithRetry } = await import(
      '../../../src/lib/family/meal-propose'
    );
    const result = await proposeMealWithRetry(xaiGrok, {
      constraints: { excluded_ingredients: ['卵'] },
      member_context: { allergies: ['卵'] },
    });

    expect(xaiGrok.chat).toHaveBeenCalledTimes(3);
    expect(result.proposed_recipe.dish_name).toBe('鶏胸肉の照り焼き');
    expect(result.proposed_recipe.allergens).toHaveLength(0);
  });
});
```

---

## 22. E2E テスト Page Object パターン

```typescript
// tests/e2e/pages/FamilyGroupPage.ts
import { Page, expect } from '@playwright/test';

export class FamilyGroupPage {
  constructor(private page: Page) {}

  async create(name: string, planKey = 'family_basic') {
    await this.page.goto('/family/new');
    await this.page.waitForLoadState('networkidle');
    await this.page.fill('[data-testid=group-name-input]', name);
    await this.page.selectOption('[data-testid=plan-key-select]', planKey);
    await this.page.click('[data-testid=create-group-button]');
    await this.page.waitForURL(/\/family\/[0-9a-f-]+/);
  }

  async invite(email: string, role: 'admin' | 'member' = 'member') {
    await this.page.click('[data-testid=invite-member-button]');
    await this.page.fill('[data-testid=invite-email-input]', email);
    await this.page.selectOption('[data-testid=invite-role-select]', role);
    await this.page.click('[data-testid=send-invite-button]');
    await expect(
      this.page.locator('[data-testid=invite-success-toast]'),
    ).toBeVisible();
  }

  async getGroupId(): Promise<string> {
    const url = this.page.url();
    const match = url.match(/\/family\/([0-9a-f-]+)/);
    return match?.[1] ?? '';
  }

  async expectMemberCount(count: number) {
    await expect(
      this.page.locator('[data-testid=member-list-item]'),
    ).toHaveCount(count);
  }

  async freezeGroup() {
    await this.page.click('[data-testid=group-settings-button]');
    await this.page.click('[data-testid=freeze-group-button]');
    await this.page.click('[data-testid=confirm-freeze-button]');
    await expect(
      this.page.locator('[data-testid=group-status-badge]'),
    ).toContainText('凍結中');
  }
}

// tests/e2e/pages/MealRequestPage.ts
export class MealRequestPage {
  constructor(private page: Page) {}

  async createRequest(params: {
    targetMemberId: string;
    date: string;
    mealType: string;
    reason?: string;
  }) {
    await this.page.goto('/family/meal-requests/new');
    await this.page.selectOption(
      '[data-testid=target-member-select]',
      params.targetMemberId,
    );
    await this.page.fill('[data-testid=request-date-input]', params.date);
    await this.page.selectOption(
      '[data-testid=meal-type-select]',
      params.mealType,
    );
    if (params.reason) {
      await this.page.fill('[data-testid=reason-textarea]', params.reason);
    }
    await this.page.click('[data-testid=submit-request-button]');
    await this.page.waitForURL(/\/family\/meal-requests\/[0-9a-f-]+/);
  }

  async acceptProposal(requestId: string) {
    await this.page.goto(`/family/meal-requests/${requestId}`);
    await this.page.click('[data-testid=accept-proposal-button]');
    await this.page.click('[data-testid=confirm-accept-button]');
    await expect(
      this.page.locator('[data-testid=request-status-badge]'),
    ).toContainText('承認済み');
  }
}

// tests/e2e/pages/OrgAdminPage.ts
export class OrgAdminPage {
  constructor(private page: Page) {}

  async uploadMemberCsv(filePath: string) {
    await this.page.goto('/org/members/import');
    await this.page.setInputFiles('[data-testid=csv-file-input]', filePath);
    await this.page.click('[data-testid=upload-csv-button]');
    await this.page.waitForSelector('[data-testid=import-result-table]');
  }

  async distributeLicenses(poolId: string, memberIds: string[]) {
    await this.page.goto(`/org/licenses/${poolId}/distribute`);
    for (const memberId of memberIds) {
      await this.page.check(`[data-testid=member-checkbox-${memberId}]`);
    }
    await this.page.click('[data-testid=distribute-button]');
    await expect(
      this.page.locator('[data-testid=distribute-success-message]'),
    ).toBeVisible();
  }
}

// tests/e2e/pages/OperatorPage.ts
export class OperatorPage {
  constructor(private page: Page) {}

  async createPlan(params: {
    planKey: string;
    displayName: string;
    monthlyPrice: number;
    trialDays: number;
  }) {
    await this.page.goto('/operator/plans/new');
    await this.page.fill('[data-testid=plan-key-input]', params.planKey);
    await this.page.fill('[data-testid=display-name-input]', params.displayName);
    await this.page.fill(
      '[data-testid=monthly-price-input]',
      String(params.monthlyPrice),
    );
    await this.page.fill(
      '[data-testid=trial-days-input]',
      String(params.trialDays),
    );
    await this.page.click('[data-testid=save-draft-button]');
    await expect(
      this.page.locator('[data-testid=plan-status-badge]'),
    ).toContainText('下書き');
  }

  async publishPlan(planId: string) {
    await this.page.goto(`/operator/plans/${planId}`);
    await this.page.click('[data-testid=publish-plan-button]');
    await this.page.click('[data-testid=confirm-publish-button]');
    await expect(
      this.page.locator('[data-testid=plan-status-badge]'),
    ).toContainText('公開中');
  }

  async impersonateUser(userId: string) {
    await this.page.goto('/operator/users');
    await this.page.fill('[data-testid=search-user-input]', userId);
    await this.page.click(`[data-testid=user-row-${userId}]`);
    await this.page.click('[data-testid=impersonate-button]');
    await this.page.click('[data-testid=confirm-impersonate-button]');
    await expect(
      this.page.locator('[data-testid=impersonation-banner]'),
    ).toBeVisible();
  }
}
```

---

## 23. フレーク対策 (Flaky Test 防止)

### 23.1 Playwright 設定

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0, // CI では 2 回リトライ
  workers: process.env.CI ? 4 : 2,
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { channel: 'chromium' },
    },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] },
    },
  ],
});
```

### 23.2 Vitest 設定

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup/vitest-setup.ts'],
    timeout: 5_000,
    retry: process.env.CI ? 1 : 0,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/types/**',
        'src/**/mocks/**',
        'src/**/*.generated.*',
        'src/app/**/layout.tsx',
      ],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
      },
    },
  },
});
```

### 23.3 待機戦略

```typescript
// tests/e2e/helpers/wait-helpers.ts

// NG: 固定 sleep は使わない
// await page.waitForTimeout(2000);

// OK: 要素が現れるまで待つ
await page.waitForSelector('[data-testid=member-list]', { state: 'visible' });

// OK: ネットワークが静止するまで待つ (初期ロード後)
await page.waitForLoadState('networkidle');

// OK: API レスポンスを待つ
await page.waitForResponse(
  (resp) =>
    resp.url().includes('/api/family/groups') && resp.status() === 200,
);

// OK: Realtime 更新を待つ (タイムアウト付き)
await expect(page.locator('[data-testid=shopping-item-checked]')).toBeVisible({
  timeout: 5_000,
});
```

### 23.4 スクリーンショット・動画の自動保存

失敗時のみ自動保存 (playwright.config.ts の `screenshot: 'only-on-failure'`, `video: 'retain-on-failure'`)。

CI では `playwright-report/` と `test-results/` を artifacts として保存:

```yaml
# .github/workflows/ci.yml (抜粋)
- name: Upload Playwright report
  uses: actions/upload-artifact@v4
  if: failure()
  with:
    name: playwright-report-${{ matrix.shard }}
    path: playwright-report/
    retention-days: 14

- name: Upload test results
  uses: actions/upload-artifact@v4
  if: always()
  with:
    name: test-results-${{ matrix.shard }}
    path: test-results/
    retention-days: 7
```

---

## 24. テスト並列実行と DB 隔離

### 24.1 Playwright シャーディング

```yaml
# .github/workflows/ci.yml (E2E 並列化)
test-e2e-full:
  strategy:
    matrix:
      shard: [1, 2, 3, 4]
  steps:
    - run: pnpm playwright test --shard=${{ matrix.shard }}/4
```

### 24.2 Vitest スレッド並列

```typescript
// vitest.config.ts (pool 設定)
export default defineConfig({
  test: {
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false, // デフォルト並列
        maxThreads: 4,
        minThreads: 1,
      },
    },
  },
});
```

### 24.3 Integration テスト DB 隔離

各 Integration テストスイートは独立したスキーマを使用し、テスト間の干渉を防ぐ:

```typescript
// tests/integration/setup.ts
import { randomUUID } from 'crypto';

let testSchema: string;
let supabaseAdmin: ReturnType<typeof createClient>;

beforeAll(async () => {
  testSchema = `test_${randomUUID().replace(/-/g, '_')}`;
  supabaseAdmin = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // テスト用スキーマ作成
  await supabaseAdmin.rpc('create_test_schema', { schema_name: testSchema });
});

afterAll(async () => {
  // テスト後にスキーマを削除
  await supabaseAdmin.rpc('drop_test_schema', { schema_name: testSchema });
});
```

---

## 25. CI でのテスト実行最適化

### 25.1 変更ファイルに基づく選択実行

```yaml
# .github/workflows/ci.yml
- name: Detect changed files
  id: changes
  uses: dorny/paths-filter@v3
  with:
    filters: |
      family:
        - 'src/app/api/family/**'
        - 'src/lib/family/**'
        - 'tests/unit/family/**'
      org:
        - 'src/app/api/org/**'
        - 'src/lib/org/**'
        - 'tests/unit/org/**'
      operator:
        - 'src/app/api/operator/**'
        - 'src/lib/operator/**'

- name: Run family tests only
  if: steps.changes.outputs.family == 'true'
  run: pnpm vitest run --testPathPattern=family
```

### 25.2 node_modules + Playwright キャッシュ

```yaml
- name: Cache node_modules
  uses: actions/cache@v4
  with:
    path: ~/.pnpm-store
    key: pnpm-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
    restore-keys: pnpm-${{ runner.os }}-

- name: Cache Playwright browsers
  uses: actions/cache@v4
  with:
    path: ~/.cache/ms-playwright
    key: playwright-${{ runner.os }}-${{ hashFiles('package.json') }}
    restore-keys: playwright-${{ runner.os }}-
```

---

## 26. Visual Regression 詳細

### 26.1 設定

```typescript
// tests/visual/visual-regression.config.ts
export const VISUAL_CONFIG = {
  // 差分閾値 0.1% (ピクセル単位の微細な差は許容)
  threshold: 0.001,

  // ブレークポイント
  viewports: [
    { name: 'mobile', width: 390, height: 844 },   // iPhone 14
    { name: 'tablet', width: 768, height: 1024 },   // iPad
    { name: 'desktop', width: 1440, height: 900 },  // MacBook Pro
  ],

  // ダークモード
  colorSchemes: ['light', 'dark'] as const,

  // ベースライン保存先 (Git LFS で管理)
  snapshotDir: './tests/visual/__snapshots__',
};
```

### 26.2 テスト実装例

```typescript
// tests/visual/family-dashboard.visual.spec.ts
import { test, expect } from '@playwright/test';
import { VISUAL_CONFIG } from './visual-regression.config';

for (const viewport of VISUAL_CONFIG.viewports) {
  for (const colorScheme of VISUAL_CONFIG.colorSchemes) {
    test(`family dashboard - ${viewport.name} - ${colorScheme}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await page.goto('/family/dashboard');
      await page.waitForLoadState('networkidle');

      // アニメーション完了を待つ
      await page.evaluate(() =>
        document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 500))),
      );

      await expect(page).toHaveScreenshot(
        `family-dashboard-${viewport.name}-${colorScheme}.png`,
        { maxDiffPixelRatio: VISUAL_CONFIG.threshold },
      );
    });
  }
}
```

### 26.3 ベースライン管理

- `main` ブランチへのマージ時に baseline を自動更新
- PR では差分画像をコメントとして投稿 (percy.io または Chromatic の GitHub integration)
- 意図的な UI 変更時は `UPDATE_SNAPSHOTS=true` で baseline を手動更新

---

## 27. パフォーマンステスト (k6 詳細)

```javascript
// tests/load/k6/family-meal-request.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('error_rate');
const mealRequestDuration = new Trend('meal_request_duration');

export const options = {
  scenarios: {
    // 定常負荷: 50 VU で 5 分
    constant_load: {
      executor: 'constant-vus',
      vus: 50,
      duration: '5m',
      startTime: '0s',
    },
    // スパイク: 0 → 500 VU → 0
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '1m', target: 500 },
        { duration: '30s', target: 0 },
      ],
      startTime: '6m', // constant_load の後
    },
  },
  thresholds: {
    // p95 が 500ms 以内
    http_req_duration: ['p(95)<500', 'p(99)<2000'],
    // エラー率 1% 以内
    http_req_failed: ['rate<0.01'],
    error_rate: ['rate<0.01'],
    meal_request_duration: ['p(95)<800'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'https://staging.homegohan.app';
const AUTH_TOKEN = __ENV.AUTH_TOKEN;

export default function () {
  const params = {
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };

  // 家族グループ一覧取得
  const listRes = http.get(`${BASE_URL}/api/family/groups`, params);
  check(listRes, {
    'GET /api/family/groups status is 200': (r) => r.status === 200,
    'response time < 300ms': (r) => r.timings.duration < 300,
  });
  errorRate.add(listRes.status !== 200);

  // 個別リクエスト作成
  const requestStart = Date.now();
  const postRes = http.post(
    `${BASE_URL}/api/family/meal-requests`,
    JSON.stringify({
      family_group_id: __ENV.TEST_GROUP_ID,
      target_member_id: __ENV.TEST_MEMBER_ID,
      date: new Date().toISOString().split('T')[0],
      meal_type: 'dinner',
      reason: 'k6 負荷テスト',
    }),
    params,
  );
  mealRequestDuration.add(Date.now() - requestStart);

  check(postRes, {
    'POST /api/family/meal-requests status is 201': (r) => r.status === 201,
    'response has id': (r) => JSON.parse(r.body).id !== undefined,
  });
  errorRate.add(postRes.status !== 201);

  sleep(1);
}

export function handleSummary(data) {
  return {
    'tests/load/results/summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
```

---

## 28. テストカバレッジ計測 (Istanbul / v8)

### 28.1 vitest.config.ts coverage 設定 (完全版)

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup/vitest-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: [
        'text-summary',  // ターミナル出力
        'html',          // ブラウザで確認
        'lcov',          // Codecov / SonarQube 連携
        'json-summary',  // CI での閾値チェック
      ],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        // 型定義
        'src/**/*.d.ts',
        'src/**/types/**',
        'src/**/schemas/**',
        // モック
        'src/**/mocks/**',
        'src/**/__mocks__/**',
        // 自動生成コード
        'src/**/*.generated.*',
        'src/generated/**',
        // レイアウト (ロジックなし)
        'src/app/**/layout.tsx',
        'src/app/**/loading.tsx',
        'src/app/**/error.tsx',
        'src/app/**/not-found.tsx',
        // Storybook
        'src/**/*.stories.{ts,tsx}',
      ],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
        // ディレクトリごとに閾値を設定可能
        'src/lib/': {
          lines: 95,
          branches: 90,
          functions: 95,
        },
        'src/components/': {
          lines: 80,
          branches: 75,
        },
      },
    },
  },
});
```

### 28.2 Codecov 連携

```yaml
# .github/workflows/ci.yml (coverage upload)
- name: Upload coverage to Codecov
  uses: codecov/codecov-action@v4
  with:
    token: ${{ secrets.CODECOV_TOKEN }}
    files: ./coverage/lcov.info
    flags: unit
    fail_ci_if_error: true
    verbose: true
```

---

## 29. アクセシビリティテスト詳細

### 29.1 @axe-core/playwright の使い方

```typescript
// tests/e2e/helpers/a11y.ts
import { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export async function checkA11y(
  page: Page,
  options?: {
    includedImpacts?: ('critical' | 'serious' | 'moderate' | 'minor')[];
    exclude?: string[];
  },
) {
  const builder = new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa',
  ]);

  // 特定要素を除外 (サードパーティ、ビデオプレイヤー等)
  if (options?.exclude?.length) {
    builder.exclude(options.exclude);
  }

  const results = await builder.analyze();

  // 重大度でフィルタリング
  const targetImpacts = options?.includedImpacts ?? ['critical', 'serious'];
  const violations = results.violations.filter(
    (v) => v.impact && targetImpacts.includes(v.impact as never),
  );

  if (violations.length > 0) {
    const messages = violations.map(
      (v) =>
        `[${v.impact}] ${v.id}: ${v.description}\n  ` +
        v.nodes.map((n) => n.target.join(', ')).join('\n  '),
    );
    throw new Error(
      `${violations.length} accessibility violation(s) found:\n${messages.join('\n\n')}`,
    );
  }

  return results;
}
```

### 29.2 E2E spec での使用例

```typescript
// tests/e2e/a11y/family-dashboard-a11y.spec.ts
import { test, expect } from '@playwright/test';
import { checkA11y } from '../helpers/a11y';

test.describe('家族ダッシュボード アクセシビリティ', () => {
  test('critical/serious violations = 0 on family dashboard', async ({
    page,
  }) => {
    await page.goto('/family/dashboard');
    await page.waitForLoadState('networkidle');
    await checkA11y(page, { includedImpacts: ['critical', 'serious'] });
  });

  test('critical/serious violations = 0 on meal request form', async ({
    page,
  }) => {
    await page.goto('/family/meal-requests/new');
    await page.waitForLoadState('networkidle');
    await checkA11y(page, {
      includedImpacts: ['critical', 'serious'],
      exclude: ['#stripe-payment-element'], // Stripe 埋め込みは除外
    });
  });

  test('keyboard navigation works on family member list', async ({ page }) => {
    await page.goto('/family/members');
    await page.keyboard.press('Tab');
    const focusedElement = page.locator(':focus');
    await expect(focusedElement).toBeVisible();
    // Tab キーでフォーカスが移動することを確認
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(focusedElement).toBeFocused();
  });
});
```

---

## 30. テスト失敗時のデバッグ

### 30.1 Playwright Trace Viewer

```bash
# CI の artifacts からトレースファイルをダウンロードして確認
npx playwright show-trace test-results/family-create-and-invite-chromium/trace.zip
```

`playwright.config.ts` で `trace: 'retain-on-failure'` を設定すると、失敗時のみ `.zip` トレースが保存される。

### 30.2 Network HAR 保存

```typescript
// tests/e2e/helpers/debug.ts
export async function saveHar(page: Page, filename: string) {
  if (process.env.CI && process.env.DEBUG_HAR) {
    await page.routeFromHAR(`./test-results/har/${filename}.har`, {
      update: true,
    });
  }
}
```

### 30.3 console.log 出力の収集

```typescript
// tests/e2e/helpers/console-collector.ts
export function collectConsoleLogs(page: Page): string[] {
  const logs: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      logs.push(`[${msg.type()}] ${msg.text()}`);
    }
  });
  return logs;
}

// テストでの使用
test('no console errors on family page', async ({ page }) => {
  const logs = collectConsoleLogs(page);
  await page.goto('/family/dashboard');
  await page.waitForLoadState('networkidle');
  expect(logs.filter((l) => l.includes('[error]'))).toHaveLength(0);
});
```

---

## 31. テスト品質メトリクス

### 31.1 Mutation Testing (Stryker)

```json
// stryker.config.json
{
  "packageManager": "pnpm",
  "reporters": ["html", "clear-text", "progress", "dashboard"],
  "testRunner": "vitest",
  "coverageAnalysis": "perTest",
  "mutate": [
    "src/lib/**/*.ts",
    "!src/lib/**/*.test.ts",
    "!src/lib/**/*.d.ts"
  ],
  "thresholds": {
    "high": 80,
    "low": 60,
    "break": 50
  }
}
```

Stryker は週次 nightly でのみ実行 (コストが高いため)。mutation score が 50% 未満のモジュールは優先的にテスト強化対象とする。

### 31.2 Test Execution Time Tracking

```yaml
# .github/workflows/ci.yml
- name: Track test execution time
  run: |
    echo "unit_test_duration=$(cat test-results/vitest-duration.txt)" >> $GITHUB_STEP_SUMMARY
    echo "e2e_test_duration=$(cat test-results/playwright-duration.txt)" >> $GITHUB_STEP_SUMMARY
```

### 31.3 Flake Rate Monitoring

- CI の各 run で test 結果を `test-results/results.json` に保存
- Datadog / Grafana で flake rate をモニタリング (1% を超えたらアラート)
- GitHub Actions の `retry` で 2 回以内に成功したテストは flaky 候補としてラベル

---

## 32. 各ドメイン代表テストケース (具体例 20 件)

### 32.1 Family ドメイン (5 件)

```typescript
// tests/unit/family/allergen-checker.test.ts
describe('アレルゲン突合ロジック', () => {
  it('excludes recipe with egg when member has egg allergy', () => {
    const member = familyMemberFactory({ allergies: ['卵'] });
    const recipe = { ingredients: [{ name: '卵', quantity: '3個' }] };
    expect(hasAllergenConflict(member, recipe)).toBe(true);
  });

  it('accepts recipe with chicken when only egg allergy', () => {
    const member = familyMemberFactory({ allergies: ['卵'] });
    const recipe = { ingredients: [{ name: '鶏胸肉', quantity: '200g' }] };
    expect(hasAllergenConflict(member, recipe)).toBe(false);
  });
});

// tests/integration/family/meal-request-status.integration.test.ts
describe('個別献立リクエスト ステータス遷移', () => {
  it('transitions from pending to proposed when assignee proposes', async () => {
    const request = await createMealRequestInDB(supabaseAdmin, {
      status: 'pending',
    });
    await supabaseAdmin
      .from('family_meal_requests')
      .update({ status: 'proposed', proposed_dish_name: '鶏肉の煮物' })
      .eq('id', request.id);
    const { data } = await supabaseAdmin
      .from('family_meal_requests')
      .select('status')
      .eq('id', request.id)
      .single();
    expect(data?.status).toBe('proposed');
  });

  it('returns 403 when non-owner tries to accept proposal', async () => {
    // 非オーナーユーザーで PATCH をコール → 403 を確認
    const res = await fetch(
      `${BASE_URL}/api/family/meal-requests/${requestId}/accept`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${nonOwnerToken}` },
      },
    );
    expect(res.status).toBe(403);
  });
});

// tests/e2e/family/family-11-realtime-shopping.spec.ts
test('Realtime: wife checks item, husband sees update within 2s', async ({
  browser,
}) => {
  const wifeContext = await browser.newContext();
  const husbandContext = await browser.newContext();
  const wifePage = await wifeContext.newPage();
  const husbandPage = await husbandContext.newPage();

  await Promise.all([
    wifePage.goto('/family/shopping-list'),
    husbandPage.goto('/family/shopping-list'),
  ]);
  await Promise.all([
    wifePage.waitForLoadState('networkidle'),
    husbandPage.waitForLoadState('networkidle'),
  ]);

  await wifePage.click('[data-testid=shopping-item-0-checkbox]');
  await expect(
    husbandPage.locator('[data-testid=shopping-item-0-checkbox]'),
  ).toBeChecked({ timeout: 5_000 });
});
```

### 32.2 Org ドメイン (5 件)

```typescript
// tests/integration/org/license-pool-overflow.integration.test.ts
describe('ライセンスプール容量制限', () => {
  it('returns 409 when pool is at capacity and new assignment is attempted', async () => {
    const pool = await createOrgLicensePoolInDB(supabaseAdmin, {
      total_licenses: 1,
      used_licenses: 1, // 満杯
    });
    const res = await fetch(`${BASE_URL}/api/org/licenses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${orgAdminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pool_id: pool.id, user_id: faker.string.uuid() }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('ORG_LICENSE_POOL_EXHAUSTED');
  });

  it('HR webhook is idempotent for same external_id', async () => {
    const payload = { external_id: 'hr-event-001', action: 'revoke', user_id: memberId };
    const res1 = await POST('/api/webhooks/hr', payload, orgAdminToken);
    const res2 = await POST('/api/webhooks/hr', payload, orgAdminToken);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.idempotent).toBe(true);
  });

  it('industrial doctor cannot access other org patient data', async () => {
    const res = await fetch(
      `${BASE_URL}/api/org/industrial-doctor/patients/${otherOrgPatientId}`,
      { headers: { Authorization: `Bearer ${doctorToken}` } },
    );
    expect(res.status).toBe(403);
  });

  it('family group is frozen when HR revoke is processed', async () => {
    await triggerHrRevoke(memberId);
    // バッチ処理を待つ (Integration テストでは直接関数を呼び出す)
    await processRevokeJob(memberId);
    const { data: group } = await supabaseAdmin
      .from('family_groups')
      .select('status')
      .eq('owner_id', memberId)
      .single();
    expect(group?.status).toBe('frozen');
  });

  it('monthly report PDF is generated with correct member stats', async ({
    page,
  }) => {
    await page.goto('/org/reports/monthly');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('[data-testid=download-pdf-button]'),
    ]);
    expect(download.suggestedFilename()).toMatch(/monthly-report-\d{4}-\d{2}\.pdf/);
  });
});
```

### 32.3 Operator ドメイン (5 件)

```typescript
// tests/unit/operator/plan-validation.test.ts
describe('プラン作成バリデーション', () => {
  it('returns error when plan_key contains uppercase letters', () => {
    const result = validatePlanCreate({ plan_key: 'Individual_Pro' });
    expect(result.success).toBe(false);
    expect(result.errors[0].field).toBe('plan_key');
  });

  it('calculates gross margin correctly for standard plan', () => {
    const margin = calculateGrossMargin({
      monthly_price_jpy: 980,
      stripe_fee_rate: 0.036,
      infra_cost_jpy: 50,
    });
    expect(margin.gross_margin_jpy).toBe(895); // 980 * (1 - 0.036) - 50
    expect(margin.gross_margin_rate).toBeCloseTo(0.913, 2);
  });
});

// tests/integration/operator/stripe-price-sync.integration.test.ts
describe('Stripe Price 同期', () => {
  it('inserts plan_price_history when price is updated via Stripe webhook', async () => {
    const event = {
      type: 'price.updated',
      data: { object: { id: 'price_123', unit_amount: 1200, metadata: { plan_key: 'pro' } } },
    };
    await POST('/api/webhooks/stripe', signStripeEvent(event));
    const { data } = await supabaseAdmin
      .from('plan_price_history')
      .select('*')
      .eq('plan_id', planId)  // DDL は plan_id UUID (operator/01 §3.x)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    expect(data?.new_monthly_price_jpy).toBe(1200);
  });
});

// tests/e2e/operator/operator-01-plan-lifecycle.spec.ts
test('plan lifecycle: draft → public → private → deprecated', async ({
  page,
}) => {
  const opPage = new OperatorPage(page);
  await opPage.createPlan({
    planKey: 'test_plan_001',
    displayName: 'テストプラン',
    monthlyPrice: 1980,
    trialDays: 7,
  });
  await opPage.publishPlan('test_plan_001');
  await expect(page.locator('[data-testid=plan-status]')).toContainText('公開中');
  await page.click('[data-testid=make-private-button]');
  await expect(page.locator('[data-testid=plan-status]')).toContainText('非公開');
  await page.click('[data-testid=deprecate-button]');
  await expect(page.locator('[data-testid=plan-status]')).toContainText('廃止予定');
});
```

### 32.4 Mobile ドメイン (5 件)

```typescript
// apps/mobile/__tests__/lib/deeplink.test.ts (既存テスト拡張)
describe('Deep Link ルーティング', () => {
  it('routes /family/invite/:token to InviteAcceptScreen', () => {
    const route = resolveDeepLink('homegohan://family/invite/abc123');
    expect(route.screen).toBe('InviteAcceptScreen');
    expect(route.params.token).toBe('abc123');
  });

  it('routes /meal-requests/:id to MealRequestDetailScreen', () => {
    const route = resolveDeepLink('homegohan://meal-requests/uuid-123');
    expect(route.screen).toBe('MealRequestDetailScreen');
    expect(route.params.id).toBe('uuid-123');
  });

  it('returns NotFoundScreen for unknown path', () => {
    const route = resolveDeepLink('homegohan://unknown/path');
    expect(route.screen).toBe('NotFoundScreen');
  });
});

// apps/mobile/__tests__/push/notification-handler.test.ts
describe('Push 通知ハンドラ', () => {
  it('navigates to MealRequestDetailScreen on meal_request notification', async () => {
    const notification = {
      data: { type: 'meal_request_proposed', request_id: 'req-123' },
    };
    const navigation = createMockNavigation();
    await handlePushNotification(notification, navigation);
    expect(navigation.navigate).toHaveBeenCalledWith('MealRequestDetail', {
      id: 'req-123',
    });
  });

  it('shows badge count in app icon when unread notifications exist', () => {
    const { setBadgeCount } = mockExpoBadge();
    updateBadgeFromNotifications([{ read: false }, { read: false }, { read: true }]);
    expect(setBadgeCount).toHaveBeenCalledWith(2);
  });
});
```

---

## 33. テスト計画の段階的ロールアウト

### Phase 1 (実装着手: スプリント 1-4)

- Smoke E2E (§7.1 の 20 spec、ハッピーパスのみ)
- Unit テスト 70% カバレッジ
- Integration テスト: RLS (allow/deny) + 主要 API status code
- 目標: CI グリーン、merge ブロックなし

### Phase 2 (β 公開前: スプリント 5-8)

- Full E2E (110 シナリオ全★1-2)
- Integration テスト 80% カバレッジ
- a11y violations = 0 (critical/serious)
- Stripe webhook 冪等テスト完備
- 目標: PR マージ時 E2E フル実行

### Phase 3 (本番リリース前)

- カバレッジ 90% (line) / 85% (branch)
- Visual Regression (main ブランチで baseline 確立)
- 負荷テスト (k6): p(95) < 500ms 達成確認
- Mutation score > 70%
- 目標: リリースゲートとして全テスト通過必須

### Phase 4 (運用安定後)

- カオスエンジニアリング: DB 接続断、LLM API タイムアウト、Stripe webhook 遅延
- Contract テスト (OpenAPI + dredd): API 変更で自動検出
- Security テスト: OWASP ZAP での定期スキャン
- DR テスト: 月 1 回 PITR 復元 → 整合性確認

---

## 34. テスト環境変数一覧

```bash
# .env.test.local
SUPABASE_URL=http://localhost:54321
SUPABASE_ANON_KEY=eyJ...  # supabase start で生成
SUPABASE_SERVICE_ROLE_KEY=eyJ...  # supabase start で生成
NEXT_PUBLIC_APP_URL=http://localhost:3000
PLAYWRIGHT_BASE_URL=http://localhost:3000

# Stripe テストモード
STRIPE_SECRET_KEY_TEST=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_test_...

# テスト用メール (Resend サンドボックス)
RESEND_API_KEY=re_test_...

# LLM モック (Unit/Integration では不要、E2E nightly のみ実 API)
XAI_API_KEY=xai_test_...  # nightly のみ

# k6 負荷テスト
K6_CLOUD_TOKEN=...
BASE_URL=https://staging.homegohan.app
TEST_GROUP_ID=...
TEST_MEMBER_ID=...
AUTH_TOKEN=...
```
