# モバイルアプリ — EAS Build / Submit ハンドオフ (2026-04-29)

## 現状

`apps/mobile/` のフェーズ 0〜3 / 5 は実装完了。残るは **フェーズ 4 = ストア提出** のみ。本書はそれを最短で完遂するための実作業ガイド。

---

## 0. 事前準備（1 回だけ必要）

| アカウント | 必要な情報 | どこで取る |
|---|---|---|
| **Apple Developer Program** | Apple ID / Team ID | https://developer.apple.com/account ($99/年) |
| **App Store Connect** | App ID (10桁の数字) | アプリを「My Apps → +」で作成すると採番される |
| **Expo Application Services (EAS)** | アカウント / プロジェクトリンク | `eas login` & `eas project:init` |
| **Google Play Console** | サービスアカウント JSON | Google Play Console → 設定 → API アクセス → 新規サービスアカウント作成 |

> 既に取得済みなら次のステップへ。

### EAS にログイン

```bash
cd apps/mobile
npx eas-cli login         # Expo アカウントでログイン
npx eas-cli whoami        # 確認
npx eas-cli project:init  # プロジェクト ID を app.json に書き込む
```

---

## 1. ビルド前のラストマイル整備

### 1-1. iOS アイコンの alpha 問題

Apple App Store は **PNG に alpha チャンネルがあると拒否** する。本日 `apps/mobile/assets/icon-ios.png` を 1024×1024 RGB で生成済み (`icon.png` を `#FFF7ED` 背景に composite)。`app.json` の `expo.ios.icon` がこの新しいファイルを指しているので、**追加作業なし**。

### 1-2. eas.json の REPLACE_WITH_* を埋める

`apps/mobile/eas.json` に下記プレースホルダがある:

```json
"submit": {
  "production": {
    "ios": {
      "appleId": "REPLACE_WITH_APPLE_ID@example.com",
      "ascAppId": "REPLACE_WITH_APP_STORE_CONNECT_APP_ID",
      "appleTeamId": "REPLACE_WITH_APPLE_TEAM_ID"
    },
    "android": {
      "serviceAccountKeyPath": "../../secrets/google-play-service-account.json",
      "track": "internal",
      "releaseStatus": "draft"
    }
  }
}
```

| キー | 取得方法 |
|---|---|
| `appleId` | 普段使ってる Apple ID メールアドレス |
| `ascAppId` | App Store Connect でアプリ作成後の URL の数字部分 (`https://appstoreconnect.apple.com/apps/<ここ>`) |
| `appleTeamId` | https://developer.apple.com/account → Membership → Team ID |
| `serviceAccountKeyPath` | Google Play Console で発行した JSON の保存先（リポジトリ外推奨） |

### 1-3. EAS Secrets に環境変数を登録

mobile アプリは `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` を build-time に必要とする (Expo は build 時に EXPO_PUBLIC_* を bundle に焼き込む)。

```bash
cd apps/mobile

# Supabase URL & anon key (homegohan project)
npx eas-cli env:create \
  --name EXPO_PUBLIC_SUPABASE_URL \
  --value "https://flmeolcfutuwwbjmzyoz.supabase.co" \
  --visibility plaintext \
  --environment production,preview,development

# anon key は Supabase 管理画面 or Management API で取得
# 例:
# curl -s "https://api.supabase.com/v1/projects/flmeolcfutuwwbjmzyoz/api-keys" \
#   -H "Authorization: Bearer $SUPA_TOKEN" | jq -r '.[] | select(.name=="anon") | .api_key'
npx eas-cli env:create \
  --name EXPO_PUBLIC_SUPABASE_ANON_KEY \
  --value "eyJhbG...（anonキー）" \
  --visibility sensitive \
  --environment production,preview,development

# Web ドメイン
npx eas-cli env:create \
  --name EXPO_PUBLIC_API_BASE_URL \
  --value "https://homegohan-app.vercel.app" \
  --visibility plaintext \
  --environment production,preview,development
```

確認:
```bash
npx eas-cli env:list --environment production
```

### 1-4. クレデンシャル生成

```bash
# iOS: Apple ログイン後、自動で push key / signing cert / provisioning profile を生成
npx eas-cli credentials --platform ios

# Android: keystore を自動生成（ストアに上げる前にバックアップ必須）
npx eas-cli credentials --platform android
```

> Android の keystore を失うと **二度と同じパッケージ名でアップデート出来ない**。生成直後に `~/Library/Developer/.../homegohan.jks` のような場所に出力されるので、絶対に別場所に複製を保管しておくこと。

---

## 2. ビルド（preview → production の順で）

### 2-1. Preview build (内部配布用 — TestFlight前のスモーク)

```bash
cd apps/mobile

# iOS preview (TestFlight 内部テスト or simulator 配布)
npx eas-cli build --profile preview --platform ios

# Android preview (APK 直接インストール)
npx eas-cli build --profile preview --platform android

# 両方同時 (時間効率上推奨)
npx eas-cli build --profile preview --platform all
```

ビルド進捗は EAS のダッシュボードで追える: https://expo.dev/accounts/<account>/projects/homegohan/builds

完了したら、表示される QR から実機 install して**動作確認**。確認項目:

- ログイン → ホーム表示
- 食事記録 (写真撮影 → AI 解析が走る)
- 週間献立リクエスト (RAG で本日修正したメニューが返ること)
- AI 相談 (テキスト送信 → 返答)
- 健康記録入力 → グラフ表示
- 退会フロー (`(tabs)/settings` → アカウント削除) が完走するか

### 2-2. Production build

Preview で問題なければ:

```bash
npx eas-cli build --profile production --platform all
```

---

## 3. ストア提出 (Submit)

### 3-1. 事前にストア側で必要な準備

| 項目 | iOS (App Store Connect) | Android (Play Console) |
|---|---|---|
| アプリ作成 | My Apps → + → 新規 App | アプリを作成 |
| バンドル名 | `com.homegohan.app` | `com.homegohan.app` |
| カテゴリ | Health & Fitness or Food & Drink | 同左 |
| プライバシー URL | `https://homegohan-app.vercel.app/privacy` | 同左 |
| サポート URL | `https://homegohan-app.vercel.app/contact` | 同左 |
| アイコン | `icon-ios.png` (1024×1024 RGB) を Connect でアップ | 同左の Play 用 (alpha OK) |
| スクリーンショット | iPhone 6.5"/6.7"/5.5" 各 3〜10 枚 | Phone / Tablet 各 2〜8 枚 |
| プレビュー動画 | 任意 | 任意 |
| 説明文 / キーワード | 日本語 (App Store Connect で入力) | 同左 |
| データセーフティ | Privacy Manifest 提出 (健康データ取扱の有無、解析ログ送信先など) | Data Safety Form 入力 |

> **データセーフティの記入は要注意**。健康記録データを Supabase / OpenAI / Gemini に送っているので、Apple Privacy Manifest と Google Data Safety の両方で「使用する第三者 API」と「送信されるデータタイプ」を正確に申告する必要あり。

### 3-2. Submit コマンド

ビルドが完了している前提:

```bash
# iOS (TestFlight に上がる)
npx eas-cli submit --profile production --platform ios

# Android (Play Console の Internal track に上がる、releaseStatus=draft なので即公開はされない)
npx eas-cli submit --profile production --platform android
```

> `--latest` を付けると最後に成功した production ビルドを自動で送れる。

### 3-3. 審査提出までの手作業

iOS:
1. App Store Connect の TestFlight タブで、上がってきた build の輸出コンプライアンス情報を入力
2. 内部テスター/外部テスターをアサイン
3. 1〜2 日テストで問題なければ、App Store タブに移って審査提出
4. Apple 審査は通常 1〜3 日

Android:
1. Play Console の「内部テスト」レーンで自分のアカウントを test user に追加
2. Play Store のリンクから install して動作確認
3. 「製品版」レーンに昇格 → 審査提出
4. Google 審査は通常 1〜7 日 (初回は 7 日かかることが多い)

---

## 4. 既知の地雷

### iOS
- **アイコン alpha 問題** — 修正済み (`icon-ios.png` を使用)
- **NSCameraUsageDescription / NSPhotoLibraryUsageDescription** — 設定済み (`app.json`)
- **退会導線** — App Store Guideline 5.1.1(v) で必須。実装済み (`app/settings/account.tsx` で「アカウント削除」ボタン確認)
- **Privacy Manifest (PrivacyInfo.xcprivacy)** — Expo SDK 52 では自動生成されるはずだが、build ログで warn が出てないか確認
- **In-App Purchase / Subscription** — 現状なし。将来導入時は別途 Guideline 3.1.1 対応

### Android
- **Keystore 紛失リスク** — `eas-cli credentials` で生成した jks を必ずバックアップ
- **POST_NOTIFICATIONS** — Android 13+ で必須申告 → 設定済み
- **Data Safety Form** — Supabase / OpenAI / Gemini への送信を申告
- **64-bit 必須** — Expo SDK 52 のデフォルトで対応

### 両プラットフォーム
- **`EXPO_PUBLIC_SUPABASE_ANON_KEY` の漏洩リスク** — anon key は Supabase 仕様上「公開されてよい」前提だが、RLS が厳格に設定されているか必ず再確認
- **API rate limit** — 公開後トラフィックが増えると Supabase / AIMLAPI / OpenAI / Gemini 全てで 429 が出始めるので、Edge Function 側のリトライとフォールバックを再点検

---

## 5. 完全コマンド早見表

```bash
# ─── 1回だけ ───
cd apps/mobile
npx eas-cli login
npx eas-cli project:init
npx eas-cli credentials --platform ios
npx eas-cli credentials --platform android

# 環境変数登録
npx eas-cli env:create --name EXPO_PUBLIC_SUPABASE_URL      --value "https://flmeolcfutuwwbjmzyoz.supabase.co" --visibility plaintext --environment production,preview,development
npx eas-cli env:create --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "REAL_ANON_KEY"                          --visibility sensitive --environment production,preview,development
npx eas-cli env:create --name EXPO_PUBLIC_API_BASE_URL      --value "https://homegohan-app.vercel.app"       --visibility plaintext --environment production,preview,development

# ─── 毎回のビルド／提出 ───
# Preview
npx eas-cli build  --profile preview --platform all

# Production
npx eas-cli build  --profile production --platform all
npx eas-cli submit --profile production --platform ios --latest
npx eas-cli submit --profile production --platform android --latest
```

---

## 6. Pass 1〜10 検証ゲート

`MOBILE_TODO.md` 末尾の Pass 1〜10 は審査提出前に通すべき品質ゲート。最低限:

- Pass 5 (AI機能): Edge Function の長時間処理（解析 30s 超）でアプリがクラッシュしない
- Pass 6 (画像/アップロード): カメラ撮影 → S3 / Supabase Storage アップロード → Edge Function 経路の全てが iOS / Android 両方で通る
- Pass 10 (ストア要件): Privacy Policy / Terms / 退会導線 / データセーフティ全てが入力済み

---

## 7. 完了の定義

- [ ] iOS: TestFlight でβテスター 1 人以上が検収
- [ ] Android: Play Console 内部テストで自身の端末で全機能動作
- [ ] iOS App Store 審査提出 (在りモードでなく公開予定)
- [ ] Google Play 製品版審査提出
- [ ] 審査通過後、ストア公開を堀さんが手動で「公開」ボタン押下
- [ ] 公開後 24 時間以内のクラッシュ率 < 1% を確認 (EAS Insights / Crashlytics)

ここまで通れば「ほめゴハン」モバイル正式リリース完了。
