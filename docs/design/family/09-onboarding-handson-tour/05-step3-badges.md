# 05 — Step 3: バッジ確認 詳細

> 関連: [04-step2-menu](./04-step2-menu.md) / [06-step4-graduation](./06-step4-graduation.md) / [07-components](./07-components.md) / [09-api-spec](./09-api-spec.md)

---

## 1. 役割

Step 3 は **「あなたはもう 2 つバッジを持っている」気づきと、報酬システムの存在認知** を提供する。Step 1/2 で実際に獲得済みの `first_bite` / `planner` バッジを表示し、Step 4 で得られる `tutorial_complete` を予告 (半透明)。

---

## 2. 既存 `/badges` 画面の活用

### 2.1 既存 UI 構造 (researcher 結果)
- パス: `src/app/(main)/badges/page.tsx`
- 取得 API: `GET /api/badges` (バッジマスター + 獲得済み判定)
- データ構造:
  ```ts
  type BadgeListResponse = {
    badges: Array<{
      code: string;
      name: string;
      description: string;
      icon_url: string | null;
      obtained_at: string | null;  // null = 未獲得
    }>;
  };
  ```
- 獲得時アニメーション: `AnimatePresence` でフルスクリーンオーバーレイ (🎊、5 秒)
- testID: `badge-card`, `badge-detail-modal`

### 2.2 既存バッジ 13 種 + 新規 1 種

§03 §3.10 で `first_bite` 付与、§04 §3.10 で `planner` 付与。Step 3 表示時には:

| code | 名前 | 状態 (新規ユーザーのハッピーパス) |
|---|---|---|
| `first_bite` | はじめての一歩 | 獲得済 ✅ |
| `streak_3` | 3 日連続 | 未獲得 |
| `streak_7` | 1 週間連続 | 未獲得 |
| `streak_30` | 30 日連続 | 未獲得 |
| `photo_10` | 写真 10 枚 | 未獲得 |
| `early_bird` | 朝食記録 | 未獲得 |
| `night_guard` | 夜食記録 | 未獲得 |
| `veggie_5` | 野菜 5 サーブ | 未獲得 |
| `protein_5` | タンパク質 5 サーブ | 未獲得 |
| `balance_king` | 栄養バランス | 未獲得 |
| `chef_soul` | シェフの魂 | 未獲得 |
| `rainbow` | 7 色の食事 | 未獲得 |
| `hello_ai` | AI と話す | 未獲得 |
| `planner` | 1 週間献立 | 獲得済 ✅ |
| `legend_100` | 100 日連続 | 未獲得 |
| `tutorial_complete` (新規) | 使い方マスター | 未獲得 (Step 4 で獲得) |

---

## 3. ハンズオン Step 3 のサブステップ

### 3.1 サブステップ表

| sub | 表示 | testID 起点 | 自動進行 | 手動進行 |
|---|---|---|---|---|
| 3.0 | バッジ取得中 spinner | `tour-step-3-loading` | API 完了 | なし |
| 3.1 | intro 吹き出し ("もう 2 つ獲得しています!") | `tour-step-3-intro` | 2.0s | タップ可 |
| 3.2 | first_bite カード Spotlight | `badge-card-first_bite` | なし | 【次へ】 |
| 3.3 | planner カード Spotlight | `badge-card-planner` | なし | 【次へ】 |
| 3.4 | tutorial_complete カード (半透明) Spotlight | `badge-card-tutorial_complete` | なし | 【次へ】 → Step 4 |

### 3.2 サブステップ 3.0: バッジ取得中

`/handson-tour/badges` page マウント時、`GET /api/badges` を呼ぶ。レスポンス受信前は spinner 表示。

```
┌────────────────────────────────────┐
│                                    │
│         [スピナー]                    │
│       バッジを確認中...                 │
│                                    │
└────────────────────────────────────┘
```

レスポンス受信後:
- `first_bite` と `planner` の `obtained_at` が NOT NULL であることを確認
- `tutorial_complete` の `obtained_at` が NULL であることを確認
- 確認 OK なら 3.1 へ
- 確認 NG (= 想定外、Step 1/2 で実 API 失敗があった etc) → エラー画面 (§3.6)

### 3.3 サブステップ 3.1: intro 吹き出し

#### 内容

```
┌────────────────────────────────────┐
│   🎖️ {nickname} さん                  │
│      もう 2 つ獲得しています!          │
│   タップで進む                          │
└────────────────────────────────────┘
```

#### 仕様
- §02 §3.2 と同形式、アイコン: 🎖️
- 自動進行: 2.0s 後 3.2 へ (canonical: §14 §5.1 `STEP3_INTRO_AUTO_MS = 2000`)
- 手動進行: タップで即時 3.2

#### 文言

| key | 文言 |
|---|---|
| `intro_title` | "{nickname} さん、もう 2 つ獲得しています!" |
| `intro_hint` | "タップで進む" |

### 3.4 サブステップ 3.2: first_bite カード Spotlight

#### 内容
バッジ一覧画面の `[badge-card-first_bite]` を Spotlight + 説明吹き出し。

#### 仕様
- Spotlight ターゲット: `badge-card-first_bite`
- カードはアニメーション onClick 等で展開しない (静的表示のみ)
- 吹き出し位置: target の下 (画面上部にカードあれば bottom)
- 吹き出し内容:
  - title: "はじめての一歩"
  - body: "写真から記録を 1 度しました"
  - 【次へ】ボタン
- 進捗ドット: ● ● ● ● ○ (Step 3 中、4 段目 active)

#### 文言

| key | 文言 |
|---|---|
| `first_bite_title` | "はじめての一歩" |
| `first_bite_bubble` | "写真から記録を 1 度しました" |
| `next_button` | "次へ" |

### 3.5 サブステップ 3.3: planner カード Spotlight

#### 内容
`[badge-card-planner]` を Spotlight + 説明。

#### 仕様
- §3.4 と同様、ターゲットだけ変更
- 吹き出し:
  - title: "プランナー"
  - body: "献立を 1 度作りました"

#### 文言

| key | 文言 |
|---|---|
| `planner_title` | "プランナー" |
| `planner_bubble` | "献立を 1 度作りました" |

### 3.6 サブステップ 3.4: tutorial_complete カード (半透明) Spotlight

#### 内容
未獲得の `[badge-card-tutorial_complete]` を半透明で表示し、Spotlight + "次の画面で受け取れます" 吹き出し。

#### 仕様
- カード自体は `opacity: 0.4` のグレースケール表示 (badges page 既存の未獲得バッジ表示と同じ視覚)
- 吹き出し:
  - title: "使い方マスター"
  - body: "次の画面で受け取れます"
  - 【次へ】ボタン
- 進捗ドット: ● ● ● ● ● (= Step 3 完了直前)

#### 文言

| key | 文言 |
|---|---|
| `tutorial_complete_title` | "使い方マスター" |
| `tutorial_complete_bubble` | "次の画面で受け取れます" |

#### 【次へ】タップ動作
- `/handson-tour/graduate` へ遷移
- `handson_tour_step_completed { step: 3, dwell_ms }` event

### 3.7 エラー画面 (3.0 失敗時 / 想定外状態)

`GET /api/badges` 失敗、または first_bite/planner 未獲得が判明した場合:

```
┌────────────────────────────────────┐
│   ⚠ バッジ情報を取得できませんでした    │
│                                    │
│   [   もう一度   ]                    │
│   [   あとで    ]                    │
└────────────────────────────────────┘
```

【もう一度】タップで API を再取得。3 回失敗で skip 推奨。

#### 想定外状態

| 状態 | 原因 | 対処 |
|---|---|---|
| `first_bite` 未獲得 | Step 1 で API 失敗かつ skip しなかった (= state inconsistent) | UI ではエラー表示せず Step 4 へ進む (skip して影響を最小化) |
| `planner` 未獲得 | 同上 (Step 2) | 同上 |
| `tutorial_complete` 既獲得 | force=1 再表示 + 過去完了済 | 通常表示 (= 半透明ではなく 普通表示)、吹き出しは "もう一度受け取れます" 等に変更 |

---

## 4. ハイブリッドサンドボックスのプロップ仕様

### 4.1 `<BadgesPage tutorialMode>` プロップ (URL クエリ経由)

```
/badges?tutorial-mode=1&highlight=first_bite,planner,tutorial_complete
```

- `tutorial-mode=1`: チュートリアルモード ON
  - サイドバー (web) / タブバー (mobile) は非表示
  - Spotlight overlay コンテナを mount
- `highlight={code1,code2,...}`: 強調するバッジ codes
  - 実装: コンマ区切り文字列を split
  - 順序通り Spotlight を当てる

### 4.2 内部 Hook

```ts
function useTutorialMode() {
  const params = useSearchParams();
  const tutorialMode = params.get('tutorial-mode') === '1';
  const highlight = params.get('highlight')?.split(',') ?? [];
  return { tutorialMode, highlight };
}
```

`<BadgesPage>` 内で `tutorialMode` が true なら通常 UI に加えて `<TourOverlay>` を重ねる。

---

## 5. mock データ

Step 3 は **実 API を呼ぶ** (案 B 採用、Step 1/2 で実獲得済のため一覧は実データで取得)。mock データは特になし。

ただし以下のシナリオ要素はクライアント側 mock:
- 獲得未獲得の状態判定: API レスポンス + UI で半透明 / 通常分岐
- アニメーション: ハンズオン中はバッジ獲得モーダル (既存の 🎊 5 秒モーダル) を **抑制** する
  - 理由: Step 1/2 で既獲得済なので、Step 3 表示時にモーダルがちょうど浮上したら UX が壊れる
  - 実装: `?tutorial-mode=1` のとき badges page の `AnimatePresence` モーダル発火条件を `obtained_at が直近 1 分以内 かつ tutorialMode==false` に絞る

---

## 6. 個人情報の利用 (Step 3)

| フィールド | 取得元 | 利用箇所 |
|---|---|---|
| `nickname` | profile | 3.1 intro 吹き出し |

その他: なし (各バッジカードはマスタデータのみ)。

---

## 7. アニメーション

### 7.1 サブステップ間トランジション

| from → to | 動き | duration |
|---|---|---|
| 3.0 → 3.1 (loading off + intro fade in) | crossfade | 200ms |
| 3.1 → 3.2 (intro fade out + Spotlight on first_bite) | crossfade | 200ms |
| 3.2 → 3.3 (Spotlight 移動 first_bite → planner) | spotlight 移動 + scroll | 300ms |
| 3.3 → 3.4 (Spotlight 移動 planner → tutorial_complete) | spotlight 移動 + scroll | 300ms |
| 3.4 → Step 4 (Spotlight off + page 遷移) | 全体 fade out | 200ms |

### 7.2 自動スクロール (バッジ一覧が長い場合)

- バッジ一覧は 14 種で 1 画面に収まらない可能性
- Spotlight 対象が画面外なら自動スクロール (smooth) で表示エリアにスクロール
- 実装:
  ```ts
  const scrollToTarget = (testId: string) => {
    const el = document.querySelector(`[data-testid="${testId}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  ```
- mobile: `ScrollView.scrollTo` 等

### 7.3 reduce-motion
- 全 fade を 0ms
- スクロールも `behavior: 'auto'` (instant)

---

## 8. testID 一覧

| testID | プラットフォーム | 用途 |
|---|---|---|
| `tour-step-3-loading` | both | 新規 |
| `tour-step-3-intro` | both | 新規 |
| `badge-card-first_bite` | web 既存 / mobile 要追加 | 既存パターン拡張 (badge code をキー化) |
| `badge-card-planner` | both 要追加 | 同上 |
| `badge-card-tutorial_complete` | both 要追加 | 新規バッジ |
| `tour-step-3-error` | both | 新規 |
| `tour-step-3-error-retry` | both | 新規 |
| `tour-step-3-error-skip` | both | 新規 |

`badge-card-{code}` パターンは既存 web の `data-testid="badge-card"` (= 1 個のみ) を **動的化** する変更が必要。

実装変更:
```tsx
// 既存 (推測)
<div data-testid="badge-card">

// 変更後
<div data-testid={`badge-card-${badge.code}`}>
```

mobile も同様。

---

## 9. Analytics events (Step 3)

| event | timing | properties |
|---|---|---|
| `handson_tour_step_viewed` | 3.0 マウント | `{ step: 3, platform }` |
| `handson_tour_step_completed` | 3.4 【次へ】タップ | `{ step: 3, dwell_ms }` |
| `handson_tour_step_error` | 3.0 失敗 | `{ step: 3, error_code, error_message }` |
| `handson_tour_skipped` | エラー画面【あとで】 | `{ step: 3, reason: 'user_action' }` |

---

## 10. 状態管理

### 10.1 ローカル state

```ts
type Step3State = {
  subStep: 'loading' | '3.1' | '3.2' | '3.3' | '3.4' | 'error';
  badges: BadgeListResponse['badges'] | null;
  errorCount: number;
  errorPayload: ErrorPayload | null;
  mountTime: number;
};
```

### 10.2 API 取得

```ts
useEffect(() => {
  (async () => {
    try {
      const res = await fetch('/api/badges').then(r => r.json());
      // sanity check
      const firstBite = res.badges.find(b => b.code === 'first_bite');
      const planner = res.badges.find(b => b.code === 'planner');
      const tutorial = res.badges.find(b => b.code === 'tutorial_complete');
      if (!firstBite?.obtained_at || !planner?.obtained_at) {
        // 想定外、ただしエラー画面は出さず Step 4 へ進む (silent skip)
        fireAnalytics('handson_tour_step_error', { step: 3, error_code: 'badges_not_obtained_silently' });
      }
      setBadges(res.badges);
      setSubStep('3.1');
    } catch (err) {
      setError(err);
      setSubStep('error');
    }
  })();
}, []);
```

### 10.3 自動進行

```ts
useEffect(() => {
  if (subStep === '3.1') {
    const timer = setTimeout(() => setSubStep('3.2'), HANDSON_TOUR_CONSTANTS.STEP3_INTRO_AUTO_MS);  // = 2000ms (§14 canonical)
    return () => clearTimeout(timer);
  }
}, [subStep]);
```

### 10.4 Spotlight 連動

```ts
const targetTestId = useMemo(() => {
  switch (subStep) {
    case '3.2': return 'badge-card-first_bite';
    case '3.3': return 'badge-card-planner';
    case '3.4': return 'badge-card-tutorial_complete';
    default: return null;
  }
}, [subStep]);
```

---

## 11. テストケース

### 11.1 Unit
- `<BadgesPage tutorialMode>` の挙動: アニメーションモーダル抑制
- 自動スクロール (Spotlight 対象が画面外なら scroll)
- silent skip (first_bite / planner 未獲得でも Step 4 へ進む)
- `tutorial_complete` 既獲得時の表示変化 (force=1 シナリオ)

### 11.2 E2E (Maestro)

```yaml
# 07-step3-badges.yaml
appId: com.homegohan.app
---
- runFlow: 05-step2-menu-success.yaml  # Step 1+2 完走
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
- assertVisible: { id: tour-step-4-graduate }
```

### 11.3 Integration
- `GET /api/badges` で first_bite / planner が `obtained_at` NOT NULL で返ってくる
- `tutorial_complete` が `obtained_at = null` で返ってくる
- tutorial-mode=1 のとき badge 獲得モーダルが起動しない

---

## 12. 残不確実性 (§99 連携)

- [ ] 既存 web の `data-testid="badge-card"` を `badge-card-{code}` に動的化する変更の影響範囲 (既存テスト fix 必要か)
- [ ] mobile 版 badges 画面の構造 (researcher で web 側のみ確認済、mobile 要調査)
- [ ] バッジ獲得時の AnimatePresence モーダルが Step 3 表示時に発火しないことを保証する条件 (Step 1/2 後すぐに Step 3 が来るので、5 秒ウィンドウとの重なり)
- [ ] tutorial_complete を半透明で見せる方法 (既存未獲得バッジ表示と同じ視覚で OK か、追加スタイル必要か)
- [ ] silent skip (badges 未獲得検出時) の妥当性 (UX 上見えないが状態 inconsistent、Sentry alert すべきか)
