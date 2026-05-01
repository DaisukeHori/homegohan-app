# Maestro E2E テスト

## Maestro CLI のインストール

```bash
curl -Ls https://get.maestro.mobile.dev | bash
```

インストール後、ターミナルを再起動してパスを通してください。

## テストの実行

シミュレーター/エミュレーターを起動した状態で以下を実行:

```bash
# 特定フローのみ
maestro test apps/mobile/maestro/flows/01-login.yaml

# 全フローを順番に実行
maestro test apps/mobile/maestro/flows/

# スモークテスト
maestro test apps/mobile/maestro/smoke.yaml
```

## ファイル構成

| ファイル | 説明 |
|---------|------|
| `smoke.yaml` | アプリ起動確認のスモークテスト |
| `config.yaml` | 共通設定 (appId) |
| `flows/01-login.yaml` | 起動 → メール+パスワード入力 → ホーム画面確認 |
| `flows/02-onboarding.yaml` | 新規登録ユーザーでオンボーディング質問回答 → 完了画面 |
| `flows/03-weekly-meal-toggle.yaml` | ホーム → 週間メニュー → カードタップで完了アイコン変化確認 |
| `flows/04-meal-create.yaml` | 食事追加 → 一覧に反映確認 |
| `flows/05-shopping-generate.yaml` | 週間メニューから買い物リスト生成 → リスト表示確認 |
| `flows/06-pantry-add-delete.yaml` | pantry アイテム追加 → 削除確認 |
| `flows/07-ai-chat.yaml` | AI チャット起動 → メッセージ送信 → 応答表示確認 (モック前提) |

## 前提条件

### シミュレーター要件

- **iOS**: Xcode 15 以上 + iOS 17 以上のシミュレーター起動済み
- **Android**: Android Studio + API Level 33 以上のエミュレーター起動済み

### アプリビルド

```bash
# iOS シミュレーター向けビルド
cd apps/mobile
npx expo run:ios

# Android エミュレーター向けビルド
npx expo run:android
```

### 必要な環境変数

| 変数名 | 説明 |
|--------|------|
| `E2E_USER_EMAIL` | E2E テスト用既存ユーザーのメールアドレス |
| `E2E_USER_PASSWORD` | E2E テスト用既存ユーザーのパスワード |
| `E2E_NEW_USER_EMAIL` | オンボーディングテスト用新規ユーザーのメールアドレス |
| `E2E_NEW_USER_PASSWORD` | オンボーディングテスト用新規ユーザーのパスワード |

ローカル実行時は `.env.e2e` ファイルに記述するか、シェルにエクスポートしてください:

```bash
export E2E_USER_EMAIL=test@example.com
export E2E_USER_PASSWORD=your-password
```

## CI (Maestro Cloud)

`.github/workflows/mobile-e2e.yml` が `apps/mobile/**` への PR で自動実行されます。

実行には以下の GitHub Secrets の設定が必要です:

| Secret 名 | 説明 |
|-----------|------|
| `MAESTRO_CLOUD_API_KEY` | Maestro Cloud の API キー (未設定の場合 job をスキップ) |
| `E2E_USER_EMAIL` | テスト用ユーザーメール |
| `E2E_USER_PASSWORD` | テスト用ユーザーパスワード |

`MAESTRO_CLOUD_API_KEY` が未設定の場合、CI ジョブは自動的にスキップされます。

## testId の実装について

各フローは `testID` プロップを参照します。対応するコンポーネントに以下のように `testID` を付与してください:

```tsx
// ログイン画面の例
<View testID="login-screen">
  <TextInput testID="email-input" ... />
  <TextInput testID="password-input" ... />
  <Pressable testID="login-button" ... />
</View>
```

未実装の `testID` があるフローはスキップされる場合があります。
