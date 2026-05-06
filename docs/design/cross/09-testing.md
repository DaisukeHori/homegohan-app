# cross/ テスト戦略 (統合)

全ドメイン横断のテスト戦略。各ドメイン設計書末尾の「テスト方針」セクションを統合・補完する。

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
