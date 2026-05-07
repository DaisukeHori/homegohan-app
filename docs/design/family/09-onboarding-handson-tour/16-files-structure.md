# 16 — ファイル構造とコード差分量

> 関連: [12-phases](./12-phases.md) / [13-integration](./13-integration.md)

---

## 1. 新規ファイル一覧

### 1.1 共通 package

| ファイル | 行数目安 |
|---|---|
| `packages/handson-tour-shared/package.json` | 30 |
| `packages/handson-tour-shared/tsconfig.json` | 25 |
| `packages/handson-tour-shared/src/index.ts` | 30 |
| `packages/handson-tour-shared/src/types.ts` | 80 |
| `packages/handson-tour-shared/src/steps.ts` | 200 |
| `packages/handson-tour-shared/src/mocks.ts` | 80 |
| `packages/handson-tour-shared/src/analytics.ts` | 120 |
| `packages/handson-tour-shared/src/personalize.ts` | 70 |
| `packages/handson-tour-shared/src/i18n.ts` | 200 |
| `packages/handson-tour-shared/src/url-routes.ts` | 30 |
| `packages/handson-tour-shared/src/constants.ts` | 60 |
| `packages/handson-tour-shared/__tests__/personalize.test.ts` | 80 |
| `packages/handson-tour-shared/__tests__/i18n.test.ts` | 60 |

合計: ~1065 行

### 1.2 Web 実装

| ファイル | 行数目安 |
|---|---|
| `src/app/handson-tour/layout.tsx` | 50 |
| `src/app/handson-tour/page.tsx` (Step 0) | 90 |
| `src/app/handson-tour/photo/page.tsx` | 100 |
| `src/app/handson-tour/menu/page.tsx` | 100 |
| `src/app/handson-tour/badges/page.tsx` | 80 |
| `src/app/handson-tour/graduate/page.tsx` | 110 |
| `src/components/handson-tour/TourOverlay.tsx` | 280 |
| `src/components/handson-tour/TourBubble.tsx` | 130 |
| `src/components/handson-tour/TourProgress.tsx` | 60 |
| `src/components/handson-tour/TourSandboxWrapper.tsx` | 80 |
| `src/components/handson-tour/useTourOverlayLogic.ts` | 120 |
| `src/components/handson-tour/useReducedMotion.ts` | 30 |
| `src/components/handson-tour/index.ts` | 20 |
| `src/components/handson-tour/TourOverlay.stories.tsx` | 80 |
| `src/components/handson-tour/TourBubble.stories.tsx` | 50 |
| `src/components/handson-tour/TourProgress.stories.tsx` | 40 |
| `src/contexts/TourContext.tsx` | 80 |
| `src/lib/handson-tour/getStatus.ts` | 30 |

合計: ~1530 行

### 1.3 Mobile 実装

| ファイル | 行数目安 |
|---|---|
| `apps/mobile/app/handson-tour/_layout.tsx` | 40 |
| `apps/mobile/app/handson-tour/index.tsx` (Step 0) | 100 |
| `apps/mobile/app/handson-tour/photo.tsx` | 110 |
| `apps/mobile/app/handson-tour/menu.tsx` | 110 |
| `apps/mobile/app/handson-tour/badges.tsx` | 90 |
| `apps/mobile/app/handson-tour/graduate.tsx` | 130 |
| `apps/mobile/src/handson-tour/TourOverlay.tsx` | 320 |
| `apps/mobile/src/handson-tour/TourBubble.tsx` | 140 |
| `apps/mobile/src/handson-tour/TourProgress.tsx` | 60 |
| `apps/mobile/src/handson-tour/TourSandboxWrapper.tsx` | 80 |
| `apps/mobile/src/handson-tour/Confetti.tsx` | 200 |
| `apps/mobile/src/handson-tour/useTourOverlayLogic.ts` | 130 |
| `apps/mobile/src/handson-tour/useReducedMotion.ts` | 30 |
| `apps/mobile/src/handson-tour/index.ts` | 20 |
| `apps/mobile/src/contexts/TourContext.tsx` | 80 |

合計: ~1740 行

### 1.4 API 実装

| ファイル | 行数目安 |
|---|---|
| `src/app/api/handson-tour/status/route.ts` | 100 |
| `src/app/api/handson-tour/complete/route.ts` | 130 |
| `src/app/api/handson-tour/skip/route.ts` | 70 |
| `src/lib/handson-tour/getStatus.ts` | 80 |
| `src/lib/handson-tour/awardBadge.ts` | 60 |

合計: ~440 行

### 1.5 DB

| ファイル | 行数目安 |
|---|---|
| `supabase/migrations/2026XXXXXXXXXX_handson_tour.sql` | 80 |
| `docs/seed_badges.sql` (修正) | +5 行 |

合計: ~85 行

### 1.6 アセット

| ファイル | サイズ |
|---|---|
| `public/handson-tour/sample-meal.jpg` (cp from karaage.jpg) | ~200KB |
| `public/handson-tour/sample-meal.webp` (optional) | ~80KB |
| `apps/mobile/assets/handson-tour/sample-meal.jpg` (cp) | ~200KB |
| `apps/mobile/assets/handson-tour/tutorial-complete-icon.svg` (将来) | (未確定) |

合計サイズ増: ~480KB (jpg のみ採用なら ~400KB)

### 1.7 テスト

| ファイル | 行数目安 |
|---|---|
| `apps/mobile/maestro/flows/tour/01-handson-completion.yaml` | 100 |
| `apps/mobile/maestro/flows/tour/02-skip-at-welcome.yaml` | 25 |
| `apps/mobile/maestro/flows/tour/03-hard-back.yaml` | 35 |
| `apps/mobile/maestro/flows/tour/04-step1-error-retry.yaml` | 50 |
| `apps/mobile/maestro/flows/tour/05-step2-menu-success.yaml` | 60 |
| `apps/mobile/maestro/flows/tour/06-step2-error-retry.yaml` | 45 |
| `apps/mobile/maestro/flows/tour/07-step3-badges.yaml` | 50 |
| `apps/mobile/maestro/flows/tour/08-step4-graduation.yaml` | 60 |
| `apps/mobile/maestro/flows/tour/09-step4-retry.yaml` | 40 |
| `apps/mobile/maestro/flows/tour/10-force-replay.yaml` | 50 |
| `apps/mobile/maestro/flows/tour/11-skip-for-admin.yaml` | 25 |
| `apps/mobile/maestro/flows/tour/12-skip-for-existing-user.yaml` | 25 |
| `apps/mobile/maestro/_shared/login-as-new-user.yaml` | 30 |
| `apps/mobile/maestro/_shared/login-as-admin.yaml` | 25 |
| `tests/e2e/tour/01-handson-completion.spec.ts` | 120 |
| `tests/e2e/tour/02-skip-at-welcome.spec.ts` | 40 |
| `tests/e2e/tour/03-graduation-retry.spec.ts` | 60 |
| `tests/e2e/tour/04-force-replay.spec.ts` | 60 |
| `tests/e2e/tour/05-skip-for-admin.spec.ts` | 35 |
| `tests/e2e/tour/06-skip-for-existing-user.spec.ts` | 35 |
| `tests/e2e/tour/07-a11y-axe.spec.ts` | 80 |
| `tests/e2e/tour/fixtures.ts` | 80 |
| `.github/workflows/handson-tour-tests.yml` | 80 |
| Web Unit テスト (component / hook) | ~400 行 |
| Mobile Unit テスト | ~400 行 |
| API Integration テスト | ~300 行 |

合計: ~2410 行

### 1.8 新規合計

| カテゴリ | 行数 |
|---|---|
| 共通 package | 1065 |
| Web 実装 | 1530 |
| Mobile 実装 | 1740 |
| API | 440 |
| DB | 85 |
| テスト | 2410 |
| **総新規** | **約 7270 行** |

---

## 2. 既存ファイルの変更

| ファイル | 変更内容 | +行 / -行 |
|---|---|---|
| `apps/mobile/app/meals/new.tsx` | sandbox prop 対応 (`MealNewScreenSandbox` 分岐実装) | +120 / -5 |
| `src/app/(main)/meals/new/page.tsx` | 同上 | +120 / -5 |
| `src/components/ai-assistant/V4GenerateModal.tsx` | sandbox prop + initialFlags + testID 追加 | +150 / -5 |
| Mobile 版 V4GenerateModal (要確認) | 同上 | +150 / -5 |
| `src/app/(main)/badges/page.tsx` | tutorial-mode + highlight + 動的 testID | +60 / -10 |
| Mobile 版 badges 画面 (要確認) | 同上 | +60 / -10 |
| `apps/mobile/app/onboarding/index.tsx` | next_route 分岐 | +30 / -5 |
| `src/app/onboarding/complete/page.tsx` | 同上 | +30 / -5 |
| `apps/mobile/app/(tabs)/home.tsx` | mount 時検証 | +25 / -0 |
| `src/app/(main)/home/page.tsx` | 同上 | +25 / -0 |
| `apps/mobile/app/(tabs)/settings.tsx` | 再開エントリ | +20 / -0 |
| `src/app/(main)/settings/page.tsx` | 同上 | +20 / -0 |
| `src/app/api/meal-plans/add-from-photo/route.ts` | sandbox 対応 + 偽装防止 | +50 / -2 |
| `src/app/api/menu-plans/add/route.ts` | 同上 | +50 / -2 |
| `src/app/api/onboarding/complete/route.ts` | next_route 追加 | +20 / -2 |
| `docs/seed_badges.sql` | tutorial_complete 1 行 | +5 / -0 |
| `package.json` (root) | workspace 依存 | +3 / -0 |
| `apps/mobile/package.json` | 同上 + react-native-masked-view | +5 / -0 |
| `tsconfig.json` (root) | path mapping 追加 | +5 / -0 |
| **設計書 canonical 追記** | | |
| `docs/design/operator/01-data-model.md` | 4 つの DDL 追加 | +50 / -0 |
| `docs/design/family/02-api-spec.md` | 7 API 仕様 | +120 / -0 |
| `docs/design/family/03-ui-spec.md` | ハンズオン画面群 | +60 / -0 |
| `docs/design/cross/03-design-system.md` | Coachmark コンポーネント仕様 | +80 / -0 |
| `docs/design/cross/05-i18n-a11y.md` | tour a11y 章 | +40 / -0 |
| `docs/design/operator/07-audit-monitoring.md` | analytics events 章 | +60 / -0 |
| `docs/design/mobile/01-architecture.md` | tour routing 章 | +40 / -0 |
| **既存テスト fix** | | |
| `src/__tests__/badges/*.test.tsx` | testID 動的化対応 | +20 / -10 |
| `tests/e2e/badges/*.spec.ts` | 同上 | +15 / -10 |
| `src/__tests__/onboarding/complete.test.ts` | next_route snapshot 更新 | +10 / -5 |

合計既存変更: +約 1460 行 / -約 86 行

---

## 3. 全体ボリューム

| カテゴリ | 行数 |
|---|---|
| 新規 | ~7270 |
| 既存追加 | ~1460 |
| 既存削除 | ~86 |
| アセット | 480KB (バイナリ) |

ハンズオン機能で **コードベースに ~8.7K 行追加**。

---

## 4. PR 分割 (再掲、§12-phases と一致)

| PR # | タイトル | 含まれるファイル | 行数想定 |
|---|---|---|---|
| P1-A | DB + Migration | DB セクション | +85 |
| P1-B | API + 共通 package | API + 共通 + 既存 API 拡張 | +1500 |
| P2-A | Web UI コア | Web 実装の §1.2 全部 | +1530 |
| P2-B | Mobile UI コア | Mobile 実装の §1.3 全部 | +1740 |
| P3-A | Web 既存画面 sandbox | meals/new + V4Modal + badges + onboarding 等 | +600 |
| P3-B | Mobile 既存画面 sandbox | 同上 (mobile) | +600 |
| P4 | a11y + Analytics | 既存ファイルへの a11y 属性追加 + analytics fire | +400 |
| P5 | E2E テスト | テストセクション | +2400 |
| **合計 8 PR** | | | **+8855 行** |

各 PR は ~500-2000 行規模。レビュー可能なサイズ。

---

## 5. ディレクトリ全体図

```
homegohan/
├── packages/
│   └── handson-tour-shared/        ← NEW (workspace package)
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── index.ts
│       │   ├── types.ts
│       │   ├── steps.ts
│       │   ├── mocks.ts
│       │   ├── analytics.ts
│       │   ├── personalize.ts
│       │   ├── i18n.ts
│       │   ├── url-routes.ts
│       │   └── constants.ts
│       └── __tests__/
│           ├── personalize.test.ts
│           └── i18n.test.ts
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── handson-tour/        ← NEW
│   │   │   │   ├── status/route.ts
│   │   │   │   ├── complete/route.ts
│   │   │   │   └── skip/route.ts
│   │   │   ├── meal-plans/add-from-photo/route.ts  ← MODIFIED
│   │   │   ├── menu-plans/add/route.ts             ← MODIFIED
│   │   │   └── onboarding/complete/route.ts        ← MODIFIED
│   │   ├── handson-tour/                ← NEW
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx                    (Step 0)
│   │   │   ├── photo/page.tsx              (Step 1)
│   │   │   ├── menu/page.tsx               (Step 2)
│   │   │   ├── badges/page.tsx             (Step 3)
│   │   │   └── graduate/page.tsx           (Step 4)
│   │   └── (main)/
│   │       ├── home/page.tsx               ← MODIFIED
│   │       ├── badges/page.tsx             ← MODIFIED
│   │       ├── meals/new/page.tsx          ← MODIFIED
│   │       └── settings/page.tsx           ← MODIFIED
│   ├── components/
│   │   ├── handson-tour/             ← NEW
│   │   │   ├── TourOverlay.tsx
│   │   │   ├── TourBubble.tsx
│   │   │   ├── TourProgress.tsx
│   │   │   ├── TourSandboxWrapper.tsx
│   │   │   ├── useTourOverlayLogic.ts
│   │   │   ├── useReducedMotion.ts
│   │   │   ├── *.stories.tsx
│   │   │   └── index.ts
│   │   └── ai-assistant/
│   │       └── V4GenerateModal.tsx       ← MODIFIED
│   ├── contexts/
│   │   └── TourContext.tsx              ← NEW
│   └── lib/
│       └── handson-tour/                ← NEW
│           ├── getStatus.ts
│           └── awardBadge.ts
├── apps/mobile/
│   ├── app/
│   │   ├── handson-tour/             ← NEW
│   │   │   ├── _layout.tsx
│   │   │   ├── index.tsx                  (Step 0)
│   │   │   ├── photo.tsx
│   │   │   ├── menu.tsx
│   │   │   ├── badges.tsx
│   │   │   └── graduate.tsx
│   │   ├── (tabs)/
│   │   │   ├── home.tsx                   ← MODIFIED
│   │   │   └── settings.tsx               ← MODIFIED
│   │   ├── meals/new.tsx                  ← MODIFIED
│   │   └── onboarding/index.tsx           ← MODIFIED
│   ├── src/
│   │   ├── handson-tour/                  ← NEW
│   │   │   ├── TourOverlay.tsx
│   │   │   ├── TourBubble.tsx
│   │   │   ├── TourProgress.tsx
│   │   │   ├── TourSandboxWrapper.tsx
│   │   │   ├── Confetti.tsx
│   │   │   ├── useTourOverlayLogic.ts
│   │   │   ├── useReducedMotion.ts
│   │   │   └── index.ts
│   │   └── contexts/
│   │       └── TourContext.tsx            ← NEW
│   ├── assets/
│   │   └── handson-tour/                  ← NEW
│   │       └── sample-meal.jpg            (cp from tests/e2e/fixtures/karaage.jpg)
│   └── maestro/
│       └── flows/tour/                    ← NEW
│           └── 01-12.yaml
├── public/
│   └── handson-tour/                      ← NEW
│       ├── sample-meal.jpg
│       └── sample-meal.webp (optional)
├── supabase/
│   └── migrations/
│       └── 2026XXXXXXXXXX_handson_tour.sql ← NEW
├── tests/
│   └── e2e/
│       └── tour/                          ← NEW
│           ├── 01-07.spec.ts
│           └── fixtures.ts
├── docs/
│   ├── design/
│   │   ├── operator/01-data-model.md      ← MODIFIED (canonical DDL)
│   │   ├── family/
│   │   │   ├── 02-api-spec.md             ← MODIFIED
│   │   │   ├── 03-ui-spec.md              ← MODIFIED
│   │   │   └── 09-onboarding-handson-tour/  ← NEW (本ディレクトリ、25 ファイル)
│   │   ├── cross/
│   │   │   ├── 03-design-system.md        ← MODIFIED
│   │   │   └── 05-i18n-a11y.md            ← MODIFIED
│   │   ├── operator/07-audit-monitoring.md ← MODIFIED
│   │   └── mobile/01-architecture.md      ← MODIFIED
│   └── seed_badges.sql                    ← MODIFIED
└── .github/
    └── workflows/
        └── handson-tour-tests.yml         ← NEW
```

---

## 6. ビルドサイズ影響

### 6.1 Web bundle

- 共通 package: ~5KB gzipped (型 + i18n + mocks)
- `<TourOverlay>` + `<TourBubble>` + `<TourProgress>`: ~10KB gzipped
- `<TourSandboxWrapper>`: ~3KB
- react-confetti: ~10KB gzipped
- 画像 (sample-meal.webp): ~80KB
- 合計: **~108KB 増 (gzipped、画像込み)**

### 6.2 Mobile bundle

- 共通 package: ~5KB
- Tour 系コンポーネント: ~12KB
- @react-native-masked-view: ~50KB (新規依存)
- 自前 Confetti: ~3KB
- 画像 (sample-meal.jpg): ~200KB
- 合計: **~270KB 増 (画像込み)**

### 6.3 圧縮対策

- 画像: webp 化で web 60% 削減
- 共通 package: tree-shaking で未使用 i18n key を除外

---

## 5. コード規約

### 5.1 ディレクトリ命名

統一 prefix: `handson-tour` (kebab-case、英語のみ)。文書とコードで同一。

| 場所 | パス |
|---|---|
| Web component | `src/components/handson-tour/` |
| Mobile component | `apps/mobile/src/handson-tour/` |
| Web ルート | `src/app/handson-tour/` |
| Mobile ルート | `apps/mobile/app/handson-tour/` |
| Web API | `src/app/api/handson-tour/` |
| 共通 package | `packages/handson-tour-shared/` |
| 設計書 | `docs/design/family/09-onboarding-handson-tour/` |

### 5.2 コンポーネント命名

ファイル名とコンポーネント名は一致させる:

| ファイル名 | エクスポート名 |
|---|---|
| `TourOverlay.tsx` | `TourOverlay` (確定、HandsonTour プレフィックスは不採用) |
| `TourBubble.tsx` | `TourBubble` |
| `TourProgress.tsx` | `TourProgress` |
| `TourSandboxWrapper.tsx` | `TourSandboxWrapper` |

v1 では **短縮形 (`Tour*`) を採用** することで Storybook / import 文の冗長性を避ける。

### 5.3 testID 命名規則

すべて kebab-case + `tour-*` プレフィックス。

#### 共通 testID

| testID | 役割 |
|---|---|
| `tour-overlay` | overlay 全体 |
| `tour-bubble` | 吹き出しコンテナ |
| `tour-bubble-title` | 吹き出しタイトル |
| `tour-bubble-body` | 吹き出し本文 |
| `tour-progress-dots` | 進捗ドット (5 個) |
| `tour-next-button` | 共通【次へ】ボタン (overlay 内) |
| `tour-skip-button` | 共通【あとで】ボタン (Step 0 / 4) |

#### Step 別 testID

| testID 接頭辞 | Step |
|---|---|
| `tour-step-0-*` | Step 0 ウェルカム (start, skip, title, subtitle) |
| `tour-step-1-*` | Step 1 写真 (intro, intro-tap, saving, error, error-retry, error-skip) |
| `tour-step-2-*` | Step 2 AI 献立 (同上) |
| `tour-step-3-*` | Step 3 バッジ (同上 + loading) |
| `tour-step-4-*` | Step 4 卒業 (saving, graduate, icon, title, subtitle, badge-card, badge-icon, badge-label, go-home, error, retry, error-skip) |
| `tour-step-5-*` | Step 5 通常 home (toast) |

#### 既存 testID 流用 (Spotlight ターゲット)

| testID | 役割 |
|---|---|
| `meal-mode-select-meal`, `meal-camera-button`, `meal-analyzing-view`, `meal-result-screen`, `meal-result-dish-name`, `meal-result-calories`, `meal-save-button`, `meal-cancel-button` | Step 1 sandbox |
| `v4-no-cook-toggle`, `v4-simple-only-toggle`, `v4-variety-emphasis-toggle`, `v4-note-textarea`, `v4-generate-button`, `v4-loading-spinner`, `v4-result-card`, `v4-result-dish-name`, `v4-result-calories`, `v4-add-to-menu-button` | Step 2 sandbox |
| `badge-card-{code}` (動的) | Step 3 sandbox。`{code}` = `first_bite` / `planner` / `tutorial_complete` 等。既存 web の固定 testID `badge-card` を動的化 (§13 §3.1 案 A 採用) |

### 5.4 i18n キー命名

`tour.{section}.{element}` (snake_case)。詳細は §14-mocks-i18n §2.2。

### 5.5 命名違反検出

CI で:
- testID が `tour-*` / `meal-*` / `v4-*` / `badge-*` のいずれかで始まることを確認
- ファイル名と export 名の一致 (eslint-rule)

---

## 7. 残不確実性 (§99 連携)

- [ ] Mobile 版 V4GenerateModal の存在 (web 専用なら mobile 新規実装で行数増)
- [ ] Mobile 版 BadgesPage の構造 (要 researcher 調査)
- [ ] @react-native-masked-view の Expo SDK 53 互換性 (要バージョン確認)
- [ ] mobile アセット (sample-meal.jpg) の Expo bundling 戦略 (require vs URL fetch)
- [ ] 行数見積もりの精度 (実装時に ±30% 揺れる可能性)
