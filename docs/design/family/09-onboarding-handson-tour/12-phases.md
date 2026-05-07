# 12 — 実装フェーズ計画 (並列開発戦略)

> 関連: [16-files-structure](./16-files-structure.md) / [13-integration](./13-integration.md) / cross/03-design-system.md

---

## 1. 並列開発戦略

memory: feedback-modular-monolith-parallel に従い、30+ ファイル規模の実装は Opus がモジュール境界で分割し、並列 implementer を起動する。

### 1.1 PR 分割の単位

| 単位 | 担当 |
|---|---|
| DDL + 共通 package | 1 PR (= Phase 1) |
| API ハンドラ | 1 PR (= Phase 1 後半) |
| Web UI コア | 1 PR (= Phase 2A) |
| Mobile UI コア | 1 PR (= Phase 2B) |
| Web 既存画面 sandbox 対応 | 1 PR (= Phase 3A) |
| Mobile 既存画面 sandbox 対応 | 1 PR (= Phase 3B) |
| a11y 仕上げ | 1 PR (= Phase 4) |
| E2E テスト | 1 PR (= Phase 5) |

合計 8 PR、Phase 内は並列、Phase 間は依存あり (逐次)。

### 1.2 並列度

| Phase | 並列度 | 想定期間 (1 implementer) | 並列実行時 |
|---|---|---|---|
| 1: DB + 共通 | 1 | 1-2 日 | 1-2 日 |
| 2: UI コア | 2 (Web + Mobile) | 6-8 日 | 3-4 日 |
| 3: 既存画面 sandbox | 2 (Web + Mobile) | 4-6 日 | 2-3 日 |
| 4: a11y / Analytics | 1 | 1-2 日 | 1-2 日 |
| 5: E2E | 1 | 2 日 | 2 日 |

合計 並列実行で **9-13 日** (実装者 5 名いれば最大並列で 5-7 日)。

---

## 2. Phase 1: DB + 共通 package + API (1-2 日)

### 2.1 タスク一覧

| 担当 | タスク | ファイル | 完了基準 |
|---|---|---|---|
| Opus | operator/01-data-model.md 更新 | `docs/design/operator/01-data-model.md` | 4 つの DDL が canonical 化 |
| Opus | family/02-api-spec.md 更新 | `docs/design/family/02-api-spec.md` | 新規 4 API + 拡張 3 API 追記 |
| implementer-A | Migration SQL | `supabase/migrations/2026XXXXXXXXXX_handson_tour.sql` | 適用後 DB に列追加 |
| implementer-A | seed_badges.sql 更新 | `docs/seed_badges.sql` | tutorial_complete 1 行追加 |
| implementer-A | Supabase RPC 関数 (`user_has_non_sandbox_activity`, `complete_handson_tour`) | 同上 migration | RPC 呼び出し OK |
| implementer-B | `packages/handson-tour-shared/` workspace package 構築 | (§7-components.md §5.2) | npm install 後 import 可 |
| implementer-A | `/api/handson-tour/status` 実装 | `src/app/api/handson-tour/status/route.ts` | curl で 200 OK |
| implementer-A | `/api/handson-tour/complete` 実装 | `src/app/api/handson-tour/complete/route.ts` | 同上 |
| implementer-A | `/api/handson-tour/skip` 実装 | `src/app/api/handson-tour/skip/route.ts` | 同上 |
| implementer-A | 既存 API 拡張 (sandbox + source) | `src/app/api/meal-plans/add-from-photo/route.ts` + `src/app/api/menu-plans/add/route.ts` | 既存テスト pass + 新規テスト pass |
| implementer-A | onboarding/complete レスポンス拡張 | `src/app/api/onboarding/complete/route.ts` | next_route 含まれる |
| implementer-A | Unit テスト (API + personalize) | `__tests__/handson-tour/` | 全テスト pass |

### 2.2 完了基準
- migration 適用後、`user_profiles` に 2 列、`meal_logs` / `weekly_menus` に `is_sandbox` 列追加
- `tutorial_complete` バッジ seed 完了
- 4 つの API ハンドラがレスポンスを返す (Postman / curl 確認)
- 共通 package が `import { MOCK_PHOTO_RESPONSE } from '@homegohan/handson-tour-shared';` で使える
- Unit テスト coverage > 80%

### 2.3 Phase 1 完了後の検証

```bash
# DB 検証
psql -c "SELECT column_name FROM information_schema.columns WHERE table_name='user_profiles' AND column_name LIKE 'handson_tour%';"
# → 2 行 (completed_at, skipped_at)

# Badge 検証
psql -c "SELECT code FROM badges WHERE code='tutorial_complete';"
# → 1 行

# API 検証
curl -X GET https://homegohan.app/api/handson-tour/status -H "Authorization: Bearer $JWT"
# → JSON レスポンス
```

---

## 3. Phase 2: UI コア (Web + Mobile)

### 3.1 並列度
Web と Mobile は同時並行 (依存関係なし)。implementer-Web と implementer-Mobile が別 PR で進める。

### 3.2 Phase 2A: Web UI コア (3-4 日)

| タスク | ファイル | 担当 |
|---|---|---|
| `<TourOverlay>` 実装 | `src/components/handson-tour/TourOverlay.tsx` | implementer-Web |
| `<TourBubble>` 実装 | `src/components/handson-tour/TourBubble.tsx` | implementer-Web |
| `<TourProgress>` 実装 | `src/components/handson-tour/TourProgress.tsx` | implementer-Web |
| `<TourSandboxWrapper>` 実装 | `src/components/handson-tour/TourSandboxWrapper.tsx` | implementer-Web |
| `useTourOverlayLogic` hook | `src/components/handson-tour/useTourOverlayLogic.ts` | implementer-Web |
| ルーティング (Step 0-4) | `src/app/handson-tour/{layout,page,photo/page,menu/page,badges/page,graduate/page}.tsx` | implementer-Web |
| onboarding/complete からの遷移 | `src/app/onboarding/complete/page.tsx` | implementer-Web |
| /home マウント時検証 | `src/app/(main)/home/page.tsx` | implementer-Web |
| /settings 再開エントリ | `src/app/(main)/settings/page.tsx` | implementer-Web |
| Storybook (4 components) | `*.stories.tsx` | implementer-Web |
| Unit テスト (component) | `__tests__/handson-tour-web/` | implementer-Web |

### 3.3 Phase 2B: Mobile UI コア (4-5 日)

Web と並列で実行。

| タスク | ファイル | 担当 |
|---|---|---|
| `<TourOverlay>` 実装 | `apps/mobile/src/handson-tour/TourOverlay.tsx` | implementer-Mobile |
| `<TourBubble>` 実装 | `apps/mobile/src/handson-tour/TourBubble.tsx` | implementer-Mobile |
| `<TourProgress>` 実装 | `apps/mobile/src/handson-tour/TourProgress.tsx` | implementer-Mobile |
| `<TourSandboxWrapper>` 実装 | `apps/mobile/src/handson-tour/TourSandboxWrapper.tsx` | implementer-Mobile |
| `useTourOverlayLogic` hook (mobile 版) | `apps/mobile/src/handson-tour/useTourOverlayLogic.ts` | implementer-Mobile |
| ルーティング (Expo Router) | `apps/mobile/app/handson-tour/{_layout,index,photo,menu,badges,graduate}.tsx` | implementer-Mobile |
| onboarding/complete からの遷移 | `apps/mobile/app/onboarding/complete.tsx` | implementer-Mobile |
| home マウント時検証 | `apps/mobile/app/(tabs)/home.tsx` | implementer-Mobile |
| settings 再開エントリ | `apps/mobile/app/(tabs)/settings.tsx` | implementer-Mobile |
| Reanimated アニメーション | (TourOverlay 内) | implementer-Mobile |
| 紙吹雪自前実装 (Step 4) | `apps/mobile/src/handson-tour/Confetti.tsx` | implementer-Mobile |
| 画像配置 (sample-meal.jpg) | `apps/mobile/assets/handson-tour/sample-meal.jpg` (cp 配置) | implementer-Mobile |
| Unit テスト (component) | `__tests__/handson-tour-mobile/` | implementer-Mobile |

### 3.4 完了基準 (Phase 2)
- 4 components 実装完了 (web/mobile 各)
- ルーティングで Step 0-4 ページが表示される
- mock データで通しで進めるが API 連動はまだ (Phase 3 で完成)
- Storybook (web) で 4 components のスナップショット確認

---

## 4. Phase 3: 既存画面 sandbox 対応 (Web + Mobile、2-3 日)

### 4.1 並列度
Web と Mobile は同時並行。

### 4.2 Phase 3A: Web sandbox 対応 (2 日)

| タスク | ファイル |
|---|---|
| `<MealNewScreen>` mode='sandbox' 対応 | `src/app/(main)/meals/new/page.tsx` |
| `<V4GenerateModal>` mode='sandbox' 対応 | `src/components/ai-assistant/V4GenerateModal.tsx` |
| `<BadgesPage>` tutorial-mode 対応 | `src/app/(main)/badges/page.tsx` |
| `badge-card-{code}` 動的 testID | 同上 (data-testid 付与) |
| testID 追加 (V4GenerateModal の v4-no-cook-toggle 等) | 同上 |
| Unit テスト | 各 `__tests__/` |

### 4.3 Phase 3B: Mobile sandbox 対応 (2 日)

| タスク | ファイル |
|---|---|
| `<MealNewScreen>` mode='sandbox' 対応 | `apps/mobile/app/meals/new.tsx` |
| `<V4GenerateModal>` Mobile 版 mode='sandbox' 対応 | (該当 Mobile コンポーネント、要調査) |
| Mobile badges 画面の sandbox 対応 | (該当 Mobile 画面) |
| testID 全件 (v4 系 + badge-card-{code}) | 各画面 |
| Unit テスト | `apps/mobile/__tests__/` |

### 4.4 完了基準 (Phase 3)
- Phase 2 の Tour ルーティングから既存画面が sandbox モードでマウントされる
- Step 1-3 で実 API が呼ばれてバッジ実獲得
- Web/Mobile 両方で同等の動作

---

## 5. Phase 4: a11y / Analytics (1-2 日)

### 5.1 タスク

| タスク | ファイル | 担当 |
|---|---|---|
| ARIA 属性追加 (web) | `src/components/handson-tour/*.tsx` | implementer-Web |
| AccessibilityInfo 追加 (mobile) | `apps/mobile/src/handson-tour/*.tsx` | implementer-Mobile |
| VoiceOver / TalkBack アナウンス追加 | 同上 | implementer-Mobile |
| reduce-motion 対応 | 各 component | implementer-Web/Mobile |
| Dynamic Type / Font Scale 対応 | mobile 各 component | implementer-Mobile |
| Analytics events 配信 (PostHog or Mixpanel) | `packages/handson-tour-shared/src/analytics.ts` + 連携 | implementer (operator/07 連携) |
| 各 step での Analytics fire 連動 | 各 page / component | implementer |
| axe-core テスト | `tests/e2e/tour/07-a11y-axe.spec.ts` | tester |

### 5.2 完了基準
- axe-core 違反 0 (web)
- VoiceOver / TalkBack アナウンス確認 (手動)
- Analytics events が PostHog dashboard に表示される
- Dynamic Type AX5 (2.85x) でレイアウト崩れなし

---

## 6. Phase 5: E2E テスト (2 日)

### 6.1 タスク

| タスク | ファイル | 担当 |
|---|---|---|
| Maestro flow 12 本 | `apps/mobile/maestro/flows/tour/*.yaml` | tester |
| Playwright spec 7 本 | `tests/e2e/tour/*.spec.ts` | tester |
| `_shared/login-as-new-user.yaml` 整備 | `apps/mobile/maestro/_shared/` | tester |
| Playwright fixtures (signupNewUser) | `tests/e2e/tour/fixtures.ts` | tester |
| CI ワークフロー追加 | `.github/workflows/handson-tour-tests.yml` | tester |
| 既存 mobile テスト fixture (karaage.jpg) との衝突確認 | tests/e2e | tester |

### 6.2 完了基準
- ハッピーパス E2E が web/mobile 両方で pass
- 12 シナリオ全て pass
- CI ワークフローが PR で自動実行される

---

## 7. PR 一覧

| PR # | タイトル | Phase | 依存 PR |
|---|---|---|---|
| P1-A | feat(handson-tour): DB + Supabase RPC + Migration | 1 | - |
| P1-B | feat(handson-tour): API ハンドラ 4 本 + 既存拡張 + 共通 package | 1 | P1-A |
| P2-A | feat(handson-tour): Web UI コア (4 components + ルーティング) | 2 | P1-B |
| P2-B | feat(handson-tour): Mobile UI コア | 2 | P1-B |
| P3-A | feat(handson-tour): Web 既存画面 sandbox 対応 | 3 | P2-A |
| P3-B | feat(handson-tour): Mobile 既存画面 sandbox 対応 | 3 | P2-B |
| P4 | feat(handson-tour): a11y + Analytics | 4 | P2-A, P2-B, P3-A, P3-B |
| P5 | test(handson-tour): E2E (Maestro + Playwright) | 5 | P3-A, P3-B, P4 |

---

## 8. 各 PR のレビュー観点

### 8.1 PR P1-A: DB
- [ ] Migration SQL が冪等 (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`)
- [ ] ロールバック SQL が動作する
- [ ] RPC 関数が SECURITY DEFINER で正しい権限
- [ ] Index が partial で効率的

### 8.2 PR P1-B: API
- [ ] 各 API の Zod schema 検証
- [ ] sandbox=true 偽装防止 (admin / 既存ユーザー拒否)
- [ ] Rate limit 設定
- [ ] エラーレスポンス形式 (cross/04 準拠)

### 8.3 PR P2-A/B: UI コア
- [ ] Props interface が family/09 §07 と一致
- [ ] reduce-motion 対応
- [ ] focus trap (web)
- [ ] Storybook 4 stories 作成

### 8.4 PR P3-A/B: 既存画面 sandbox
- [ ] mode='sandbox' で実 API が呼ばれる (バッジ実獲得)
- [ ] 通常 mode では既存挙動を破壊しない
- [ ] testID 動的化で既存テスト破損なし

### 8.5 PR P4: a11y / Analytics
- [ ] axe-core 違反 0
- [ ] Analytics events が schema に従う
- [ ] PII を含まない

### 8.6 PR P5: E2E
- [ ] 12 シナリオ全 pass
- [ ] flaky test 検出機構
- [ ] CI 実行時間 < 15 分 (mobile 除く)

---

## 9. リスクとリスク低減

### 9.1 高リスク (Phase 2 / Phase 3 連携)

リスク: Phase 2 の Sandbox Wrapper API と Phase 3 の既存画面の `mode='sandbox'` Props 仕様が乖離

低減策: Phase 1 完了時点で `packages/handson-tour-shared` に **共通 type 定義** を確定させる:

```ts
// packages/handson-tour-shared/src/types.ts
export interface SandboxComponentProps<T> {
  mode: 'sandbox';
  prefilled: T;
  apiOptions: { source: 'handson_tour'; sandbox: true };
  onSandboxComplete: (result: any) => void;
  onSandboxError?: (error: any) => void;
}

export type MealNewSandboxProps = SandboxComponentProps<typeof MOCK_PHOTO_RESPONSE> & {
  initialStep?: 'mode-select' | 'capture' | 'analyzing' | 'result' | 'select-date';
};

export type V4GenerateSandboxProps = SandboxComponentProps<typeof MOCK_MENU_RESPONSE> & {
  initialFlags: Partial<{ no_cook: boolean; simple_only: boolean; variety_emphasis: boolean }>;
  loadingDurationMs: number;
};
```

Phase 2 / Phase 3 はこの共通 type を import するだけ。

### 9.2 中リスク (測定対象テスト ID 不足)

リスク: V4GenerateModal の web 側に testID は付いているが、mobile 側は未付与。Spotlight 対象が見つからずに E2E fail

低減策: Phase 3B に **testID 一括追加タスク** を含める。Maestro の検出失敗を CI で早期発見。

### 9.3 低リスク (画像最適化)

リスク: karaage.jpg が大きすぎる (~1MB) → ハンズオン bundle サイズ膨張

低減策: Phase 2 で `cwebp -q 85` で webp 変換。fallback は元 jpg (古いブラウザ用)。

---

## 10. スケジュールサマリ

```
Day 1-2:  Phase 1 (DB + 共通 + API)
Day 3-7:  Phase 2 (Web + Mobile UI コア、並列)
Day 6-9:  Phase 3 (既存画面 sandbox、Phase 2 完了後)
Day 9-11: Phase 4 (a11y + Analytics)
Day 11-13:Phase 5 (E2E)
```

合計 **9-13 日** (並列度に応じて短縮可)。

---

## 11. 残不確実性 (§99 連携)

- [ ] V4GenerateModal の Mobile 版が存在するか (researcher で web 中心の確認、mobile は未確認)
- [ ] PR の merge 戦略 (各 PR を main にマージ vs feature ブランチに集約後一括 main)
- [ ] Phase 5 の Maestro Cloud 利用 (現状未設定、CI で実機ビルド or Cloud)
- [ ] Phase 1 の RPC 関数を SQL マイグレーションで定義するか、Supabase Edge Function で TypeScript 実装するか
