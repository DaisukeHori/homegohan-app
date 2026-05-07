# 11 — テスト詳細

> 関連: [09-api-spec](./09-api-spec.md) / [10-a11y](./10-a11y.md) / cross/09-testing.md (canonical 概念のみ)

---

## 1. テスト戦略

### 1.1 テストピラミッド

```
            E2E (Maestro / Playwright)
              ↑ 10%  (7 シナリオ × 2 platform = 14 spec)
           Integration
              ↑ 20%  (API + DB の結合)
           Unit
              ↑ 70%  (component / hook / lib)
```

- 70% Unit: 速い、関数 / コンポーネント単位、CI で常時実行
- 20% Integration: 中速、API ハンドラ + DB の結合、PR ごとに実行
- 10% E2E: 遅い、画面遷移含むユーザー体験、main マージ前に実行

### 1.2 対象範囲

| 層 | テスト対象 |
|---|---|
| Unit | personalize() / shouldShowHandsonTour() / コンポーネント Props / アニメーション state |
| Integration | API ハンドラ + Supabase RPC + RLS / sandbox 偽装防止 / バッジ付与トランザクション |
| E2E | 7 シナリオ (Maestro + Playwright) |
| 視覚回帰 | Storybook + Chromatic で各コンポーネントの状態スナップショット |
| a11y 自動 | axe-core (Playwright 連携) |
| a11y 手動 | VoiceOver / TalkBack / NVDA / macOS VoiceOver |
| パフォーマンス | Lighthouse (web) / Reanimated FPS 計測 (mobile) |
| セキュリティ | sandbox=true 偽装防止 / RLS / CSRF |

---

## 2. Unit テスト

### 2.1 `personalize()` (`packages/handson-tour-shared/src/personalize.ts`)

```ts
// __tests__/personalize.test.ts
import { personalize } from '@homegohan/handson-tour-shared';

describe('personalize', () => {
  it('nickname を埋め込む', () => {
    const result = personalize('{nickname} さん', { nickname: '太郎' });
    expect(result).toBe('太郎 さん');
  });

  it('nickname null/empty なら "あなた"', () => {
    expect(personalize('{nickname} さん', { nickname: null })).toBe('あなた さん');
    expect(personalize('{nickname} さん', { nickname: '' })).toBe('あなた さん');
    expect(personalize('{nickname} さん', { nickname: '   ' })).toBe('あなた さん');
  });

  it('30 文字超で truncate + …', () => {
    const long = '長'.repeat(50);
    const result = personalize('{nickname} さん', { nickname: long });
    expect(result).toBe('長'.repeat(30) + '… さん');
  });

  it('target_kcal を埋め込む', () => {
    const result = personalize('目標 {target_kcal} kcal', { target_kcal: 2000 });
    expect(result).toBe('目標 2000 kcal');
  });

  it('target_kcal undefined なら placeholder 残し', () => {
    const result = personalize('目標 {target_kcal} kcal', {});
    // 仕様: placeholder 削除して隙間埋め (実装次第)
    expect(result).not.toContain('{target_kcal}');
  });

  it('allergies 配列を join', () => {
    expect(personalize('{allergies}', { allergies: ['卵', '乳'] })).toBe('卵・乳');
    expect(personalize('{allergies}', { allergies: [] })).toBe('');
    expect(personalize('{allergies}', { allergies: undefined })).toBe('');
  });

  it('cooking_experience を text 展開', () => {
    expect(personalize('{cooking_experience_text}', { cooking_experience: 'beginner' })).toBe('初心者でも作れる');
    expect(personalize('{cooking_experience_text}', { cooking_experience: 'advanced' })).toBe('シェフの腕前を活かせる');
    expect(personalize('{cooking_experience_text}', { cooking_experience: null })).toBe('初心者でも作れる');
  });
});
```

### 2.2 `shouldShowHandsonTour()` ロジック

```ts
// __tests__/should-show-handson-tour.test.ts
describe('shouldShowHandsonTour', () => {
  // condition A AND B AND NOT C AND NOT D = 4 条件 = 16 通り (2^4)

  const baseProfile = {
    onboarding_completed_at: '2026-05-08T10:00:00Z',
    handson_tour_completed_at: null,
    handson_tour_skipped_at: null,
    roles: ['user'],
  };

  it('A:false (onboarding 未完) → false', async () => {
    const result = await shouldShowHandsonTour({ ...baseProfile, onboarding_completed_at: null });
    expect(result.should_show).toBe(false);
    expect(result.reason).toBe('onboarding_not_completed');
  });

  it('B:false (completed_at NOT NULL) → false', async () => {
    const result = await shouldShowHandsonTour({ ...baseProfile, handson_tour_completed_at: '2026-05-08T11:00:00Z' });
    expect(result.should_show).toBe(false);
    expect(result.reason).toBe('already_completed');
  });

  it('B:false (skipped_at NOT NULL) → false', async () => {
    const result = await shouldShowHandsonTour({ ...baseProfile, handson_tour_skipped_at: '2026-05-08T11:00:00Z' });
    expect(result.should_show).toBe(false);
    expect(result.reason).toBe('already_skipped');
  });

  it('D:true (admin role) → false (skipped_at セットしない)', async () => {
    const result = await shouldShowHandsonTour({ ...baseProfile, roles: ['user', 'admin'] });
    expect(result.should_show).toBe(false);
    expect(result.reason).toBe('admin_role');
    // skipped_at は不変
    expect(/* DB の skipped_at */).toBeNull();
  });

  it('C:true (既存 meal_logs) → false (skipped_at auto-set)', async () => {
    // mock: hasNonSandboxActivity → true
    const result = await shouldShowHandsonTour(baseProfile, { hasActivity: true });
    expect(result.should_show).toBe(false);
    expect(result.reason).toBe('existing_user_auto_skip');
    expect(/* DB UPDATE */).toHaveBeenCalled();
  });

  it('A AND B AND NOT C AND NOT D → true', async () => {
    const result = await shouldShowHandsonTour(baseProfile, { hasActivity: false });
    expect(result.should_show).toBe(true);
    expect(result.reason).toBe('eligible');
  });

  // ... 残り 9 通り
});
```

### 2.3 コンポーネントテスト

#### 2.3.1 `<HandsonTourOverlay>`

```ts
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

describe('<HandsonTourOverlay>', () => {
  it('targetTestId 指定時に Spotlight 表示', () => {
    render(<HandsonTourOverlay targetTestId="some-element" bubble={{ body: 'test' }} ... />);
    expect(screen.getByTestId('tour-overlay')).toBeInTheDocument();
  });

  it('autoAdvanceMs で onAutoAdvance 発火', async () => {
    const onAdvance = jest.fn();
    render(<HandsonTourOverlay autoAdvanceMs={1000} onAutoAdvance={onAdvance} ... />);
    await waitFor(() => expect(onAdvance).toHaveBeenCalled(), { timeout: 1500 });
  });

  it('primaryAction.onPress で発火', () => {
    const onPress = jest.fn();
    render(<HandsonTourOverlay primaryAction={{ label: '次へ', onPress }} ... />);
    fireEvent.click(screen.getByTestId('tour-next-button'));
    expect(onPress).toHaveBeenCalled();
  });

  it('reduce-motion で アニメ duration 0', () => {
    // mock matchMedia
    window.matchMedia = jest.fn().mockReturnValue({ matches: true });
    const { container } = render(<HandsonTourOverlay ... />);
    // アニメ duration を内部 prop or class name で確認
  });
});
```

#### 2.3.2 `<HandsonTourBubble>` 配置ロジック

```ts
describe('<HandsonTourBubble> position calculation', () => {
  it('position=auto + target が画面下なら top に表示', () => {
    const target = { x: 100, y: 700, width: 80, height: 40 };  // 画面下
    const bubble = { width: 280, height: 100 };
    const viewport = { width: 375, height: 800 };
    const result = calculateBubblePosition(target, 'auto', bubble, viewport, 12);
    expect(result.actualPosition).toBe('top');
    expect(result.y).toBeLessThan(target.y);
  });

  it('position=auto + target が画面上なら bottom', () => {
    const target = { x: 100, y: 50, width: 80, height: 40 };
    const result = calculateBubblePosition(target, 'auto', { width: 280, height: 100 }, { width: 375, height: 800 }, 12);
    expect(result.actualPosition).toBe('bottom');
  });
});
```

### 2.4 Step ごとの state 管理

```ts
describe('Step1 state machine', () => {
  it('subStep 1.1 → 1.2 を 2.5s 後に自動遷移', async () => {
    // ...
  });

  it('subStep 1.6 で API 呼び出し成功 → 1.8 → Step 2 遷移', async () => {
    // ...
  });

  it('subStep 1.6 で API 失敗 → error 画面', async () => {
    // ...
  });
});
```

---

## 3. Integration テスト

### 3.1 API + DB

#### 3.1.1 `/api/handson-tour/complete`

```ts
// tests/integration/handson-tour-complete.test.ts
import { createClient } from '@supabase/supabase-js';

describe('POST /api/handson-tour/complete', () => {
  let testUserId: string;

  beforeEach(async () => {
    testUserId = await createTestUser({ onboarding_completed: true });
  });

  it('新規ユーザー: 200 + バッジ付与', async () => {
    const res = await fetch('/api/handson-tour/complete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${getJwt(testUserId)}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.already_completed).toBe(false);
    expect(data.badge_awarded.code).toBe('tutorial_complete');

    // DB 確認
    const profile = await getProfile(testUserId);
    expect(profile.handson_tour_completed_at).not.toBeNull();
    const badges = await getUserBadges(testUserId);
    expect(badges).toContainEqual(expect.objectContaining({ code: 'tutorial_complete' }));
  });

  it('連続 2 回呼出: 2 回目 already_completed: true、user_badges 1 行のみ', async () => {
    await fetch('/api/handson-tour/complete', { method: 'POST', ... });
    const res2 = await fetch('/api/handson-tour/complete', { method: 'POST', ... });
    const data2 = await res2.json();
    expect(data2.already_completed).toBe(true);

    const badges = await getUserBadges(testUserId);
    expect(badges.filter(b => b.code === 'tutorial_complete')).toHaveLength(1);
  });

  it('admin role: 403 not_eligible', async () => {
    await setUserRoles(testUserId, ['user', 'admin']);
    const res = await fetch('/api/handson-tour/complete', { method: 'POST', ... });
    expect(res.status).toBe(403);
  });

  it('既存ユーザー (condition C): 409', async () => {
    await insertMealLog(testUserId, { is_sandbox: false });
    const res = await fetch('/api/handson-tour/complete', { method: 'POST', ... });
    expect(res.status).toBe(409);
  });
});
```

#### 3.1.2 `/api/meal-plans/add-from-photo` sandbox

```ts
describe('POST /api/meal-plans/add-from-photo with sandbox', () => {
  it('通常ユーザー sandbox=true: meal_logs に is_sandbox=true で挿入', async () => {
    const res = await fetch('/api/meal-plans/add-from-photo?source=handson_tour', {
      method: 'POST',
      headers: { ... },
      body: JSON.stringify({ sandbox: true, dishName: '...', calories: 780, ... }),
    });
    expect(res.status).toBe(200);

    const logs = await getMealLogs(testUserId);
    expect(logs[0].is_sandbox).toBe(true);
  });

  it('admin sandbox=true: 403', async () => {
    await setUserRoles(testUserId, ['user', 'admin']);
    const res = await fetch('/api/meal-plans/add-from-photo?source=handson_tour', {
      method: 'POST',
      body: JSON.stringify({ sandbox: true, ... }),
    });
    expect(res.status).toBe(403);
  });

  it('sandbox=true で first_bite バッジ付与', async () => {
    await fetch('/api/meal-plans/add-from-photo?source=handson_tour', {
      method: 'POST', body: JSON.stringify({ sandbox: true, ... }),
    });
    const badges = await getUserBadges(testUserId);
    expect(badges).toContainEqual(expect.objectContaining({ code: 'first_bite' }));
  });
});
```

### 3.2 RLS テスト

```ts
describe('RLS for handson_tour', () => {
  it('他人の handson_tour_completed_at を読めない', async () => {
    const otherUserId = await createTestUser({});
    await setHandsonTourCompleted(otherUserId);

    // testUserId の jwt で other の profile を SELECT
    const { data, error } = await supabaseAsUser(testUserId)
      .from('user_profiles')
      .select('handson_tour_completed_at')
      .eq('user_id', otherUserId);

    expect(data).toEqual([]);  // RLS で空
  });

  it('他人の user_badges に INSERT できない', async () => {
    const otherUserId = await createTestUser({});
    const { error } = await supabaseAsUser(testUserId)
      .from('user_badges')
      .insert({ user_id: otherUserId, badge_id: '...', obtained_at: now() });
    expect(error).toBeTruthy();
  });
});
```

---

## 4. E2E テスト (Maestro)

### 4.1 シナリオ一覧

| # | name | 内容 |
|---|---|---|
| 01 | handson-completion | ハッピーパス完走 |
| 02 | skip-at-welcome | Step 0 で【あとで】 |
| 03 | hard-back | 各 step でハードバック |
| 04 | step1-error-retry | Step 1 API fail → リトライ → 成功 |
| 05 | step2-menu-success | Step 2 完走 (Step 1 から続き) |
| 06 | step2-menu-error-retry | Step 2 リトライ |
| 07 | step3-badges | Step 3 でバッジ表示確認 |
| 08 | step4-graduation | Step 4 卒業 |
| 09 | step4-graduation-retry | Step 4 卒業 API failure → リトライ |
| 10 | force-replay | /settings から強制再表示 |
| 11 | skip-for-admin | admin で表示されない |
| 12 | skip-for-existing-user | 既存ユーザーで表示されない (auto skip) |

### 4.2 完全 YAML (主要シナリオ)

#### 4.2.1 01-handson-completion.yaml

```yaml
appId: com.homegohan.app
name: Tour - Handson Completion (Happy Path)
tags: ['handson-tour', 'critical', 'P1']
---
- runFlow: ../_shared/login-as-new-user.yaml
- assertVisible:
    id: tour-step-0
    timeout: 5000

# Step 0
- assertVisible:
    id: tour-step-0-title
    text: ".+さん、ようこそ!"
- tapOn:
    id: tour-step-0-start

# Step 1
- assertVisible: { id: tour-step-1-intro }
- # 自動進行を待つ (1.1 → 1.2)
- waitForAnimationToEnd:
    timeout: 4000
- assertVisible: { id: meal-camera-button }
- # 1.2 → 1.3 自動 (2.0s)
- waitForAnimationToEnd:
    timeout: 3000
- assertVisible: { id: meal-analyzing-view }
- # 1.3 → 1.4 自動 (1.5s)
- waitForAnimationToEnd:
    timeout: 2500
- assertVisible: { id: meal-result-screen }
- assertVisible:
    id: meal-result-dish-name
    text: "鶏の唐揚げ定食"
- assertVisible:
    id: meal-result-calories
    text: "780"
- # 1.5 → 1.6 spotlight 表示
- waitForAnimationToEnd:
    timeout: 1500
- tapOn:
    id: tour-next-button
- assertVisible: { id: meal-save-button }
- tapOn:
    id: meal-save-button
- # API 呼び出し ~500ms
- waitForAnimationToEnd:
    timeout: 3000

# Step 2
- assertVisible: { id: tour-step-2-intro }
- waitForAnimationToEnd: { timeout: 4000 }
- assertVisible: { id: v4-no-cook-toggle }
- tapOn: { id: tour-next-button }
- assertVisible: { id: v4-note-textarea }
- tapOn: { id: tour-next-button }
- assertVisible: { id: v4-generate-button }
- tapOn: { id: v4-generate-button }
- assertVisible: { id: v4-loading-spinner }
- waitForAnimationToEnd: { timeout: 3000 }
- assertVisible: { id: v4-result-card }
- assertVisible:
    id: v4-result-dish-name
    text: "豚肉と野菜の生姜焼き"
- tapOn: { id: tour-next-button }
- assertVisible: { id: v4-add-to-menu-button }
- tapOn: { id: v4-add-to-menu-button }
- waitForAnimationToEnd: { timeout: 3000 }

# Step 3
- assertVisible: { id: tour-step-3-loading }
- waitForAnimationToEnd: { timeout: 5000 }
- assertVisible: { id: tour-step-3-intro }
- waitForAnimationToEnd: { timeout: 3000 }
- assertVisible: { id: badge-card-first_bite }
- tapOn: { id: tour-next-button }
- assertVisible: { id: badge-card-planner }
- tapOn: { id: tour-next-button }
- assertVisible: { id: badge-card-tutorial_complete }
- tapOn: { id: tour-next-button }

# Step 4
- assertVisible: { id: tour-step-4-saving }
- waitForAnimationToEnd: { timeout: 3000 }
- assertVisible: { id: tour-step-4-graduate }
- assertVisible:
    id: tour-step-4-title
    text: "卒業おめでとう"
- # 5 秒待ち (button 活性化)
- waitForAnimationToEnd: { timeout: 6000 }
- tapOn: { id: tour-step-4-go-home }

# Step 5
- assertVisible: { id: home-condition-section }
- assertVisible:
    id: tour-step-5-toast
    text: ".+さん"
- # toast 自動 dismiss
- waitForAnimationToEnd: { timeout: 5000 }
- assertNotVisible: { id: tour-step-5-toast }

# 再起動後にもハンズオンは出ない
- killApp
- launchApp
- assertVisible: { id: home-condition-section }
- assertNotVisible: { id: tour-step-0 }
```

#### 4.2.2 02-skip-at-welcome.yaml

```yaml
appId: com.homegohan.app
name: Tour - Skip at Welcome
tags: ['handson-tour', 'critical', 'P1']
---
- runFlow: ../_shared/login-as-new-user.yaml
- assertVisible: { id: tour-step-0 }
- tapOn: { id: tour-step-0-skip }
- assertVisible: { id: home-condition-section }
- assertNotVisible: { id: tour-step-0 }
- killApp
- launchApp
- assertVisible: { id: home-condition-section }
- assertNotVisible: { id: tour-step-0 }
```

#### 4.2.3 11-skip-for-admin.yaml

```yaml
appId: com.homegohan.app
name: Tour - Skip for Admin Role
tags: ['handson-tour', 'P2']
---
- runFlow: ../_shared/login-as-admin.yaml
- assertVisible: { id: home-condition-section }
- assertNotVisible: { id: tour-step-0 }
- # /handson-tour 直リンクでも表示されない
- launchApp:
    arguments:
      - "/handson-tour"
- assertVisible: { id: home-condition-section }
```

### 4.3 Maestro fixtures

`apps/mobile/maestro/_shared/login-as-new-user.yaml`:
```yaml
appId: com.homegohan.app
---
- runFlow: ./logout.yaml
- launchApp
- runFlow: ./signup-new-user.yaml  # 新規 signup → onboarding 完了まで自動
```

新規ユーザー作成 maestro flow も整備が必要 (既存 auth/04-signup-new-user 流用検討)。

---

## 5. E2E テスト (Playwright Web)

### 5.1 spec ファイル

```
tests/e2e/tour/
├── 01-handson-completion.spec.ts
├── 02-skip-at-welcome.spec.ts
├── 03-graduation-retry.spec.ts
├── 04-force-replay.spec.ts
├── 05-skip-for-admin.spec.ts
├── 06-skip-for-existing-user.spec.ts
└── 07-a11y-axe.spec.ts
```

### 5.2 主要 spec

```ts
// 01-handson-completion.spec.ts
import { test, expect } from '@playwright/test';
import { signupNewUser, loginAsAdmin } from './fixtures';

test.describe('Tour - Handson Completion (Web)', () => {
  test('Happy path completes successfully', async ({ page }) => {
    await signupNewUser(page);
    await expect(page.getByTestId('tour-step-0')).toBeVisible();
    await expect(page.getByTestId('tour-step-0-title')).toContainText('さん、ようこそ');

    await page.getByTestId('tour-step-0-start').click();
    await expect(page.getByTestId('tour-step-1-intro')).toBeVisible();
    // 自動進行を待機
    await expect(page.getByTestId('meal-result-screen')).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('meal-result-dish-name')).toContainText('鶏の唐揚げ定食');
    await page.getByTestId('tour-next-button').click();
    await page.getByTestId('meal-save-button').click();

    // Step 2
    await expect(page.getByTestId('tour-step-2-intro')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('v4-no-cook-toggle')).toBeChecked();
    await page.getByTestId('tour-next-button').click();
    await page.getByTestId('tour-next-button').click();
    await page.getByTestId('v4-generate-button').click();
    await expect(page.getByTestId('v4-result-card')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('tour-next-button').click();
    await page.getByTestId('v4-add-to-menu-button').click();

    // Step 3
    await expect(page.getByTestId('badge-card-first_bite')).toBeVisible({ timeout: 5000 });
    // ... 以降同様
  });
});
```

### 5.3 Playwright fixtures

```ts
// tests/e2e/tour/fixtures.ts
export async function signupNewUser(page) {
  const email = `e2e-tour-${Date.now()}@homegohan.test`;
  await page.goto('/signup');
  await page.fill('[data-testid="email"]', email);
  await page.fill('[data-testid="password"]', 'TestPassword123!');
  await page.click('[data-testid="signup-button"]');
  // onboarding 自動入力 (skip-able の項目はスキップ)
  await fastOnboarding(page);
}
```

### 5.4 a11y axe テスト

```ts
// 07-a11y-axe.spec.ts
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('Tour a11y', () => {
  test('Step 0 violates 0', async ({ page }) => {
    await signupNewUser(page);
    const results = await new AxeBuilder({ page })
      .include('[data-testid="tour-step-0"]')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  // Step 1, 2, 3, 4 各ページで axe 違反 0 を検証
});
```

---

## 6. 視覚回帰テスト (Storybook + Chromatic)

### 6.1 Storybook 構成

```
src/components/handson-tour/
├── TourOverlay.stories.tsx
├── TourBubble.stories.tsx
├── TourProgress.stories.tsx
└── TourSandboxWrapper.stories.tsx
```

### 6.2 主要 story (TourOverlay)

```tsx
// TourOverlay.stories.tsx
import type { Meta, StoryObj } from '@storybook/react';
import { TourOverlay } from './TourOverlay';

const meta: Meta<typeof TourOverlay> = {
  title: 'HandsonTour/TourOverlay',
  component: TourOverlay,
};
export default meta;

export const FullscreenWelcome: StoryObj = {
  args: {
    targetTestId: null,
    bubble: { title: 'ようこそ', body: '3 つの便利機能を試しましょう', position: 'auto' },
    primaryAction: { label: 'はじめる', onPress: () => {} },
    showSkip: true,
    progress: { current: 1, total: 5 },
  },
};

export const SpotlightOnButton: StoryObj = {
  args: {
    targetTestId: 'demo-button',
    bubble: { body: 'このボタンをタップ', position: 'top' },
    primaryAction: { label: '次へ', onPress: () => {} },
    progress: { current: 2, total: 5 },
  },
};

export const ReducedMotion: StoryObj = {
  args: {
    forceReducedMotion: true,
    targetTestId: 'demo-button',
    bubble: { body: 'reduce-motion 状態', position: 'auto' },
  },
};
```

### 6.3 Chromatic 自動承認
- PR ごとに視覚差分検出
- 意図的変更は手動承認 → main マージ
- Diff > 0.5% で blocking

---

## 7. パフォーマンステスト

### 7.1 Web (Lighthouse)

CI で `/handson-tour` の各ページに Lighthouse 実行:

| 指標 | 目標 |
|---|---|
| Performance Score | > 90 |
| First Contentful Paint | < 1.5s |
| Largest Contentful Paint | < 2.5s |
| Total Blocking Time | < 200ms |
| Cumulative Layout Shift | < 0.1 |

### 7.2 Mobile (Reanimated FPS)

- Step 4 紙吹雪 + 🎓 spring アニメーション中の fps 計測
- 目標: 60fps 維持 (60fps 以下は detox / e2e で fail)

```ts
// 計測 (mobile dev only)
import { useFrameCallback } from 'react-native-reanimated';
useFrameCallback((info) => {
  console.log('frame', info.timeSinceFirstFrame, info.timeSincePreviousFrame);
});
```

### 7.3 Step 4 卒業 API レイテンシ

- 目標: p95 < 500ms
- 計測: Sentry / OpenTelemetry trace
- 閾値超過で alert

---

## 8. セキュリティテスト

### 8.1 sandbox=true 偽装防止

```ts
describe('sandbox=true 偽装防止', () => {
  it('admin が sandbox=true で submit → 403', async () => {
    await setUserRoles(testUserId, ['admin']);
    const res = await fetch('/api/meal-plans/add-from-photo?source=handson_tour', {
      method: 'POST',
      body: JSON.stringify({ sandbox: true, ... }),
    });
    expect(res.status).toBe(403);
  });

  it('既存ユーザー (non-sandbox meal_logs あり) が sandbox=true → 409', async () => {
    await insertMealLog(testUserId, { is_sandbox: false });
    const res = await fetch('/api/meal-plans/add-from-photo?source=handson_tour', {
      method: 'POST', body: JSON.stringify({ sandbox: true, ... }),
    });
    expect(res.status).toBe(409);
  });
});
```

### 8.2 RLS 抜け穴チェック
§3.2 のテストを参照。

### 8.3 CSRF (web)
SameSite=Lax cookie + Bearer token で防御済。CSRF テストは cross/04 で標準的に行う。

---

## 9. テストデータ・fixtures

### 9.1 ユーザー
- `e2e-tour-new-user-{timestamp}@homegohan.test`: signup から始める新規 user
- `e2e-tour-completed@homegohan.test`: ハンズオン完了済 (force=1 シナリオ用)
- `e2e-tour-admin@homegohan.test`: admin ロール
- `e2e-tour-existing-user@homegohan.test`: meal_logs を持つ既存 user

### 9.2 画像
- `tests/e2e/fixtures/karaage.jpg` (既存、再利用)

### 9.3 mock seed
- `MOCK_PHOTO_RESPONSE`, `MOCK_MENU_RESPONSE` を `packages/handson-tour-shared/src/mocks.ts` から import

---

## 10. CI/CD 統合

### 10.1 GitHub Actions ワークフロー

```yaml
# .github/workflows/handson-tour-tests.yml
name: Handson Tour Tests

on:
  pull_request:
    paths:
      - 'src/components/handson-tour/**'
      - 'apps/mobile/src/handson-tour/**'
      - 'src/app/api/handson-tour/**'
      - 'src/app/handson-tour/**'
      - 'apps/mobile/app/handson-tour/**'
      - 'packages/handson-tour-shared/**'
      - 'tests/e2e/tour/**'

jobs:
  unit-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test -- --coverage src/components/handson-tour packages/handson-tour-shared

  integration-test:
    runs-on: ubuntu-latest
    services:
      supabase: ...
    steps:
      - run: npm run test:integration

  e2e-web:
    runs-on: ubuntu-latest
    steps:
      - run: npx playwright install
      - run: npm run test:e2e:tour -- --grep '@critical'

  e2e-mobile:
    runs-on: macos-latest
    steps:
      - run: cd apps/mobile && eas build --platform ios --profile preview --local
      - run: maestro test apps/mobile/maestro/flows/tour --include-tags critical
```

### 10.2 PR ごとの実行範囲
- 関連ファイル変更 → 全テスト実行
- 関連なし → skip

---

## 11. テスト実行時間目標

| 種類 | 想定時間 |
|---|---|
| Unit (component / lib) | < 30 秒 |
| Integration (API + DB) | < 2 分 |
| E2E Maestro (1 シナリオ) | 1-3 分 (実機 + ビルド込みなら +15 分) |
| E2E Playwright (1 spec) | 30-60 秒 |
| Lighthouse | 1 分 |

CI total: < 15 分 (e2e-mobile 除く、それは別 job 並列)

---

## 12. テスト計測 (test analytics)

### 12.1 Flaky test 検出
- 7 日間で 3 回以上 retry した test を flaky とみなす
- Slack #ci-alerts に通知 + Issue 自動作成

### 12.2 実行時間トレンド
- 各 test の実行時間を Datadog / Looker で可視化
- 50% 以上の劣化で alert

---

## 13. 残不確実性 (§99 連携)

- [ ] Maestro Cloud or local 実行どちらを CI で使うか
- [ ] Playwright の parallel execution worker 数 (default 4 で十分か)
- [ ] axe-core で検出できない動的 a11y 問題の手動チェックリスト
- [ ] 視覚回帰 (Chromatic) の閾値 (Diff > 0.5% は妥当か)
- [ ] Mobile 60fps 維持の自動 fail 条件 (e2e で計測難しい場合は manual QA)
- [ ] integration test の DB seed 戦略 (毎テスト truncate or test ごとに別 schema)
