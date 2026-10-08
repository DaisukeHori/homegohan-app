## 目的
Web版（Next.js）で実装済みの「ほめゴハン」を **React Native / Expo** でスマホアプリ化し、
**App Store / Google Play 公開（EAS Build/Submit）**まで到達する。
**最初のストア提出は iOS（App Store）のみ。Android（Google Play）は iOS の提出後に回す**（2026-10-08 オーナー判断）。

> **Status: 2026-10-08 update — 最初の提出は iOS のみ。提出前に片付けるブロッカーは「最初のストア提出は iOS のみ」の節、品質ゲートは「10パス検証」の節（WebView ハイブリッド向けに定義し直した）。**

> **Status: 2026-04-29 update — フェーズ 0〜3 および 5 はほぼ実装完了。残るはフェーズ 4 の実 EAS Build / Submit と Pass 1〜10 検証。**
>
> 詳細実装状況は本ファイル末尾の「実装スナップショット (2026-04-29)」セクション参照。本チェックリストの旧フォーマットは履歴として保持する。

---

## 方針（重要）
- **モノレポ**で進める（当面はWebはルート、`apps/mobile` を追加して動かす）
- 共有は **`packages/core` に段階的に切り出す**
- 端末に **秘密鍵を置かない**（OpenAI/Gemini/Service Roleなどはサーバ・Edge Functions側）
- 「まず日常導線」→「機能拡張」→「管理系」→「全機能完了」の順で進める
- **WebView ハイブリッド**: タブの主要画面は Web（Next.js）を WebView で表示し、ネイティブはタブ・認証・設定・カメラ・Push・ディープリンクに絞る（`docs/design/mobile/01-architecture.md`）
- **管理者（admin）の画面はモバイルに作らない**: 運営作業は Web に一本化する（2026-10-08 オーナー判断、#1122）。アプリの `(admin)` 画面と、その Maestro フロー（`flows/admin/`）は削除済み。admin / super_admin のユーザーも、ログイン後は他のユーザーと同じ振り分けになる。`(support)` と `(super-admin)` の画面も同じ方針にするかは未決定（オーナーに確認する）。なお `(org)` / `(support)` / `(super-admin)` へ移動する導線は、アプリ内に元々なく、深いリンクで直接開いたときだけ表示される

---

## 最初のストア提出は iOS のみ（2026-10-08 オーナー判断）

- 提出するのは **iOS（App Store）だけ**。Android（Google Play）は iOS の提出後に別途進める。
  - Android 側で残っているもの: Play Console のサービスアカウントキー（`apps/mobile/eas.json` の `serviceAccountKeyPath` が指す `secrets/google-play-service-account.json` はリポジトリに無く、配置を確認できていない）、FCM サーバーキー、Data Safety の入力、内部テストでの動作確認
- iOS の EAS 設定（`appleId` / `ascAppId` / `appleTeamId`）は `apps/mobile/eas.json` に入っている。実際の EAS Build / Submit はまだ実行していない
- 手順書は `docs/eas-build-submit-handoff-20260429.md`、TestFlight の実機確認は `docs/operations/mobile-smoke-test.md`、審査メモは `docs/operations/app-store-metadata.md`

### 提出前に片付けるブロッカー

次の 8 件を片付けてから、審査に出す。

| # | ブロッカー | 内容 | 追跡 |
|---|-----------|------|------|
| 1 | WebView 認証ブリッジのトークン漏洩 | access / refresh token が URL のクエリに載る。注入スクリプトが全オリジンで動く | #1036 / PR #1289（ワンタイム code 方式にして、WebView を自オリジンに固定する） |
| 2 | 孤立したネイティブ画面。ログアウト・アカウント削除の導線がない | アプリ内の UI から、ログアウト・アカウント削除・通知設定へ着けない。アカウント削除の導線は App Store 審査の必須要件（5.1.1(v)） | #1037 / PR #1079 |
| 3 | 認証・セッション・プッシュ通知の不具合 7 件 | Web 側ログアウトとのずれ、refresh token の競合、セッションの平文保存、Google ログインのコールバック破棄、push token の残存など | #1038 |
| 4 | 中優先の不具合のまとめ | 通知タップの遷移、WebView のエラー / オフライン UI、env の不整合、状態の復元など | #1049 |
| 5 | Sign in with Apple | Google ログインがあるため、App Store 審査（4.8）で Sign in with Apple も必要 | 作業計画 T43 |
| 6 | 公開のプライバシーポリシー URL | `/privacy` と `/terms` が未ログインだと `/login` に転送される。App Store Connect には誰でも開ける URL が要る | 作業計画 T04 / #1364 |
| 7 | AI 利用の同意 | 外国の AI 事業者へデータを送ることを説明し、同意を取る（App Store 審査 5.1.2）。**データの送信は止めない**（オーナー方針）。足すのは同意の取得だけ | 作業計画 T15 / T18 / #1154 |
| 8 | 公開レシピの通報機能 | 利用者が投稿した公開レシピを、ほかの人が見られる。通報の手段を付けるかは **オーナー判断待ち**（App Store 審査 1.2） | オーナー判断 |

#1036・#1037・#1038・#1049 と PR #1079 / #1289 は、モバイル協調リリース調整トラッカー #1115 でリリースの順序を合わせる。

---

## フェーズ0：基盤（モノレポ + Expo起動）
- [x] `apps/mobile` を追加（Expo + TypeScript）
- [x] `packages/core` を追加（共有型/共通utilsの器）
- [x] ルート `package.json` を **workspaces** 対応（npm想定）
- [x] Expo monorepo 向けの `metro.config.js` / `babel.config.js` 整備（`packages/*` を参照可能に）
- [x] EAS用設定（`apps/mobile/app.json`, `apps/mobile/eas.json`）
- [x] モバイル環境変数の整理（`EXPO_PUBLIC_*`）

---

## フェーズ1：認証・ナビゲーション（MVPの土台）
- [x] Supabase Auth（email/password）でログイン/サインアップ
- [x] セッション永続化（起動時に復元）
- [x] 画面構成（expo-router）
  - `(auth)`：login / signup
  - `(tabs)`：home / meals / menus / health / settings（まずはプレースホルダー可）

---

## フェーズ2：日常導線の実装（優先度高）
- [ ] ホーム：今日の献立/次の食事/簡易サマリ（※現状はプロフィール読込まで実装）
- [ ] 週間献立：一覧表示・編集（`planned_meals` / `meal_plan_days`）
- [ ] 食事記録：写真撮影/アップロード（Storage）＋AI解析（Edge Function）
- [ ] AI相談：チャット表示、アクション実行（献立変更・買い物追加など）

---

## フェーズ3：健康・買い物・冷蔵庫
- [ ] 健康記録（入力/一覧/簡易入力）
- [ ] グラフ/インサイト表示（既存API/Edge Functionと連携）
- [ ] 買い物リスト（CRUD/チェック）
- [ ] 冷蔵庫（CRUD/期限管理）＋冷蔵庫写真解析

---

## フェーズ4：ストア公開準備（EAS/審査対応）
- [ ] iOS/Android 識別子（bundleId/package）確定
- [ ] App Icon / Splash / 権限文言（カメラ/写真/通知）整備
- [ ] EAS Build（preview → production）
- [ ] EAS Submit（TestFlight / 内部テスト → 本番申請）
- [ ] プライバシーポリシー/利用規約/削除導線（審査要件）最終確認

---

## フェーズ5：完全移植（必要に応じて）
- [ ] レシピ機能（検索/いいね/コメント/コレクション）
- [ ] 比較・ランキング（セグメント）
- [ ] 家族機能
- [ ] 管理系（org/support/super-admin）をモバイルに実装（ロールに応じてUI/権限制御）。管理者（admin）は作らない（運営作業は Web に一本化。#1122）

---

## 機能/画面チェックリスト（Web → Mobile）
`src/app/**/page.tsx` の全ルートに対応する（到達可能な導線を用意する）。

> 旧チェックリスト（ネイティブへの全面移植が前提）。WebView ハイブリッドでは、Web の全ルートをタブ内の WebView で開けることを Pass 1 で確かめる。履歴として残す。

### 公開ページ
- [ ] `/`（LP）
- [ ] `/about`
- [ ] `/company`
- [ ] `/contact`
- [ ] `/faq`
- [ ] `/guide`
- [ ] `/legal`
- [ ] `/news`
- [ ] `/pricing`

### 認証
- [ ] `/login`
- [ ] `/signup`
- [ ] `/auth/forgot-password`
- [ ] `/auth/reset-password`
- [ ] `/auth/verify`

### オンボーディング
- [ ] `/onboarding`
- [ ] `/onboarding/complete`

### メイン（ログイン後）
- [ ] `/home`
- [ ] `/meals/new`
- [ ] `/meals/[id]`
- [ ] `/menus/weekly`
- [ ] `/menus/weekly/request`
- [ ] `/health`
- [ ] `/health/record`
- [ ] `/health/record/quick`
- [ ] `/health/graphs`
- [ ] `/health/insights`
- [ ] `/health/goals`
- [ ] `/health/challenges`
- [ ] `/health/settings`
- [ ] `/badges`
- [ ] `/comparison`
- [ ] `/profile`
- [ ] `/settings`
- [ ] `/terms`
- [ ] `/privacy`

### 組織（org）
- [ ] `/org/dashboard`
- [ ] `/org/challenges`
- [ ] `/org/departments`
- [ ] `/org/invites`
- [ ] `/org/members`
- [ ] `/org/settings`

### 管理者（admin）
モバイルには作らない（運営作業は Web に一本化する。2026-10-08 オーナー判断、#1122）。`/admin` 以下は Web だけで使う。

### スーパー管理（super-admin）
- [ ] `/super-admin`
- [ ] `/super-admin/admins`
- [ ] `/super-admin/database`
- [ ] `/super-admin/feature-flags`
- [ ] `/super-admin/settings`

### サポート（support）
- [ ] `/support`
- [ ] `/support/inquiries`
- [ ] `/support/users`

---

## 10パス検証（最低10周）— WebView ハイブリッド向けに定義し直した（2026-10-08）

旧定義は、ネイティブへの全面移植（全画面と全 API をネイティブで実装する）を前提にしていた。
実際のアプリは WebView ハイブリッドで、タブの主要画面は Web を WebView で表示する。Web 側の画面と API は Web のテスト・CI が担保するので、
モバイルでは **WebView とネイティブの境目** と **ストアの要件** を重点的に確かめる。
最初の提出は iOS のみなので、端末での確認は iOS 実機で行う（Android は iOS の提出後）。

全機能の実装後に Pass 1〜10 をチェックし、差分があれば修正して次へ進む。

- [ ] Pass 1: 導線（到達性）— アプリ内の UI だけで、5 つのタブと設定（ログアウト・アカウント削除・通知）へ着ける。孤立したネイティブ画面は、削除するか導線を張る（#1037）。タブ内の WebView から Web の全ルートを開ける
- [ ] Pass 2: WebView の境界 — 自オリジン以外を WebView 内で開かず、外部リンクは OS のブラウザに渡す。認証ブリッジはワンタイム code 方式で、トークンが URL・ログ・外部サイトの localStorage に出ない（#1036）
- [ ] Pass 3: 認証/セッション — メール / Google / Sign in with Apple でのログイン、ログアウト、起動時の復元、期限切れ、オフライン起動、メール確認、パスワード再設定。Web 側のログアウトとネイティブの状態がずれない。共有端末に前の利用者の情報や push token が残らない（#1038、Sign in with Apple は T43）
- [ ] Pass 4: RLS/権限 — 他の利用者のデータに触れない（Web 側の RLS 回帰テストが緑であることが前提）。org / support / super-admin の画面はロール判定で出し分ける（admin の画面は削除済み。#1122）
- [ ] Pass 5: AI機能 — Edge Function の長時間処理（30 秒超）でアプリが落ちない。失敗時とリトライ。外国の AI 事業者への送信について説明し、同意を取る（T15 / T18）。送信は止めない
- [ ] Pass 6: 画像/アップロード — ネイティブの ImagePicker で撮影 → Storage へアップロード → 解析、の経路が iOS 実機で通る（iOS 18 のカメラ dismiss の回避を含む）。失敗から戻れる
- [ ] Pass 7: データ整合性 — Web とモバイルが同じデータを見ている（献立/食事/健康/買い物/冷蔵庫）。ネイティブ画面と WebView の画面が別々に書き込まない
- [ ] Pass 8: UX — ローディング/エラー/空/戻る/多重送信/オフライン。WebView が読み込めないときにリトライ UI が出る。通知をタップして該当画面へ移る（#1049）
- [ ] Pass 9: パフォーマンス — 起動、WebView の初回表示、画像、メモリ
- [ ] Pass 10: ストア要件（iOS）— 公開のプライバシーポリシー URL（T04）、アカウント削除の導線（5.1.1(v)）、Sign in with Apple（4.8）、AI 利用の同意（5.1.2）、公開レシピの通報（1.2。オーナー判断待ち）、権限文言、App Privacy の申告（Privacy Manifest）、審査用アカウントと Notes for Review（`docs/operations/app-store-metadata.md`）

---

## 実装スナップショット (2026-04-29)

ファイルツリー実測ベース。チェックボックスはコード上の存在＋行数による状態評価。

### 公開ページ — 全 10 画面実装済み
- [x] `/about` (`apps/mobile/app/(public)/about.tsx`)
- [x] `/company`
- [x] `/contact`
- [x] `/faq`
- [x] `/guide`
- [x] `/legal`
- [x] `/news`
- [x] `/pricing`
- [x] `/privacy`
- [x] `/terms`

### フェーズ 1 — 認証 / ナビゲーション (実装済み)
- [x] login / signup
- [x] auth/forgot-password / auth/reset-password / auth/verify
- [x] expo-router の (auth) / (tabs) / (org) / (super-admin) / (support) / (public)（`(admin)` は 2026-10-08 に削除。#1122）

### フェーズ 2 — 日常導線 (実装済み)
- [x] ホーム `app/(tabs)/home.tsx` (694 行)
- [x] 週間献立 `app/menus/weekly/index.tsx` (631 行) + `app/menus/weekly/request/index.tsx`
- [x] 食事記録 `app/meals/new.tsx` (1,045 行) + `app/meals/[id].tsx` + `app/meals/[id]/edit.tsx`
- [x] AI相談 `app/ai/index.tsx` + `app/ai/[sessionId].tsx` + `app/ai/important.tsx`

### フェーズ 3 — 健康・買い物・冷蔵庫 (実装済み)
- [x] 健康記録 `app/health/record/index.tsx` + `app/health/record/[date].tsx` + `app/health/record/quick.tsx`
- [x] グラフ / インサイト `app/health/graphs.tsx` (320 行) / `app/health/insights.tsx` (213 行)
- [x] 健康目標 / チャレンジ / 血液検査 / ストリーク / 設定
- [x] 買い物リスト `app/shopping-list/index.tsx` (445 行)
- [x] 冷蔵庫 `app/pantry/index.tsx` (470 行)

### フェーズ 5 — 完全移植 (実装済み)
- [x] レシピ機能 `app/recipes/` 配下: index / new / [id] / [id]/edit / collections / collections/[id] / collections/select
- [x] 比較 `app/comparison/`、バッジ `app/badges/`、家族 `app/family/`、プロフィール `app/profile/` + `app/profile/nutrition-targets.tsx`
- [x] 管理系 `(admin)`: 実装したが、2026-10-08 に削除した（運営作業は Web に一本化するオーナー判断。呼び先の API がサーバーに無い画面もあった。#1122）
- [x] 組織 `(org)`: dashboard / members / invites / departments / challenges / settings
- [x] スーパー管理 `(super-admin)`: index / admins / database / feature-flags / settings
- [x] サポート `(support)`: index / inquiries / inquiries/[id] / users / users/[id]

### フェーズ 4 — EAS / ストア準備 (大半完了、実 build/submit が残)
- [x] iOS bundleId `com.homegohan.app` (`apps/mobile/app.json`)
- [x] Android package `com.homegohan.app`
- [x] App Icon `./assets/icon.png` / Splash `./assets/splash.png` 設定
- [x] iOS Info.plist 権限文言: NSCameraUsageDescription, NSPhotoLibraryUsageDescription, NSPhotoLibraryAddUsageDescription
- [x] Android permissions: CAMERA, READ_MEDIA_IMAGES, READ_EXTERNAL_STORAGE, WRITE_EXTERNAL_STORAGE, POST_NOTIFICATIONS
- [x] expo-router / expo-image-picker / expo-notifications プラグイン設定
- [x] `apps/mobile/eas.json` の development / preview / production プロファイル
- [ ] **EAS Build (preview → production) を実行**（iOS のみ先行。Android は後回し）
- [ ] **EAS Submit (TestFlight)**（iOS のみ先行。Google Play 内部テストは後回し）
- [ ] **本番審査の提出**（iOS のみ先行）
- [ ] プライバシーポリシー / 利用規約 / 退会・データ削除導線の最終確認
- [ ] 上の「提出前に片付けるブロッカー」8 件を解消

### Pass 1〜10 検証 (未着手)
定義は上の「10パス検証」の節（WebView ハイブリッド向け）。
- [ ] Pass 1: 導線（到達性）
- [ ] Pass 2: WebView の境界
- [ ] Pass 3: 認証 / セッション
- [ ] Pass 4: RLS / 権限
- [ ] Pass 5: AI 機能 (Edge Functions / 長時間処理 / 失敗時 / リトライ / 同意)
- [ ] Pass 6: 画像 / アップロード
- [ ] Pass 7: データ整合性
- [ ] Pass 8: UX
- [ ] Pass 9: パフォーマンス
- [ ] Pass 10: ストア要件（iOS）

### 残作業の本数
- **コードのフェーズ実装は実質完了**
- **残るのは次の 3 つ（最初の提出は iOS のみ）**
  1. 「提出前に片付けるブロッカー」8 件の解消
  2. フェーズ 4 の実 build/submit（iOS）
  3. Pass 1〜10 の品質ゲート（WebView ハイブリッド向け）
