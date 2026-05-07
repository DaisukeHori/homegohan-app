# 15 — デザイン仕様 (色・タイポグラフィ・寸法・アニメーション)

> 関連: [02-step0-welcome](./02-step0-welcome.md) / [07-components](./07-components.md) / cross/03-design-system.md (canonical)

---

## 1. デザイントークン全体

cross/03-design-system.md (canonical) に追記する Coachmark 関連トークンの **proposal**。本ファイルは具体値を集約。

---

## 2. カラートークン

### 2.1 ライトモード

| トークン名 | 値 | 用途 |
|---|---|---|
| `colors.tour.dim` | `rgba(0, 0, 0, 0.6)` | overlay 背景 (default opacity) |
| `colors.tour.bubble.bg` | `#FFFFFF` | 吹き出し背景 |
| `colors.tour.bubble.text` | `#111827` (gray-900) | 吹き出し本文 |
| `colors.tour.bubble.title` | `#111827` (gray-900) | 吹き出しタイトル |
| `colors.tour.bubble.shadow` | `0 8px 16px rgba(0,0,0,0.12)` | 吹き出し影 |
| `colors.tour.bubble.arrow` | `#FFFFFF` | 吹き出し矢印 |
| `colors.tour.spotlight.border` | `#3B82F6` (primary-500) | spotlight 縁取り |
| `colors.tour.progress.active` | `#2563EB` (primary-600) | 進捗ドット active |
| `colors.tour.progress.inactive` | `#D1D5DB` (gray-300) | 進捗ドット inactive |
| `colors.tour.button.primary.bg` | `#2563EB` (primary-600) | primary ボタン背景 |
| `colors.tour.button.primary.text` | `#FFFFFF` | primary ボタン文字 |
| `colors.tour.button.primary.hover` | `#1D4ED8` (primary-700) | primary ボタン hover |
| `colors.tour.button.primary.disabled` | `#93C5FD` (primary-300) | primary ボタン disabled |
| `colors.tour.button.text.color` | `#4B5563` (gray-600) | text ボタン文字 |
| `colors.tour.welcome.background` | `#FFFFFF` | Step 0 / Step 4 モーダル背景 |
| `colors.tour.error.background` | `#FEF2F2` (red-50) | エラー画面背景 |
| `colors.tour.error.icon` | `#DC2626` (red-600) | エラーアイコン |
| `colors.tour.error.text` | `#991B1B` (red-800) | エラー文字 |
| `colors.tour.confetti.palette` | `['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6']` | 紙吹雪パーティクル色 |

### 2.2 ダークモード

`prefers-color-scheme: dark` (web) / `Appearance.getColorScheme() === 'dark'` (mobile) で自動切替。

| トークン名 | 値 |
|---|---|
| `colors.tour.dim` | `rgba(0, 0, 0, 0.7)` (より暗く) |
| `colors.tour.bubble.bg` | `#1F2937` (gray-800) |
| `colors.tour.bubble.text` | `#F9FAFB` (gray-50) |
| `colors.tour.bubble.title` | `#F9FAFB` (gray-50) |
| `colors.tour.bubble.shadow` | `0 8px 16px rgba(0,0,0,0.3)` |
| `colors.tour.bubble.arrow` | `#1F2937` (gray-800) |
| `colors.tour.spotlight.border` | `#60A5FA` (primary-400, 明るく) |
| `colors.tour.progress.active` | `#60A5FA` (primary-400) |
| `colors.tour.progress.inactive` | `#4B5563` (gray-600) |
| `colors.tour.button.primary.bg` | `#3B82F6` (primary-500) |
| `colors.tour.button.primary.text` | `#FFFFFF` |
| `colors.tour.button.text.color` | `#9CA3AF` (gray-400) |
| `colors.tour.welcome.background` | `#1F2937` (gray-800) |
| `colors.tour.error.background` | `#7F1D1D` (red-900) |
| `colors.tour.error.icon` | `#FECACA` (red-200) |
| `colors.tour.error.text` | `#FECACA` (red-200) |

### 2.3 コントラスト確認

§10-a11y.md §6 の通り、全色組み合わせで WCAG AA 以上を達成。

---

## 3. タイポグラフィ

### 3.1 フォントファミリー

cross/03 既存:
- 日本語: 'Noto Sans JP', sans-serif
- 英語/数字: 'Inter', 'Helvetica Neue', sans-serif

ハンズオン専用フォントは追加なし。

### 3.2 サイズ表

| 用途 | size | weight | line-height | font-family |
|---|---|---|---|---|
| Step 0 / Step 4 タイトル | 24sp / 1.5rem | 700 (bold) | 1.3 | Noto Sans JP |
| Step 0 / Step 4 サブタイトル | 16sp / 1rem | 400 (regular) | 1.5 | Noto Sans JP |
| 吹き出しタイトル | 16sp / 1rem | 600 (semibold) | 1.3 | Noto Sans JP |
| 吹き出し本文 | 14sp / 0.875rem | 500 (medium) | 1.4 | Noto Sans JP |
| 吹き出しヒント ("タップで進む") | 12sp / 0.75rem | 400 (regular) | 1.4 | Noto Sans JP |
| ボタン (primary) | 16sp / 1rem | 600 (semibold) | 1 | Noto Sans JP |
| ボタン (text) | 14sp / 0.875rem | 500 (medium) | 1 | Noto Sans JP |
| 進捗 a11y label (sr only) | (visually hidden) | - | - | - |
| エラータイトル | 18sp / 1.125rem | 600 (semibold) | 1.3 | Noto Sans JP |

### 3.3 Dynamic Type 対応

iOS Dynamic Type / Android Font scale で 0.85x ~ 2.85x まで自動調整。
`allowFontScaling` (RN) / `rem` ベース (web) で実現。

---

## 4. 寸法・余白

### 4.1 Spotlight

| 項目 | 値 |
|---|---|
| Spotlight padding | 8px |
| Spotlight 縁取り 太さ | 2px |
| Spotlight 縁取り 角丸 | 12px (target が button なら 8px、card なら 12px) |
| Spotlight 周囲のフェード幅 | 4px (mask 境界の anti-aliasing) |

### 4.2 吹き出し

| 項目 | 値 |
|---|---|
| 吹き出し最大幅 | 280px |
| 吹き出し最小幅 | 240px (短文時) |
| 吹き出し内側 padding | 16px (上下左右) |
| 吹き出し角丸 | 12px |
| target との距離 (offset) | 12px |
| 矢印サイズ | 8px (border-width) |
| タイトルと本文の間隔 | 8px |
| 本文と進捗ドットの間隔 | 12px |
| 進捗ドットとボタンの間隔 | 16px |

### 4.3 進捗ドット

| 項目 | 値 |
|---|---|
| ドットサイズ | 8px |
| ドット間隔 | 8px |
| 進捗ドット total height | 24px (上下 padding 8px + ドット 8px) |

### 4.4 ボタン

| 項目 | 値 |
|---|---|
| primary ボタン高さ | 56px (Step 0/4 のメインボタン) / 44px (吹き出し内) |
| primary ボタン padding | 12px 24px |
| primary ボタン角丸 | 12px |
| text ボタン高さ | 44px (a11y 最小) |
| text ボタン padding | 12px 24px |
| ボタン文字との隙間 | 0 |
| ボタンの最小タップ領域 | 44×44pt (Apple HIG) |

### 4.5 Step 0 / Step 4 全画面モーダル

| 項目 | 値 (mobile) | 値 (web > 768px) |
|---|---|---|
| モーダル max-width | 100% | 480px |
| モーダル max-height | 100% | 80vh |
| アイコン (アプリアイコン / 🎓) | 96×96 (Step 0) / 80×80 (Step 4) | 同上 |
| アイコンの位置 | 上から 25% (Step 0) / 上から 22% (Step 4) | 同上 |
| title margin-top | 32px (アイコン下) | 同上 |
| subtitle margin-top | 12-16px | 同上 |
| ボタン margin-top | 32-40px | 同上 |

---

## 5. アニメーション

### 5.1 entrance / exit

| 動き | duration | easing | プラットフォーム |
|---|---|---|---|
| Overlay fade-in | 200ms | ease-out | Web (Framer Motion) / Mobile (Reanimated `Easing.out(Easing.ease)`) |
| Overlay fade-out | 200ms | ease-in | 同上 |
| Spotlight 移動 (target 切替) | 250ms | ease-in-out | 同上 |
| Spotlight scale (要素 size 変化) | 250ms | ease-in-out | 同上 |
| 吹き出し fade-in | 150ms (delay 100ms) | ease-out | 同上 |
| 吹き出し fade-out | 150ms | ease-in | 同上 |
| 進捗ドット切替 | 200ms | ease-out (color のみ) | 同上 |
| Step 0 モーダル scale (entrance) | 300ms (0.95→1.0) | ease-out | Framer Motion / Reanimated spring |
| Step 4 モーダル scale | 300ms | ease-out | 同上 |
| Step 4 🎓 アイコン scale (entrance) | 600ms (0.5→1.0) | spring (damping 10, stiffness 100) | Framer / Reanimated.withSpring |
| Step 4 紙吹雪 | 3000ms (loop) | linear (各 paritcle) | react-confetti / Reanimated 自前 |
| Step 4 バッジカード scale | 300ms (0.9→1.0) (delay 1100ms) | ease-out | Framer / Reanimated |
| Step 4 バッジ glow | 1000ms (一回) | ease-out | Framer / Reanimated |
| ローディングスピナー | 800ms (連続回転) | linear | OS 標準 |
| エラーアイコン pulse | 1000ms (loop) | ease-in-out | Framer / Reanimated |
| Toast (Step 5) entrance | 250ms (slide up) | ease-out | 同上 |
| Toast exit | 250ms (slide down) | ease-in | 同上 |

### 5.2 reduce-motion 時の簡略化

§10 §7 の通り、すべて 0ms (instant) に置換、紙吹雪と spring は無効化。

### 5.3 アニメーション設計原則

1. **意味のあるアニメーション**: 装飾でなく、ユーザーの注意を誘導 (Spotlight 移動、entrance / exit)
2. **70-80% は ease-out**: ユーザー操作に応答する動きは ease-out
3. **同時アニメーションは 3 つまで**: 複雑にしない
4. **delay は 100ms 単位**: 階層感を出す
5. **ease-in-out は遷移系のみ**: spotlight 移動など

---

## 6. レスポンシブ・ブレークポイント

### 6.1 ブレークポイント

| 名前 | 範囲 | 主な対応 |
|---|---|---|
| sm | < 640px | スマホ縦 |
| md | 640px - 768px | スマホ横、小タブレット |
| lg | 768px - 1024px | タブレット |
| xl | > 1024px | デスクトップ |

### 6.2 ブレークポイントごとのレイアウト

| 要素 | sm (< 640px) | md/lg (640px-1024px) | xl (> 1024px) |
|---|---|---|---|
| Step 0/4 モーダル | 100% width, 100% height | 480px width, 80vh max | 480px width |
| 吹き出し max-width | 280px | 280px | 320px |
| ボタン高さ | 56px | 56px | 56px |
| アイコン | 96×96 (Step 0) / 80×80 (Step 4) | 同上 | 112×112 (Step 0) (大きく) |

### 6.3 ランドスケープ (mobile)

- Step 0/4 モーダルは縦スクロール可
- 吹き出しは横長になる場合あり (max-width 320px に拡張)
- Step 1-3 の sandbox 画面は既存 UI のレスポンシブに従う

---

## 7. アイコン

### 7.1 使用するアイコン (絵文字 or SVG)

| 用途 | アイコン | 形式 |
|---|---|---|
| Step 0 タイトル末尾 | 👋 (絵文字) | OS native |
| Step 1 intro | 📸 (絵文字) | OS native |
| Step 2 intro | 🤖 (絵文字) | OS native |
| Step 3 intro | 🎖️ (絵文字) | OS native |
| Step 4 タイトル | 🎉 (絵文字) | OS native |
| Step 4 卒業バッジ | 🎓 (絵文字) | OS native (フォールバック) |
| Step 4 卒業バッジ (将来) | カスタム SVG | リポ内 asset (要発注、§99) |
| エラー | ⚠ (絵文字) | OS native |

### 7.2 絵文字 vs カスタム SVG

v1 は絵文字で実装。理由:
- 開発スピード重視
- OS native rendering で 一貫性 (= ユーザーの慣れた見た目)
- bundle サイズ増えない

v2 でブランディング統一のため、カスタム SVG に置き換え検討。

### 7.3 アクセシビリティ

絵文字は VoiceOver で読み上げられるが、装飾的な場合は aria-hidden:

```tsx
<h1>{nickname} さん、ようこそ! <span aria-hidden="true">👋</span></h1>
```

---

## 8. ダークモード対応

### 8.1 検出方法

#### Web
```ts
const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
```

#### Mobile
```ts
import { useColorScheme } from 'react-native';
const colorScheme = useColorScheme();  // 'light' | 'dark' | null
```

### 8.2 トークン適用

CSS variables (web):

```css
:root {
  --tour-dim: rgba(0, 0, 0, 0.6);
  --tour-bubble-bg: #FFFFFF;
  /* ... */
}

@media (prefers-color-scheme: dark) {
  :root {
    --tour-dim: rgba(0, 0, 0, 0.7);
    --tour-bubble-bg: #1F2937;
    /* ... */
  }
}
```

mobile (Reanimated theming):

```ts
const tourColors = useMemo(() => ({
  dim: colorScheme === 'dark' ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.6)',
  bubble: { bg: colorScheme === 'dark' ? '#1F2937' : '#FFFFFF', /* ... */ },
}), [colorScheme]);
```

---

## 9. 共通コンポーネント連携

### 9.1 既存 cross/03-design-system のコンポーネント

ハンズオンで以下を再利用:
- `<Button>` (primary / text バリアント)
- `<Spinner>`
- `<Toast>`
- `<Modal>` (Step 0/4 のモーダルベース)

### 9.2 新規コンポーネント

cross/03 に追加するコンポーネント:
- `<Coachmark>` (= `<TourOverlay>`)
- `<TourBubble>` (= `<TourBubble>`)

§13-integration.md のとおり、Phase 1 で cross/03 への追記、Phase 2 で実装。

---

## 10. テスト

### 10.1 視覚回帰 (Storybook + Chromatic)
- 各コンポーネントの light / dark variant
- iPhone SE / iPhone 14 Pro / iPad Mini / Desktop の breakpoint
- 動的フォントサイズ Default / Accessibility 5
- reduce-motion off / on

### 10.2 単体
- token 値の単体テスト (色コード check)
- light / dark 切替で正しい token が適用されるか

---

## 11. 残不確実性 (§99 連携)

- [ ] cross/03-design-system の primary palette の確定値 (現状の推測値)
- [ ] tutorial_complete バッジの専用 SVG icon (絵文字フォールバックでスタートで OK か、Phase 1 で発注するか)
- [ ] ダークモード対応の手動 QA 計画 (実機 toggle で各画面確認)
- [ ] Dynamic Type AX5 (2.85x) で吹き出しがはみ出ないかの実機検証
- [ ] 紙吹雪パーティクル数 300 で 60fps 維持できるかの実機 (低スペック端末) 検証
