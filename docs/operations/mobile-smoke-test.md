# Mobile Smoke Test — TestFlight 実機検証手順

TestFlight にビルドを提出した後、実機で Maestro smoke テストを走らせる手順です。

---

## 前提条件

| 要件 | 確認方法 |
|------|----------|
| Maestro CLI インストール済み | `maestro --version` |
| iOS 実機が Mac に接続されている | `idevice_id -l` または Xcode Devices |
| TestFlight アプリ経由でビルドをインストール済み | TestFlight アプリで最新ビルドを確認 |
| テスト用アカウントが用意済み | Supabase Auth でオンボーディング完了済みのユーザー |

### Maestro CLI のインストール

```bash
curl -Ls https://get.maestro.mobile.dev | bash
```

インストール後、ターミナルを再起動してパスを通してください。

---

## ステップ 1: IPA ビルドと TestFlight 提出

```bash
# 1. CocoaPods PATH 設定 (Homebrew Ruby 依存)
export PATH="/opt/homebrew/opt/ruby/bin:$PATH"
export GEM_PATH="/opt/homebrew/opt/ruby/gems"

# 2. EAS ローカルビルド
cd apps/mobile
eas build --platform ios --local --non-interactive --profile production

# 3. TestFlight 提出
eas submit --platform ios --path <generated .ipa path> --non-interactive
```

TestFlight でビルドを内部テスター向けに公開し、実機にインストールしてください。

---

## ステップ 2: 環境変数の設定

```bash
export E2E_USER_EMAIL="<テストユーザーのメールアドレス>"
export E2E_USER_PASSWORD="<テストユーザーのパスワード>"
```

テストユーザーは:
- オンボーディングが完了済み (`onboarding_completed_at` が非 NULL)
- `admin` / `super_admin` ロールを持たない一般ユーザー

---

## ステップ 3: 実機で Maestro smoke テストを実行

```bash
# apps/mobile ディレクトリから実行
cd apps/mobile
npm run test:e2e:smoke

# または直接 maestro コマンドで実行
maestro test maestro/smoke.yaml
```

Maestro は USB 接続または Wi-Fi 経由で実機を自動検出します。複数デバイスが接続されている場合は `--device <device-id>` オプションで指定してください。

```bash
# デバイス一覧確認
maestro hierarchy

# 特定デバイスを指定して実行
maestro --device <device-id> test maestro/smoke.yaml
```

---

## ステップ 4: 結果確認

smoke テストは以下のフローをカバーします:

1. アプリ起動 → ウェルカム画面表示
2. ログインボタンタップ → メール + パスワード入力 → ログイン
3. ホーム画面 (`webview-home`) 表示確認
4. 献立タブ (`tab-menus`) 遷移確認
5. スキャンタブ (meals) 遷移確認
6. 比較タブ (`tab-comparison`) 遷移確認
7. マイページタブ (`tab-profile`) 遷移確認
8. ホームに戻る確認
9. プロファイル → 設定 → ログアウト実行
10. ウェルカム画面に戻ることを確認

すべてのステップがグリーンであれば、TestFlight ビルドの基本動作は問題ありません。

---

## トラブルシューティング

### Maestro がデバイスを検出できない

- USB ケーブルが正しく接続されているか確認
- `idevice_id -l` でデバイス UUID が表示されるか確認
- 実機の「このコンピュータを信頼しますか？」ダイアログを承認

### ログイン画面が表示されない

- `E2E_USER_EMAIL` / `E2E_USER_PASSWORD` が正しく設定されているか確認
- TestFlight ビルドの `appId` が `com.homegohan.app` であることを確認

### タブ遷移でタイムアウト

- TestFlight ビルドはネットワーク経由で WebView を読み込むため、通常より時間がかかる場合があります
- 安定した Wi-Fi 接続環境で実行してください

### meals タブが見つからない

- meals (スキャン) タブはタブバーラベルが非表示のため、アイコンの位置で認識されます
- テストが失敗する場合は `maestro hierarchy` でUI要素ツリーを確認してください

---

## 参考

- Maestro 公式ドキュメント: https://maestro.mobile.dev
- EAS Build ドキュメント: https://docs.expo.dev/build/introduction/
- TestFlight 提出フロー: `docs/operations/` 内の `eas-build-submit-handoff-*.md`
