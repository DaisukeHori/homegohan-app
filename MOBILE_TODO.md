## 目的
Web版（Next.js）で実装済みの「ほめゴハン」を **React Native / Expo** でスマホアプリ化し、
**App Store / Google Play 公開（EAS Build/Submit）**まで到達する。

---

## 方針（重要）
- **モノレポ**で進める（当面はWebはルート、`apps/mobile` を追加して動かす）
- 共有は **`packages/core` に段階的に切り出す**
- 端末に **秘密鍵を置かない**（OpenAI/Gemini/Service Roleなどはサーバ・Edge Functions側）
- 「まず日常導線」→「機能拡張」→「管理系」→「全機能完了」の順で進める

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
- [ ] 管理系（admin/org/support/super-admin）をモバイルに実装（ロールに応じてUI/権限制御）

---

## 機能/画面チェックリスト（Web → Mobile）
`src/app/**/page.tsx` の全ルートに対応する（到達可能な導線を用意する）。

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
- [ ] `/admin`
- [ ] `/admin/announcements`
- [ ] `/admin/audit-logs`
- [ ] `/admin/inquiries`
- [ ] `/admin/moderation`
- [ ] `/admin/organizations`
- [ ] `/admin/users`

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

## 10パス検証（最低10周）
全機能実装完了後、以下を **Pass1〜Pass10** としてチェックし、差分があれば修正して次へ進む。

- [ ] Pass 1: 画面網羅性（上のチェックリスト全到達）
- [ ] Pass 2: API網羅性（画面ごとのCRUD/AI呼び出し/管理API）
- [ ] Pass 3: 認証/セッション（ログイン/ログアウト/復元/期限切れ/メール確認/パスリセット）
- [ ] Pass 4: RLS/権限（他ユーザーアクセス不可・ロール別表示制御）
- [ ] Pass 5: AI機能（Edge Functions/長時間処理/失敗時/リトライ）
- [ ] Pass 6: 画像/アップロード（カメラ/ライブラリ/Storage/失敗復帰）
- [ ] Pass 7: データ整合性（献立/食事/健康/買い物/冷蔵庫の整合）
- [ ] Pass 8: UX（ローディング/エラー/空/戻る/多重送信/オフライン）
- [ ] Pass 9: パフォーマンス（起動/一覧/画像/キャッシュ/メモリ）
- [ ] Pass 10: ストア要件（権限文言/プライバシー/削除導線/審査NG）


