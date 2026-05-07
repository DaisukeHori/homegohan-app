# 06 — Step 4: 卒業 (tutorial_complete バッジ付与) 詳細

> 関連: [05-step3-badges](./05-step3-badges.md) / [09-api-spec](./09-api-spec.md) / [19-rollout](./19-rollout.md) / [21-migration-sql](./21-migration-sql.md)

---

## 1. 役割

Step 4 は **「ハンズオンを完走した達成感を最大化する」**。`tutorial_complete` バッジを実際に付与し、🎓 アニメーション + 紙吹雪で卒業セレモニー。完了登録 (`POST /api/handson-tour/complete`) はここで実行。

---

## 2. 画面レイアウト

### 2.1 ASCII

```
┌──────────────────────────────────────┐
│                                      │
│          [紙吹雪 (3s loop)]            │
│                                      │
│         🎓 (アニメーション 80×80)       │
│                                      │
│       卒業おめでとう! 🎉                │
│                                      │
│       {nickname} さん、これで              │
│       homegohan を使いこなせます           │
│                                      │
│       ┌──────────────────┐              │
│       │ [tutorial badge] │              │ ← 80×80 バッジアイコン
│       │  使い方マスター   │              │
│       └──────────────────┘              │
│                                      │
│        ┌────────────────┐               │
│        │   ホームへ     │               │ ← primary button
│        └────────────────┘               │
│                                      │
└──────────────────────────────────────┘
   背景: rgba(0,0,0,0.6) + 紙吹雪パーティクル
   モーダル本体: 白 (light) / gray-900 (dark)
```

### 2.2 寸法表

| 要素 | width | height | offset |
|---|---|---|---|
| 紙吹雪コンテナ | 100% | 100% | 全画面 (背面) |
| 🎓 アイコン | 80px | 80px | 上から 22% |
| title | max 320px | auto | margin-top: 24px |
| subtitle | max 280px | auto | margin-top: 12px |
| バッジカード | max 240px | 120px | margin-top: 32px |
| バッジアイコン | 64px | 64px | カード上部中央 |
| バッジラベル | auto | auto | margin-top: 8px (アイコン下) |
| 【ホームへ】 | 80% (max 320px) | 56px | margin-top: 32px |

---

## 3. サブステップ詳細

### 3.1 サブステップ表

| sub | 表示 | testID | 進行 |
|---|---|---|---|
| 4.0 | バッジ付与中 spinner (内部処理) | `tour-step-4-saving` | API 完了 (~500ms) |
| 4.1 | 卒業画面表示 + 🎓 アニメ + 紙吹雪 | `tour-step-4-graduate` | 5s 後 4.2 へ自動 |
| 4.2 | 【ホームへ】活性化 | `tour-step-4-go-home` | タップ |
| 4.3 | /home へ遷移 + welcome toast | `tour-step-5-toast` | toast 4s |

### 3.2 サブステップ 4.0: バッジ付与中

#### 内容
画面マウント直後 (100ms 後) に `POST /api/handson-tour/complete` を呼ぶ。レスポンス受信前は spinner 表示。

```
┌────────────────────────────────────┐
│                                    │
│          [スピナー]                  │
│       完了処理中...                   │
│                                    │
└────────────────────────────────────┘
```

#### サーバー処理

```sql
BEGIN;

-- profile UPDATE
UPDATE user_profiles
SET handson_tour_completed_at = COALESCE(handson_tour_completed_at, now())
WHERE user_id = $1
RETURNING handson_tour_completed_at;

-- badge INSERT (冪等)
INSERT INTO user_badges (user_id, badge_id, obtained_at)
SELECT $1, b.id, now() FROM badges b WHERE b.code = 'tutorial_complete'
ON CONFLICT (user_id, badge_id) DO NOTHING;

-- 結果取得
SELECT b.code, b.name, ub.obtained_at, b.icon_url
FROM user_badges ub JOIN badges b ON b.id = ub.badge_id
WHERE ub.user_id = $1 AND b.code = 'tutorial_complete';

COMMIT;
```

#### レスポンス

```ts
type CompleteResponse = {
  completed_at: string;  // ISO8601
  badge_awarded: {
    code: 'tutorial_complete';
    name: '使い方マスター';
    obtained_at: string;
    icon_url: string | null;
  };
  already_completed: boolean;  // force=1 再実行時 true
};
```

### 3.3 サブステップ 4.1: 卒業画面表示

#### 内容
API 成功後、4.0 spinner を fade out して卒業画面を表示。同時に:
- 🎓 アイコン: scale 0.5 → 1.0 spring animation 600ms
- 紙吹雪: 300 paritcle で 3 秒間ループ表示
- title / subtitle / バッジカード / 【ホームへ】を順次 fade in (delay 200ms ずつ)

#### 紙吹雪仕様
- web: `react-confetti` を採用
  - props: `numberOfPieces={300}`, `recycle={false}`, `tweenDuration={3000}`
- mobile: `react-native-reanimated` で自前実装
  - 300 paritcle、各 particle は random 色 (primary palette + accent) + random 速度 + 3 秒で fade out

#### バッジカード
- API レスポンスの `badge_awarded.icon_url` を優先表示
- icon_url が NULL なら 🎓 絵文字フォールバック (§99 残不確実性)

### 3.4 サブステップ 4.2: 【ホームへ】活性化

#### 内容
- 5 秒間アニメ後に【ホームへ】ボタンが活性化 (それまでは disabled で半透明、tap 不可)
- 5 秒待たずに【ホームへ】タップしたい場合のスキップ動線:
  - 5 秒経過前に画面のどこかをタップ → アニメをスキップして即【ホームへ】活性化
  - これによりせっかちなユーザーへの配慮

#### タップ動作
- `/home` へ遷移 (`router.replace('/home')`)
- Step 5 サブステップ 5.0 (welcome toast) に進む

### 3.5 サブステップ 4.3: welcome toast (Step 5 連携)

#### 内容
/home マウント直後にトースト表示:

```
┌─────────────────────────────────────┐
│ これからは自分のペースで              │
│ 使ってね、{nickname} さん             │
└─────────────────────────────────────┘
```

#### 仕様
- 画面下部に bottom: 80px (タブバー上) で表示
- 4 秒後に自動 dismiss
- タップで即時 dismiss
- 既存トースト UI コンポーネントを流用 (cross/03-design-system §toast)

#### 文言

| key | 文言 |
|---|---|
| `welcome_toast` | "これからは自分のペースで使ってね、{nickname} さん" |

---

## 4. エラー画面 (4.0 失敗時)

```
┌────────────────────────────────────┐
│   ⚠ 電波が悪いみたい                  │
│      少し待ってからもう一度              │
│                                    │
│   [   もう一度   ]                    │
│   [   あとで    ]                    │
└────────────────────────────────────┘
```

### 4.1 エラー文言 (i18n key: `tour.step4.error_*`)

| key | 文言 |
|---|---|
| `error_title` | "電波が悪いみたい" |
| `error_subtitle` | "少し待ってからもう一度" |
| `retry_button` | "もう一度" |
| `error_later_button` | "あとで" |

### 4.2 リトライロジック
- 【もう一度】タップで再度 4.0 サブステップを実行
- 連続 3 回失敗で【あとで】を強調表示
- 3 回失敗後にも【もう一度】押し続けたい場合は許可 (rate limit にかかるまで)

### 4.3 【あとで】タップ動作
- `POST /api/handson-tour/skip { step: 4, reason: 'user_action' }`
- /home へ遷移
- ※ 卒業 API 失敗 → 完了登録なし → tutorial_complete バッジは未付与のまま
- 後日 /settings から再開できるが、`force=1` で再実行時に【ホームへ】タップで再 attempts

---

## 5. force=1 再実行時の挙動

### 5.1 複数回卒業した場合
- 1 回目: completed_at セット + tutorial_complete INSERT (新規)
- 2 回目以降 (force=1): completed_at は更新せず (= COALESCE で既存値維持)、user_badges は ON CONFLICT DO NOTHING でスキップ
- レスポンス: `already_completed: true` を返す

### 5.2 UI 上の差分
- 2 回目以降の【ホームへ】活性化は通常通り
- 紙吹雪 + 🎓 アニメは普通に再生 (= 体験してほしいため)
- バッジカード表示は同じ
- ただし welcome toast は **表示しない** (= 既に通常モードのユーザー)

```ts
const [showWelcomeToast, setShowWelcomeToast] = useState(false);
// API レスポンスから判定
if (!response.already_completed) {
  setShowWelcomeToast(true);
}
```

---

## 6. アニメーション

### 6.1 entrance (4.1 表示時)

```
0ms      : 4.0 spinner fade out (200ms)
200ms    : モーダル fade-in (300ms)
500ms    : 🎓 アイコン scale 0.5→1.0 (600ms spring, damping 10, stiffness 100)
500ms    : 紙吹雪 開始 (3000ms ループ)
700ms    : title fade-in (200ms)
900ms    : subtitle fade-in (200ms)
1100ms   : バッジカード fade-in + scale 0.9→1.0 (300ms ease-out)
1400ms   : 【ホームへ】fade-in (200ms、disabled 状態で表示)
1600ms-5000ms : 5 秒タイマー (= 4.2 の活性化)
5000ms   : 【ホームへ】activate
```

### 6.2 タップでスキップ
```ts
const handleScreenTap = (e: GestureEvent) => {
  if (Date.now() - mountTime.current < 5000) {
    setIsButtonActive(true);  // 即活性化
  }
};
```

### 6.3 reduce-motion
- 紙吹雪 → 表示しない
- 🎓 spring → 即時 1.0
- すべての fade を 0ms

---

## 7. バッジカードの表示仕様

### 7.1 構造

```tsx
<div className="badge-card" data-testid="tour-step-4-badge-card">
  <img src={badge_awarded.icon_url ?? FALLBACK_GRADUATION_ICON} alt={badge_awarded.name} />
  <span className="badge-label">{badge_awarded.name}</span>
</div>
```

### 7.2 アニメーション
- entrance: scale 0.9 → 1.0 + opacity 0 → 1 (300ms ease-out, delay 1100ms)
- 取得直後の glow effect (任意): box-shadow 拡張アニメーション 1 秒、薄い黄色の glow

### 7.3 アクセシビリティ
- `aria-label` = "{badge.name} バッジを獲得しました"
- VoiceOver アナウンス: "使い方マスター バッジを獲得しました"

---

## 8. testID 一覧

| testID | プラットフォーム | 用途 |
|---|---|---|
| `tour-step-4-saving` | both | 4.0 spinner |
| `tour-step-4-graduate` | both | 4.1 graduation modal |
| `tour-step-4-icon` | both | 🎓 アイコン |
| `tour-step-4-title` | both | "卒業おめでとう!" |
| `tour-step-4-subtitle` | both | "{nickname} さん..." |
| `tour-step-4-badge-card` | both | バッジカード |
| `tour-step-4-badge-icon` | both | バッジアイコン img |
| `tour-step-4-badge-label` | both | バッジラベル |
| `tour-step-4-go-home` | both | 【ホームへ】 |
| `tour-step-4-error` | both | エラー画面 |
| `tour-step-4-retry` | both | エラー時【もう一度】 |
| `tour-step-4-error-skip` | both | エラー時【あとで】 |
| `tour-step-5-toast` | both | welcome toast (Step 5) |

---

## 9. Analytics events (Step 4)

| event | timing | properties |
|---|---|---|
| `handson_tour_step_viewed` | 4.0 マウント | `{ step: 4, platform }` |
| `handson_tour_completed` | 4.1 API success | `{ total_duration_ms, step_skipped_count: 0, platform }` |
| `handson_tour_step_completed` | 4.2 【ホームへ】タップ | `{ step: 4, dwell_ms }` |
| `handson_tour_step_error` | 4.0 失敗 | `{ step: 4, error_code, error_message }` |
| `handson_tour_skipped` | エラー画面【あとで】 | `{ step: 4, reason: 'user_action' }` |

`total_duration_ms` の計算:
```ts
const tourStartTime = sessionStorage.getItem('tourStartTimestamp');  // Step 0【はじめる】タップ時に保存
const totalDurationMs = Date.now() - parseInt(tourStartTime ?? '0', 10);
```

---

## 10. 状態管理

### 10.1 ローカル state

```ts
type Step4State = {
  subStep: '4.0' | '4.1' | '4.2' | 'error';
  completedAt: string | null;
  badgeAwarded: BadgeAward | null;
  alreadyCompleted: boolean;
  isButtonActive: boolean;  // 5 秒タイマー or タップで activate
  errorCount: number;
  errorPayload: ErrorPayload | null;
  mountTime: number;
};
```

### 10.2 マウント時の API 呼び出し

```ts
useEffect(() => {
  const timer = setTimeout(async () => {
    try {
      const res = await fetch('/api/handson-tour/complete', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error(`status_${res.status}`);
      const data = await res.json();
      setCompletedAt(data.completed_at);
      setBadgeAwarded(data.badge_awarded);
      setAlreadyCompleted(data.already_completed);
      setSubStep('4.1');

      // analytics
      const tourStartTimestamp = parseInt(sessionStorage.getItem('tourStartTimestamp') ?? '0', 10);
      fireAnalytics('handson_tour_completed', {
        total_duration_ms: Date.now() - tourStartTimestamp,
        step_skipped_count: 0,
        platform,
      });
    } catch (err) {
      setError(err);
      setSubStep('error');
      fireAnalytics('handson_tour_step_error', { step: 4, error_code: err.message });
    }
  }, 100);  // mount 直後の visual flash 回避

  return () => clearTimeout(timer);
}, []);
```

### 10.3 5 秒タイマー (button 活性化)

```ts
useEffect(() => {
  if (subStep === '4.1') {
    const timer = setTimeout(() => setIsButtonActive(true), 5000);
    return () => clearTimeout(timer);
  }
}, [subStep]);
```

---

## 11. テストケース

### 11.1 Unit
- API 成功 → 4.0 → 4.1 進行
- API 失敗 → エラー画面表示
- リトライ動作
- 5 秒タイマーで【ホームへ】活性化
- 画面タップで即活性化
- already_completed=true 時は welcome toast 抑制
- バッジ icon_url NULL 時のフォールバック表示

### 11.2 E2E (Maestro)

```yaml
# 08-step4-graduation.yaml
appId: com.homegohan.app
---
- runFlow: 07-step3-badges.yaml  # Step 1+2+3 完走
- assertVisible: { id: tour-step-4-saving }
- waitForAnimationToEnd: { timeout: 3000 }
- assertVisible: { id: tour-step-4-graduate }
- assertVisible:
    id: tour-step-4-title
    text: "卒業おめでとう"
- # 5 秒待つ
- waitForAnimationToEnd: { timeout: 6000 }
- # 【ホームへ】が活性化
- tapOn: { id: tour-step-4-go-home }
- assertVisible: { id: home-condition-section }
- # welcome toast 表示
- assertVisible:
    id: tour-step-5-toast
    text: ".+さん"
- waitForAnimationToEnd: { timeout: 5000 }
- assertNotVisible: { id: tour-step-5-toast }
```

```yaml
# 09-step4-graduation-retry.yaml
appId: com.homegohan.app
env:
  HANDSON_COMPLETE_API_FAIL_ONCE: 'true'
---
- runFlow: 07-step3-badges.yaml
- assertVisible: { id: tour-step-4-error }
- tapOn: { id: tour-step-4-retry }
- assertVisible: { id: tour-step-4-graduate }
- # 以降 hapy path
```

```yaml
# 10-step4-force-replay.yaml
appId: com.homegohan.app
---
- runFlow: ../_shared/login-as-tour-completed-user.yaml
- tapOn: { id: settings-tab }
- tapOn: { id: settings-replay-handson-tour }
- # ハンズオン全工程やり直し
- # ... Step 0 から 4 まで自動進行
- assertVisible: { id: tour-step-4-graduate }
- # already_completed=true なので welcome toast は出ない
- tapOn: { id: tour-step-4-go-home }
- waitForAnimationToEnd: { timeout: 5000 }
- assertNotVisible: { id: tour-step-5-toast }
```

### 11.3 Integration
- API 呼び出しで user_profiles.handson_tour_completed_at がセット
- user_badges に tutorial_complete が追加される
- 同じユーザーで 2 回目呼び出しは already_completed=true、user_badges は重複しない
- skip API 呼び出しで handson_tour_skipped_at がセット (handson_tour_completed_at は変更しない)

---

## 12. 残不確実性 (§99 連携)

- [ ] `tutorial_complete` バッジのアイコン (icon_url で URL 配信か、絵文字 🎓 をフォールバック使用するか)
- [ ] 紙吹雪パーティクル数 300 で web/mobile 両方 60fps 維持できるか
- [ ] 5 秒待ち時間は適切か (短すぎ = 体験不足、長すぎ = 退屈)
- [ ] バッジカードの glow effect (黄色) は派手すぎないか
- [ ] welcome toast 4 秒は適切か
- [ ] `total_duration_ms` の sessionStorage 保存タイミング (Step 0 で保存、Step 4 で参照、storage 失敗時の fallback)
- [ ] force=1 で 2 回目卒業時、紙吹雪 + 🎓 アニメをスキップする選択肢を出すか
