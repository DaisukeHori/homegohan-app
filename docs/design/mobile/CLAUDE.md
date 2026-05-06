# mobile/ モバイル App ドメイン 開発指針

要件定義 `docs/requirements/01-family-management.md §15` の詳細設計。

## ファイル一覧

| ファイル | 担当範囲 | 要件参照 |
|---------|--------|---------|
| `01-architecture.md` | WebView ハイブリッド構成 / native bridge / セッション同期 | 01 §15 全体 |
| `02-deep-link.md` | `homegohan://` カスタムスキーム / Universal Links / 招待受諾画面 | 01 §15.1 |
| `03-push-notification.md` | Expo Push / バッジカウント / 通知種別 on-off / Quiet Hours | 01 §15.3-4 |
| `04-storage-camera.md` | meal-photos バケット / native ImagePicker / EXIF 削除 | 01 §15.2 |

## ドメインの役割

React Native + Expo SDK 53 によるモバイルアプリ:
- **WebView ハイブリッド**: 主要画面は Web 側 (`src/app/`) を WebView で表示
- **ネイティブ機能**: Push 通知 / カメラ / ディープリンク / Biometric 認証
- **配布**: Apple Configurator 2 (開発) → TestFlight (β) → App Store (本番)

## アーキテクチャ概要

```
┌─────────────────────────────────────────────────┐
│  Mobile App (React Native + Expo SDK 53)        │
│  ├── app/                                        │
│  │   ├── _layout.tsx (Linking handler)         │
│  │   ├── (tabs)/ ネイティブタブ                │
│  │   ├── family/invite-accept.tsx              │
│  │   └── org/invite-accept.tsx                 │
│  └── src/                                        │
│      ├── components/web/WebViewScreen.tsx      │
│      ├── lib/                                   │
│      │   ├── nativeBridge.ts (Web ↔ Native)    │
│      │   ├── pushNotifications.ts              │
│      │   ├── deeplink.ts                       │
│      │   └── storage.ts (uploadMealPhoto)      │
│      └── ...                                     │
└─────────────────────────────────────────────────┘
              │ WebView 内
              ↓
┌─────────────────────────────────────────────────┐
│  Web (Next.js) — 主要 UI                       │
└─────────────────────────────────────────────────┘
              │ ネイティブブリッジ呼び出し
              ↓
┌─────────────────────────────────────────────────┐
│  Native APIs (Camera / Push / Linking / Bio)    │
└─────────────────────────────────────────────────┘
```

## 設計原則

### 1. WebView を主、ネイティブを従
- 機能の 80% は Web で実装、Mobile は薄いラッパー
- ネイティブ実装が必要なケースのみ専用画面 (deep link 受諾、Push 設定等)

### 2. セッション同期
- WebView 内の Supabase セッションをネイティブ側 SecureStore と同期
- ネイティブログイン → WebView で自動ログイン状態
- ログアウトは両側同期 (`/api/auth/logout` → SecureStore クリア)

### 3. ディープリンク
- スキーム: `homegohan://`
- 招待: `homegohan://invite/family/{token}` / `homegohan://invite/org/{token}`
- アプリ未起動 (`Linking.getInitialURL`) と起動済み (`addEventListener('url')`) 両対応
- Apple Configurator 2 配布でも動く (Universal Links 不要)

### 4. Push 通知
- Expo Push Token を `user_push_tokens` に登録
- バッジカウントは payload の `badge` フィールド + `setBadgeCountAsync`
- 通知種別ごとの on/off (`notification_preferences.preferences` JSONB)
- Quiet Hours (22:00-7:00) は緊急通知以外スキップ

### 5. 食事写真アップロード
- Web 側 `<input type="file">` は iOS 18 でカメラ dismiss バグ → ネイティブ ImagePicker 必須
- `expo-image-picker` で撮影 → URI 取得 → Supabase Storage `meal-photos` バケットへ direct upload
- アップロード時に EXIF 削除 (GPS 等の PII 漏洩防止)

## 他ドメインとの依存

| 依存先 | 用途 |
|-------|------|
| `cross/01-auth-session.md` | セッション同期 / 2FA / 子供同意 |
| `family/02-api-spec.md` | `/api/family/invites/{token}/accept` 受諾フロー |
| `org/02-api-spec.md` | `/api/org/invites/{token}/accept` 受諾フロー |
| `cross/04-api-conventions.md` | API レスポンス snake_case |

## このドメインから他ドメインへの提供

| 提供内容 | 利用先 |
|---------|------|
| Expo Push Token | `cross/03-design-system.md` (notify-push Edge Function) |
| ディープリンク受諾フロー | family / org の invite フロー |
| Native ImagePicker | family の食事写真アップロード |

## テスト戦略

- **Unit**: deeplink parser / pushNotifications ロジック
- **E2E**: Maestro (or Detox) でディープリンク受諾フロー / Push 通知受信
- **Manual**: Apple Configurator 2 で実機検証 (Push の APNs / バッジ表示)

## 既存実装との関連

### 保持
- `apps/mobile/` 全体の WebView ハイブリッド構成 (要件 01 §15.3 でも明示)
- `src/components/web/WebViewScreen.tsx`
- `src/lib/pushNotifications.ts` (基本部分)

### 修正
- `_layout.tsx` に `Linking.addEventListener` 追加 (要件 §15.1)
- `pushNotifications.ts` に `setBadgeCountAsync` 追加 (要件 §15.3)
- `storage.ts` に `uploadMealPhoto(file, familyGroupId?)` 追加 (要件 §15.2)
- `(tabs)/settings.tsx` に通知種別 on/off UI 追加 (要件 §15.4)

### 新規
- `app/family/invite-accept.tsx`
- `app/org/invite-accept.tsx`
- `src/lib/deeplink.ts`
- `src/lib/nativeBridge.ts` (Web → Native 通信)

## EAS Build 設定

- iOS: APNs キー (.p8) は EAS Secret 登録済み
- Android: FCM Server Key を `EXPO_FCM_SERVER_KEY` として EAS Secret に追加 (新規、要件 §15.7)
- ビルドコマンド: `eas build --platform ios --profile preview --local`
- 配布: Apple Configurator 2 → TestFlight (β) → App Store (本番)

## 強制アップデート (`/api/app/version-check`)

破壊的 API 変更 (snake_case 統一等) で旧アプリが動作不能になる際:
- 起動時に `GET /api/app/version-check?platform=ios&version=1.2.3`
- レスポンス: `{ minimum_supported, current, force_update }`
- `force_update: true` なら App Store / Play Store へ誘導モーダル
