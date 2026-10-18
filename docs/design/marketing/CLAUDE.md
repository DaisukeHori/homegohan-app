# marketing/ 紹介ページ・公開ページの見た目 ドメイン 開発指針

未ログインの人向けの紹介ページ (`/`) と、公開ページの見た目の設計。要件の正本は Issue #1867 (サービスの本サイト (homegohan.com) を作り直す) の本文とコメント。

## ファイル一覧

| ファイル | 担当範囲 | 要件参照 |
|---------|--------|---------|
| `01-landing-site.md` | 紹介ページ (`/`) の設計: 構造・文言と公開の主張の表 (§4)・視覚と動きのトークン (§5・§6)・部品と facade 契約 (§8)・正典の範囲 (§9)・速さ (§10)・アクセシビリティ (§11)・検索 (§12)・表 3 点 (§13)・テスト一覧 (§16) | Issue #1867 |
| `prototype/index.html` | 静的な試作 (`01-landing-site.md` §23)。見た目の参考で、正典ではない | Issue #1867 |

実装の置き場所: 殻 `src/app/page.tsx` (メタ情報・viewport・構造化データだけ)・本体 `src/components/marketing/` (`LandingPage.tsx`・`sections/`・`primitives/`・`marketing.css`・`demo-state.ts`・`landing-copy.ts`)。

## 守ること

### 1. 文言の正本は `landing-copy.ts`
紹介ページの文言・画像・公開の主張・デモの見本は `src/components/marketing/landing-copy.ts` (`LANDING_COPY`) が正本。部品 (`.tsx`) に文言を直書きしない。

### 2. 主張は公開の主張の表の行だけ
機能・条件を言う文は、`01-landing-site.md` §4.1 の公開の主張の表 (`LANDING_COPY.claims`。各行が根拠の `evidence` (file:line の元のファイル) と `condition` を持つ) の行に当たるものだけを書く。表に無い主張は書かない。条件 (AI の 1 日の利用回数の上限・写真の記録の入口の違い・AI 機能の同意) を落とした言い方をしない (`01-landing-site.md` §2.5)。

### 3. 回数を約束する語を書かない
AI を使う機能には 1 日の利用回数の上限がある。`たびに`・`毎回`・`何度でも`・`無制限`・`使い放題` などの「書かない語」は `01-landing-site.md` §4.0 の表が正本で、`tests/landing-page-1867.test.ts` の U-20 (`LANDING_COPY`) と U-15 (`SITE_DESCRIPTION`) が確かめる。

### 4. 実績の数字を作らない
利用者数・評価・継続率・メディア掲載・利用者の声など、実績に見える数字や表示を作らない (利用者ゼロ)。`tests/public-claims-guard.test.ts` の `FORBIDDEN` が公開ページを見張る。

### 5. 絵文字を使わない
アイコンは `lucide-react` のみ (`cross/03-design-system.md` §16)。`landing-copy.ts` に絵文字が無いことを U-9 が確かめる。

### 6. 逐語の正典の範囲
`01-landing-site.md` §9 の表が範囲の正本。逐語で持つのは、見た目と振る舞いの決まり (デザインのトークン・部品の一覧と facade の名前とシグネチャ・受入の条件・文言と公開の主張の表とデモの見本・デモの状態機械の型と遷移表・`SITE_DESCRIPTION` と殻の export) まで。`marketing.css` の書き方とクラス名・各部品のコード・テストのコード・試作は逐語の正典にしない (受入の条件を満たすように実装が書く)。

### 7. CSP と全ページ動的の前提
全ページが動的に描画される (`src/app/layout.tsx:10` の `export const dynamic = 'force-dynamic'`)。CSP は nonce 方式で、外部 CDN のスクリプトは読めない (`cross/18-csp-nonce.md`・`src/lib/security/csp.ts`)。紹介ページも動的のままで、ライブラリは bundle に同梱し、フォントは `next/font` の自前配信、画像は `public/` に置く。紹介ページが書くインラインのスクリプトは構造化データ (`src/components/seo/SiteStructuredData.tsx`。nonce は `src/app/page.tsx` が `getCspNonce()` で読んで渡す) の 1 本だけで、`cross/18-csp-nonce.md` の許可リストに載っている。CSP は変えない (`01-landing-site.md` §2.4)。

### 8. 更新の頻度
紹介ページの更新は開発の流れで行い、頻度は月に数回まで (Issue #1867 のコメント 2026-10-18 の置き場所の比較)。
