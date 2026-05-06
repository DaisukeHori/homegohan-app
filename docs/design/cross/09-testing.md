# cross/ テスト戦略 (統合)

全ドメイン横断のテスト戦略。各ドメイン設計書末尾の「テスト方針」セクションを統合・補完する。

> **重要原則**: 本ドキュメントは **概念設計** (戦略 / 規約 / カバレッジ目標 / シナリオ網羅)。
> 列名・型・フィールドの **正は各ドメイン設計書の DDL** (`operator/01-data-model.md` / `family/01-data-model.md` / `org/01-data-model.md`) と Zod スキーマ (`family/04-meal-request-flow.md §8` 等)。
> テスト実装時は `supabase gen types typescript` の自動生成型を直接使用し、本ドキュメントに具体的な列名サンプルは記載しない (リネーム時の追従漏れによる矛盾を防ぐため)。

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
        /  \   E2E (~30 spec、Phase 1)
       /────\  Critical user journeys
      /      \
     /────────\ Integration (~150 spec)
    /          \ DB + RLS + Edge Function
   /────────────\
  /              \ Unit (~500 spec)
 /                \ Pure logic, helpers, components
/──────────────────\
```

| 種別 | 比率 | 目安 spec 数 | per spec 目標時間 |
|-----|------|--------|----------|
| Unit | 70% | 500 | < 100ms |
| Integration | 25% | 150 | < 1s |
| E2E (smoke) | 5% (smoke) | 5 | < 30s |
| E2E (full) | 5% (full) | 30 | < 60s |

## 4. テストカバレッジ目標

| カテゴリ | カバレッジ目標 | 計測 | CI ブロック条件 |
|---------|------------|------|----------|
| Unit (`src/lib/`) | line 90% / branch 85% | Vitest coverage | < 85% で merge ブロック |
| React コンポーネント | line 80% | Vitest + RTL | - |
| API routes | 100% (status code + happy path) | Vitest + Supabase Local | 100% 必須 |
| RLS ポリシー | 100% (各 policy で allow/deny) | Vitest + Supabase Local | 100% 必須 |
| E2E 主要フロー | 110 シナリオの ★1-2 全部 | Playwright | smoke 失敗で main ブロック |
| a11y violations | 0 (全画面) | @axe-core/playwright | violations > 0 で fail |
| Lighthouse Performance | ≥ 90 | Lighthouse CI | < 80 で main マージブロック |

## 5. ツールスタック

| 用途 | ツール | 設定ファイル |
|-----|------|----------|
| Unit | Vitest + jsdom | `vitest.config.ts` |
| React コンポーネント | Vitest + React Testing Library | `vitest-setup.ts` |
| Integration (DB) | Vitest + Supabase Local | `tests/integration/setup.ts` |
| Integration (Edge Function) | Vitest + Deno test | `supabase/functions/_tests/` |
| E2E | Playwright | `playwright.config.ts` |
| a11y | @axe-core/playwright | E2E spec 内 |
| Visual Regression | Playwright + Percy.io (or Chromatic) | `tests/visual/` |
| 負荷 | k6 Cloud | `tests/load/k6/` |
| API スキーマ | OpenAPI + dredd / vacuum | `tests/contract/` |
| Mobile | Maestro (or Detox) | `apps/mobile/.maestro/` |
| Mutation | Stryker (Phase 4) | `stryker.config.json` |

## 6. テスト命名規則

**ファイル名**:
- `*.test.ts` — Unit
- `*.integration.test.ts` — Integration
- `*.spec.ts` — E2E (Playwright)
- `*.test.tsx` — React コンポーネント

**describe / it**:
- describe: 「対象 (関数名 / コンポーネント名 / API パス)」
- it: 「条件 + 期待結果」を英語または日本語で
- 例: `it('returns 403 when caller is not org_admin')`
- 例: `it('frozen 状態の家族グループでは新規 meal_request を拒否する')`

## 7. テストデータ Factory パターン (戦略のみ)

各ドメインのテーブルごとに `tests/factories/<table>.factory.ts` を用意:

- 入力: `Partial<生成型>` (overrides)
- 出力: 生成型のレコード (UUID / 必須列 / デフォルト値含む)
- 命名: `<テーブル名キャメルケース>Factory`
- DB INSERT 用ヘルパー: `create<テーブル名>InDB(supabase, overrides?)`

**列名は実装時に `types/supabase.ts` (自動生成) から型推論**。本ドキュメントには具体的な列名・サンプル値を書かない (DDL リネーム時の矛盾源)。

ファイル雛形:
```typescript
// tests/factories/<table>.factory.ts
import type { Database } from '@/types/supabase';
import { faker } from '@faker-js/faker';

type Row = Database['public']['Tables']['<table>']['Insert'];

export const <table>Factory = (overrides?: Partial<Row>): Row => ({
  // 必須列をデフォルト値で埋める (DDL から型推論)
  ...overrides,
});

export async function create<Table>InDB(
  supabase: SupabaseClient<Database>,
  overrides?: Partial<Row>,
) {
  const { data, error } = await supabase
    .from('<table>')
    .insert(<table>Factory(overrides))
    .select()
    .single();
  if (error) throw error;
  return data;
}
```

## 8. テストデータベース Seed 戦略

`scripts/seed-test-data.ts` で staging/local の seed:

- **9 種公式 plan_key** を `subscription_plans` に INSERT (operator/01-data-model.md §3.2 seed と同一)
- テスト組織 3 件 (Org Standard / Org Pro / Org Enterprise)
- テストユーザー 7 種 (各ロール × 1 名)
- テスト家族グループ 2 件
- テスト食事記録 30 日分

各 E2E spec の `beforeAll` で独立した seed (テナント分離)。

## 9. RLS 網羅テスト戦略

各 RLS ポリシーごとに **allow / deny の両方** を確認:

```typescript
// tests/integration/rls/<table>.rls.test.ts の構造のみ示す
describe('<table> RLS', () => {
  it('allows: <許可されるべきユーザー>', async () => { /* ... */ });
  it('denies: <拒否されるべきユーザー>', async () => { /* ... */ });
});
```

各ドメインの RLS ポリシー一覧:
- `family/08-rls-policies.md` (家族系)
- `org/09-rls-policies.md` (組織系)
- `cross/02-rls-patterns.md` (テンプレート + 共通)

各ポリシーに対し最低 2 ケース (allow/deny) を E2E に組み込む。

## 10. Edge Function テスト戦略

```
supabase/functions/<function-name>/test.ts (Deno test)
```

- 入力: HTTP Request mock
- 外部依存 (LLM API): モック (§11)
- 出力: ステータスコード + JSON body 検証
- Zod スキーマ検証は実装と同じ schema をインポート (二重定義禁止)

## 11. モック戦略

### 11.1 Stripe
- Unit/Integration: `tests/mocks/stripe.ts` で `vi.fn()` モック
- E2E: Stripe Test Mode で実 API 呼び出し
- Webhook 署名検証は実 webhooks.constructEvent を使用

### 11.2 LLM (xAI / Gemini / Claude)
- Unit/Integration: 全モック必須 (LLM は決定的でないため)
- E2E (smoke): モック
- E2E (nightly full): 実 API 呼び出し (週次、コスト管理下)
- モックレスポンスは `tests/fixtures/llm/` に固定 JSON で用意

### 11.3 Push 通知 (Expo Push)
- 全テスト: モック
- `expo-server-sdk` の `sendPushNotificationsAsync` を `vi.fn()` で代替

### 11.4 Resend (Email)
- Unit/Integration: モック
- E2E: Mailtrap サンドボックスへ実送信、受信確認

### 11.5 認証 (Supabase Auth)
- Integration: Supabase Local の `auth.admin.createUser()` で実ユーザー生成
- Unit: モック化された Supabase Client

## 12. 並行性テスト

以下のシナリオを **必ず Integration でカバー**:

- ライセンスプール容量超過時の同時 INSERT (FOR UPDATE 行ロック検証)
- family_groups owner 譲渡と migrate-to-personal の同時実行 (advisory lock 検証)
- Stripe webhook 重複送信 (idempotency 検証)
- クーポン同時適用 (partial unique index 検証)

各シナリオで `Promise.allSettled` で並行リクエスト → 期待状態を assert。

## 13. AI 出力スキーマ検証

- 全 AI Edge Function は出力を **Zod schema で parse** する設計
- テストでは:
  1. 正常出力 → `parse()` が throw しないこと
  2. 必須フィールド欠落 → `ZodError` を throw すること
  3. アレルゲン突合 → 3 回リトライ後に成功 (mock spy)

Zod schema は **唯一の場所** から import:
- `ProposedRecipeSchema`: `family/04-meal-request-flow.md §8` が canonical → 実装は `src/shared/schemas/proposed-recipe.ts`

## 14. E2E Page Object パターン

`tests/e2e/pages/<Domain><Page>.ts` でカプセル化:
- selector は data-testid 必須 (CSS 変更耐性)
- 操作メソッド (create / edit / delete) を提供
- アサーションは spec 側で実行 (Page は状態遷移のみ)

## 15. フレーク対策

| 対策 | 設定 |
|-----|------|
| Retry | Playwright `retries: 2` (CI のみ)、Vitest `retry: 1` |
| Timeout | Vitest 5s、E2E 30s、global beforeAll 60s |
| 待機 | `waitForLoadState('networkidle')` 推奨、`waitForSelector` 必須 |
| 失敗時アーティファクト | スクリーンショット + 動画 + Trace を自動保存 |
| Flake rate モニタ | CI で 1% 以下を維持、超過で alert |

## 16. テスト並列実行

| ツール | 並列度 | DB 隔離 |
|-------|-------|--------|
| Playwright | workers 4 (CI で 6) | E2E ごとに schema 分離 or transaction rollback |
| Vitest | threads (デフォルト) | Integration は per-test schema |
| k6 | VU は scenario 依存 | staging 環境で実行 |

## 17. CI/CD パイプライン

```yaml
# .github/workflows/ci.yml の要点
jobs:
  lint:        # eslint + prettier check + typecheck
  test-unit:   # Vitest + coverage
  test-integration:  # Vitest + Supabase Local
  test-e2e-smoke:    # Playwright @smoke
  test-a11y:         # @axe-core/playwright
  test-e2e-full:     # main のみ、Playwright full
  lighthouse:        # main のみ
  visual-regression: # main のみ
```

PR 時 vs main マージ時の実行ステージ分岐:

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

### 17.1 Nightly Run (毎日 03:00 JST)
- E2E full (実 LLM API 含む)
- 負荷テスト (k6)
- DR 復元テスト (月 1 回、staging に PITR)

## 18. E2E シナリオ網羅 (Phase 1 = 30 spec)

`docs/requirements/100-scenarios.md` の主要シナリオから派生。詳細スペックは各ドメイン設計書の `tests/e2e/...` ファイル名指定で:

| ペルソナ | spec 数 | 担当ドメイン |
|---------|--------|----------|
| 個人 (A1-A20) | 4 | family + operator (個人課金) |
| 家族 owner (B1-B20) | 9 | family |
| 家族 admin/member (C1-C10) | - | family (Phase 2) |
| 組織 admin (D1-D15) | 8 | org |
| 組織 member / 産業医 (E1-E10) | 2 | org |
| 運営 (F1-F20) | 7 | operator |

### Phase 2 拡充 (~50 spec 追加)
エッジケース、特殊家族構成、複雑なフロー (グループ分割、子供 18 歳到達、退職フロー full)。

## 19. Visual Regression

- Playwright の `toMatchSnapshot()` または Percy.io / Chromatic
- 主要画面の差分検出
- ダークモード切替時の差分 (Phase 2)
- レスポンシブブレークポイント別 (mobile / tablet / desktop)
- baseline は main ブランチで自動更新、PR では差分レビュー必須

## 20. 負荷テスト (k6)

シナリオ定義: `tests/load/k6/<scenario>.js`

主要シナリオ:
- constant_load: 50 VU × 5 分 (通常負荷)
- spike: 0 → 500 VU 急増 (スパイク負荷)
- ramping: 段階的増加 (キャパ計画)

Thresholds:
- `http_req_duration p(95) < 500ms`
- `http_req_failed rate < 0.01`

実行頻度:
- 主要リリース前
- 半年に 1 回

## 21. アクセシビリティテスト

`@axe-core/playwright` を使用、各 E2E spec に追加:

- critical / serious / moderate / minor の 4 段階
- `critical` / `serious` は CI で fail
- `moderate` / `minor` は warning として記録、後で修正

例外設定 (許容する違反) は `playwright.a11y-config.ts` に明示。

## 22. デバッグ支援

- Playwright Trace Viewer (失敗時自動保存)
- Network HAR 保存
- console.log 出力の収集
- スクリーンショット (失敗時のみ)
- 動画 (失敗時のみ)

## 23. テスト品質メトリクス (Phase 4)

- Mutation testing (Stryker)
- Test execution time tracking
- Flake rate monitoring (1% 以下を維持)
- Coverage trend (週次レポート)

## 24. 既存テスト破壊リスト

clean-build 後 (commit 32d13e1) に既存テストが壊れているリスト (要件 01 §15.6):
- `tests/e2e/r10-org-pantry-deep.spec.ts` (旧 /api/org/users 参照)
- `tests/e2e/w5-13-new-features-adversarial.spec.ts` (旧 /api/org/settings)
- `tests/e2e/w5-12-admin-adversarial.spec.ts` (旧 /api/admin/* 参照)
- `tests/e2e/wave5-w56-settings-account-profile-adversarial.spec.ts` (旧 plan-limits 経由)

これらは **設計書実装後に書き直し** (新 API 仕様に対応)。

### 保持
- `tests/e2e/smoke.spec.ts` (LP + ログイン、新 API に依存しない)
- `apps/mobile/__tests__/lib/deeplink.test.ts` (新規 deeplink ロジックで再利用可能)

### 新規追加 (Phase 1 = 30 spec)
詳細は §18 の表参照。

## 25. 段階的ロールアウト

| Phase | 期間目安 | 達成条件 |
|------|--------|--------|
| **Phase 1** (実装着手) | β 公開まで | smoke E2E + Unit 70% カバレッジ |
| **Phase 2** (β 公開) | 公開後 1-2 ヶ月 | full E2E + Integration 80% + a11y violations 0 |
| **Phase 3** (本番安定) | 公開後 3-6 ヶ月 | カバレッジ 90% + Visual Regression + 負荷テスト定常運用 |
| **Phase 4** (運用最適化) | 6 ヶ月以降 | Mutation testing 導入、カオスエンジニアリング |

## 26. 環境変数

テスト用 環境変数 (CI / local 共通):

| 変数名 | 用途 | デフォルト |
|-------|------|--------|
| `SUPABASE_URL` | Supabase Local URL | `http://localhost:54321` |
| `SUPABASE_ANON_KEY` | Supabase 匿名 key | local key |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key (テストデータ seed 用) | local key |
| `STRIPE_SECRET_KEY` | Test Mode key | `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | Test Mode webhook secret | `whsec_test_...` |
| `XAI_API_KEY` | nightly full E2E のみ | (本番 key、CI Secret) |
| `MAILTRAP_API_KEY` | E2E Email | (CI Secret) |
| `EXPO_PUSH_ACCESS_TOKEN` | Push テスト | (CI Secret) |

ローカル開発時は `.env.test.local` に配置 (gitignore)、CI は GitHub Secrets。

## 27. 各ドメイン設計書のテスト方針セクション参照

各ドメイン設計書末尾に **具体的なテストケース** が記載されている:

| ドメイン | 参照箇所 |
|---------|--------|
| family | `family/01-data-model.md §7` / `family/02-api-spec.md §17` / `family/04-meal-request-flow.md §11` 他 |
| org | `org/01-data-model.md §7` / `org/02-api-spec.md §17` / `org/04-license-management.md §11` 他 |
| operator | `operator/01-data-model.md §X` / `operator/02-api-spec.md §24` / `operator/05-stripe-integration.md §X` 他 |
| mobile | `mobile/03-push-notification.md §X` / `mobile/04-storage-camera.md §X` 他 |

各ドメインのテスト方針セクションは **概念とテストケース名** のみ。具体的なコード例 (factory / Zod schema 等) は **本ドキュメント (cross/09)** または **実装時の自動生成型** から派生させる。

## 28. 未解決事項

- Visual Regression のベンダー選定 (Percy vs Chromatic)
- Mobile E2E の自動化 (Maestro vs Detox)
- 実 LLM を使った E2E nightly のコスト試算
- staging 環境でのデータマスキング戦略 (cross/22 と整合)
- カオスエンジニアリングツール選定 (Phase 4)
