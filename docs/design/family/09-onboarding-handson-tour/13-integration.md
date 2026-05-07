# 13 — 既存実装との接続点

> 関連: [03-step1-photo](./03-step1-photo.md) / [04-step2-menu](./04-step2-menu.md) / [05-step3-badges](./05-step3-badges.md) / [12-phases](./12-phases.md)

---

## 1. 接続点一覧 (画面 / コード)

| 既存ファイル / 機能 | 変更内容 | Phase |
|---|---|---|
| `src/app/api/onboarding/complete/route.ts` | レスポンスに `next_route` 追加 | 1 |
| `src/app/onboarding/complete/page.tsx` (web) | `next_route` を読んで遷移 | 2A |
| `apps/mobile/app/onboarding/complete.tsx` (mobile) | 同上 | 2B |
| `src/app/(main)/home/page.tsx` (web) | mount 時 `getHandsonTourStatus()` 確認 | 2A |
| `apps/mobile/app/(tabs)/home.tsx` (mobile) | 同上 | 2B |
| `src/app/(main)/meals/new/page.tsx` (web) | `mode='sandbox'` プロップ追加 | 3A |
| `apps/mobile/app/meals/new.tsx` (mobile) | 同上 | 3B |
| `src/components/ai-assistant/V4GenerateModal.tsx` (web) | `mode='sandbox'` プロップ追加 | 3A |
| Mobile 版 V4GenerateModal (未確認) | 同上 | 3B |
| `src/app/(main)/badges/page.tsx` (web) | `?tutorial-mode=1&highlight=...` 対応 + `badge-card-{code}` 動的 testID | 3A |
| Mobile 版 badges 画面 (未確認) | 同上 | 3B |
| `src/app/(main)/settings/page.tsx` (web) | "使い方ガイドをもう一度見る" エントリ追加 | 2A |
| `apps/mobile/app/(tabs)/settings.tsx` (mobile) | 同上 | 2B |
| `src/app/api/meal-plans/add-from-photo/route.ts` | `?source` query + `body.sandbox` 対応 + sandbox 偽装防止 | 1 |
| `src/app/api/menu-plans/add/route.ts` | 同上 | 1 |
| `docs/seed_badges.sql` | `tutorial_complete` 追加 | 1 |
| `supabase/migrations/` | 新規ファイル `2026XXXXXXXXXX_handson_tour.sql` | 1 |
| `src/app/layout.tsx` (web) | `/handson-tour/*` route 追加 (Next.js App Router 自動検出だが念のため) | 2A |
| `apps/mobile/app/_layout.tsx` (mobile) | `/handson-tour` ルート登録 | 2B |
| `tests/e2e/fixtures/karaage.jpg` | **削除・移動禁止** (E2E 既存テストが参照) | - |
| `apps/mobile/assets/handson-tour/sample-meal.jpg` (新規) | karaage.jpg を `cp` コピー | 2B |
| `public/handson-tour/sample-meal.jpg` (新規) | 同上 | 2A |

---

## 2. 各接続点の詳細

### 2.1 `/api/onboarding/complete` 拡張

#### 既存レスポンス (推測)

```json
{
  "ok": true,
  "user_profile": { ... },
  "nutrition_target": { ... }
}
```

#### 拡張後

```json
{
  "ok": true,
  "user_profile": { ... },
  "nutrition_target": { ... },
  "next_route": "/handson-tour"  // または "/home"
}
```

#### サーバー側変更

```ts
// src/app/api/onboarding/complete/route.ts
import { getHandsonTourStatusInternal } from '@/lib/handson-tour';

export async function POST(req: Request) {
  // 既存ロジック (onboarding 完了処理)
  // ...

  // 追加
  const tourStatus = await getHandsonTourStatusInternal(userId);
  
  return Response.json({
    ok: true,
    user_profile,
    nutrition_target,
    next_route: tourStatus.should_show ? '/handson-tour' : '/home',
  });
}
```

#### クライアント側変更

```tsx
// src/app/onboarding/complete/page.tsx
const handleComplete = async () => {
  const result = await fetch('/api/onboarding/complete', { method: 'POST' }).then(r => r.json());
  router.replace(result.next_route);  // '/handson-tour' or '/home'
};
```

---

### 2.2 /home マウント時の検証 (フォールバック)

直リンク or 別経路で /home に来た場合の防御。

#### web

```tsx
// src/app/(main)/home/page.tsx
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    (async () => {
      const status = await fetch('/api/handson-tour/status').then(r => r.json());
      if (status.should_show) {
        router.replace('/handson-tour');
      }
    })();
  }, []);

  // 既存の home コンテンツ
  return <div>{/* ... */}</div>;
}
```

#### mobile

```tsx
// apps/mobile/app/(tabs)/home.tsx
import { useEffect } from 'react';
import { useRouter } from 'expo-router';

export default function HomeScreen() {
  const router = useRouter();

  useEffect(() => {
    (async () => {
      const res = await fetch('https://homegohan.app/api/handson-tour/status', {
        headers: { Authorization: `Bearer ${await getJwt()}` },
      });
      const status = await res.json();
      if (status.should_show) {
        router.replace('/handson-tour');
      }
    })();
  }, []);

  return <View>{/* ... */}</View>;
}
```

---

### 2.3 `<MealNewScreen>` mode='sandbox' 対応

§07 §6.1 に詳述。実装変更:

#### Web

```tsx
// src/app/(main)/meals/new/page.tsx
import type { MealNewScreenProps } from '@homegohan/handson-tour-shared';

export default function MealNewScreen(props: MealNewScreenProps = {}) {
  if (props.mode === 'sandbox') {
    return <MealNewScreenSandbox {...props} />;
  }
  return <MealNewScreenNormal {...props} />;
}

function MealNewScreenSandbox(props: MealNewSandboxProps) {
  const [step, setStep] = useState(props.initialStep ?? 'result');
  const [result, setResult] = useState(props.prefilled);

  const handleSave = async () => {
    try {
      const res = await fetch(`/api/meal-plans/add-from-photo?source=${props.apiOptions.source}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${await getJwtToken()}`,  // 必須 (cross/04 既定)
        },
        body: JSON.stringify({
          ...result,
          sandbox: props.apiOptions.sandbox,
          eaten_at: new Date().toISOString(),
          meal_type: 'dinner',
        }),
      });
      if (!res.ok) throw new Error(`status_${res.status}`);
      const data = await res.json();
      props.onSandboxComplete?.(data);
    } catch (err) {
      props.onSandboxError?.(err);
    }
  };

  return (
    <div className="meal-new-screen-sandbox">
      {/* result 画面 (既存と同じ visual) */}
      <h1 data-testid="meal-result-dish-name">{result.dishName}</h1>
      <p data-testid="meal-result-calories">{result.calories} kcal</p>
      {/* PFC、photo、日付選択など */}
      <button data-testid="meal-save-button" onClick={handleSave}>保存</button>
      <button data-testid="meal-cancel-button" onClick={() => router.back()}>キャンセル</button>
    </div>
  );
}
```

#### Mobile

```tsx
// apps/mobile/app/meals/new.tsx
import type { MealNewSandboxProps } from '@homegohan/handson-tour-shared';

export default function MealNewScreen(props?: MealNewScreenProps) {
  if (props?.mode === 'sandbox') return <MealNewScreenSandbox {...props} />;
  return <MealNewScreenNormal {...props} />;
}
```

---

### 2.4 `<V4GenerateModal>` mode='sandbox' 対応

#### Web

```tsx
// src/components/ai-assistant/V4GenerateModal.tsx
export function V4GenerateModal(props: V4GenerateModalProps) {
  if (props.mode === 'sandbox') {
    return <V4GenerateModalSandbox {...props} />;
  }
  return <V4GenerateModalNormal {...props} />;
}

function V4GenerateModalSandbox(props: V4GenerateSandboxProps) {
  const [flags, setFlags] = useState({
    no_cook: props.initialFlags.no_cook ?? false,
    simple_only: props.initialFlags.simple_only ?? false,
    variety_emphasis: props.initialFlags.variety_emphasis ?? false,
  });
  const [step, setStep] = useState<'input' | 'loading' | 'result'>('input');
  const [result, setResult] = useState<typeof MOCK_MENU_RESPONSE | null>(null);

  const handleGenerate = () => {
    setStep('loading');
    setTimeout(() => {
      setResult(props.prefilled);
      setStep('result');
    }, props.loadingDurationMs);
  };

  const handleAddToMenu = async () => {
    try {
      const res = await fetch(`/api/menu-plans/add?source=${props.apiOptions.source}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${await getJwtToken()}`,  // 必須 (cross/04 既定)
        },
        body: JSON.stringify({ ...result, sandbox: props.apiOptions.sandbox }),
      });
      if (!res.ok) throw new Error(`status_${res.status}`);
      props.onSandboxComplete?.(await res.json());
    } catch (err) {
      props.onSandboxError?.(err);
    }
  };

  return (
    <div data-testid="v4-modal-sandbox">
      {step === 'input' && (
        <>
          <input type="checkbox" data-testid="v4-no-cook-toggle" checked={flags.no_cook} onChange={...} />
          <textarea data-testid="v4-note-textarea" />
          <button data-testid="v4-generate-button" onClick={handleGenerate}>生成する</button>
        </>
      )}
      {step === 'loading' && <Spinner data-testid="v4-loading-spinner" />}
      {step === 'result' && result && (
        <div data-testid="v4-result-card">
          <h2 data-testid="v4-result-dish-name">{result.dish_name}</h2>
          <p data-testid="v4-result-calories">{result.calories} kcal</p>
          <button data-testid="v4-add-to-menu-button" onClick={handleAddToMenu}>献立に追加</button>
        </div>
      )}
    </div>
  );
}
```

#### Mobile

V4GenerateModal の mobile 実装が存在するか要確認 (§99)。存在しなければ新規作成 or web 流用。

---

### 2.5 `<BadgesPage>` tutorial-mode 対応

#### Web

```tsx
// src/app/(main)/badges/page.tsx
'use client';

import { useSearchParams } from 'next/navigation';
import { TourOverlay } from '@/components/handson-tour/TourOverlay';

export default function BadgesPage() {
  const params = useSearchParams();
  const tutorialMode = params.get('tutorial-mode') === '1';
  const highlight = params.get('highlight')?.split(',') ?? [];
  const [badges, setBadges] = useState([]);

  useEffect(() => {
    fetch('/api/badges').then(r => r.json()).then(setBadges);
  }, []);

  return (
    <div>
      {!tutorialMode && <Header />}
      <div className="badges-grid">
        {badges.map(badge => (
          <BadgeCard
            key={badge.code}
            badge={badge}
            data-testid={`badge-card-${badge.code}`}  // 動的 testID
            highlighted={tutorialMode && highlight.includes(badge.code)}
            // tutorialMode 中は獲得モーダル発火を抑制
            suppressAcquisitionModal={tutorialMode}
          />
        ))}
      </div>

      {tutorialMode && (
        <HandsonTourBadgesOverlay highlight={highlight} />
      )}
    </div>
  );
}
```

`<BadgeCard>` に `suppressAcquisitionModal` prop を追加。tutorialMode の時は AnimatePresence の獲得モーダルを発火させない。

#### Mobile

同様。Mobile 版 BadgesPage の構造を要確認。

---

### 2.6 /settings の再開エントリ

#### Web

```tsx
// src/app/(main)/settings/page.tsx
const handleReplayTour = () => {
  router.push('/handson-tour?force=1');
};

// 既存の settings UI に追加
<SettingsItem
  icon="📚"
  label="使い方ガイドをもう一度見る"
  onClick={handleReplayTour}
  data-testid="settings-replay-handson-tour"
/>
```

#### Mobile

```tsx
// apps/mobile/app/(tabs)/settings.tsx
const handleReplayTour = () => {
  router.push('/handson-tour?force=1');
};

<SettingsItem
  icon="📚"
  label="使い方ガイドをもう一度見る"
  onPress={handleReplayTour}
  testID="settings-replay-handson-tour"
/>
```

---

### 2.7 既存 API 拡張: meal-plans/add-from-photo

```ts
// src/app/api/meal-plans/add-from-photo/route.ts
import { z } from 'zod';

const RequestSchema = z.object({
  // 既存フィールド
  dishName: z.string(),
  calories: z.number(),
  // ...
  // 追加
  sandbox: z.boolean().optional().default(false),
});

export async function POST(req: Request) {
  const url = new URL(req.url);
  const source = url.searchParams.get('source') ?? 'normal';
  const body = RequestSchema.parse(await req.json());
  const userId = await getAuthUserId(req);

  // sandbox=true の偽装防止
  if (body.sandbox) {
    const profile = await getProfile(userId);
    if (profile.handson_tour_completed_at || profile.handson_tour_skipped_at) {
      return Response.json({ error: 'sandbox_not_eligible' }, { status: 409 });
    }
    const adminRoles = ['admin', 'super_admin', 'org_admin', 'org_industrial_doctor'];
    if (profile.roles?.some(r => adminRoles.includes(r))) {
      return Response.json({ error: 'sandbox_not_eligible', reason: 'admin_role' }, { status: 403 });
    }
    const hasActivity = await rpcUserHasNonSandboxActivity(userId);
    if (hasActivity) {
      return Response.json({ error: 'sandbox_not_eligible', reason: 'existing_user' }, { status: 409 });
    }
  }

  // INSERT
  const { data: log, error } = await supabase.from('meal_logs').insert({
    user_id: userId,
    dish_name: body.dishName,
    calories: body.calories,
    // ...
    is_sandbox: body.sandbox,
    source,  // 計測用
  }).select().single();

  if (error) return Response.json({ error: 'internal_error', message: error.message }, { status: 500 });

  // first_bite バッジ付与 (既存ロジック流用)
  const badgeResult = await tryAwardBadge(userId, 'first_bite');

  return Response.json({ meal_log_id: log.id, badge_awarded: badgeResult });
}
```

### 2.8 既存 API 拡張: menu-plans/add

同様の構造。`planner` バッジ付与。

---

### 2.9 Migration ファイル配置

```
supabase/migrations/2026XXXXXXXXXX_handson_tour.sql
```

`XXXXXXXXXX` は `date +%Y%m%d%H%M%S` で生成 (例: `20260507143000`)。

詳細は §21-migration-sql.md。

---

## 3. testID 動的化の影響

### 3.1 既存 web の `data-testid="badge-card"` を `badge-card-{code}` に変更

#### 影響
- 既存 E2E テストで `[data-testid="badge-card"]` を query している場合は壊れる
- 既存実装の検索で grep:

```bash
grep -r 'data-testid="badge-card"' src/ tests/
```

#### 互換性維持

両方付与する案 (deprecation 期間):

```tsx
<div
  data-testid="badge-card"  // 旧、deprecated
  data-testid-new={`badge-card-${badge.code}`}  // 新
>
```

または、tutorial-mode のときだけ動的 testID を追加:

```tsx
<div
  data-testid={tutorialMode ? `badge-card-${badge.code}` : 'badge-card'}
>
```

→ 推奨: **動的 testID に変更し、既存テストを fix する**。Phase 3A の作業範囲に含める。

---

## 4. 既存の Spotlight / コーチマーク不在の確認

researcher 結果より、既存実装に coachmark / tour / spotlight / showcase / walkthrough / tutorial 系のコードは **存在しない**。新規実装。

つまり Phase 2 で新規 Tour コンポーネント群を構築する際、既存システムからの流用はない。クリーンスレートでの実装。

---

## 5. Bottom Tab Bar / Header の制御

### 5.1 web
- `/handson-tour/*` 配下では Header と Sidebar を非表示
- `src/app/handson-tour/layout.tsx` で `<MainLayout>` を bypass

```tsx
// src/app/handson-tour/layout.tsx
export default function HandsonTourLayout({ children }: { children: React.ReactNode }) {
  return <div className="handson-tour-root">{children}</div>;
  // MainLayout (Header + Sidebar) を bypass
}
```

### 5.2 mobile
- `apps/mobile/app/handson-tour/_layout.tsx` で `<Stack screenOptions={{ headerShown: false }} />`
- タブバーも非表示 (`Stack` は taボbar group の外なので自動的に隠れる)

```tsx
// apps/mobile/app/handson-tour/_layout.tsx
import { Stack } from 'expo-router';

export default function HandsonTourLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        gestureEnabled: false,  // iOS swipe back 無効化
      }}
    />
  );
}
```

---

## 6. ディープリンク

### 6.1 URL スキーム
- web: `https://homegohan.app/handson-tour`
- mobile: `homegohan://handson-tour`

### 6.2 universal link 設定 (mobile)

```json
// apps/mobile/app.json
{
  "expo": {
    "ios": {
      "associatedDomains": ["applinks:homegohan.app"]
    },
    "android": {
      "intentFilters": [
        {
          "action": "VIEW",
          "data": [{ "scheme": "https", "host": "homegohan.app", "pathPrefix": "/handson-tour" }],
          "category": ["BROWSABLE", "DEFAULT"],
          "autoVerify": true
        }
      ]
    }
  }
}
```

---

## 7. push 通知との連携 (将来)

v1 ではハンズオン関連の push 通知はしない。v2 で「3 日経過してもハンズオン未開始のユーザーに push」等を検討。

---

## 8. 監視 / 観測 (operator/07 連携)

§28 / §20 に詳述。本ファイルでは接続点のみ:
- Sentry / Bugsnag に Tour 関連の breadcrumb を追加
- PostHog / Mixpanel に events を流す
- Slack #app-alerts にエラー率閾値超えで alert

---

## 9. 既存テストへの影響範囲

### 9.1 影響を受ける既存テスト

| テストファイル | 影響 |
|---|---|
| `src/__tests__/badges/*.test.tsx` | `badge-card` testID 変更で fix 必要 |
| `tests/e2e/badges/*.spec.ts` | 同上 |
| `src/__tests__/onboarding/complete.test.ts` | レスポンスに `next_route` 追加で snapshot 更新 |
| `tests/e2e/onboarding/*.spec.ts` | onboarding 完了後の遷移先テストを更新 |

### 9.2 影響を受けない既存テスト
- ハンズオン完全に新規追加なので、ほとんどの既存テストには影響なし

---

## 10. 残不確実性 (§99 連携)

- [ ] Mobile 版 V4GenerateModal の実装場所 (web のみか、mobile にもあるか)
- [ ] Mobile 版 BadgesPage の実装場所
- [ ] 既存 `data-testid="badge-card"` を参照するテストの数 (= fix 工数)
- [ ] `/handson-tour/*` 配下で MainLayout を bypass する方法 (Next.js App Router の慣習)
- [ ] Universal link / Deep link の実装ステータス (既存設定の有無)
