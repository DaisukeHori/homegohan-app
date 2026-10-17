# ほめゴハン（モバイル） - React Native / Expo

## 前提
- ルートは npm workspaces（`apps/*`, `packages/*`）です
- モバイルアプリは `apps/mobile` 配下にあります
- **秘密鍵（OpenAI/Gemini/Service Role）は端末に置きません**

## ローカル起動

### 1) 依存関係のインストール
プロジェクトルートで実行:

```bash
npm install
```

### 2) 環境変数（開発用）
`apps/mobile/env.example` を参考に、以下を設定してください（どちらかの方法）。

#### 方法A: シェルでexport（推奨・最短）

```bash
export EXPO_PUBLIC_SUPABASE_URL="https://xxx.supabase.co"
export EXPO_PUBLIC_SUPABASE_ANON_KEY="xxx"
export EXPO_PUBLIC_API_BASE_URL="https://homegohan-app.vercel.app"
export EXPO_PUBLIC_APP_ENV="development"
```

#### 方法B: `apps/mobile/.env` を作成（Git管理しない）
※ `.env*` はリポジトリにコミットしないでください。

```env
EXPO_PUBLIC_SUPABASE_URL=...
EXPO_PUBLIC_SUPABASE_ANON_KEY=...
EXPO_PUBLIC_API_BASE_URL=https://homegohan-app.vercel.app
EXPO_PUBLIC_APP_ENV=development
```

### 3) 起動

```bash
# ルートから
npm run mobile:start

# または
npm run mobile:ios
npm run mobile:android
```

## 実装テスト（モバイル）

> ここでいう「テスト」は、実装の動作確認（スモーク/手動）を指します。

### A) 実機（Expo Go）で確認（推奨）
> SDK 58 の Expo Go は公開待ちで、push 通知は SDK 55 から Expo Go では例外になるため、SDK 58 の動作と push 通知は preview のビルド（`eas build --profile preview`）で確かめてください。

1. iOS/Android 端末に **Expo Go** をインストール
2. 端末とPCを同じネットワークに接続
3. ルートで `npm run mobile:start` を実行
4. ターミナルに表示される QR を Expo Go で読み込み
5. 以下の観点で一通り確認
   - 認証（ログイン/新規登録/パスワードリセット）
   - ホームのタブ（WebView）
   - 献立のタブ（WebView。週間献立の生成/生成中/再生成/並び替え/編集は、Web の画面をこの中で使う）
   - スキャンのタブ（WebView。食事の記録、写真系は実機で）
   - AI相談（タブの上の AI のボタンから開くシート: 送信/終了と要約）
   - 比較・マイページのタブ（WebView）と、マイページの歯車の先の設定（栄養目標・健康診断の血液検査・使い方ガイドなど）
   - 買い物リスト・冷蔵庫・レシピ・家族・健康記録・バッジ・お気に入り・運営の画面（組織・サポート・スーパー管理）は、アプリのネイティブの画面としては無い（通常の操作で届かなかったので消した。#1598。Web の画面で確認する）

※ 本番バックエンドに繋ぐ場合は `EXPO_PUBLIC_API_BASE_URL=https://homegohan-app.vercel.app`（いまアプリが動いている Web。`homegohan.com` はサイトを移すまで別のサービスを指しているので使わない）でOKですが、**本番データを汚さないテスト用アカウント**の利用を推奨します。

### B) iOS Simulator / Android Emulator で確認
- iOS: `npm run mobile:ios`
- Android: `npm run mobile:android`

### C) Expo Web で確認（補助）
最短で画面遷移の確認をしたい場合:

```bash
cd apps/mobile
npm run web
```

注意:
- ブラウザ都合で **CORS** により `https://homegohan-app.vercel.app/api/*` が失敗する場合があります（その場合は実機/Simulator推奨）
- カメラ/Push通知などは Web では制約があります

### D) 事前チェック（CI向け）
```bash
# 型チェック
npx tsc -p apps/mobile/tsconfig.json --noEmit

# Expo設定/依存の整合性チェック
cd apps/mobile
npx expo-doctor
```

## 認証
現時点のMVPは **メール/パスワード** を想定しています。
ログイン後、ホーム画面で `user_profiles` を読み込み、簡易表示します。

## ストア公開（EAS）

### bundleId / package
- iOS: `com.homegohan.app`
- Android: `com.homegohan.app`
- scheme: `homegohan`

### EAS Build
`apps/mobile/eas.json` に profile を定義しています。

```bash
cd apps/mobile

# プレビュー（社内配布）
eas build --platform ios --profile preview
eas build --platform android --profile preview

# 本番（ストア提出用）
eas build --platform ios --profile production
eas build --platform android --profile production
```

### EAS Submit

```bash
cd apps/mobile

eas submit --platform ios --profile production
eas submit --platform android --profile production
```

## 注意（AI機能）
AI（献立生成/写真分析/AI相談）は、端末から直接OpenAI/Geminiを呼ばず、
Supabase Edge Functions / Next.js API を経由して実行します（秘密鍵はサーバ側）。



