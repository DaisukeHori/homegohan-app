# Retrospective: middleware 配置ミス + Vercel CDN 未認証配信 (2026-04)

## 1. 概要

| 項目 | 内容 |
|------|------|
| 期間 | 2026-04-29 〜 2026-04-30 |
| 対象 | Vercel + Next.js 14 App Router + Supabase SSR + Auth middleware |
| 影響度 | **高** — 未認証ユーザーが認証必要ページの cached HTML を閲覧できる状態だった |
| 関連 Issue | #88 (bug-37) |

2026-04 の bug-fix 大量並列処理セッションで、認証保護に関する **重大なセキュリティ系 root cause が 2 つ** 発見された。
どちらも単独では気づきにくく、組み合わさることで「ログインしていないユーザーが保護ページを閲覧できる」という深刻な状態を生んでいた。

---

## 2. Root Cause 1: middleware.ts の配置ミス

### 問題

`middleware.ts` が repository root 直下 (`/middleware.ts`) に配置されていた。

### 症状

`next build` 後の `.next/server/middleware-manifest.json` が以下の状態だった:

```json
{ "middleware": {} }
```

このため Next.js が middleware を **認識せず実行しない** — `/home` や `/health` などの保護ルートへのリクエストが認証チェックをすり抜けた。

### 原因

`src/app/` ディレクトリ構成を採用したプロジェクトでは、Next.js の middleware 検出パスは `src/middleware.ts` になる。
root 直下の `middleware.ts` はビルド時に無視される。

### 対応

`middleware.ts` → `src/middleware.ts` へ移動。

**commit:** `be83073` (2026-04-30 09:23 +0700)
```
fix(security): middleware.ts を src/middleware.ts に移動 —
Next.js が App Router src/ 構成で検出できる正しい位置に修正
```

### 再発防止

`src/app/` を採用しているプロジェクトでは middleware は **必ず `src/` 直下** に置く。
CI で `middleware-manifest.json` の中身を検証するスクリプトを追加すること (後述 Action Items 参照)。

---

## 3. Root Cause 2: Vercel CDN による未認証 HTML 配信

### 問題

middleware が (配置修正後に) 動作していても、Vercel CDN が認証保護ページの pre-rendered static HTML を
`x-vercel-cache: HIT` で配信し続けていた。
CDN HIT のレスポンスは Edge middleware を **経由しない** ため、認証チェックがバイパスされる。

### 影響範囲

以下の保護ルートが対象:

- `/home`
- `/health`
- `/menus/weekly`
- `/profile`
- `/settings`

### 対応

2 段階で対処した。

#### 対応 1: Cache-Control ヘッダーを middleware で付与

middleware で `!isPublicPath` のレスポンスに以下のヘッダーを設定。

```
Cache-Control: private, no-store, max-age=0, must-revalidate
```

**commit:** `865e397` / `b28491d` (2026-04-30 09:00 +0700)
```
fix(security): 認証保護ルートを CDN キャッシュさせない (Closes #88 part 2)
```

#### 対応 2: (main) セグメントを force-dynamic に変更

`(main)/layout.tsx` を server wrapper として再構成し、以下を設定。

```ts
export const dynamic = 'force-dynamic'
export const revalidate = 0
```

client component 部分は `MainLayout.tsx` にリネームして分離した。
これにより `(main)/*` 全保護ルートが毎リクエスト middleware を経由するようになった。

**commit:** `77da068` (2026-04-30 09:08 +0700)
```
fix(security): (main) セグメントを force-dynamic にし Vercel CDN による未認証 HTML 配信を防止
```

---

## 4. なぜ Phase 1 で見逃したか

| フェーズ | テスト観点 | カバーできなかったこと |
|---------|-----------|----------------------|
| Phase 1 (機能テスト) | ログイン済み状態での操作確認に集中 | **未認証ユーザー視点のテストが不足** |
| Phase 2 (探索テスト) | 既知バグの再現と修正確認 | middleware の配置検証はスコープ外 |
| Round 4〜5 | E2E 実行中に「未認証で /home が表示される」という挙動を発見 | ここで初めて root cause に到達 |

根本的な見落としは「ログインしていない状態でリダイレクトが起きるか」という **happy path の逆方向テスト** が必須化されていなかったことにある。

また `middleware-manifest.json` が空であるという事実は `next build` ログを注意深く確認しなければ気づきにくく、
CLI / CI での自動検証が存在しなかったことも一因。

---

## 5. 教訓 / Action Items

- [ ] **Next.js App Router 採用時は `middleware-manifest.json` の中身を CI で検証するスクリプトを追加**
  - `jq '.middleware | length'` が 0 の場合はビルドを失敗させる
  - `src/app/` 構成では `src/middleware.ts` の存在もあわせてアサートする

- [ ] **Vercel デプロイ後の `x-vercel-cache: HIT` を認証保護ページで検出する E2E を追加**
  - `curl -I` で `x-vercel-cache` ヘッダーを確認し、`HIT` が返る場合はアラート

- [ ] **未認証ユーザー視点の E2E を bug-fixture と並列で必須化**
  - logged-out 状態で `/home`, `/health`, `/menus/weekly`, `/profile`, `/settings` にアクセス
  - すべて `/login` へ redirect されることを確認
  - 新規保護ルート追加時はこのリストに加えることをルール化

- [ ] **retrospective 内容を on-call runbook にも反映**
  - 「認証が効いていない疑い」トリアージ手順を runbook に追記
  - `middleware-manifest.json` 確認 → `x-vercel-cache` 確認 → `force-dynamic` 確認 の順序を明記

---

## 6. 関連 commit 一覧

| commit | 日時 | 概要 |
|--------|------|------|
| `0a74fab` | 2026-04-30 09:15 | `debug(mw)`: middleware が redirect を返さない件の原因究明用一時ログ追加 |
| `b28491d` | 2026-04-30 09:00 | `fix(security)`: 認証保護ルートへの Cache-Control: private, no-store 付与 (初回) |
| `865e397` | 2026-04-30 09:00 | `fix(security)`: 認証保護ルートへの Cache-Control: private, no-store 付与 (Closes #88 part 2) |
| `77da068` | 2026-04-30 09:08 | `fix(security)`: (main) セグメントを force-dynamic に変更し CDN 未認証配信を防止 |
| `be83073` | 2026-04-30 09:23 | `fix(security)`: middleware.ts を src/middleware.ts に移動 (根本修正) |
| `5c5b5f2` | 2026-04-30 09:33 | `fix(round3)`: 残5件失敗を最終解消 + middleware debug log 除去 |
