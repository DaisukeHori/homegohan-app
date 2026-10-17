# mobile/07 モバイルのツールチェーンのメジャー更新 — Expo SDK 53 → 58 (React Native 0.79 → 0.88・Jest 29 → 30)

| | |
|---|---|
| 版 | v1.5 (2026-10-18) |
| Status | 設計ゲート通過 (wf_932fc07c-ab0)。段 A〜C は実装済み (1 本の WF・1 本の PR)。ネイティブのビルド・提出・実機の確認は #1115 (オーナー作業・§16) |
| Issue | #1591 (モバイルのツールチェーン (expo・react-native・metro・jest) のメジャー更新 — npm audit の high の残りの原因。#1444 から分割)。載せる先のネイティブのビルドは #1115 (協調リリース) |
| 範囲の正本 | Issue #1591 の本文とコメント。本書はその上で決めた上げ先・壊れる所・直し方・検証・段分け・オーナー作業との境目 |
| 実装者 | Sonnet 5.5 が本書だけを読んで手を止めずに実装できることを完成条件にする (設計ゲートを省くなら Opus 5.5) |

オーナーの選択 (2026-10-17): 「今から始める。設計 → 実装 → マージし、次のネイティブのビルド (#1115) に載せる。」

本冊は、`apps/mobile` のツールチェーン (`expo` / `expo-updates` / `react-native` / `metro` / `jest` / `jest-expo`) を **Expo SDK 58 (React Native 0.88.0・React 19.3.0・Jest 30.5) に一度に上げる**。Issue #1591 が挙げた npm audit の high のうち、**image-size・postcss・jest 系 (jest-haste-map・@jest/environment ほか) の経路は消える**。**braces と node-forge は 2026-10-17 時点で修正版が公開されていない** (npm の latest がそれぞれ 3.0.3・1.4.0 で、どちらも脆弱な範囲) ので、どの版に上げても残る (§2.3)。`metro-transform-worker` は image-size の経路が消えても、`metro-file-map` → `micromatch` → `braces` の経路の上にあるので high のまま残る (§2.3 の実測)。したがって「high が消える最小の組み合わせ」は存在せず、上げ先は「残る 2 系統以外を全部消し、いまの安定版に乗る」SDK 58 にする (§5)。

---

## 0. 分冊判定・範囲・読み方

### 0.1 分冊判定 (相 1 で実施)

| 目安 | 本冊 | 判定 |
|---|---|---|
| 設計書 800 行超 | 超える (壊れる所の表・正典の設定ファイル・表 3 点・トレースを 1 冊に持つため) | 該当 |
| 消費先レーン 3 以上 | 依存の宣言 (`package.json` ×2・`package-lock.json`)・アプリの設定 (`app.json` / `eas.json` / Metro / Babel / tsconfig)・Jest の基盤・アプリのコード (expo-router 58 への追随 2 か所・API の置き換え 3 か所)・番兵のテスト = 5 | 該当 |
| 共有面 2 つ以上 | ルートの `package.json` の `overrides`・`package-lock.json` (Web と共有)・`.github/dependabot.yml` のコメント・設計正典 (`mobile/01`・`mobile/CLAUDE.md`・`cross/13b`・`00-architecture`・ルート `CLAUDE.md`。§15.2) | 該当 |

判定: **設計は 1 冊 (本書) のまま、実装は 1 本の B 型 WF の中で 3 段 (A: 依存と設定 / B: expo-router 58 への追随 / C: 番兵と README) に分け、段ごとに 2 枚レビューを挟み、マージは最後に 1 回**。理由: どの段も同じネイティブのビルド (#1115) に載るまで利用者には届かず、段 A だけをマージすると、設定の画面に届かない (§7.1 の B-1) ・同意画面の止めが効かない (B-2) 状態の main ができる。核と配線に分けても、分かれた冊が参照する「マージ済みの核」が無い (全部が同じ `package-lock.json` の 1 回の作り直しに依る) ので、分けても行数も周回も減らない。

### 0.2 本冊の範囲と、対象外

| 本冊 | 対象外 (別の案件) |
|---|---|
| `apps/mobile` の依存を Expo SDK 58 の版 (`expo/bundledNativeModules.json`) にそろえ、ルートの `package-lock.json` を作り直す | Web (`src/`・ルートの `next` / `react` / `eslint-config-next`) の更新。`eslint-config-next` → `fast-glob` → `micromatch` → `braces` の high (dev) は Web 側の案件 |
| 上げ先で壊れる所 (API・設定・テスト) の全列挙と直し方 (§7) | `@testing-library/react-native` 14 への移行 (`render` / `fireEvent` / `act` が Promise を返すようになり、`render(` を使うテスト 67 ファイルの書き換えになる。§5.1 の C) |
| `runtimeVersion` の方針 (fingerprint) と、OTA を使わない現状の固定 (§11) | OTA (EAS Update) を使い始めること (`mobile/01` §13 の「大型変更時に検討」のまま) |
| Jest 29 → 30 への追随と、Reanimated 4 (worklets) の Jest の設定 (§7.3) | `expo-file-system` の新しい API (`File` / `Directory`) への移行 (`/legacy` の入口を使い続ける。§7.1 の A-3) |
| 使っていない依存 3 つの削除 (§6.3) | `expo-dev-client` の導入 (`eas.json` の `development` プロファイルは、いまも入っていない。変えない) |
| 検証 (tsc・local-ci の mobile:jest / mobile:core・npm audit・expo-doctor・`expo install --check`) と合格の数 (§10) | ネイティブのビルド・提出・実機の確認 (オーナー作業。§16 に手順と確認の表を置く) |
| 番兵 (版の組・lockfile の置き場・`runtimeVersion`・`/legacy` の入口) の新設 (§9.7) | `react-native-web` / `expo start --web` の整備 (`react-dom` を宣言していない現状のまま。既知の制約として §17) |

### 0.3 読み方・用語

- **根の advisory**: `npm audit --json` の `vulnerabilities[*].via` に、文字列 (経路のパッケージ名) でなくオブジェクト (GHSA の ID・題名・範囲) が入っている項目。high の件数 (47 件) のほとんどは、根の 4 系統 (braces・node-forge・image-size・postcss) に依存のパスで繋がっているだけの「経路のパッケージ」である。本冊の合否は根の集合で見る (§10.4)。
- **bundledNativeModules**: `expo` パッケージが持つ `bundledNativeModules.json`。SDK ごとに合う版の表で、`npx expo install --fix` / `--check` が読む。本冊の版は、この表 (expo 58.0.14 のもの) から逐語で写す (§6.1)。
- **協調リリース (#1115)**: 次のネイティブのビルドと提出。本冊の実装のマージ後に、オーナーが EAS でビルドして実機で確かめる。

---

## 1. 目的・スコープ

- npm audit の high の残り (Issue #1591) のうち、ツールチェーンのメジャー更新でしか消えない経路を消す。
- モバイルを、いまの安定版 (Expo SDK 58・2026-10-15 公開) に乗せる。SDK 53 は Legacy Architecture 時代の最後から 2 つ前の版で、Expo Go・EAS の既定のイメージ・Xcode の要件 (SDK 55 以降は Xcode 26) から離れている。
- 既存のネイティブのビルド (SDK 53・`runtimeVersion` 1.0.0) に、新しい JS が OTA で届いて落ちることが無いことを、構造 (更新を無効のまま) と方針 (fingerprint) の両方で固定する。
- 上げた後も、Dependabot のパッチ更新や手作業の更新で React とレンダラーの版がずれないよう、番兵で固定する。

---

## 2. 関連要件と現行の事実

### 2.1 関連 Issue・既存設計

| 文書 | 関係 |
|---|---|
| Issue #1591 (本文) | 対象のパッケージ・high の系統・`@react-native-community/slider` の確認・Dependabot #1589 / #1590 の仕分け |
| Issue #1444 (閉) | 第 1 段 (PR #1585) でメジャーを上げずに直せるものを直した。残りが #1591 |
| Issue #1115 (開) | 協調リリースのトラッカー。本冊の実装はここに載せる。2026-10-16/17 のコメントに、実機で確かめる項目 (#1722 Push・#588 字形・#1822 公開ページのヘッダ・#1442 同意ゲート) が積んである |
| `docs/design/mobile/01-architecture.md` | 技術スタック (SDK 53 と書いてある)・§3.2 の設定画面の置き場 (`app/(tabs)/settings.tsx`・`href: null`)・§13 の OTA の行 |
| `docs/design/cross/13b-legal-consent-mobile.md` | 同意ゲート (と、同じ形の凍結のゲート #1861)。`beforeRemove` と `navigationRef.reset` の規則 (§0.3・§6.6.8〜6.6.11) が expo-router 58 で変わる (§7.1 の B-2) |
| `docs/design/cross/16-auth-history-sessions.md` | `app/(tabs)/settings.tsx` を名指しする (5 か所)。本冊は設定の画面の置き場を変えない (§7.1 の B-1) ので、追随は無い |
| `docs/design/mobile/05-auth-session.md` | 設定画面の `signOutOnDevice` (ファイル名は書いていない)。番兵 `tests/mobile-sign-out-doc-callers.test.ts` が画面のファイル (`app/(tabs)/settings.tsx`) を持つ。置き場を変えないので、どちらも変わらない |
| Dependabot PR #1589 (postcss・expo・next) / #1590 (minor/patch のまとめ) | どちらも閉 (10/14・10/16)。#1590 の `@supabase/ssr` は #1768 (PR #1841) で別に上げた。本冊で扱う残りは無い |

### 2.2 現行の事実 (origin/main `904f9e8f` で採取し、`1d69d88b` で採り直した。`307ae1cf` (cross/16 の段 B・PR #1838) の差分 (設定の画面の行 1 つ・Jest のテスト 3 本) を取り込んだ。2026-10-17。`9dd73f23` (2026-10-18) で突き合わせた: その間の `apps/mobile` の変更は認証の 4 ファイル (`(auth)/auth/reset-password.tsx`・`AccountCredentialsSection.tsx`・`src/lib/account-credentials.ts`・`AuthProvider.tsx`) と既存のテスト 3 本で、本冊が触るファイル・Jest のテストの数 (115)・`render(` の数 (62)・依存の宣言と lockfile は変わらない。`0ca17773` (2026-10-18) でも突き合わせた: `9dd73f23` からの 2 commit (#1862・#1863) は `apps/mobile` を 1 つも変えず、ルートの `package.json`・`package-lock.json` も変えない。`d34f18d8` (2026-10-18) でも突き合わせた: `835fbe7c` からの 5 commit (#1872〜#1876) のうち `apps/mobile` を変えたのは #1876 だけで、設定の画面の書き出しの 2 行の副題と CSV の共有の題を書き換え (`app/(tabs)/settings.tsx`)、その Jest のテスト `settings/export-rows.test.tsx` (新設。`jest.mock('expo-file-system', …)` を持つ) を足した。ルートの `package.json`・`package-lock.json` は変えない。`cf6393c3` (#1877・2026-10-18) でも突き合わせた: `apps/mobile` とルートの `package.json`・`package-lock.json` を変えないので、数は `d34f18d8` と同じ)

**数の基準 (この章と §8・§13・§14・§15 の数はすべて origin/main のもの)**: Jest のテストの数 (121)・`expo-file-system` の `jest.mock` を持つテスト (12)・`render(` のファイル (67) は、`git ls-tree -r origin/main` (d34f18d8) / `git grep … origin/main` で数えた。本冊の設計の枝 (`design/issue-1591-mobile-toolchain`) は `904f9e8f` から切ったので、枝の上の `apps/mobile` は main より古い (`904f9e8f..9dd73f23` の `apps/mobile` の差は 29 ファイル。上の 3 回の取り込みの和で、`data-requests-entry`・`sessions-entry`・`sessions`・`device-name` の 4 本のテストを含む。枝の上で数えると Jest は 111 本・mock は 10 本になる)。設計の枝は本冊 1 ファイルしか変えないので、枝の古さは実装に届かない: 実装の worktree は設計の枝からでなく、投入の時点の origin/main から切る (§14.1)。

**版 (`apps/mobile/package.json` の宣言 → `package-lock.json` の解決)**

| パッケージ | 宣言 | 解決 | 置き場 |
|---|---|---|---|
| expo | ~53.0.0 | 53.0.27 | ルート |
| react-native | 0.79.6 | 0.79.6 | ルート |
| react | 19.0.0 | 19.0.0 | `apps/mobile/node_modules` (ルートは Web 用 19.2.8) |
| @types/react | ~19.0.10 | 19.0.x | `apps/mobile/node_modules` (ルートは 19.2.18) |
| expo-updates | ~0.28.18 | 0.28.18 | ルート |
| expo-router | ~5.1.11 | 5.1.11 | ルート |
| react-native-reanimated | ^3.17.5 | 3.19.5 | ルート |
| jest | ~29.7.0 | 29.7.0 | ルート |
| jest-expo | ~53.0.14 | 53.0.14 | ルート (`react-test-renderer` 19.0.0 を入れ子で持つ) |
| react-test-renderer | ^19.0.0 | 19.2.5 | ルート (jest の `moduleNameMapper` が指す先。react 19.0.0 と版が違うまま動いている) |
| @types/jest | ^30.0.0 | 30.0.0 | ルート (Jest 29 のまま型だけ 30) |
| typescript | ~5.8.3 | 5.8.3 | `apps/mobile/node_modules` (ルートは 5.9.3) |
| metro (react-native 経由) | – | 0.82.5 | ルート。`image-size ^1.0.2` に依存 |
| @expo/metro-config (expo 経由) | – | 0.20.18 | ルート。`postcss ~8.4.32` → 8.4.49 を入れ子で持つ |
| @expo/vector-icons (expo 経由) | 宣言なし | 14.1.0 | ルート。`app/` `src/` の 22 ファイルが `Ionicons` を import している |
| @react-native-community/slider | 4.5.7 | 4.5.7 | `apps/mobile/node_modules`。`app/` `src/` に import は無い。テストの `__tests__/home/home.test.tsx:51-58` に、使われていない `jest.mock('@react-native-community/slider', …)` が残っている |
| expo-haptics / expo-image-manipulator | 宣言あり | – | **import も mock も無い** (`apps/mobile`・`packages`・`tests`・`src` の grep 0 件) |
| react-native-url-polyfill | ^2.0.0 | 2.0.0 | **使っている**: `src/lib/supabase.ts:1` と `src/lib/webViewBridge.ts:18` が `react-native-url-polyfill/auto` を import。`__tests__/lib/supabase-config.test.ts:23` が mock |

**設定ファイル**

| ファイル | 事実 |
|---|---|
| `apps/mobile/app.json` | `ios.runtimeVersion` と `android.runtimeVersion` に文字列 `"1.0.0"` を直書き。`updates.enabled: false`・`updates.checkAutomatically: "NEVER"`・`updates.url` あり。`splash` (トップレベル) と `assetBundlePatterns` あり。`plugins` は `expo-router` / `expo-image-picker` / `expo-notifications`。`newArchEnabled` の指定なし (SDK 53 の既定は New Architecture 有効) |
| `apps/mobile/eas.json` | `cli.version ">= 12.0.0"`・`appVersionSource: remote`。`development` (developmentClient・simulator)・`preview` (internal・apk)・`production` (autoIncrement・app-bundle) |
| `apps/mobile/babel.config.js` | `babel-preset-expo` だけ |
| `apps/mobile/metro.config.js` | `expo/metro-config` の既定に、monorepo の `watchFolders` / `nodeModulesPaths` と、`react` / `react-dom` を `apps/mobile/node_modules` から解決する `resolveRequest` (React の二重化の回避) |
| `apps/mobile/jest.config.js` | preset `jest-expo`。`transformIgnorePatterns` を自前の一覧で上書き。`moduleNameMapper` で `react` を `apps/mobile/node_modules`、`react-native` と `react-test-renderer` をルートの `node_modules` に固定。`@homegohan/shared` と `react-native-webview` (stub) の別名 |
| `apps/mobile/jest.setup.js` | `@testing-library/jest-native/extend-expect`・RNTL の `configure`・AsyncStorage の mock・`Alert.alert` の spy |
| `apps/mobile/tsconfig.json` | `expo/tsconfig.base` を継承。`paths.react` を入れ子の `@types/react` に固定 (#1199) |
| ルート `package.json` | `overrides: { "react-native": { "@types/react": "~19.0.10" } }`・`engines.node "22.x"`・`.nvmrc` は `22` |
| `.github/workflows/mobile-test.yml` | `npm ci` → `apps/mobile` で `npm test -- --ci --coverage` → ルートで `npm run test -- --run packages/core`。Node は `'22'` |
| `.github/workflows/security.yml` | `npm audit --omit=dev --audit-level=critical` (critical で止める。high は Summary に数だけ)。`npm-audit-summary.mjs` が表にする |
| `.github/dependabot.yml` | `expo*` / `jest-expo` / `react-native*` / `@react-native*` はパッチ更新だけ許す。`react` / `react-dom` / `react-test-renderer` は無視。コメントに「いまは 19.0.0」 |

**アプリのコードが使っている、上げ先で変わる API** (`git grep`。母集合は `apps/mobile/app` と `apps/mobile/src`)

| 面 | 事実 |
|---|---|
| `expo-file-system` | `app/(tabs)/settings.tsx` と `src/lib/webViewDownload.ts` が `import * as FileSystem from "expo-file-system"` で旧 API (`cacheDirectory` / `documentDirectory` / `writeAsStringAsync` / `makeDirectoryAsync` / `readDirectoryAsync` / `getInfoAsync` / `deleteAsync` / `EncodingType`) を使う。Jest のテスト 12 ファイルが `jest.mock('expo-file-system', …)` (origin/main `307ae1cf` で足された `settings/sessions-entry.test.tsx` と、`d34f18d8` (#1876) で足された `settings/export-rows.test.tsx` を含む)。そのうち 3 ファイルはテスト自身も `import * as FileSystem from 'expo-file-system'` で mock の関数を取り出す (`__tests__/components/WebViewScreen.bridge.test.tsx:91`・`WebViewScreen.download.test.tsx:84`・`__tests__/lib/webViewDownload.test.ts:36`)。テストの `require('expo-file-system')`・`jest.requireActual('expo-file-system')` は 0 件。ルートの vitest の `tests/webview-download-export-limit-contract.test.ts:26` が `vi.mock('expo-file-system', () => ({}))` で `webViewDownload.ts` を読む |
| `as any` | `app/` `src/` に 28 行 (31 か所)・9 ファイル: `(auth)/login.tsx`・`index.tsx`・`onboarding/questions.tsx`・`profile/nutrition-targets.tsx`・`health/blood-tests.tsx` (253・264 行)・`AIAdvisorSheet.tsx`・`V4GenerateModal.tsx`・`useHomeData.ts`・`ProfileProvider.tsx` |
| `react-native` の `SafeAreaView` | `app/handson-tour/index.tsx`・`app/handson-tour/graduate.tsx`・`src/components/ai/AIAdvisorSheet.tsx` の 3 ファイル (ほかは `react-native-safe-area-context` の `SafeAreaView`) |
| `expo-router` | `Stack` / `Tabs` / `Link` / `Redirect` / `router` / `useRouter` / `useNavigation` / `useLocalSearchParams` / `usePathname` / `useSegments` / `useRootNavigationState` / `useNavigationContainerRef`。`(tabs)/_layout.tsx` が `<Tabs.Screen name="settings" options={{ href: null }} />`、`(tabs)/profile.tsx` が `router.push('/(tabs)/settings')`。`app/legal-consent.tsx` が `navigation.addListener("beforeRemove", …)` + `preventDefault()`。`src/components/legal/LegalConsentGate.tsx` が `navigationRef.reset({ index: 0, routes: [{ name: 'legal-consent' }] })`、`src/components/AccountFrozenGate.tsx` (#1861。`f9484bd0`) が `navigationRef.reset({ index: 0, routes: [{ name: FROZEN_SCREEN_ROUTE_NAME }] })`。`navigation.addListener('tabPress' / 'blur')`・`getParent`・`getState`・`isFocused`・`setParams` |
| `react-native-reanimated` | `Animated.View`・`useSharedValue`・`useAnimatedStyle`・`withTiming`・`withSpring` (`{ damping, stiffness }`)・`withDelay`・`withSequence`・`Easing` の 4 ファイル (handson-tour の index / graduate・`src/handson-tour/TourOverlay.tsx` / `Confetti.tsx`) |
| `expo-notifications` | `setNotificationHandler` (`shouldShowBanner` ほか)・`getExpoPushTokenAsync`・`get/requestPermissionsAsync`・`setNotificationChannelAsync`・`AndroidImportance`・`getLastNotificationResponseAsync`・`clearLastNotificationResponseAsync`・`addNotificationResponseReceivedListener` |
| `expo-image-picker` | `launchCameraAsync` / `launchImageLibraryAsync` / `requestCameraPermissionsAsync` / `requestMediaLibraryPermissionsAsync`。`app/health/blood-tests.tsx` の 2 か所が `mediaTypes: ["images"] as any` |
| React Native 0.87 以降で消える・型が変わるもの | `InteractionManager`・`Touchable`・`NativeMethods`・`ImageBackground`・`StatusBar` の `backgroundColor` / `translucent`・`Modal` の `animated`・`react-native/Libraries/*` の深い import: **どれも使っていない** (0 件) |
| `@react-navigation/*` の直接 import | 無し (コメントに 1 か所) |
| `(tabs)` の layout の止め | `app/(tabs)/_layout.tsx` は、`(tabs)` の下の画面 (設定を含む) すべてに 3 つの止めを掛ける: 31 行 `if (!session) return <Redirect href="/" />`・35 行 同意の状態が `loading` / `required` の間はスピナー・46〜48 行 初期設定が済んでいなければ初期設定へ。ルートの Stack の画面 (`app/settings/account.tsx` など) には掛からない (`app/settings/_layout.tsx` は無い) |
| 隠しタブ (設定の画面) | `app/(tabs)/_layout.tsx:119` が `<Tabs.Screen name="settings" options={{ href: null }} />`。expo-router 5.1.11 の `build/layouts/TabsClient.js:24-39` は `href: null` を `tabBarItemStyle: { display: 'none' }` と、`null` を返す `tabBarButton` に展開する (route は `(tabs)` の state に残り、マイページの歯車の `router.push('/(tabs)/settings')` で届く。タブバーにはボタンも枠も出ない) |
| 設定の画面の遷移 | `app/(tabs)/settings.tsx` (origin/main `307ae1cf`): 251 行 `handleLogout` の `router.replace("/")`・324 行「プロフィール」の `router.push("/(tabs)/profile")`・332 / 340 / 375 / 393 / 437 / 446 行の `router.push` (`/health/blood-tests`・`/profile/nutrition-targets`・`AI_CONSENT_SCREEN_PATH`・`/handson-tour?force=1`・`/settings/account`・`/settings/sessions`)。どれも、ルートの Stack の前面が `(tabs)` であること (設定の画面が `(tabs)` の中にあること) を前提に書かれている。ルートの Stack の画面は getId を持たない (`app/_layout.tsx` の 114〜119 行) |
| ルートの `ErrorBoundary` | `app/_layout.tsx:34` はルートの境界 (「再試行」だけ)。`(tabs)` の境界は「ホームへ戻る」(`homeHref="/"`) も出す |

**Jest のテスト** (`apps/mobile/__tests__`: 121 ファイル (origin/main `d34f18d8`。`307ae1cf` では 115 で、`f9484bd0` (#1861) が凍結の 5 本 (`app/frozen-screen`・`components/account-frozen-flow`・`components/account-frozen-gate`・`lib/account-frozen`・`providers/account-frozen-provider`) を、`d34f18d8` (#1876) が `settings/export-rows` を足した)。904f9e8f の後に `settings/data-requests-entry.test.tsx` が、1d69d88b の後に cross/16 の段 B の `settings/sessions-entry.test.tsx`・`settings/sessions.test.tsx`・`lib/device-name.test.ts` が足された)

- 使っている API: `jest.fn` / `jest.mock` / `jest.spyOn` / `jest.useFakeTimers` / `jest.advanceTimersByTime(Async)` / `jest.isolateModules` / `jest.requireActual` / `jest.replaceProperty` / `jest.SpyInstance` 型 / `jest.Mock` 型。Jest 30 で消える別名の matcher (`toBeCalled` / `toThrowError` / `lastCalledWith` …) は **0 件**。`--testPathPattern` の利用は **0 件**。`done` コールバック **0 件**。`@jest-environment` の docblock **0 件**。
- `@testing-library/jest-native` の matcher: `toHaveTextContent` 21・`toBeEnabled` 20・`toBeDisabled` 16・`toContainElement` 4・`toHaveStyle` 2。
- `render(` を使うファイル: 67 (1d69d88b では 60・`0ca17773` では 62・`835fbe7c` では 66。cross/16 の段 B のテスト 2 本と、#1861 のテスト 4 本と、#1876 の `settings/export-rows` が足された)。

**型検査 (`npx tsc -p apps/mobile/tsconfig.json --noEmit`。k270・Node v22.23.3 で実測)**: 6 件 (`src/handson-tour/useTourOverlayLogic.ts` の 3 件 (TS2344・TS2345 ×2)、`src/lib/realtime.ts:42` の TS2339、`lib/slot-builder.ts:14` と `types/domain.ts:6` の TS2307 (`@/types/*` の別名がモバイルの tsconfig に無い))。CI はモバイルの型検査をしていない。

### 2.3 npm audit の実測と、根の advisory

`npm audit --json` (ルート。2026-10-17): total 68 = moderate 21・high 47・critical 0。`--omit=dev`: total 43 = moderate 21・high 22・critical 0。

| 根の advisory | 脆弱な範囲 | 修正版 | いまの経路 (本番の依存の側) | 上げ先 (SDK 58) で |
|---|---|---|---|---|
| braces GHSA-vfj7-8cjw-p6xm (2026-09-18 公開) | ≤ 3.0.3 | **無い** (latest 3.0.3) | `micromatch 4.0.8` ← `metro-file-map 0.82.5` ← `metro` ← `@react-native/community-cli-plugin` ← `react-native`。dev では jest 29 の `jest-haste-map` / `jest-message-util` / `@jest/transform` / `jest-config` と、Web の `fast-glob` ← `eslint-config-next` | **残る**。`metro-file-map 0.87.1` も `micromatch ^4.0.4`。jest 30.5 は `picomatch` / `glob` に移り、jest 側の経路は消える。Web の `fast-glob` の経路は対象外 |
| node-forge GHSA-86w9-cpqp-85rv (2026-09-03 公開) | ≤ 1.4.0 | **無い** (latest 1.4.0) | `@expo/cli 0.24.24` と `@expo/code-signing-certificates 0.0.6` (← `expo-updates`) | **残る**。`@expo/cli 58.1.11` は `node-forge ^1.4.0`、`@expo/code-signing-certificates 0.0.7` も `^1.4.0` |
| image-size GHSA-5p2g-fcmc-qvqq / GHSA-w3rx-r6r6-pgpr | ≥ 0.6.3 ≤ 2.0.2 | 2.0.3 (メジャー) | `metro 0.82.5` → `image-size ^1.0.2` | **消える**。`metro 0.83.8` / `0.87.1` は `image-size` に依存しない |
| postcss GHSA-qx2v-qp2m-jg93 / 6g55-p6wh-862q / fxqj-rqcc-2cmp / r28c-9q8g-f849 | ≤ 8.5.22 | 8.5.23 | `@expo/metro-config 0.20.18` → `postcss ~8.4.32` (入れ子 8.4.49) | **消える**。`@expo/metro-config 58.0.14` は `postcss ^8.5.23` (ルートの 8.5.30 を共有) |

high 47 件の残り 43 件は、この 4 系統に依存の経路で繋がっている「経路のパッケージ」(`expo` / `expo-updates` / `react-native` / `metro*` / `jest*` / `@jest/*` / `babel-jest` / `jest-expo` / `@expo/cli` / `eslint-config-next` …)。`npm audit` の `fixAvailable` は経路の先頭の 1 つを示すだけで、修正版の無い根 (braces・node-forge) までは消せない。

**SDK ごとの比較** (npm registry の各版の `dependencies` から):

| 上げ先 | react-native / react | postcss | image-size | jest 系 | 備考 |
|---|---|---|---|---|---|
| SDK 54 (expo 54.0.37) | 0.81 / 19.1 | **残る** (`@expo/metro-config 54.0.17` は `postcss ~8.4.32`) | 消える (metro 0.83) | 残る (jest-expo 54 は Jest 29 の依存) | Legacy Architecture 対応の最終版 |
| SDK 55 (55.0.31) | 0.83.10 / 19.2.0 | 消える (`^8.5.14`) | 消える | 残る (jest-expo 55.0.22: `babel-jest ^29.2.1` ほか) | New Architecture のみ。Xcode 26 |
| SDK 57 (57.0.30) | 0.86.3 / 19.2.3 | 消える | 消える | 残る (jest-expo 57.0.6: `babel-jest ^29.2.1` ほか) | Hermes V1 |
| **SDK 58 (58.0.14)** | **0.88.0 / 19.3.0** | 消える | 消える | **消える** (jest-expo 58.0.11: `babel-jest ^30` / `@jest/globals ^30` / `jest-environment-jsdom ^30` / `jest-snapshot ^30`。peer `jest ^29 \|\| ^30`) | 2026-10-15 公開の最新。Expo Go (SDK 58) は数週間後 |

jest-expo が Jest 30 の依存で組まれているのは 58 系だけ。Jest 系の high を消すには SDK 58 しかない (jest-expo 58 は peer に `@react-native/jest-preset ^0.88.0` を持ち、react-native 0.88 と組になる)。

**上げ先の実測** (§10.1 の 2 段の手順で作った試作の lockfile を `npm audit --json` で数えた。2026-10-17): total 55 = moderate 33・high 22・critical 0。`--omit=dev`: total 49 = moderate 30・high 19・critical 0。根の advisory は両方とも `braces: GHSA-vfj7-8cjw-p6xm` と `node-forge: GHSA-86w9-cpqp-85rv` の 2 つだけ。high の経路のパッケージは `@expo/cli`・`@expo/code-signing-certificates`・`@expo/metro`・`@expo/metro-config`・`@react-native/community-cli-plugin`・`@react-native/virtualized-lists`・`expo`・`expo-modules-core`・`expo-updates`・`metro`・`metro-config`・`metro-file-map`・`metro-transform-worker`・`micromatch`・`react-native`・`react-native-reanimated`・`react-native-worklets` と、dev の `fast-glob`・`@next/eslint-plugin-next`・`eslint-config-next`。名前が `jest` 系の high は 0。moderate が 21 から 33 に増えるのは、新しい版の依存に付いた moderate で、合否には使わない (CI は critical で止める)。

### 2.4 lockfile の置き場 (作り直しの手順で変わる。実測)

| 作り方 | 結果 |
|---|---|
| origin/main の lockfile に、§6.1 の `package.json` を当てて 1 回で作り直す (素 → ERESOLVE → `--legacy-peer-deps` → 素) | `react-native`・`expo`・`expo-router`・`jest`・`jest-expo`・`metro`・`react-test-renderer`・`react-native-reanimated` が `apps/mobile/node_modules` に入れ子になり、`@react-native/jest-preset`・`@testing-library/react-native`・`react-native-worklets`・`lucide-react-native` はルートに残る。(下の 2 段で、先に SDK 53 の古い木 (`expo-*`・`react-native` 0.79 ほか) を消すとルートに巻き上がるので、古い木が残ったまま新しい版を置くことが原因と見ている。npm の配置の判断の内部までは確かめていない。)`@react-native/jest-preset` の `jest-preset.js` は Node の `require.resolve('react-native')` を自分の場所 (ルート) から引くので、この形では jest-expo の preset の読み込みで止まる (`The React Native Jest preset that jest-expo relies on has moved to a separate package`) |
| §10.1 の 2 段 (先に版を変える依存を宣言から外して古い木を消し、次に §6.1 を当てる) | `apps/mobile/node_modules` の入れ子は `react` 19.3.0 と `@types/react` 19.3.0 の 2 つだけ。ほかのツールチェーン (`react-native` 0.88.0・`@react-native/jest-preset` 0.88.0・`react-test-renderer` 19.3.0・`jest` 30.5.2・`jest-expo` 58.0.11・`expo` 58.0.14・`metro` 0.87.1・`babel-jest` 30.5.2・`typescript` 5.9.3) はルート。ルートの `react` / `react-dom` は 19.2.8 のまま。ルートの `package.json` が宣言する依存 (Web) の解決は 1 つも変わらない。`node_modules/@react-native/jest-preset/node_modules/babel-jest` は無い (overrides で 30 にそろい巻き上がる)。`npm ci --dry-run` が通る |

2 段の形は、いまの main と同じ考え方の置き場 (ルートに `react-native`、モバイルの `apps/mobile/node_modules` には React とその型の入れ子) で、`metro.config.js` の `resolveRequest`・jest の `moduleNameMapper` の `react` の行・tsconfig の `paths.react` がそのまま効く。`react-native` 0.88.0 の peer `react ^19.3.0` は、ルートの `react` 19.2.8 からは満たされない (npm の peer の検査では不整合) が、Node の解決で `react-native` が読む `react` は、Metro では `resolveRequest`、Jest では `moduleNameMapper` の `^react$` がモバイルの 19.3.0 に差し替える。いまの main も `react-native` (ルート) が読む `react` をこの 2 つで差し替えて動いている。

---

## 3. 相 1 外形固定

### 3.1 要件行列

| # | 要件 | 由来 | 満たす場所 |
|---|---|---|---|
| R-1 | 上げ先の版と理由を決める | Issue 本文・設計で決めること | §5・§6 |
| R-2 | image-size・postcss・jest 系の high の経路を消す (`metro-transform-worker` は braces の経路として残る。R-3) | Issue 本文 | §2.3・§10 の V-4 |
| R-3 | 修正版の無い根 (braces・node-forge) は、残ることと経路を明記し、合否から外す | §2.3 の事実 | §2.3・§10 の V-4・§17 |
| R-4 | 壊れる所 (API の廃止・設定・テスト) を全列挙し、直し方を表にする | 設計で決めること | §7 |
| R-5 | `runtimeVersion` の扱いを決め、既存のビルドに OTA で新しい JS が届かないことを固定する | 設計で決めること | §11・§9.7 |
| R-6 | 段分けと検証 (local-ci の mobile:jest・mobile:core・tsc・npm audit の数) を決める | 設計で決めること | §10・§14 |
| R-7 | オーナー作業 (EAS のビルド・提出・実機) との境目を決める | 設計で決めること | §16 |
| R-8 | 本番 (Supabase・HubSpot 等) に触らない。ネイティブのビルドはしない | 制約 | 全体 (本冊はサーバーにも DB にも触れない) |
| R-9 | `@react-native-community/slider` 4.5.7 の扱い (SDK の推奨より上のパッチ) | Issue 本文 | §6.3 (アプリは使っていないので消し、テストに残った mock も消す) |
| R-10 | Dependabot #1589 / #1590 の仕分け | Issue 本文 | §2.1 (どちらも閉。残りは無い) |
| R-11 | `as any` を新しく書かない。業務上の意味を持つ数値は名前付き定数 | 全体の規律 | §7.1 の A-3 (触る `blood-tests.tsx` の `as any` 2 行を外す。ほかの 8 ファイルの 26 行 (29 か所) は本冊が触らないので残る)・§9 |
| R-12 | 既存の番兵 (契約テスト・走査テスト) の追随を全列挙する | 設計の完成条件 | §15.1 |
| R-13 | 上げた後の React とレンダラーの版のずれを番兵で止める | ルート CLAUDE.md「完全に同じ版でないと動かない」 | §9.7 |
| R-14 | Node の最低版 (SDK 58: `^22.13.0 \|\| ^24.3.0 \|\| ^26`) を満たす | SDK 58 の要件 | §6.4 |
| R-15 | 設定の画面 (`(tabs)` の中の隠しタブ) に、expo-router 58 でもマイページの歯車から届く。いまの挙動 (タブバーに設定のボタンも枠も出ない・`(tabs)` の layout の止め・タブバーと FAB・`(tabs)` の境界・設定の画面から出る遷移の並び) を変えない | B-1 (expo-router 58 は `href: null` の route を届かなくする。§2.2) | §7.1 の B-1・§9.10・§8.3 (c) |
| R-16 | lockfile の置き場を決め、作り直しの手順で変わらないようにする (Jest の preset と mapper がルートの `react-native` を前提にする) | §2.4 の実測 | §10.1・§9.11・§9.7 |

### 3.2 ユーザーシナリオ (23 本)

「利用者」はアプリの利用者、「実装者」は本冊の実装、「オーナー」は EAS のビルドと提出をする人。

| # | シナリオ |
|---|---|
| S1 | 実装者が `apps/mobile/package.json` とルートの `overrides` を §6 の版に書き換え、`package-lock.json` を §10.1 の 2 段で作り直す。ルート (Web) の `react` 19.2.8 と `apps/mobile` の `react` 19.3.0 は別の置き場に解決され、ほかのツールチェーンはルートに巻き上がる。Web の依存の解決は変わらない |
| S2 | CI (`mobile-test.yml`) が `npm ci` のあと `apps/mobile` で `npm test -- --ci --coverage` を Jest 30 で流し、123 ファイル (いまの 121 + 新設の `home/tabs-hidden-route.test.ts`・`app/legal-consent-frozen-collapse.test.tsx`) が緑になる |
| S3 | ローカル CI の `mobile:jest` / `mobile:core` が同じ結果を JSON (`numPassedTests` / `numFailedTests`) で返し、`parse jest` が読める |
| S4 | 実装者が `npx tsc -p apps/mobile/tsconfig.json --noEmit` を流す。React Native 0.88 の Strict TypeScript API の既定で新しい型エラーが出ないか見る。段 B の後は既存の 6 件以外は 0 件 (段 A の後だけ、B-2 で消す `app/legal-consent.tsx` の `beforeRemove` の effect の型エラーが加わる。§10 の V-2) |
| S5 | 実装者が `npm audit --json` を流し、根の advisory が braces と node-forge の 2 系統だけになり、image-size と postcss の GHSA と `jest*` / `@jest/*` の経路が無いことを数える |
| S6 | オーナーが `eas build --platform ios --profile preview` を流す。`runtimeVersion` は fingerprint の方針でビルド時に計算され、SDK 53 のビルドの `1.0.0` とは別の値になる |
| S7 | 利用者の端末に残る SDK 53 のビルド (`runtimeVersion` 1.0.0・更新は無効) は、起動しても更新を確認せず (`checkAutomatically: NEVER`・`enabled: false`)、新しい JS が届くことは無い。将来 OTA を有効にしても、fingerprint が違うので SDK 58 の JS は SDK 53 のビルドに届かない |
| S8 | 利用者がマイページの歯車を押す。`router.push('/(tabs)/settings')` で `(tabs)` の中の設定の画面 (隠しタブ) へ切り替わり、ログアウト・通知・退会の行が使える。expo-router 58 でも最初のタブへ戻されない。タブバー (設定のボタンも枠も無い) と AI の FAB は、いまと同じに出る |
| S9 | 同意が要る利用者がログインする。ゲートがルートの Stack の持ち主の state から「同意画面 1 つ」の完全な state を作って `reset` し、Stack が同意画面だけになる。ログイン直後の `routeAfterSignIn` の `replace` は、同意画面の `usePreventRemove` が止める |
| S10 | 同意画面で Android の戻るボタンを押す。Stack の唯一の route なので OS に渡り、アプリが背面へ移る。iOS のスワイプは `gestureEnabled: false` |
| S11 | 利用者が Web の同意画面で同意する。合図 `legal-consent-accepted` で state が `clear` になり、同意画面の止めが外れ、ゲートが `router.replace('/')` で入口へ移す |
| S12 | 同意を待つ間に Web で「同意しない」を押してログアウトした。同意画面は案内と「閉じる」を出し、取り除く操作を全部止める。「閉じる」で止めを解いて入口へ移る |
| S13 | 利用者が設定の「データの書き出し (JSON)」を押す。`expo-file-system/legacy` の `writeAsStringAsync` で書き、`expo-sharing` で共有する |
| S14 | 利用者がハンズオンツアーの最初の画面と卒業の画面を Android 16 の端末で開く。edge-to-edge が強制されるので、`react-native-safe-area-context` の `SafeAreaView` が上下の余白を取り、文字が status bar の下に潜らない。Reanimated 4 の `withTiming` / `withSpring` でバッジが動く |
| S15 | 利用者が血液検査の画面でカメラ/ライブラリから写真を選ぶ。`expo-image-picker` 58 の `mediaTypes: ["images"]` は型が付くので `as any` が無い |
| S16 | 前面で Push 通知が届く。`setNotificationHandler` が `shouldShowBanner: true` を返すので表示される (SDK 58 の既定も表示)。通知をタップすると `NotificationRouter` が `getLastNotificationResponseAsync` / `clearLastNotificationResponseAsync` で行き先へ移す |
| S17 | Dependabot が `react-native` のパッチ更新 (例 0.88.1) の PR を出す。`tests/mobile-toolchain-contract.test.ts` が、`react-native` と `react` が `expo/bundledNativeModules.json` の版と一致しないので赤にし、SDK ごとの組で上げるよう促す |
| S18 | 実装者が `npx expo install --check` と `npx expo-doctor@latest` を流す。`--check` は `typescript` だけを `expo.install.exclude` で外し (§6.4)、「Dependencies are up to date」(ほかのずれ 0 件)、expo-doctor は app.json のスキーマ (SDK 58 に無い `splash` を消し、`assetBundlePatterns` を消した) を通る (20 項目のうち 19 が通る。残る 1 項目「重複する依存」は `react` (モバイル 19.3.0・ルート 19.2.8) を挙げる。Web と別の React を持つ設計 (§6.1・C-7) なので、既知の項目として PR の本文に文面を写す) |
| S19 | 利用者が設定の画面を開いている間に session が切れる (トークンの更新の失敗・退会)。`(tabs)` の layout の `<Redirect href="/" />` が入口へ移す (いまと同じ) |
| S20 | 利用者が設定の画面の「プロフィール」を押す。`(tabs)` の中でマイページのタブへ切り替わる (いまと同じ) |
| S21 | 利用者が設定の画面でログアウトし、続けて同じ端末でログインし直す。ログアウトで入口だけになり、ログインの後はタブ 1 組 (`(tabs)` が 1 つ) だけになる (いまと同じ) |
| S22 | 利用者が設定の画面の「使い方ガイドをもう一度見る」を押す。Stack は [(tabs), ツアー] になる (いまと同じ) |
| S23 | 同意が要る利用者が同意画面にいる間に、アカウントが凍結される (#1861。同意画面の表示中に /api が 403 AUTH_ACCOUNT_FROZEN を返す・凍結の判定が同意の判定より遅れて届く)。Stack は凍結の画面 1 つになる (同意画面は残らない。凍結が先) |
---

## 4. 相 2 構想

### 4.1 構造 (発明相の結論)

1. **一度に SDK 58 へ上げる** (54 → 55 → … と段階を踏まない)。Expo の changelog (54・55・56・57・58) の破壊的変更を §7 に全部列挙し、各版の差を本冊で吸収する。ネイティブのビルドは 1 回で済み、中間の版でビルドして確かめる工程を置かない。
2. **版は `expo/bundledNativeModules.json` (58.0.14) の逐語**。`npx expo install --fix` の結果と同じ版を `package.json` に手で書き、`package-lock.json` を `--package-lock-only` の **2 段** で作り直す (先に版を変える依存を宣言から外して古い木を消し、次に §6.1 を当てる。1 回で作ると置き場が崩れる。§2.4・§10.1)。置き場は V-1 の検査 (§9.11) と番兵 (§9.7) で固定する。
3. **React は入れ子のまま** (ルート 19.2.8 / モバイル 19.3.0)。`metro.config.js` の `resolveRequest` と jest の `moduleNameMapper` の `react` / `react-test-renderer` の行は残し、コメントを現在形にする。jest の `moduleNameMapper` の `react-native` の 2 行は消し、`@react-native/jest-preset` と jest-expo の preset の別名 (`react-native/setup-env` などの exports だけの入口を含む) に任せる (§5.2・§7.2 の C-9)。
4. **Jest は 30.5 + jest-expo 58 + `@react-native/jest-preset` 0.88**。`@react-native/jest-preset` が持つ Jest 29 の依存 (`babel-jest` / `jest-environment-node`) はルートの `overrides` で 30 にそろえ、jest 29 の経路を lockfile から消す (§6.2)。jest-expo 58 自身は `babel-jest` と環境を自分の Jest 30 の依存から `require.resolve` するので、実行時は overrides の有無に依らず Jest 30 で動く。
5. **RNTL は 13.3.3 のまま、`react-test-renderer` を 19.3.0 (React と同じ版) に固定**。RNTL 14 は別案件 (§0.2)。
6. **expo-router 58 への追随は 2 か所だけ**: 設定の画面は `(tabs)` の中の隠しタブのまま、`(tabs)/_layout.tsx` の `href: null` (58 では届かない route になる) を `tabBarButton: () => null` と `tabBarItemStyle: { display: "none" }` に書き換える (expo-router 5 が `href: null` を中で展開していた形と同じ。§9.10) / 同意画面の止めを `usePreventRemove` に、ゲートの畳み直しを完全な state (持ち主の navigator の `key` / `routeNames` / `routeKeySeq` / `type` を写し `stale: false`。同意画面の route があれば `key` ごと再利用) の RESET の action を持ち主に宛てて `dispatch` する形にする。
7. **API の置き換えは 3 種**: `expo-file-system` → `expo-file-system/legacy` (2 ファイル + mock 12 ファイル) / `react-native` の `SafeAreaView` → `react-native-safe-area-context` (3 ファイル) / `mediaTypes` の `as any` を外す (2 か所)。
8. **`runtimeVersion` は fingerprint の方針をトップレベルに置き、更新は無効のまま**。番兵が固定する (§11・§9.7)。
9. **使っていない依存 3 つを消す** (`@react-native-community/slider`・`expo-haptics`・`expo-image-manipulator`。slider はテストに残った mock も消す)。`react-native-url-polyfill` は使っているので残す (版も変えない)。`@expo/vector-icons` (expo 58 が依存しなくなった) と `react-native-worklets` (Reanimated 4 の peer) と `@react-native/jest-preset` を新しく宣言する。
10. **段 A (依存と設定・API の置き換え) → 段 B (expo-router 58 への追随) → 段 C (番兵・README)** を 1 本の WF で直列に積み、マージは最後に 1 回。設計正典の追随 (`mobile/01`・`mobile/CLAUDE.md`・`cross/13b`・`00-architecture`・ルート `CLAUDE.md`) はオーケストレーターの専権 PATCH (§15.2)。

### 4.2 シナリオのトレース (上の構造で手で走らせたもの)

| # | トレース |
|---|---|
| S1 | `apps/mobile/package.json` を §6.1 に、ルート `package.json` の `overrides` を §6.2 にする → commit → offload の行き先で §10.1 の 2 段 (1 段目: 版を変える依存と消す依存を宣言から外した `apps/mobile/package.json` で `--legacy-peer-deps` の作り直し = 古い SDK 53 の木が消える / 2 段目: §6.1 に戻して素 → ERESOLVE なら `--legacy-peer-deps` → 素) → `package-lock.json` を持ち帰る → §9.11 の V-1 の検査: ルートに `react-native` 0.88.0・`@react-native/jest-preset` 0.88.0・`react-test-renderer` 19.3.0・`jest` 30 系・`jest-expo` 58 系・`expo` 58 系・`babel-jest` 30 系、`apps/mobile/node_modules` の入れ子は `react` 19.3.0 と `@types/react` 19.3 系の 2 つだけ、`node_modules/image-size` と `node_modules/@expo/metro-config/node_modules/postcss` が無い、ルートが宣言する依存 (Web) の版が origin/main と同じ → `V-1 OK` (§2.4 の実測と同じ形) |
| S2 | `npm ci` が lockfile どおりに入れる → `jest-expo` 58 の preset が `@react-native/jest-preset` (0.88.0。ルート) を読み、その preset が `require.resolve('react-native')` でルートの `react-native` を引いて別名 (`^react-native/setup-env$` などの exports だけの入口と、`^react-native($\|/.*)` の総称) を絶対パスで作る。`babel-jest` と環境は jest-expo 自身の Jest 30 の依存を `require.resolve` → `jest.config.js` の `moduleNameMapper` は `react` (モバイルの 19.3.0)・`react-test-renderer` (ルートの 19.3.0)・`@homegohan/shared`・`react-native-webview` だけを持ち、`react-native` は preset の別名で解決される → `jest.setup.js` が worklets の mock と Reanimated の `setUpTests()`・jest-native・RNTL の `configure` を入れる → 116 ファイル (いまの 115 + 新設の `home/tabs-hidden-route.test.ts`) が流れ、`--coverage` (babel-plugin-istanbul 8) も出る |
| S3 | `stage_mobile` は `npm test --silent -- --listTests --json` と `npm test -- --ci --coverage --json --outputFile=…` を流す。Jest 30 の JSON も `testResults` / `numPassedTests` / `numFailedTests` / `numPendingTests` を持つので `parse jest` は変えない |
| S4 | `expo/tsconfig.base` (58) は `module: preserve`・`moduleResolution: bundler`・`customConditions: ["react-native"]`・`${configDir}` (TypeScript 5.5 以降) → モバイルの `typescript ~5.9.3` で読める。`react-native/Libraries/*` の深い import は 0 件なので Strict API で消える型は無い。`SafeAreaView` を `react-native-safe-area-context` から読むと `edges` 付きの型になる。`mediaTypes: ["images"]` は `MediaType[]` で通る → 段 A の後は、既存の 6 件に `app/legal-consent.tsx` の `beforeRemove` の effect (いまの 63〜69 行) の型エラーが加わる: expo-router 58 の `useNavigation()` の既定の型 (`build/useNavigation.d.ts:55`) は `NavigationProp<ReactNavigation.RootParamList>` (の `getState` を差し替えた型。イベントの型引数は既定の `{}`) で、`addListener` の第 1 引数は `EventMapCore` のキー (`focus`・`blur`・`state`・`removePrevented`・`removed`。`build/react-navigation/core/types.d.ts:74-112`・`addListener` は 141 行) だけになり、`beforeRemove` が無い → 段 B の B-2 がこの effect を `usePreventRemove` に替える → 既存の 6 件だけ残る |
| S5 | `npm audit --json` の `vulnerabilities` を走査 → `via` にオブジェクトを持つ項目 = `braces` と `node-forge` だけ → `image-size`・`postcss` の項目が無い → 名前が `jest` / `@jest/` / `babel-jest` / `create-jest` / `expect` / `jest-expo` で始まる high が無い → 合格 (§10 の V-4)。high の総数 (§2.3 の実測で 22。`--omit=dev` で 19。経路は §2.3 の一覧) は PR の本文に写す |
| S6 | `app.json` の `runtimeVersion: { "policy": "fingerprint" }` → EAS が `@expo/fingerprint` (expo 58 の依存) でネイティブに効く依存と設定のハッシュを計算し、ビルドの runtime version にする。`expo.version` の変更はハッシュに入らない (SDK 58) |
| S7 | SDK 53 のビルド: `updates.enabled: false` のため `Updates.isEnabled` は false で埋め込みの JS だけを読む。`checkAutomatically: NEVER` のため起動時の確認もしない。更新を公開する操作 (`eas update`) は本冊に無い (R-8)。将来 `enabled: true` にしても、SDK 58 のビルドの fingerprint と `1.0.0` は一致しない |
| S8 | `(tabs)/profile.tsx` の `router.push('/(tabs)/settings')` → expo-router 58 の `resolveNavigationDestination` は、ルートの Stack の前面 (`(tabs)`) と行き先の名前が同じなので `(tabs)` の navigator へ降りる (`build/global-state/resolveNavigationDestination.js`) → TabRouter は PUSH を NAVIGATE と同じくタブの切り替えとして扱う (`build/react-navigation/routers/TabRouter.js:339-342`) → 前面のタブが `settings` → `useVisibleTabsWithRedirect` は `layout` で宣言済みで `options.hidden !== true` の route をタブの一覧に残す (`build/standard-navigation/useVisibleTabsWithRedirect.js:35-40`)。`settings` の options は `tabBarButton` と `tabBarItemStyle` だけで、TabsClient の `processScreens` は `href` の無い画面をそのまま通す (`build/layouts/TabsClient.js:85-127`) ので `hidden` が付かない → 一覧に残り、前面の route が一覧にあるので最初のタブへの `router.replace` は流れない (同 81〜88 行) → 設定の画面が描かれる。タブバーは一覧の route ごとに項目を描くが、`settings` の項目は外側の View が `tabBarItemStyle` の `display: 'none'` で枠を取らず (`build/react-navigation/bottom-tabs/views/BottomTabBar.js:372-377`)、ボタンは `tabBarButton` の戻り値 `null` だけを描く (`BottomTabItem.js:132`) ので何も出ない。`(tabs)` の layout の止め・FAB・境界はいまと同じ。`href: null` のままだと、`processScreens` が `hidden: true` に置き換え (同 91〜99 行)、`settings` が一覧から外れ、前面になった直後に最初のタブ (ホーム) へ `router.replace` される |
| S9 | state が `required`・前面が `(tabs)`・pathname `/home` → ゲート: `findNavigatorOwningRoute(navigationRef.getRootState(), 'legal-consent')` が前面の枝を降り、`routeNames` に `legal-consent` を持つ navigator (ルートの Stack。`key` は `navigator:root`) の state を取る → `collapseStackAction` が `{ type: 'RESET', target: 'navigator:root', payload: { key: 'navigator:root', index: 0, routeKeySeq: <持ち主の値>, routeNames: <持ち主の値の写し>, type: 'stack', stale: false, routes: [{ name: 'legal-consent' }] } }` を作る (同意画面の route が無いので名前だけ) → `navigationRef.dispatch(…)` (58 では commit の後に流れる) → expo-router 58 の `BaseRouter` の RESET: `routes` の名前が `routeNames` にあり、`stale === false` で `routeNames` が持ち主と同じ集合 → 受け付け、key の無い route に `legal-consent:<連番>` を付ける (§9.4 の後の実測) → Stack が [同意画面] → `openedRef` を立てる。`routeAfterSignIn` の `router.replace('/onboarding/welcome')` が後から流れると、同意画面の `usePreventRemove(true)` が REPLACE を止める (callback は `repeat` を呼ばず捨てる) |
| S10 | Stack の route が 1 つなので `canGoBack()` は false → コンテナは `BackHandler` で OS に渡す → アプリが背面へ。`usePreventRemove` は呼ばれない (取り除く操作が無い)。iOS は `gestureEnabled: false` |
| S11 | `clear` → 同意画面: `legalConsentScreenPreventsRemoval('free', false, false)` = false → ゲート: 前面が同意画面で `clear` → `refreshProfile()` → `canGoBack()` false → `router.replace('/')` → REPLACE は止められず [入口] → 入口が profile から振り分ける |
| S12 | session 無し・`sawRequired` → `signed-out-notice` → `usePreventRemove(true)`。「閉じる」: `closingRef` を立て、`setClosing(true)` (次の描画で `preventRemove` が false)、返り値の `disablePrevention()` を呼び、`router.canGoBack()` ? `back()` : `replace('/')` → 止められずに入口へ |
| S13 | `app/(tabs)/settings.tsx` の `import * as FileSystem from "expo-file-system/legacy"` → `FileSystem.documentDirectory` / `writeAsStringAsync` は SDK 58 の `expo-file-system/legacy` にある (exports に `./legacy`) → `Sharing.shareAsync` |
| S14 | `app/handson-tour/index.tsx` の `SafeAreaView` を `react-native-safe-area-context` から読む (既定の edges = 上下左右) → Android の edge-to-edge でも inset を取る。Reanimated 4.7.1 の `withSpring(1, { damping: 10, stiffness: 100 })` は 4 系でも同じ引数 (`restDisplacementThreshold` / `restSpeedThreshold` / `duration` は使っていない)。`babel-preset-expo` 58 が `react-native-worklets/plugin` を自動で入れる |
| S15 | `expo-image-picker` 58 の `ImagePickerOptions.mediaTypes` は `MediaType \| MediaType[]` (`'images'` を含む) → `mediaTypes: ["images"]` で型が通る |
| S16 | `expo-notifications` 58: `setNotificationHandler` / `getLastNotificationResponseAsync` / `clearLastNotificationResponseAsync` / `addNotificationResponseReceivedListener` はいずれも SDK 58 の API 一覧にあり非推奨でない (`shouldShowAlert` だけ非推奨で、使っていない)。前面の通知は handler が返す `shouldShowBanner: true` で出る |
| S17 | Dependabot の PR は `apps/mobile/package.json` の `react-native` を `0.88.1` に、lockfile も変える → `tests/mobile-toolchain-contract.test.ts`: `react-native` の宣言 ≠ `node_modules/expo/bundledNativeModules.json` の `react-native` (`0.88.0`) → 赤 → PR のマージはできず、SDK の更新 (expo も一緒) で上げる |
| S18 | `npx expo install --check` は `bundledNativeModules.json` と Expo の API の `relatedPackages` を `package.json` と突き合わせる → `typescript` は `expo.install.exclude` で外れ (「Skipped checking dependencies: typescript」)、ほかは全部一致 (§6.1 は逐語なので) → `npx expo-doctor@latest` は app.json をスキーマで検査 (SDK 58 のスキーマに `splash` は無い・`assetBundlePatterns` は非推奨) → どちらも消してあるので通る。「重複する依存」の項目は、入れ子の `react` (JS。Web 用のルートの 19.2.8 とモバイルの 19.3.0。Metro の `resolveRequest` がモバイル側に固定する) を挙げて 1 項目だけ通らない (実測 2026-10-18。ネイティブモジュールの重複ではない) |
| S19 | 前面が `(tabs)` の設定の画面。`AuthProvider` が session を失う → `(tabs)/_layout.tsx:31` の `<Redirect href="/" />` → ルートの Stack の前面 (`(tabs)`) と行き先 (`index`) の名前が違うのでルートの Stack の REPLACE → [入口] → 入口が未ログインの行き先へ (いまと同じ) |
| S20 | 「プロフィール」の行の `router.push("/(tabs)/profile")` → S8 と同じく `(tabs)` の navigator へ降り、TabRouter がマイページのタブへ切り替える → [(tabs) (マイページ)] (いまと同じ) |
| S21 | ログアウト: `handleLogout` の `router.replace("/")` → ルートの Stack の前面 (`(tabs)`) を入口に置き換える → [入口]。ログイン: 入口の `<Redirect href="/(tabs)/home" />` → 入口を `(tabs)` に置き換える → [(tabs)] (1 組。いまと同じ) |
| S22 | 「使い方ガイドをもう一度見る」の行の `router.push("/handson-tour?force=1")` → ルートの Stack の前面 (`(tabs)`) と行き先 (`handson-tour`) の名前が違うので、ルートの Stack に PUSH → [(tabs), handson-tour] (`force=1` で `entrySource = 'settings_force'`。いまと同じ) |
| S23 | 同意画面: `required`・サインイン中 → awaiting-consent。凍結の状態が `frozen` になった描画で `legalConsentScreenPreventsRemoval('awaiting-consent', false, true)` = false (`usePreventRemove` の止めを解く。layout effect なので、同じ commit の凍結のゲートの effect より先に効く) → 凍結のゲート: 前面が同意画面 (`/legal-consent` は凍結の対象外のパスでない)・`openedRef` なし → `findNavigatorOwningRoute(…, 'frozen')` → `collapseStackAction(owner, 'frozen')` を dispatch → 同意画面の route は取り除かれるが、止めていないので受け付けられる → [frozen]。同意のゲートは凍結中は何もしない。同意画面が止めたままなら 58 は RESET を捨て、`openedRef` だけが立って同意画面に残る (§8.3 (b)・(e) の ③) |
---

## 5. 相 3 構造裁定 (1 回だけ)

### 5.1 代替案の比較

| 案 | 内容 | 利点 | 欠点 | 判定 |
|---|---|---|---|---|
| A | SDK 55 (仕様の下調べの起点) | SDK 55 は postcss・image-size を消す最小の版 | jest 系の high が全部残る (jest-expo 55 は Jest 29)。公開から 3 つ後の版が出ている。Xcode 26 の要件は同じ | 却下 |
| B | SDK 57 (安定して半年近い版) | Hermes V1 の回帰 (メモリ) が直った版。SDK 58 より実績がある | jest 系の high が残る (jest-expo 57 も Jest 29)。Jest 30 にするには jest-expo の依存を `overrides` で無理に 30 にすることになり、サポート外 | 却下 |
| **C** | **SDK 58 (最新。本冊)** | jest 系の high が消える唯一の版。Expo の最新で、Expo Go / EAS / expo-doctor の前提と一致する。ネイティブのビルドは 1 回 | 公開 2 日目 (2026-10-15)。expo-router の内部が作り直され (§7.1 の B)、追随が 2 か所。RNTL 14 を expo-router が任意の peer として求める (使わない) | **採用** |
| D | 段階的 (53 → 54 → 55 → … → 58 を 1 版ずつビルドして確かめる) | 各版の changelog を 1 つずつ当てられる | ネイティブのビルドと実機の確認が 5 回。中間の版に意味は無い (載せるのは 58 だけ)。changelog は本冊で全部読んで §7 に畳んだ | 却下 |
| E | Jest だけ先に 30 にする (expo は 53 のまま) | 小さい PR | jest-expo 53 は Jest 29 の依存で組まれていて、Jest 30 と混ぜると `@jest/transform` / `jest-haste-map` 29 が残る (high も消えない) | 却下 |
| F | RNTL 14 を同時に入れる | expo-router 58 の任意の peer と expo-router/testing-library の要件 (≥ 14) を満たす | `render` / `fireEvent` / `act` が Promise になり 67 ファイルを書き換える。本冊の差分が「ツールチェーン」から「テストの書き方」に広がる | 却下 (別案件) |

設定の画面 (隠しタブ) の扱い (B-1) の代替案:

| 案 | 内容 | 利点 | 欠点 | 判定 |
|---|---|---|---|---|
| **G** | **`(tabs)` の中に残し、`href: null` を `tabBarButton: () => null` と `tabBarItemStyle: { display: "none" }` に (本冊)** | expo-router 5 の `href: null` の展開と同じ形で、いまの構造・挙動・番兵・ほかの設計書がそのまま。差分は `(tabs)/_layout.tsx` の 1 行とコメント (と `(tabs)/profile.tsx` のコメント 1 行) とテスト | expo-router 58 の `processScreens` と `useVisibleTabsWithRedirect` の実装に依る (公式の「タブを隠す」手引きは 58 で書き換え待ち: `build/layouts/TabsClient.js:92` の TODO)。依る所は `home/tabs-hidden-route.test.ts` が実物で見張る | **採用** |
| H | 設定の画面をルートの Stack の画面 (`app/settings/index.tsx`) にする | expo-router 58 の手引きの「宣言した画面だけを出す」に沿う | `(tabs)` の layout の止め (session・同意・初期設定) を画面に持たせ直し、設定の画面から出る遷移 (プロフィール・使い方ガイド・ログアウト・session の切れ) の Stack の並びを直し、タブバーと FAB・境界の「ホームへ戻る」・通知のタップの積み方が変わる (発注に無い挙動の変化)。設定の画面のパスを名指しする番兵 (`tests/` の 5 本と `handson-tour-files-structure-doc`・Web の FAQ のテスト・Jest の `route-targets-exist`・`date-basis-jst`) と設計書 (`mobile/CLAUDE.md`・`mobile/01`・`mobile/03`・`mobile/05`・`cross/05`・`cross/16`・`family/09` の 3 冊) の追随 | 却下 |
| I | マイページのタブの中に Stack を置き、設定をその上に積む | 設定の画面が `(tabs)` の中に残る | マイページの画面の移設 (`(tabs)/profile/index.tsx`)・タブの画面の一覧の番兵の追随・タブの中の Stack に WebView を置くことの実機の確認が要る。G より差分が大きい | 却下 |

### 5.2 「縁の発生源を消すより単純な構造は無いか」

| 縁 | 消せるか | 判断 |
|---|---|---|
| React の二重化 (ルート 19.2.x と モバイル 19.3.0)。`metro.config.js` の `resolveRequest`・jest の `moduleNameMapper` の `react` の行・tsconfig の `paths.react`・ルートの `overrides` がこのために在る | 消すには Web (Next 16.4.1) とモバイル (react-native 0.88.0 のレンダラーが要求する 19.3.0 と完全に同じ版) の `react` をそろえる必要がある。Web の `react` を 19.3.0 の固定にすると、Web の更新がモバイルの SDK に縛られる (逆も)。いまの Next 16.4.1 と React 19.3 の組は未検証 | **消さない**。二重化は残し、固定の仕組み (4 か所) は版だけ更新する。番兵 (§9.7) で「モバイルの `react` = bundledNativeModules の `react` = `react-test-renderer`」と lockfile の置き場を固定し、ずれの発生を止める |
| lockfile の置き場が作り直しの手順で変わる (§2.4。1 回で作ると `react-native` ほかが入れ子になり、ルートの `@react-native/jest-preset` から `react-native` が見えない) | 置き場を npm に指示する仕組み (nohoist) は npm に無い。手順 (2 段) で古い木を先に消せば、いまの main と同じ置き場になる | 手順で固定する (§10.1)。作った後は V-1 の検査 (§9.11) で、マージ後は番兵 (§9.7) で置き場を見張る。lockfile を手で直さない |
| jest 29 の経路 (`@react-native/jest-preset` の依存) | `overrides` で 30 にそろえれば lockfile から消える (実行時は jest-expo が自分の 30 を使うので挙動は変わらない) | 消す (§6.2) |
| 根の advisory (braces・node-forge) | 上流に修正版が無い。`metro-file-map` と `@expo/cli` を使わない構造は Expo を使わない構造 | 消せない。残ることを合否の外に置き (§10 の V-4)、修正版が出たら Dependabot のパッチ更新で入る |
| `(tabs)` の中の隠しタブ (settings) | 58 の `processScreens` は `href: null` を `hidden: true` に置き換え、hidden の route は届かない (§9.10)。ただし expo-router 5 も `href: null` を `tabBarItemStyle: { display: 'none' }` と `null` を返す `tabBarButton` に展開していた (§2.2) ので、その 2 つを直接書けば hidden を通らず、いまと同じ形になる。隠しタブの形を消して画面を `(tabs)` の外へ出すと、`(tabs)` の layout の止め・遷移の並び・FAB・境界・通知のタップが変わる (§5.1 の H) | 消さない (§7.1 の B-1)。残る縁は「58 の `processScreens` が `href` の無い画面を hidden にしない」こと 1 つで、`home/tabs-hidden-route.test.ts` (T-TB1〜T-TB3) が実物の expo-router で見張る |
| 同意画面の「RESET だけ通す」規則 (13b) | ゲートの `reset` が同意画面の route を `key` ごと再利用すれば、同意画面は取り除かれず、RESET を通す規則そのものが要らない | 消す (§7.1 の B-2)。残る縁は「取り除く操作は全部止める / 自分で閉じるときだけ解く」の 1 つ |

### 5.3 確定した構造

§4.1 の 10 点を確定する。以後の周で上げ先の版 (SDK 58) と段分け (A → B → C・1 PR) は蒸し返さない。仕上げ中に出る指摘は、§6〜§15 の表のセルに対して行う。

---

## 6. 上げ先の版 (正典)

### 6.1 `apps/mobile/package.json` (全文。逐語)

```json
{
  "name": "homegohan-mobile",
  "version": "0.1.0",
  "private": true,
  "main": "expo-router/entry",
  "scripts": {
    "start": "expo start",
    "android": "expo start --android",
    "ios": "expo start --ios",
    "web": "expo start --web",
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage",
    "test:e2e:smoke": "maestro test maestro/smoke.yaml"
  },
  "dependencies": {
    "@expo-google-fonts/noto-sans-jp": "^0.4.4",
    "@expo/vector-icons": "^15.0.2",
    "@homegohan/core": "*",
    "@homegohan/handson-tour-shared": "*",
    "@homegohan/shared": "*",
    "@react-native-async-storage/async-storage": "2.2.0",
    "@react-native-masked-view/masked-view": "0.3.2",
    "@supabase/supabase-js": "^2.117.3",
    "expo": "~58.0.14",
    "expo-constants": "~58.0.12",
    "expo-device": "~58.0.5",
    "expo-file-system": "~58.0.9",
    "expo-font": "~58.0.8",
    "expo-image-picker": "~58.0.10",
    "expo-linear-gradient": "~58.0.3",
    "expo-linking": "~58.0.13",
    "expo-notifications": "~58.1.5",
    "expo-router": "~58.0.23",
    "expo-secure-store": "~58.0.2",
    "expo-sharing": "~58.0.19",
    "expo-splash-screen": "~58.0.10",
    "expo-updates": "~58.0.17",
    "expo-web-browser": "~58.0.6",
    "lucide-react-native": "^1.14.0",
    "react": "19.3.0",
    "react-native": "0.88.0",
    "react-native-reanimated": "4.7.1",
    "react-native-safe-area-context": "~5.10.1",
    "react-native-screens": "~4.30.0",
    "react-native-svg": "15.16.0",
    "react-native-url-polyfill": "^2.0.0",
    "react-native-web": "~0.21.4",
    "react-native-webview": "14.0.1",
    "react-native-worklets": "0.13.0",
    "zod": "^4.6.7"
  },
  "devDependencies": {
    "@react-native/jest-preset": "0.88.0",
    "@testing-library/jest-native": "^5.4.3",
    "@testing-library/react-native": "^13.3.3",
    "@types/jest": "^30.0.0",
    "@types/react": "~19.3.0",
    "jest": "~30.5.2",
    "jest-expo": "~58.0.11",
    "react-test-renderer": "19.3.0",
    "resolve-from": "^5.0.0",
    "typescript": "~5.9.3"
  },
  "expo": {
    "install": {
      "exclude": [
        "typescript"
      ]
    }
  }
}
```

| 行 | 根拠 |
|---|---|
| `expo` 〜 `react-native-webview`・`react` / `react-native` / `react-native-reanimated` / `react-native-worklets` / `jest-expo` | expo 58.0.14 の `bundledNativeModules.json` の値をそのまま (`expo` 自身は latest の 58.0.14 を `~` で) |
| `@expo/vector-icons ^15.0.2` | 新規。expo 56 以降 `expo` が `@expo/vector-icons` に依存しない (SDK 56 changelog)。アプリは 22 ファイルで `Ionicons` を使う。bundledNativeModules の値 |
| `react-native-worklets 0.13.0` | 新規。`react-native-reanimated 4.7.1` の peer (`0.13.x`)。`babel-preset-expo` 58 が入っていれば自動で `react-native-worklets/plugin` を入れる (`babel.config.js` は変えない) |
| `@react-native/jest-preset 0.88.0` | 新規 (dev)。`jest-expo 58.0.11` の必須の peer (`^0.88.0`)。React Native 0.85 で `react-native` から分かれた |
| `jest ~30.5.2` | Jest 30 の latest。jest-expo 58 の peer `^29 \|\| ^30` のうち 30 (高い経路を消す側) |
| `react-test-renderer 19.3.0` | RNTL 13.3.3 の peer。React と「完全に同じ版」(レンダラーは `React.version` と自分の版が一致しないと `Incompatible React versions` で止まる)。`^` を付けない |
| `@types/react ~19.3.0` | React 19.3 の型 (DefinitelyTyped の latest 19.3.0)。ルート (19.2.18) と違うので入れ子になり、tsconfig の `paths.react` の固定を続ける (番兵 `tests/react-types-version-contract.test.ts` の条件と同じ) |
| `typescript ~5.9.3` | ルートと同じ (§10.1 の 2 段でルートの 5.9.3 にまとまり、入れ子の 5.8.3 が消える。§2.4)。`expo/tsconfig.base` (58) の `${configDir}` は TypeScript 5.5 以降。Jest 30 の型は 5.4 以降 |
| `expo.install.exclude: ["typescript"]` | 新規。`expo install --check` (V-6) から `typescript` だけを外す。SDK 58 の `--check` は `bundledNativeModules.json` に加えて Expo の API の `relatedPackages` (`sdkVersions['58.0.0'].relatedPackages.typescript` = `~6.0.3`) とも突き合わせ、5.9.3 をずれとして報告する。ルートと同じ 5.9.3 に据え置く (§6.4) ため外す。ほかの依存は外さない (番兵 §9.7 が `exclude` を `["typescript"]` に固定する) |
| `@testing-library/react-native ^13.3.3`・`@testing-library/jest-native ^5.4.3`・`@types/jest ^30.0.0`・`resolve-from`・`zod`・`@supabase/supabase-js`・`@homegohan/*`・`lucide-react-native`・`@expo-google-fonts/noto-sans-jp`・`react-native-url-polyfill ^2.0.0` | 変えない (zod はルートと同じ範囲でないと `tests/zod-single-copy-1444.test.ts` が赤。`react-native-url-polyfill` は `src/lib/supabase.ts` と `src/lib/webViewBridge.ts` が読む) |
| 消す行 | `@react-native-community/slider` / `expo-haptics` / `expo-image-manipulator` (§6.3) |

### 6.2 ルート `package.json` の `overrides` (逐語)

```json
"overrides": {
  "react-native": {
    "@types/react": "~19.3.0"
  },
  "@react-native/jest-preset": {
    "babel-jest": "~30.5.2",
    "jest-environment-node": "~30.5.2"
  }
}
```

| 行 | 根拠 |
|---|---|
| `react-native` → `@types/react ~19.3.0` | 既存の行の版の更新 (react-native 0.88.0 の任意の peer `@types/react ^19.1.1` をモバイルの型に合わせる) |
| `@react-native/jest-preset` → `babel-jest` / `jest-environment-node` を `~30.5.2` | `@react-native/jest-preset 0.88.0` は `babel-jest ^29.7.0`・`jest-environment-node ^29.7.0` を宣言していて、そのままだと `@jest/transform 29` → `jest-haste-map 29` → `micromatch` → `braces` と、`@jest/environment 29` → `@jest/fake-timers 29` → `jest-message-util 29` → `micromatch` の 2 経路が lockfile に残る。jest-expo 58 の preset は `babel-jest` を自分の依存から `require.resolve` し、環境も自分の `nativeEnvironment.js` (jest-expo の Jest 30 の `jest-environment-node` を継承) に差し替えるので、この 2 つの入れ子の 29 は実行時に読まれない。`@jest/create-cache-key-function ^29.7.0` は micromatch を持たないので触らない |

ほかの `overrides` は足さない。`resolutions` は使わない (npm)。

### 6.3 消す依存と根拠

grep の語はパッケージ名。母集合は `apps/mobile` (`__tests__` と `__mocks__` を含む)・`packages`・`tests`・`src` の `.ts` / `.tsx` / `.js` / `.mjs` / `.yaml` (`package.json` と lockfile を除く)。origin/main `1d69d88b` で引いた。

| パッケージ | 現行 | grep の結果 | 決定 |
|---|---|---|---|
| `@react-native-community/slider` | 4.5.7 (`apps/mobile/node_modules` に入れ子) | アプリのコード (`app/` `src/`) は 0 件。`__tests__/home/home.test.tsx:51-58` に `jest.mock('@react-native-community/slider', …)` (見出しのコメント 1 行 + 7 行) が残っているだけ (ホームはネイティブの画面を消して WebView になった。mock の相手が無い) | **消す**。`home.test.tsx` の 51〜58 行 (コメント `// ── @react-native-community/slider のモック ──…` から `});` まで) と、その直後の空行 1 行を消す (`jest.mock` は `{ virtual: true }` が無いので、パッケージが無いと `Cannot find module` で落ちる)。Issue #1591 が「SDK 53 の推奨 (4.5.6) より上のパッチ」と確認を求めた行で、SDK 58 の推奨は 5.2.1 (メジャー)。使っていないネイティブモジュールを上げる理由が無い |
| `expo-haptics` | ~14.1.4 | 0 件 | **消す**。ネイティブモジュールなのでビルドにだけ入っていた |
| `expo-image-manipulator` | ~13.1.7 | 0 件 | **消す**。同上。`docs/design/mobile/04-storage-camera.md` (未実装の画像の取り込みの設計。`processImage` はアプリに無い) は、実装するときに `npx expo install expo-image-manipulator` で足す手順 (486・492 行) を持つ。消した後もその手順のままで成り立つ (`expo install` が SDK 58 の版を選ぶ)。足すときは import する所と一緒に足し、§9.7 の番兵の一覧から外す |
| `react-native-url-polyfill` | ^2.0.0 | `src/lib/supabase.ts:1`・`src/lib/webViewBridge.ts:18` (`import "react-native-url-polyfill/auto"`)・`__tests__/lib/supabase-config.test.ts:23` (`jest.mock`) | **残す** (版も変えない)。Supabase の JS クライアントが使う `URL` を補う。JS だけのパッケージで、SDK の版の表 (`bundledNativeModules.json`) の対象外 |

消したあと、`tests/mobile-toolchain-contract.test.ts` (§9.7) が「宣言に戻っていない」ことを見張る (戻すときは import する所と一緒に足し、番兵の一覧から外す)。

### 6.4 Node・Xcode・eas-cli

| 項目 | 要件 | 本冊 |
|---|---|---|
| Node | SDK 58 / react-native 0.88 / metro 0.87: `^22.13.0 \|\| ^24.3.0 \|\| ^26.0.0` (奇数版は不可) | `.nvmrc` `22`・`engines.node "22.x"` は変えない。CI の `actions/setup-node` の `'22'` は 22 系の最新 (22.13 以上)。offload の行き先 (k270) は v22.23.3 (実測)。実装者は段 A で `node -v` を記録し、22.13.0 未満なら止める (§12 の E-1) |
| Xcode | SDK 55 以降は Xcode 26 が最低。SDK 56 以降 26.4。EAS Build のクラウドが用意する | オーナーの手元には不要 (EAS でビルド)。ローカルビルドはしない |
| eas-cli | `eas.json` の `cli.version` を `">= 25.0.0"` に上げる (25.0.0 は SDK 58 公開と同日 2026-10-15 の版) | オーナーは `npm i -g eas-cli@latest` (§16) |
| TypeScript | 5.9.3 (ルートと同じ) | SDK 56 の案内 (テンプレートは 6.0.3) は採らない。`bundledNativeModules.json` に `typescript` は無いが、SDK 58 の `expo install --check` は Expo の API の `relatedPackages` (`typescript ~6.0.3`) とも突き合わせて 5.9.3 をずれとして報告するので、`apps/mobile/package.json` の `expo.install.exclude` で `typescript` だけを外す (§6.1) |

---

## 7. 壊れる所の全列挙と直し方

各行の「段」は §14.1。「検証」は §10 の番号。SDK 54〜58 の changelog・React Native 0.80〜0.88 の告知・Jest 30 の移行手引き・Reanimated 4 の移行手引きから、本アプリが触れる行だけを抜いた (触れないものは §7.5 に「該当なし」として残す)。

### 7.1 API の廃止・変更 (アプリのコード)

| # | 壊れる所 | 事実 (出典) | 直し方 | 触るファイル | 段 | 検証 |
|---|---|---|---|---|---|---|
| A-1 | `expo-file-system` の既定の export が新しい API (`File` / `Directory`) になり、旧 API は `expo-file-system/legacy` | SDK 54 changelog (expo-file-system 19.0.0「Make the modern filesystem API the default, move previous one to `expo-file-system/legacy`」)。58.0.9 の exports に `./legacy` がある。jest-expo 55.0.7 の mock も `/legacy` を向く | import を `"expo-file-system/legacy"` にする (使う関数は変えない)。テストの `jest.mock('expo-file-system', …)` を `jest.mock('expo-file-system/legacy', …)` にする (mock の中身は変えない)。テスト自身が `import * as FileSystem from 'expo-file-system'` で mock の関数を取り出す 3 本 (`WebViewScreen.bridge.test.tsx:91`・`WebViewScreen.download.test.tsx:84`・`webViewDownload.test.ts:36`) は、その import も `'expo-file-system/legacy'` にする (変えないと、テストの `FileSystem` は SDK 58 の既定の入口 (`Paths` / `File` / `Directory` だけ) になり、`FileSystem.writeAsStringAsync as jest.Mock` などが mock でなくなって落ちる。mock の関数の取り出し方と期待は変えない) | `app/(tabs)/settings.tsx`・`src/lib/webViewDownload.ts`・`__tests__/settings/ai-consent-entry.test.tsx`・`profile-row.test.tsx`・`logout.test.tsx`・`sessions-entry.test.tsx`・`export-rows.test.tsx`・`__tests__/components/WebViewScreen.error-cleanup-tabs.test.tsx`・`WebViewScreen.download.test.tsx`・`WebViewScreen.legal-consent.test.tsx`・`WebViewScreen.auth-messages.test.tsx`・`WebViewScreen.test.tsx`・`WebViewScreen.bridge.test.tsx`・`__tests__/lib/webViewDownload.test.ts` (Jest の 12 本)。ルートの vitest の `tests/webview-download-export-limit-contract.test.ts` の 26 行 `vi.mock('expo-file-system', () => ({}))` を `vi.mock('expo-file-system/legacy', () => ({}))` に (このテストは `webViewDownload.ts` を読む。mock の指定子が合わないと本物のネイティブモジュールを読みに行って落ちる) | A | V-2・V-3・V-7 |
| A-2 | `react-native` の `SafeAreaView` は非推奨 (SDK 54 / RN 0.81)。Android 16 の edge-to-edge が強制 (SDK 54) で、`react-native` の `SafeAreaView` は Android で何もしないので文字が status bar の下に潜る | SDK 54 changelog「React Native `<SafeAreaView>`: Deprecated. Use `react-native-safe-area-context` instead」「Android edge-to-edge: Enabled on all Android apps and cannot be disabled」 | `import { SafeAreaView } from 'react-native'` の行から `SafeAreaView` を外し、`import { SafeAreaView } from 'react-native-safe-area-context'` を足す。`edges` は付けない (既定の上下左右 = `react-native` 版の iOS の挙動と同じ)。style はそのまま | `app/handson-tour/index.tsx`・`app/handson-tour/graduate.tsx`・`src/components/ai/AIAdvisorSheet.tsx` (AIAdvisorSheet を描くテストの `react-native-safe-area-context` の mock 3 つ (`__tests__/ai/service-unavailable.test.tsx`・`advisor-sheet-legal-consent.test.tsx`・`stopped-by-server-raw-fetch.test.tsx`) は `SafeAreaView` を持っているので変えない。handson-tour の index / graduate を描くテストは無い) | A | V-2・V-3・実機 (§16 の M-6) |
| A-3 | `expo-image-picker` の `mediaTypes` は `MediaType \| MediaType[]` (`'images'` …) で型が付く | SDK 52 以降の型。58.0.10 でも同じ | `mediaTypes: ["images"] as any` の `as any` を外す (2 か所)。型が通らなければ `ImagePicker.MediaType` の配列として書く (`["images"] satisfies ImagePicker.MediaType[]`)。`as any` は残さない | `app/health/blood-tests.tsx` (253 行・264 行) | A | V-2 |
| A-4 | `@expo/vector-icons` を `expo` が依存しなくなった | SDK 56 changelog「`expo` no longer depends on `@expo/vector-icons`. If you use it, add it to `package.json` yourself」 | `dependencies` に `"@expo/vector-icons": "^15.0.2"` を足す (§6.1)。コードは変えない。`@react-native-vector-icons/*` への移行 (SDK 56 の非推奨) はしない | `apps/mobile/package.json` | A | V-1・V-2・V-3 |
| A-5 | Reanimated 3 → 4: `react-native-worklets` が別パッケージ。Babel プラグインは `react-native-worklets/plugin` | Reanimated 4 の移行手引き。SDK 54 changelog「Don't edit `babel.config.js` manually, since `babel-preset-expo` handles it」 | `react-native-worklets` を宣言する (§6.1)。`babel.config.js` は変えない。アプリが使う `Animated.View` / `useSharedValue` / `useAnimatedStyle` / `withTiming` / `withSpring` / `withDelay` / `withSequence` / `Easing` は 4 系で同じ (消えたのは `useWorkletCallback` / `useAnimatedGestureHandler` / `combineTransition` / `runOnJS` 等の改名で、どれも使っていない。`withSpring` の `restDisplacementThreshold` / `restSpeedThreshold` / `duration` も使っていない) | `apps/mobile/package.json` (Jest 側は §7.3 の T-4) | A | V-2・V-3・実機 (M-6) |
| A-6 | `expo-notifications` 58: 前面の通知は handler が答えないと既定で表示。`shouldShowAlert` は非推奨 | SDK 58 changelog・SDK 58 の API 一覧 | 変えない (handler は `shouldShowBanner` を返している。使っている関数はすべて SDK 58 の一覧にあり非推奨でない) | – | – | V-2・実機 (M-4) |
| A-7 | `expo-updates` 58: `maxUpdatesToKeep` / `enableBsdiffPatchSupport` (既定 true) が増えた | SDK 56・58 changelog | 変えない (更新は無効のまま。§11) | – | – | V-8 |
| A-8 | React Native 0.87 の Strict TypeScript API が既定 (深い import・`NativeMethods`・`Touchable`・`*Properties` 型が消える。ref の型が `ViewInstance` 等に) | RN 0.87 / 0.88 の告知。SDK 58 changelog「opt-out は 0.88 まで」 | opt-out (`customConditions` に `react-native-legacy-deep-imports`) は使わない。深い import は 0 件なので、V-2 で新しく出た型エラーを個別に直す (ref の型なら `React.ElementRef<typeof X>` を `XInstance` に) | V-2 で出たファイルだけ | A | V-2 |
| A-9 | `expo-router` 58: `useNavigation` が navigator の外で例外。`navigation.dispatch` は commit 後に流れる (`dispatchSync` が即時)。モジュールの `router` は最初の描画の前に例外 | SDK 57→58 の移行手引き | 変えない。`useNavigation` を使う 4 か所 (`app/legal-consent.tsx` (B-2 で外す)・`src/lib/webViewAuthMessages.ts`・`src/components/web/WebViewScreen.tsx`・`useResetInitialPathOnBlur.ts`) はすべて route の中。`router.*` は effect と押下の中だけ。型: `WebViewScreen.tsx` と `useResetInitialPathOnBlur.ts` は使う部分の型を `useNavigation<T>()` の型引数に渡している (58 の `useNavigation` も型引数を取る。`build/useNavigation.d.ts:55`)・`webViewAuthMessages.ts` は `setParams` を `as unknown as` の形で読むだけなので、どれも型は変わらない。`app/legal-consent.tsx` の `navigation.addListener("beforeRemove", …)` だけは、58 の既定の型のイベントの一覧に `beforeRemove` が無く、段 A の V-2 で型エラーになる (B-2 がその effect を消すまで、V-2 が段 A だけ許す。§12 の E-17) | – | – | V-2・V-3・実機 (M-1〜M-3) |
| B-1 | `expo-router` 58: JS の Tabs で `href: null` は「タブを隠し、その route を届かない (initial tab へ redirect) にする」 | expo-router 58.0.0 changelog「Make `href: null` hide JS tabs and make their routes unreachable, redirecting navigation to the initial tab」。58.0.23 の実物: `build/layouts/TabsClient.js:85-127` の `processScreens` が `href: null` を `hidden: true` に置き換え、`build/standard-navigation/useVisibleTabsWithRedirect.js:35-40` が `hidden` の route をタブの一覧から外し、同 81〜88 行が「前面の route が一覧に無い」ときに最初のタブへ `router.replace` する。`href` の無い画面は `processScreens` がそのまま通す (`tabBarButton` と `href` を一緒に書くと 88〜89 行で例外)。タブバーは一覧の route ごとに項目を描き、項目の外側の View に `tabBarItemStyle` を付け (`build/react-navigation/bottom-tabs/views/BottomTabBar.js:372-377`)、中は `tabBarButton` の戻り値だけを描く (`BottomTabItem.js:123-132`)。expo-router 5.1.11 の `href: null` は `tabBarItemStyle: { display: 'none' }` と `null` を返す `tabBarButton` への展開だった (`build/layouts/TabsClient.js:24-39`) | 設定の画面は `(tabs)` の中の隠しタブのまま。`(tabs)/_layout.tsx` の `<Tabs.Screen name="settings" options={{ href: null }} />` を `<Tabs.Screen name="settings" options={{ tabBarButton: () => null, tabBarItemStyle: { display: "none" } }} />` に、前のコメント 1 行を §9.10 の文に。`(tabs)/profile.tsx` の 10 行のコメントの「`href: null`」も §9.10 の文に (コードは変えない)。ファイルの置き場・パス (`/(tabs)/settings`)・`NATIVE_SETTINGS_ROUTE`・設定の画面のコード・設定の画面から出る遷移は変えない。テストは `tab-layout.test.tsx` の 1 か所と、新設の `home/tabs-hidden-route.test.ts` (実物の expo-router の `processScreens` と `useVisibleTabsWithRedirect` に通す。§9.12) | `app/(tabs)/_layout.tsx` (118〜119 行)・`app/(tabs)/profile.tsx` (10 行のコメントだけ)・`__tests__/home/tab-layout.test.tsx`・`__tests__/home/tabs-hidden-route.test.ts` (新規) | B | V-2・V-3・実機 (M-2) |
| B-2 | `expo-router` 58: `beforeRemove` は止められない (`usePreventRemove` に)。`CommonActions.reset` は完全な state が要る。`resetRoot` は消えた | expo-router 58.0.0 changelog「Make `beforeRemove` non-preventable and add `removePrevented` event」「Export `usePreventRemove` from `expo-router`」「Require complete state in `CommonActions.reset`」。58.0.23 の `build/react-navigation/routers/BaseRouter.js` の RESET: `nextState.stale === false` のときだけ受け付け (`routeNames` が持ち主と同じ集合であること・key の無い route には key を付ける)、それ以外は `console.warn('The RESET action payload must contain a complete navigation state … Include key, index, routeNames, routeKeySeq, and stale: false')` を出して受け付けない (Unhandled。ルートまで上がって捨てられる) | 同意画面: `navigation.addListener("beforeRemove", …)` を `usePreventRemove(legalConsentScreenPreventsRemoval(mode, closing, frozenState === "frozen"), () => {})` に (止めた操作は捨てる。`repeat` は呼ばない。凍結中は止めない: 凍結のゲートの RESET は同意画面の route を取り除き、58 は取り除かれる route の 1 つでも止めていれば RESET ごと捨てる。§8.3 (b))。自分で閉じるとき (`close`) は `setClosing(true)` + 返り値の `disablePrevention()` を呼んでから遷移。ゲート (同意のゲートと凍結のゲートの 2 つ。同じ部品を共有する): `navigationRef.getRootState()` から `legal-consent` (凍結のゲートは `frozen`) を `routeNames` に持つ navigator を探し (`findNavigatorOwningRoute`。`key`・`routeNames`・`routeKeySeq` がそろわなければ null)、その `key` / `routeNames` / `routeKeySeq` / `type` を写し `stale: false` を付けた完全な state の RESET の action (`collapseStackAction`。`target` は持ち主の `key`) を `navigationRef.dispatch` に渡す。同意画面の route が既にあれば `key` ごと再利用する (同じ key は同じ画面なので取り除かれず、止めにも当たらない)。`navigationRef.reset(state)` は使わない (型が `PartialState \| NavigationState` で、`stale: false` と key の無い route の組を表せない。`dispatch` の引数の型 `NavigationAction` は `{ type: string; payload?: object; target?: string }` で、この action がそのまま入る)。`legalConsentScreenRemovalDecision` と `LegalConsentScreenRemovalDecision` は消す。`RESET_ACTION_TYPE` は残し、action の `type` に使う (§9.4) | `app/legal-consent.tsx`・`src/components/legal/LegalConsentGate.tsx`・`src/components/AccountFrozenGate.tsx` (#1861 が足した凍結のゲート。`navigationRef.reset({ index: 0, routes: [{ name: 'frozen' }] })` を同じ形に替える。§9.6)・`src/lib/legal-consent.ts` (凍結のゲートも同じ `findNavigatorOwningRoute` / `collapseStackAction` を `FROZEN_SCREEN_ROUTE_NAME` で呼ぶ)・`src/lib/account-frozen.ts` (コメント 1 か所) + テスト 6 本 (§13.2。うち 1 本は新規の `legal-consent-frozen-collapse.test.tsx`)・`app/_layout.tsx` (118 行のコメント 1 行だけ。§9.6 の後の注記) | B | V-3・実機 (M-3) |
| B-3 | `expo-router` 58: `Stack` / `Screen` の `initialRouteName` / `initialParams` / `redirect` / `navigationKey`・`freezeOnBlur` が消えた。`onReady` / `ready` が消えた。`screen` / `params` / `initial` の入れ子の指定は普通の params に | 移行手引き | 該当なし (どれも使っていない: grep 0 件)。`useRootNavigationState()?.key` で準備を見るのは残る | – | – | V-3 |
| B-4 | `expo-router` 56: `@react-navigation/*` の直接 import が動かない | SDK 56 changelog | 該当なし (直接 import は 0 件。`legal-consent.ts` のコメントの「`@react-navigation の CommonActions.reset`」は B-2 で書き換える) | – | – | – |
| B-5 | `expo-router` 58: `web.output` の既定が server (Web 出力) | SDK 58 changelog | 該当なし (`expo export` で Web を出さない。`expo start --web` は開発の補助) | – | – | – |

### 7.2 設定 (app.json・eas.json・Babel・Metro・tsconfig・Jest の設定・ルート)

| # | 壊れる所 | 事実 | 直し方 | 段 | 検証 |
|---|---|---|---|---|---|
| C-1 | `app.json` の `ios.runtimeVersion` / `android.runtimeVersion` の直書き `"1.0.0"` が、SDK 58 のビルドにも同じ値で付く | §11 | 2 行を消し、トップレベルに `"runtimeVersion": { "policy": "fingerprint" }` (§9.1) | A | V-7 (番兵)・V-8 |
| C-2 | `app.json` のトップレベル `splash` が SDK 58 のスキーマに無い (`expo-doctor` が落とす) | SDK 58 の app config のスキーマ (`splash` は無い。`updates` の下に `assetPatternsToBeBundled`)。expo-splash-screen 58 の文書「Using the config plugin … is the recommended method … The other methods are now considered legacy and will be removed in the future」 | `splash` を消し、`plugins` に `["expo-splash-screen", { "image": "./assets/splash-ios.png", "resizeMode": "contain", "backgroundColor": "#FFF7ED", "enableFullScreenImage_legacy": true }]` を足す (値は今の `splash` の逐語。`enableFullScreenImage_legacy` は iOS で全画面の画像を使い続けるための移行用の項目 (文書の「Only for: iOS」「will be removed in the future」)。Android 12 以降はシステムのスプラッシュ (`imageWidth` の既定 100 の中央の画像) になる。見え方は実機 (M-7)。画像の作り直しは §17) | A | V-9・実機 (M-7) |
| C-3 | `app.json` の `assetBundlePatterns` が非推奨 (`updates.assetPatternsToBeBundled` へ) | SDK 58 のスキーマ (deprecated) | 消す (値 `["**/*"]` は既定 (全部) と同じ。更新は無効なので効果も無い) | A | V-9 |
| C-4 | `app.json` に `newArchEnabled` / `notification` / `edgeToEdgeEnabled` があると SDK 55 で error | SDK 55 changelog | 該当なし (どれも無い) | – | V-9 |
| C-5 | `eas.json` の `cli.version ">= 12.0.0"` | §6.4 | `">= 25.0.0"` に。ほか (profiles・submit) は変えない | A | – |
| C-6 | `babel.config.js` | `babel-preset-expo` 58 が worklets の plugin を自動で入れる | 変えない | – | V-3 |
| C-7 | `metro.config.js` の `resolveRequest` (React の固定)・`watchFolders`・`nodeModulesPaths` | SDK 55 の `autolinkingModuleResolution` は monorepo で既定 ON だが、自前の `resolveRequest` は react 系だけを先に解決し、ほかは `context.resolveRequest` に渡すので干渉しない。SDK 54 の `experimentalImportSupport` (既定 true) と live bindings は Metro の変換の既定で、設定で戻さない | ロジックは変えない。コメントの「workspace root node_modules/react = 18.3.1」を「19.2.x (Web 用)」、`apps/mobile/node_modules/react = 19.0.0` を `19.3.0` に直す | A | 実機 (M-1) |
| C-8 | `tsconfig.json` の `paths.react` の固定 | §6.1 (@types/react は入れ子のまま) | ロジックは変えない。コメントの「19.0 系」を「19.3 系」に | A | V-2・V-7 |
| C-9 | `jest.config.js` の (1) `transformIgnorePatterns` の自前の一覧に `standard-navigation` (expo-router 58 の依存) が無い (2) `moduleNameMapper` の `'^react-native$'` と `'^react-native/(.*)$'` (ルートの `node_modules/react-native` へ) が、react-native 0.88 の exports だけの入口 (`./setup-env`・`./react-private-interface`・`./asset-registry`・`./unstable-internals-do-not-use`。実体は `src/` の下で、パッケージの直下に同名のファイルは無い) を `<root>/node_modules/react-native/setup-env` のような無いパスへ写す | (1) jest-expo 58 の既定は `/node_modules/(?!(.pnpm\|react-native\|@react-native\|@react-native-community\|expo\|@expo\|@expo-google-fonts\|react-navigation\|@react-navigation\|@sentry/react-native\|native-base\|standard-navigation))` + `react-native-reanimated/plugin` と `@react-native/babel-preset` の除外。自前の一覧の `react-native-svg` / `@unimodules` / `sentry-expo` は `react-native` の前方一致か、使っていない (2) `@react-native/jest-preset` 0.88.0 の `jest-preset.js` は `^react-native/react-private-interface$` と `^react-native/setup-env$` を `src/` の実体へ、`^react-native($\|/.*)` を `path.dirname(require.resolve('react-native'))/$1` へ写し、jest-expo 58.0.11 の `jest-preset.js` はその前に `^react-native/asset-registry$` と `^react-native/unstable-internals-do-not-use$` を足す (コメント「Mapped module targets must be absolute paths」)。`@react-native/jest-preset` の `jest/setup.js:136` は `react-native/setup-env` を、`Libraries/Renderer/shims/createReactNativeComponentClass.js:15` は `react-native/react-private-interface` を読む。jest-config 30 は preset とプロジェクトの `moduleNameMapper` を `{ ...プロジェクト, ...preset, ...プロジェクト }` で合わせるので、プロジェクトの総称の行が preset の個別の行より先に当たり、`Could not locate module react-native/setup-env mapped as …` で全部のスイートが準備で落ちる | (1) `transformIgnorePatterns` の項目を消し、preset の既定に任せる (2) `moduleNameMapper` の `'^react-native$'` と `'^react-native/(.*)$'` の 2 行を消し、preset の別名に任せる (preset の総称の行の行き先は §10.1 の置き場でルートの `node_modules/react-native` = 消す 2 行と同じ場所)。`react` の 2 行・`react-test-renderer` の 2 行・`@homegohan/shared`・`react-native-webview`・`modulePaths` / `setupFiles` / `setupFilesAfterEnv` / `testTimeout` は変えない (型注釈 `@type {import('jest-expo').JestExpoConfig}` もそのまま)。全文は §9.2 | A | V-3 |
| C-10 | `jest.setup.js` に worklets / Reanimated 4 の Jest の設定が無い | react-native-worklets の Jest の手引き (mock `react-native-worklets/src/mock` を推奨)・Reanimated の Jest の手引き (`setUpTests()`) | `jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'))` と `require('react-native-reanimated').setUpTests()` を足す (§9.3)。`jest.config.js` の `resolver` を `react-native-reanimated/jest/resolver` にする (§9.2。実装で分かった: この resolver が無いと、Reanimated 4 が Jest の下で web 用の実装で読む前提の内部ファイル (`initializers` など。resolver の `WEB_ONLY_IN_JEST`) を native 用で読み、`react-native-reanimated` を読んだ時点で `setCSSEventHandler is not available in JSReanimated` で落ちる。この resolver は `react-native-worklets/jest/resolver` に続けて Jest の既定の resolver を呼ぶ。`@react-native/jest-preset` の resolver を外すことになるが、その resolver がしていた `react-native` の `exports` の除去は Jest 30 では効いていない (jest-expo 58.0.11 の `jest-preset.js` の 35〜36 行のコメント「Jest 30 replaced its resolver with `unrs-resolver` and dropped the `packageFilter` option, so `@react-native/jest-preset`'s resolver can no longer strip `react-native`'s `exports` map」。exports だけの入口は C-9 のとおり preset の `moduleNameMapper` が絶対パスで写す)) | A | V-3 (handson-tour / Confetti / TourOverlay を描くテスト: `__tests__/app/handson-tour-*.test.tsx`・`__tests__/handson-tour/*.test.ts`) |
| C-11 | `jest.env.setup.js` のコメント (root は react@18・Node 20 に WebSocket が無い) | 事実が古い (root は 19.2・Node 22 には `WebSocket` がある。`if (typeof global.WebSocket === 'undefined')` の分岐は無害) | コメントを現在形に (ロジックは変えない。`RNTL_SKIP_DEPS_CHECK=1` も残す) | A | – |
| C-12 | ルート `package.json` の `overrides` | §6.2 | §6.2 のとおり | A | V-1・V-4 |
| C-13 | `.github/dependabot.yml` のコメント「(いまは 19.0.0)」 | 事実が古い | `19.3.0` に (ignore の規則は変えない。`tests/security-workflow.test.ts` は規則だけを見る) | A | V-7 |
| C-14 | `.github/workflows/mobile-test.yml`・`scripts/local-ci.sh` の `stage_mobile` | Jest 30 でも `--ci` / `--coverage` / `--json` / `--outputFile` / `--listTests` は同じ。JSON の `numPassedTests` 等も同じ | 変えない (`tests/local-ci-workflow-sync.test.ts` の対象) | – | V-3 |
| C-15 | Node の版 | §6.4 | `.nvmrc` / `engines` は変えない。段 A の最初に `node -v` を記録 | A | V-0 |
| C-16 | `apps/mobile/tsconfig.json` の `"extends": "expo/tsconfig.base"` が、ルートの vitest (Vite 8 の tsconfig の読み込み) で解決できない。`apps/mobile` のソースを import するルートのテスト 10 本 (`tests/account-deletion-blocked-message`・`design-doc-push-paths-resolve`・`legal-consent-mobile-contract`・`mobile-account-frozen-contract`・`push-issue-log-sanitizer`・`push-kinds-routes-contract`・`site-config-guard`・`stored-failure-messages`・`webview-download-export-limit-contract`・`src/__tests__/config/status-color-tokens`) が `Failed to load tsconfig 'expo/tsconfig.base': Tsconfig not found` で落ちる | expo 58.0.14 の `package.json` は `exports` を持ち (`./*` → `./*.js`・`./*.json` → `./*.json`)、`expo/tsconfig.base` (拡張子なし) に当たる入口が無い。expo 53 は `exports` を持たなかった。tsc は拡張子なしでも読める | `"extends": "expo/tsconfig.base.json"` にする (`./*.json` の入口が `tsconfig.base.json` に当たる。tsc も同じ内容を読む)。理由のコメントを付ける | A | V-2・全件 vitest |

### 7.3 テスト (Jest 29 → 30・jest-expo 58・Reanimated 4・RNTL)

| # | 壊れる所 | 事実 (Jest 30 の移行手引き・changelog) | 直し方 | 段 | 検証 |
|---|---|---|---|---|---|
| T-1 | 別名の matcher (`toBeCalled` / `toBeCalledTimes` / `toBeCalledWith` / `lastCalledWith` / `nthCalledWith` / `toReturn*` / `toThrowError`) が消えた | Jest 30 | 該当なし (0 件。§2.2)。新しく書くテストでも使わない | – | V-3 |
| T-2 | `--testPathPattern` → `--testPathPatterns`。`--init` 削除。値の無いフラグはエラー | Jest 30 | 該当なし (使っていない) | – | V-3 |
| T-3 | `jest.mock` のパスが大文字小文字を区別する。`.mjs` / `.cjs` / `.mts` / `.cts` が既定の `testMatch` に入る | Jest 30 | 該当なし (`__tests__` は `.ts` / `.tsx` だけ。mock のパスは実在の綴り。CI の Linux で既に区別されている) | – | V-3 |
| T-4 | テストの間の未処理の例外・未処理の reject で落ちる (1 ターン待ってから判定)。`expect.objectContaining` と等値で非列挙のプロパティを無視。Error の `cause` が snapshot に出る | Jest 30 | 実行して出た分を直す。直し方の規則: 製品コードが正しいときだけテストを直す。`await` / `catch` を足して reject を処理する。期待を緩めない (`toEqual` を `toMatchObject` に変える等は、非列挙の差が原因のときだけ)。snapshot は使っていない | A | V-3 |
| T-5 | jest-expo 58 の環境は `nativeEnvironment.js` (Jest 30 の `jest-environment-node` を継承)。`jsdom` は 26 | jest-expo 58 の preset | 該当なし (`@jest-environment` の指定は 0 件。すべて native の環境) | – | V-3 |
| T-6 | Reanimated 4 のコンポーネントを描くテストが、worklets のネイティブモジュールを要る | C-10 | C-10 の mock と `setUpTests()`。描くテスト: `__tests__/app/handson-tour-photo-save.test.tsx`・`handson-tour-menu-bubble.test.tsx`・`handson-tour-hard-back-step2-3.test.tsx`・`handson-tour-layout-login.test.tsx`・`__tests__/components/TourBubble.testid.test.tsx` (TourOverlay / Confetti 経由)。mock で足りなければ、Reanimated の手引きの `jest.useFakeTimers()` をそのテストの `beforeEach` に足す (アニメーションの完了を待つ test だけ) | A | V-3 |
| T-7 | `react-test-renderer` が React と違う版 (いま 19.2.5 / 19.0.0) | §6.1 | `19.3.0` の固定で React と一致。`jest.config.js` の `^react-test-renderer$` の固定先 (ルートの `node_modules`) は変えない (§10.1 の 2 段でルートに巻き上がる。V-1 と番兵 (§9.7) で確かめる) | A | V-1・V-3 |
| T-8 | `@testing-library/jest-native` 5.4.3 (非推奨) | RNTL 13.3.3 の組み込み matcher で代替できるが、`jest.setup.js` の `extend-expect` を外すと `toHaveTextContent` 等の登録の経路が変わる | 変えない (本冊の範囲外。RNTL 14 の案件で一緒に外す) | – | V-3 |
| T-9 | `expo-file-system` の mock の指定子と、テスト自身の import | A-1 | A-1 のとおり Jest の 12 ファイル (うち 3 本は `import * as FileSystem from 'expo-file-system'` も `/legacy` に) とルートの vitest の 1 ファイル (`tests/webview-download-export-limit-contract.test.ts`)。§9.7 の番兵が `__tests__` の指定子も見る | A | V-3・V-7 |
| T-10 | 隠しタブの書き方の変更に伴うテスト (`tab-layout.test.tsx` の「settings タブは href: null」の it) と、実物の expo-router 58 の `processScreens` と `useVisibleTabsWithRedirect` に通すテストの新設 | B-1 | §13.2・§9.12 のとおり (mock の `Tabs.Screen` が集めた options の形と、実物の `processScreens` が `hidden` を付けず、実物の `useVisibleTabsWithRedirect` が設定の画面を一覧に残して最初のタブへ戻さないことで見る。mock だけで緑になることを防ぐ) | B | V-2・V-3 |
| T-11 | 同意画面・同意のゲート・凍結のゲートのテスト (`beforeRemove` の mock・`reset` の期待) | B-2 | §13.2 のとおり (ゲートの期待は `navigationRef.dispatch` に渡す完全な state の action。実物の expo-router 58 の `StackRouter` に action を通す it を足し、mock だけで緑になることを防ぐ) | B | V-3 |

### 7.4 ネイティブの挙動 (オーナーが実機で確かめる。コードでは直さない)

| # | 変わるもの | 事実 | 確認 (§16 の M-n) |
|---|---|---|---|
| N-1 | Android: edge-to-edge の強制 (SDK 54)・R8 が release で既定 ON (SDK 58)・`compileSdk` 37 (RN 0.87)・Android 7.0 (API 24) 未満は `react-native-webview` 14 が切った | SDK 54 / 58 changelog・webview 14.0.0 release | M-6 (余白)・M-8 (preview の apk = release の最適化) |
| N-2 | iOS: scene-based life cycle (SDK 58 の prebuild が SceneDelegate を作る)・Xcode 26 以降・最低 iOS 16.4 (SDK 56) | SDK 56 / 58 changelog・RN 0.88 | M-1 (起動)・M-5 (deep link の cold start) |
| N-3 | Hermes V1 が既定 (SDK 56)・Metro の ESM の interop (`experimentalImportSupport`・live bindings。SDK 54) | SDK 54 / 56 changelog | M-1〜M-3 (主要な導線のスモーク) |
| N-4 | スプラッシュ (C-2) | expo-splash-screen 58 | M-7 |
| N-5 | 前面の通知の表示の既定 (A-6) | SDK 58 | M-4 |

### 7.5 読んで「該当なし」と判定した破壊的変更 (母集合の閉じを示すために残す)

SDK 54: `expo-av` (未使用)・`react-native-edge-to-edge` の plugin (未使用)・`@expo/vector-icons` の改名されたアイコン (`Ionicons` の `home` / `book-outline` / `scan` / `bar-chart` / `person` / `settings-outline` はいずれも 15 系に残る。V-2 で確かめる)・JSC (Hermes を使用)・`expo-build-properties` (未使用)・`Pressable` が hidden な `Activity` の listener を外さない (RN 0.85。`Activity` 未使用)。SDK 55: `expo-router/server` の `ExpoRequest` / `ExpoResponse`・headless tabs の `reset` → `resetOnFocus`・`NativeTabs`・`expo-blur` / `expo-video` / `expo-clipboard` / `expo-cellular` / `expo-ui`・`eas update --environment` (更新を公開しない)・開発サーバーの CORS。SDK 56: `expo/fetch` が `globalThis.fetch` (`EXPO_PUBLIC_USE_RN_FETCH` は使わない。`fetch` の呼び出しは API と Supabase で、WHATWG の `fetch` と同じ契約)・`expo-file-system` の `File.copy` / `move` の非同期化 (新 API 未使用)・`@expo/dom-webview` (DOM components 未使用)・`expo-calendar` / `contacts` / `media-library` の非推奨。SDK 57: `expo prebuild` の clean (CNG)。SDK 58: `File.write` の非同期化 (新 API 未使用)・`expo-sqlite` の libSQL・`expo-localization` の RTL・`@expo/ui`・`StyleSheet.absoluteFillObject` (RN 0.85。grep 0 件)・`InitializeCore` / `InputAccessoryView` の非推奨 (未使用)。Jest 30: `jest.genMockFromModule` (未使用)・`@jest/globals` からの `SpyInstance` 型 (使っているのは `@types/jest` の `jest.SpyInstance` で、30.0.0 にある)・glob 10 の `testMatch` (既定のまま)。

---

## 8. 表 3 点

### 8.1 全パターン表 (依存 × 更新の種類 × 消費経路 × 壊れる所)

「消費」は、そのパッケージを読む所 (app = `app/` `src/` のコード / jest = テストの実行 / metro = バンドル / eas = ネイティブのビルド / lock = lockfile だけ)。

| パッケージ | 現行 → 設計後 | 種類 | 消費 | 壊れる所 (§7) | 検証 |
|---|---|---|---|---|---|
| expo | 53.0.27 → ~58.0.14 | major | app / metro / eas | C-2・C-3・A-4 | V-1・V-9 |
| react-native | 0.79.6 → 0.88.0 | minor ×9 (0.x) | app / jest / metro / eas | A-2・A-8・N-1・N-2 | V-2・V-3 |
| react | 19.0.0 → 19.3.0 | minor | app / jest | T-7 (レンダラーと同じ版) | V-1・V-7 |
| react-test-renderer | ^19.0.0 (19.2.5) → 19.3.0 | pin | jest | T-7 | V-1・V-7 |
| @types/react | ~19.0.10 → ~19.3.0 | minor | tsc | C-8 | V-2・V-7 |
| expo-updates | 0.28.18 → ~58.0.17 | major | eas (更新は無効) | C-1・A-7 | V-8 |
| expo-router | 5.1.11 → ~58.0.23 | major | app / jest | B-1〜B-5・A-9 | V-3 |
| expo-file-system | 18.1.11 → ~58.0.9 | major | app / jest | A-1・T-9 | V-3 |
| expo-notifications | 0.31.5 → ~58.1.5 | major | app | A-6 | V-2 |
| expo-image-picker | 16.1.4 → ~58.0.10 | major | app | A-3 | V-2 |
| expo-splash-screen | 0.30.10 → ~58.0.10 | major | app / eas | C-2 | V-9 |
| expo-constants / device / font / linear-gradient / linking / secure-store / sharing / web-browser | 各 53 系 → 58 系 | major | app | 該当なし (API は同じ。V-2 が確かめる) | V-2 |
| react-native-reanimated | 3.19.5 → 4.7.1 | major | app / jest | A-5・T-6・C-10 | V-3 |
| react-native-worklets | (無し) → 0.13.0 | 新規 | app / jest / eas | A-5・C-10 | V-3 |
| @expo/vector-icons | (expo 経由 14.1.0) → ^15.0.2 (直接) | 新規 (major) | app | A-4・§7.5 のアイコン名 | V-2 |
| react-native-webview | 13.13.5 → 14.0.1 | major | app | N-1 (Android 7.0 未満を切る。JS の API は同じ) | V-3・実機 |
| react-native-safe-area-context | 5.4.0 → ~5.10.1 | minor | app | A-2 | V-3 |
| react-native-screens | 4.11.1 → ~4.30.0 | minor | app (expo-router の peer) | – | V-3 |
| react-native-svg | 15.11.2 → 15.16.0 | minor | app (lucide) | – | V-3 |
| react-native-web | 0.20.0 → ~0.21.4 | minor | `expo start --web` だけ | – (§17 の既知の制約) | – |
| @react-native-async-storage/async-storage | 2.1.2 → 2.2.0 | minor | app / jest (mock のパスは同じ) | – | V-3 |
| @react-native-masked-view/masked-view | ^0.3.2 → 0.3.2 | 固定 | app | – | V-3 |
| jest | 29.7.0 → ~30.5.2 | major | jest | T-1〜T-5 | V-3 |
| jest-expo | 53.0.14 → ~58.0.11 | major | jest | C-9・T-5 | V-3 |
| @react-native/jest-preset | (無し) → 0.88.0 | 新規 | jest / lock (overrides) | C-12 | V-1・V-3 |
| @testing-library/react-native / jest-native / @types/jest | 据え置き | – | jest | T-8 | V-3 |
| typescript | 5.8.3 (入れ子) → ~5.9.3 (ルートの 5.9.3 と共有) | minor | tsc | – (§10.1 の 2 段で入れ子が消える) | V-1・V-2 |
| @react-native-community/slider / expo-haptics / expo-image-manipulator | 消す | 削除 | 無し (アプリのコードは grep 0 件。slider はテストの mock だけ) | §6.3 | V-3・V-7 |
| react-native-url-polyfill | ^2.0.0 (2.0.0) → 据え置き | – | app (`supabase.ts`・`webViewBridge.ts`) / jest (mock) | – | V-3 |
| zod / @supabase/supabase-js / @homegohan/* / lucide-react-native / @expo-google-fonts/noto-sans-jp / resolve-from | 据え置き | – | app | – | V-3 |
| metro (react-native 経由) | 0.82.5 → 0.87.1 | 間接 | metro / jest (`jest-worker 29` は micromatch を持たない) | §2.3 (image-size が消える) | V-4 |
| @expo/metro-config (expo 経由) | 0.20.18 → 58.0.14 | 間接 | metro | §2.3 (postcss が消える) | V-4 |
| @expo/cli / @expo/code-signing-certificates | 0.24.24 / 0.0.6 → 58.1.11 / 0.0.7 | 間接 | 開発サーバー・EAS | §2.3 (node-forge は残る) | V-4 |

### 8.2 状態比較表 (現行 vs 設計後)

| 面 | 現行 (origin/main 904f9e8f) | 設計後 |
|---|---|---|
| Expo SDK / React Native / React | 53 / 0.79.6 / 19.0.0 | 58 / 0.88.0 / 19.3.0 |
| Jest / jest-expo / RN の Jest preset | 29.7.0 / 53.0.14 / `react-native/jest-preset` (react-native に同梱) | 30.5.x / 58.0.11 / `@react-native/jest-preset` 0.88.0 (別パッケージ。Jest 29 の依存は overrides で 30) |
| RNTL / jest-native / react-test-renderer | 13.3.3 / 5.4.3 / 19.2.5 (React と不一致) | 13.3.3 / 5.4.3 / 19.3.0 (React と一致) |
| npm audit の根の advisory (high) | braces・node-forge・image-size (2)・postcss (4) | braces・node-forge (修正版が出たらパッチで消える) |
| npm audit high (全体 / --omit=dev) | 47 / 22 | 22 / 19 (§2.3 の試作の実測)。PR の本文に写す。合否は根の集合 |
| `runtimeVersion` | `ios` / `android` に `"1.0.0"` の直書き | トップレベル `{ "policy": "fingerprint" }` |
| OTA | 無効 (`enabled: false`・`NEVER`) | 同じ (番兵で固定) |
| 設定の画面 | `app/(tabs)/settings.tsx` (隠しタブ・`href: null`)・`router.push('/(tabs)/settings')` | 置き場・パス・歯車は同じ。隠し方を `tabBarButton: () => null` と `tabBarItemStyle: { display: "none" }` に (expo-router 5 の `href: null` の展開と同じ。58 の `href: null` は route を届かなくする。§9.10) |
| 設定の画面の挙動 (`(tabs)` の layout の止め (session・同意・初期設定)・タブバーと AI の FAB・`(tabs)` の境界・設定の画面から出る遷移・通知のタップ) | `(tabs)` の中の隠しタブとして | 同じ (置き場を変えないので、どれも変わらない。§8.3 (c)) |
| 同意画面の止め | `beforeRemove` + `preventDefault` (RESET だけ通す) | `usePreventRemove` (全部止める。自分で閉じるときだけ解く) |
| ゲートの畳み直し | `navigationRef.reset({ index: 0, routes: [{ name: 'legal-consent' }] })` (部分の state。expo-router 58 では受け付けられない) | `navigationRef.dispatch(collapseStackAction(owner, 'legal-consent'))` (完全な state: `key`・`index: 0`・`routeKeySeq`・`routeNames`・`type`・`stale: false`。`target` は持ち主の key。同意画面の route があれば `key` ごと再利用) |
| 凍結のゲートの畳み直し (#1861) | `navigationRef.reset({ index: 0, routes: [{ name: 'frozen' }] })` (部分の state。同じく受け付けられず、凍結中の利用者がスピナーのまま止まる) | `navigationRef.dispatch(collapseStackAction(owner, 'frozen'))` (同意のゲートと同じ部品。凍結の画面の route があれば `key` ごと再利用。`routeNames` に `frozen` が入っていることも `owner` から写す) |
| `expo-file-system` | 既定の入口 (旧 API) | `/legacy` の入口 (同じ関数)。Jest のテストの `jest.mock` 12 本と、mock の関数を取り出す import 3 本も `/legacy` |
| `SafeAreaView` (3 ファイル) | `react-native` (Android で無効) | `react-native-safe-area-context` |
| `as any` (apps/mobile の `app/` `src/`) | 28 行 (31 か所)・9 ファイル | 26 行 (29 か所)・8 ファイル (`blood-tests.tsx` の 2 行だけ外す。ほかの 8 ファイルは本冊が触らない) |
| `app.json` の `splash` / `assetBundlePatterns` | あり | 無し (`expo-splash-screen` の plugin へ / 削除) |
| `eas.json` の `cli.version` | `>= 12.0.0` | `>= 25.0.0` |
| `jest.config.js` の `transformIgnorePatterns` | 自前の一覧 | preset の既定 |
| `jest.setup.js` | jest-native・RNTL・AsyncStorage・Alert | + worklets の mock・Reanimated の `setUpTests()` |
| 宣言している依存の数 (apps/mobile) | dependencies 36・devDependencies 9 | dependencies 35 (−3 +2: `@expo/vector-icons`・`react-native-worklets`)・devDependencies 10 (+1: `@react-native/jest-preset`) |
| lockfile の置き場 | ルートに `react-native` 0.79.6 ほか。`apps/mobile/node_modules` に `react` 19.0.0・`@types/react` 19.0.14・`typescript` 5.8.3 ほか | ルートに `react-native` 0.88.0 ほか。`apps/mobile/node_modules` は `react` 19.3.0 と `@types/react` 19.3 系の 2 つだけ (§2.4・§10.1) |
| `jest.config.js` の `moduleNameMapper` | `react` ×2・`react-native` ×2・`react-test-renderer` ×2・`@homegohan/shared`・`react-native-webview` | `react-native` ×2 を消す (preset の別名に任せる) |
| mobile tsc のエラー | 6 件 | 段 A の後: 6 件 + `app/legal-consent.tsx` の `beforeRemove` の effect の行 (B-2 で消える。§10 の V-2)。段 B の後: 6 件 (同じ file:line。新規 0) |
| Jest のテストファイル | 121 | 123 (新規 2: `__tests__/home/tabs-hidden-route.test.ts`・`__tests__/app/legal-consent-frozen-collapse.test.tsx`。移設・名前の変更は無し) |
| ルートの vitest の番兵 | `tests/react-types-version-contract.test.ts` ほか | + `tests/mobile-toolchain-contract.test.ts` |

### 8.3 状態遷移表

**(a) ネイティブのビルドと JS の組 (状態 = 端末に入っているビルド × その JS)**

| 状態 | 操作・イベント | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| SDK 53 のビルド (runtimeVersion `1.0.0`・埋め込みの JS) | 起動 | 同じ | `updates.enabled: false` → 更新を読まない。`checkAutomatically: NEVER` → 確認しない | 無し |
| 同上 | `eas update` (本冊では行わない) | 同じ (届かない) | 更新が無効 | 無し |
| 同上 | ストアから SDK 58 のビルドへ更新 | SDK 58 のビルド (runtimeVersion = fingerprint・埋め込みの JS) | オーナーの提出 (#1115) | 新しい JS・ネイティブ |
| SDK 58 のビルド | 起動 | 同じ | 更新は無効 | 無し |
| SDK 58 のビルド | 将来 OTA を有効にして `eas update` (別案件) | 同じ fingerprint の JS だけ受ける | runtimeVersion の一致。ネイティブに効く依存を変えたビルドは別の fingerprint | SDK 53 のビルドには届かない |

**(b) 同意画面の route (状態 = `LegalConsentScreenMode` × 自分で閉じる途中か × 凍結中か)**

| 状態 | 操作 | 遷移先 | ガード (`usePreventRemove` の第 1 引数) | 副作用 |
|---|---|---|---|---|
| awaiting-consent・閉じていない・凍結中でない | 取り除く操作 (GO_BACK / POP / POP_TO_TOP / REPLACE / NAVIGATE / 同意画面を含まない RESET) | 同じ (操作は捨てる) | true | 無し (`repeat` を呼ばない) |
| awaiting-consent・凍結中 (`useAccountFrozen` の state が `frozen`。#1861) | 凍結のゲートの畳み直し (RESET の action。ルートの Stack を `[frozen]` に。同意画面の route を取り除く) | 取り除かれる (前面は凍結の画面。凍結が先) | false (`accountFrozen`) | 無し (同意画面は自分では閉じない。`disablePrevention` も遷移も呼ばない)。止めていると expo-router 58 が RESET ごと捨て (`useNavigationTreeReducer` の `routesWithRemovalPrevented`)、同意画面に残る |
| awaiting-consent・凍結中 | 凍結が解ける (`clear`。前面が同意画面のまま) | awaiting-consent・凍結中でない | true に戻る | 無し |
| awaiting-consent | ゲートの畳み直し (RESET の action。同意画面の route を `key` ごと再利用) | 同じ画面 (ほかの route だけ外れる) | 取り除かれないので判定に入らない | WebView は読み込み直さない |
| awaiting-consent | state が `clear` / `unknown` | free | – | ゲートが入口へ (`router.replace('/')`。止めない) |
| awaiting-consent | session 無し (Web の sign-out) | signed-out-notice | – | 案内と「閉じる」 |
| signed-out-notice | 取り除く操作 | 同じ | true | 無し |
| signed-out-notice | 「閉じる」 | 閉じる途中 | – | `closingRef` / `setClosing(true)` / `disablePrevention()` → `back()` か `replace('/')` |
| free | 取り除く操作 | 取り除かれる | false | – |
| 閉じる途中 | 取り除く操作 | 取り除かれる | false (`closing`) | – |

**(c) 設定の画面 (状態 = ルートの Stack × `(tabs)` の前面のタブ)**

設定の画面は `(tabs)` の中の隠しタブのまま (§9.10)。B-1 で変わるのは「歯車で設定のタブへ切り替えたとき、expo-router 58 がそのタブをタブの一覧に残すか」だけで、ほかの遷移はいまと同じ (§4.2 の S8・S19〜S22)。遷移先の書き方はルートの Stack の route の並びで、`(tabs)` の後の括弧は前面のタブ。

| 状態 | 操作 | 遷移先 | ガード | 副作用 (いま との差) |
|---|---|---|---|---|
| [(tabs) (マイページ)] | 歯車 (`router.push('/(tabs)/settings')`) | [(tabs) (設定)] | 設定の画面の options に `href` が無いので `processScreens` が `hidden` を付けず、`useVisibleTabsWithRedirect` がタブの一覧に残す (§9.10) | いまと同じ。タブバー (設定のボタンも枠も無い) と AI の FAB が出る |
| [(tabs) (マイページ)] | 歯車 (`href: null` のまま 58 に上げた場合。B-1 で直す壊れ方) | [(tabs) (ホーム)] | `processScreens` が `hidden: true` に置き換え、一覧から外れる。前面の route が一覧に無いので最初のタブへ `router.replace` | 設定の画面に届かない |
| [(tabs) (設定)] | タブバーのほかのタブの押下 | [(tabs) (そのタブ)] | – | いまと同じ。設定のタブにはボタンが無いので、タブバーからは戻れない (いまと同じ。歯車から開く) |
| [(tabs) (設定)] | 「プロフィール」の行 (`router.push("/(tabs)/profile")`) | [(tabs) (マイページ)] | 前面の route (`(tabs)`) と行き先の名前が同じなので `(tabs)` の navigator へ降り、TabRouter がタブを切り替える | いまと同じ (S20) |
| [(tabs) (設定)] | 行 (`/settings/account`・`/settings/sessions`・`/health/blood-tests`・`/profile/nutrition-targets`・AI の同意・`/handson-tour?force=1`) の `router.push` | [(tabs), その画面] | 名前が違うのでルートの Stack に PUSH | いまと同じ (S22)。戻ると設定の画面 |
| [(tabs) (設定)] | ログアウト (`handleLogout` の `router.replace("/")`) | [入口] | ルートの Stack の REPLACE (前面の `(tabs)` を入口に置き換える) | いまと同じ (S21) |
| [(tabs) (設定)] | session が無くなる (トークンの更新の失敗・`clearSession`・SIGNED_OUT) | [入口] | `(tabs)/_layout.tsx:31` の `<Redirect href="/" />` | いまと同じ (S19) |
| [(tabs) (設定)] | 同意の状態が `loading` / `required` になる | スピナー → [同意画面] | `(tabs)` の layout (35 行) と `LegalConsentGate` | いまと同じ。ゲートの畳み直しの action だけが B-2 の完全な state の RESET になる (§8.3 (d)) |
| [(tabs) (設定)] | 通知のタップ (`NotificationRouter` の `router.push(行き先)`) | タブの行き先なら [(tabs) (そのタブ)]・`/health/blood-tests` なら [(tabs), blood-tests] | `NOTIFICATION_ROUTES` | いまと同じ |
| [(tabs) (設定)] | 描画の例外 | `(tabs)` の境界 (「再試行」と「ホームへ戻る」) | – | いまと同じ |
| [(tabs) (設定)] | Android の戻るボタン | `(tabs)` の戻り方のとおり | – | 本冊は `(tabs)` の `backBehavior` を変えない (書いていない)。実機の見え方は M-2 |
| 初期設定が済んでいない | 設定の画面に来る経路 | – | `(tabs)/_layout.tsx` の 44〜50 行 (初期設定へ `Redirect`) | いまと同じ |

**(d) 同意のゲートの畳み直し (状態 = session × 同意の状態 × 前面 × `openedRef` × 持ち主の state)**

| 状態 | 操作・イベント | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| session あり・`required`・前面が対象のパス (同意画面でも対象外のパスでもない) | effect | [同意画面] (ルートの Stack) | `findNavigatorOwningRoute` が持ち主 (key・routeNames・routeKeySeq あり・stale でない) を返す | `navigationRef.dispatch(collapseStackAction(…))`。`openedRef = true`・`closingRef = false` |
| 同上 | effect | 同じ (何もしない) | 持ち主が null (`routeNames` に `legal-consent` を持つ navigator が無い・`key` / `routeKeySeq` が無い・stale) | `console.warn("[LegalConsentGate] root stack is not ready; retry on next render")`。`openedRef` は立てない (次の描画でまた試す) |
| session あり・`required`・前面が同意画面・`openedRef` なし (deep link で開いた・下に残っていた) | effect | [同意画面] (同じ route の key) | 持ち主の state に同意画面の route がある | key を再利用した RESET の action を dispatch。同意画面は取り除かれない |
| session あり・`required`・前面が同意画面・`openedRef` あり | effect | 同じ | – | 何もしない |
| session あり・`required`・前面が対象外のパス | effect | 同じ | `isMobileLegalConsentExemptPath` | 何もしない |
| (現行) 同上の 1 行目 | effect | **同じ (無変化・RESET は受け付けられず警告だけ)** | expo-router 58 の `BaseRouter` が `stale !== false` の RESET を Unhandled にする | 現行の部分の state (`{ index: 0, routes: [...] }`) のままだと、`openedRef` だけが立ち、同意画面が開かない。本冊の完全な state で直す |
| session あり・`clear` / `unknown`・前面が同意画面 | effect | 入口 か 下の画面 | `closingRef` | いまと同じ (`refreshProfile` → `router.back()` / `router.replace('/')`) |
| session 無し | effect | 同じ | – | いまと同じ (前面が同意画面でなければ `openedRef = false`) |

**(e) 凍結のゲートの畳み直し (#1861。状態 = session × 凍結の状態 × 前面 × `openedRef` × 持ち主の state)**: (d) の「同意画面」を「凍結の画面」、`legal-consent` を `frozen`、`required` を `frozen` (凍結の状態) に読み替えた表と同じ。違いは次の 3 つだけ: ①凍結が先 (凍結中は同意のゲートが何もしない。凍結の画面が前面で、同意の状態が `required` でも畳まない) ②凍結の画面は `usePreventRemove` で止めない (`app/frozen.tsx` は止めを持たず、`gestureEnabled: false` と、ゲートの畳み直しで守る) ③前面か下に同意待ちの同意画面がある (session あり・`frozen`・前面が `/legal-consent`) ときの effect は、同意画面の route を取り除く RESET になる。同意画面は凍結中は止めないので (§8.3 (b))、RESET は受け付けられ `[frozen]` になる (止めていると 58 が捨て、`openedRef` だけが立って同意画面に残る)。持ち主が null のときの警告の語は `[AccountFrozenGate] root stack is not ready; retry on next render`。
---

## 9. 正典コード

### 9.0 正典の TS の型検査の手順 (設計ゲート用。実装者は読まなくてよい)

`ts` のフェンスのブロックは 1 つずつ独立のモジュールとして `tsc --noEmit --strict` に掛ける (`import` を省かない)。1 行目が `// tsc:skip` のブロックは検査しない: `tsx` のフェンスの説明用の差分 (expo-router 58 の型や JSX を含み、origin/main の `node_modules` では検査できない) と、§9.12 の Jest のテスト (正典として逐語で写すが、Jest の大域と RNTL の型が要る。実装では段 B の V-2 (`apps/mobile/tsconfig.json` は `__tests__` も含む) で型検査に掛かる)。JSON / JS のブロックは検査しない。

### 9.1 `apps/mobile/app.json` (全文)

```json
{
  "expo": {
    "name": "ほめゴハン",
    "slug": "homegohan",
    "scheme": "homegohan",
    "version": "0.1.0",
    "orientation": "portrait",
    "userInterfaceStyle": "automatic",
    "platforms": ["ios", "android", "web"],
    "icon": "./assets/icon.png",
    "runtimeVersion": {
      "policy": "fingerprint"
    },
    "ios": {
      "bundleIdentifier": "com.homegohan.app",
      "infoPlist": {
        "CFBundleDevelopmentRegion": "ja",
        "CFBundleLocalizations": ["ja", "en"],
        "NSCameraUsageDescription": "食事写真を撮影するためにカメラを使用します。",
        "NSPhotoLibraryUsageDescription": "食事写真を選択するために写真ライブラリを使用します。",
        "NSPhotoLibraryAddUsageDescription": "解析結果の保存のために写真ライブラリへ追加する場合があります。"
      },
      "icon": "./assets/icon-ios.png",
      "config": {
        "usesNonExemptEncryption": false
      }
    },
    "android": {
      "package": "com.homegohan.app",
      "permissions": [
        "android.permission.CAMERA",
        "android.permission.READ_MEDIA_IMAGES",
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE",
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.RECORD_AUDIO"
      ],
      "adaptiveIcon": {
        "foregroundImage": "./assets/adaptive-icon.png",
        "backgroundColor": "#E07A5F"
      }
    },
    "plugins": [
      "expo-router",
      "expo-image-picker",
      "expo-notifications",
      [
        "expo-splash-screen",
        {
          "image": "./assets/splash-ios.png",
          "resizeMode": "contain",
          "backgroundColor": "#FFF7ED",
          "enableFullScreenImage_legacy": true
        }
      ]
    ],
    "extra": {
      "eas": {
        "projectId": "ce2a0961-4696-472c-8377-a3f83cecdff5"
      },
      "router": {}
    },
    "owner": "nvidia.homeftp.net",
    "updates": {
      "url": "https://u.expo.dev/ce2a0961-4696-472c-8377-a3f83cecdff5",
      "checkAutomatically": "NEVER",
      "enabled": false
    }
  }
}
```

変更点だけ: `runtimeVersion` (トップレベルに新設・`ios` / `android` の直書きを削除)・`splash` を `plugins` の `expo-splash-screen` へ・`assetBundlePatterns` を削除。ほかの行 (`owner`・`extra`・`updates`・`ios`・`android` の値) はいまのまま。

### 9.2 `apps/mobile/jest.config.js` (全文)

```js
const path = require('path');

// __dirname = <repo-root>/apps/mobile
// モノレポルートの node_modules を基準に解決する。
// worktree の絶対パスには依存しない。
const repoRoot = path.resolve(__dirname, '../..');
const worktreeNodeModules = path.join(repoRoot, 'node_modules');
const mobileNodeModules = path.join(__dirname, 'node_modules');
// 時間切れの既定 (根拠と環境変数での上書きは jest.timeouts.js)
const { resolveMobileJestTimeouts } = require('./jest.timeouts');

/** @type {import('jest-expo').JestExpoConfig} */
module.exports = {
  preset: 'jest-expo',
  // 1 件のテストの時間切れ。負荷の高い機械で Jest の既定の 5 秒を超えて落ちるため延ばす (jest.timeouts.js)
  testTimeout: resolveMobileJestTimeouts(process.env).testTimeout,
  modulePaths: [mobileNodeModules, worktreeNodeModules],
  // Reanimated 4 は Jest の下で、一部の内部ファイル (initializers など) を native 用でなく web 用の実装で読む前提になっている。
  // この resolver が無いと react-native-reanimated を読んだ時点で「setCSSEventHandler is not available in JSReanimated」で落ちる (#1591)。
  // この resolver は react-native-worklets の resolver に続けて Jest の既定の resolver を呼ぶ。@react-native/jest-preset の resolver が
  // していた react-native の exports の除去は、Jest 30 の resolver が packageFilter を持たないため、もう効いていない (jest-expo 58 の jest-preset.js のコメント)。
  resolver: require.resolve('react-native-reanimated/jest/resolver'),
  // transformIgnorePatterns は書かない。jest-expo の既定 (react-native* / @react-native* / expo* / @expo* / @expo-google-fonts /
  // react-navigation / standard-navigation などを変換し、react-native-reanimated/plugin と @react-native/babel-preset は変換しない)
  // に任せる。自前の一覧を持つと、expo-router の新しい依存 (standard-navigation など) が一覧から漏れて SyntaxError になる (#1591)。
  // react 系モジュールを apps/mobile/node_modules から優先解決し、
  // モノレポルートの react (Web 用の 19.2 系) が react-test-renderer 経由で漏れ込むのを防ぐ。
  // react-native は書かない。@react-native/jest-preset と jest-expo の preset が、exports だけの入口
  // (react-native/setup-env・react-private-interface・asset-registry・unstable-internals-do-not-use) を含めて
  // 絶対パスで写す。ここに総称の行を書くと、preset の個別の行より先に当たって無いパスへ写す (#1591)。
  moduleNameMapper: {
    '^react$': path.join(mobileNodeModules, 'react'),
    '^react/(.*)$': path.join(mobileNodeModules, 'react', '$1'),
    '^react-test-renderer$': path.join(worktreeNodeModules, 'react-test-renderer'),
    '^react-test-renderer/(.*)$': path.join(worktreeNodeModules, 'react-test-renderer', '$1'),
    // tsconfig.json の paths と同じく、このリポジトリの packages/shared を直接読む (#1197)。
    // node_modules/@homegohan/shared (ワークスペースのシンボリックリンク) 経由だと、node_modules を
    // 別の場所のものと共有している作業コピー (git worktree など) で、手元ではなくリンク先の古い内容を読むため。
    '^@homegohan/shared$': path.join(repoRoot, 'packages/shared/src/index.ts'),
    // react-native-webview はネイティブモジュール (RNCWebViewModule) を必要とするため
    // Jest 環境では stub モックに差し替える。
    '^react-native-webview$': '<rootDir>/__mocks__/react-native-webview.js',
  },
  setupFiles: [
    '<rootDir>/jest.env.setup.js',
  ],
  setupFilesAfterEnv: [
    '<rootDir>/jest.setup.js',
  ],
};
```

### 9.3 `apps/mobile/jest.setup.js` (全文)

```js
import '@testing-library/jest-native/extend-expect';
// pure から読む (index から読むと、RNTL を使わないテストにも後片付けのフックを足すため。設定は index と同じものを共有する)
import { configure } from '@testing-library/react-native/pure';

import { resolveMobileJestTimeouts } from './jest.timeouts';

// RNTL の waitFor / findBy* の待ちの既定。RNTL の既定の 1 秒は負荷の高い機械で足りない (根拠と環境変数での上書きは jest.timeouts.js)
configure({ asyncUtilTimeout: resolveMobileJestTimeouts(process.env).asyncUtilTimeout });

// Mock AsyncStorage globally for all tests
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// react-native-worklets (Reanimated 4 の土台) はネイティブのモジュールを要るので、公式の mock に差し替える
// (react-native-worklets の Jest の手引き。#1591)。resolver は jest.config.js が react-native-reanimated/jest/resolver を指定する
// (Reanimated 4 の内部ファイルを Jest の下で読めるようにする。@react-native/jest-preset の resolver は Jest 30 では効かないので、外して差し支えない)
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));

// Reanimated の Jest の設定 (matcher と既定の fps。Reanimated の Jest の手引き。#1591)
require('react-native-reanimated').setUpTests();

// Globally spy on Alert.alert so tests can assert on it.
// react-native's jest/setup.js mocks NativeModules.AlertManager.alertWithArgs
// but Alert.alert itself may bypass the bridge in newer RN versions.
// We patch it here at setup time after all modules are initialized.
jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});
```

### 9.4 `apps/mobile/src/lib/legal-consent.ts` の差分 (正典。純)

消すもの: `LegalConsentScreenRemovalDecision` 型・`legalConsentScreenRemovalDecision`。残すもの: `RESET_ACTION_TYPE` (いまの `const RESET_ACTION_TYPE = "RESET";`。export しないまま、action の `type` に使う。説明のコメントは下のブロックの文に替える)。足すもの: 次のブロックの `legalConsentScreenPreventsRemoval` (第 3 引数 `accountFrozen` は #1861 の凍結。凍結中は止めない。§8.3 (b))・`NavigatorStateLike`・`StackOwnerState`・`CollapsedStackState`・`CollapseStackAction`・`findNavigatorOwningRoute`・`collapsedStackState`・`collapseStackAction` と、ファイルの中だけの `COLLAPSED_STACK_INDEX`・`CollapsedStackBase`。`LegalConsentScreenMode`・`RESET_ACTION_TYPE` は同じファイルの既存のもの (ブロックは独立に検査するため再掲している)。このファイルは純のまま (expo-router を import しない。ルートの vitest の `tests/legal-consent-mobile-contract.test.ts` がこのファイルを読む)。

畳む関数 (`findNavigatorOwningRoute`・`collapsedStackState`・`collapseStackAction`) は route の名前を引数に取る (使う所はゲート 1 つで、同意画面の route の名前 `LEGAL_CONSENT_SCREEN_ROUTE_NAME` を渡す。B-2・§9.6)。名前を引数にするのは、関数を純のまま、テスト (§13.2 の T-ML11) で持ち主の探し方と畳み方を名前に依らず確かめるため。

```ts
/** 同意画面の route の扱い (既存の型。src/lib/legal-consent.ts に定義済み) */
export type LegalConsentScreenMode = "awaiting-consent" | "signed-out-notice" | "free";

/**
 * navigationRef.dispatch に渡す action の type (既存の定数。expo-router 58 の CommonActions.reset が作る action と同じ値)
 */
const RESET_ACTION_TYPE = "RESET";

/** 畳んだ state の前面の route の位置。route は 1 つだけなので、その位置 (先頭) */
const COLLAPSED_STACK_INDEX = 0;

/**
 * 同意画面の route を取り除く操作を止めるか (expo-router の usePreventRemove の第 1 引数)。
 *   awaiting-consent   同意が要る間は全部止める (ログインの直後の routeAfterSignIn の REPLACE など)。
 *                      同意のゲートの畳み直し (RESET) は同意画面の route を key ごと再利用するので、同意画面は取り除かれず、ここには来ない
 *   signed-out-notice  ログアウトの後の案内。全部止める (「閉じる」でだけ閉じる)
 *   free               何も止めない
 * closing = 同意画面が自分で閉じる途中 (「閉じる」・未ログインで開かれたとき・afterSignOut)。止めない
 * accountFrozen = アカウントが凍結中 (useAccountFrozen の state が frozen。#1861)。止めない (凍結が先)。
 *   凍結のゲートの畳み直し (RESET。ルートの Stack を凍結の画面 1 つに) は同意画面の route を取り除く。expo-router 58 は、取り除かれる route の
 *   1 つでも止めていれば RESET ごと捨てるので、止めたままだと凍結中の利用者が同意画面に残る
 */
export function legalConsentScreenPreventsRemoval(
  mode: LegalConsentScreenMode,
  closing: boolean,
  accountFrozen: boolean,
): boolean {
  if (closing || accountFrozen) return false;
  return mode !== "free";
}

/**
 * ナビゲーターの state のうち、畳むのに読む欄 (expo-router 58 の NavigationState / PartialState の部分型。
 * 入れ子の navigator の state は routes[].state。rehydrate 前の state は stale: true で key・routeKeySeq を持たないことがある)
 */
export type NavigatorStateLike = {
  readonly key?: string;
  readonly index?: number;
  readonly type?: string;
  readonly routeNames?: readonly string[];
  readonly routeKeySeq?: number;
  readonly stale?: boolean;
  readonly routes: ReadonlyArray<{ readonly key?: string; readonly name: string; readonly state?: NavigatorStateLike }>;
};

/** 畳む先の route の持ち主の navigator の state (完全な state を作るのに要る key・routeNames・routeKeySeq がそろったもの) */
export type StackOwnerState = NavigatorStateLike & {
  readonly key: string;
  readonly routeNames: readonly string[];
  readonly routeKeySeq: number;
};

/**
 * expo-router 58 の RESET が受け付ける完全な state の共通の欄。
 * BaseRouter は stale === false のときだけ受け付け、routeNames が持ち主と同じ集合であることを確かめる
 * (それ以外は「Include key, index, routeNames, routeKeySeq, and stale: false」の警告を出して捨てる)
 */
type CollapsedStackBase = {
  readonly key: string;
  readonly index: typeof COLLAPSED_STACK_INDEX;
  readonly routeKeySeq: number;
  readonly routeNames: string[];
  readonly type?: string;
  readonly stale: false;
};

/**
 * route 1 つ (同意画面) に畳んだ完全な state。その route が既にあれば key ごと、無ければ名前だけ
 * (key の無い route には、expo-router の RESET が持ち主の key と routeKeySeq から key を付ける)
 */
export type CollapsedStackState =
  | (CollapsedStackBase & { readonly routes: [{ readonly name: string; readonly key: string }] })
  | (CollapsedStackBase & { readonly routes: [{ readonly name: string }] });

/**
 * navigationRef.dispatch に渡す RESET の action (ゲートが使う)。target は持ち主の navigator の key
 * (expo-router 58 は target の navigator だけに action を渡す。target が無いと前面の navigator から親へ順に試す)
 */
export type CollapseStackAction = {
  readonly type: typeof RESET_ACTION_TYPE;
  readonly target: string;
  readonly payload: CollapsedStackState;
};

/**
 * routeNames に routeName を持つ (= その route の持ち主の) navigator の state を、ルートから前面の枝を降りて探す。
 * 持ち主が無い・rehydrate 前 (stale・key や routeKeySeq が無い)・root が無い (コンテナの準備の前) なら null
 * (ゲートは何もせず次の描画で試す)
 */
export function findNavigatorOwningRoute(root: NavigatorStateLike | undefined, routeName: string): StackOwnerState | null {
  let current: NavigatorStateLike | undefined = root;
  while (current !== undefined) {
    if (current.routeNames?.includes(routeName)) {
      const { key, routeNames, routeKeySeq } = current;
      if (current.stale === true || key === undefined || routeNames === undefined || routeKeySeq === undefined) return null;
      return { ...current, key, routeNames, routeKeySeq };
    }
    const focusedIndex: number = current.index ?? 0;
    current = current.routes[focusedIndex]?.state;
  }
  return null;
}

/**
 * 持ち主の navigator の state を、routeName の route 1 つに畳んだ完全な state にする。
 * その route が既にあればその key を再利用する (同じ key は同じ画面。取り除かれず、同意画面なら usePreventRemove の止めにも当たらない)
 */
export function collapsedStackState(owner: StackOwnerState, routeName: string): CollapsedStackState {
  const existingKey = owner.routes.find((route) => route.name === routeName)?.key;
  const base: CollapsedStackBase = {
    key: owner.key,
    index: COLLAPSED_STACK_INDEX,
    routeKeySeq: owner.routeKeySeq,
    routeNames: [...owner.routeNames],
    stale: false,
    ...(owner.type === undefined ? {} : { type: owner.type }),
  };
  return existingKey === undefined
    ? { ...base, routes: [{ name: routeName }] }
    : { ...base, routes: [{ name: routeName, key: existingKey }] };
}

/** 持ち主の navigator に宛てた、routeName の route 1 つに畳む RESET の action */
export function collapseStackAction(owner: StackOwnerState, routeName: string): CollapseStackAction {
  return { type: RESET_ACTION_TYPE, target: owner.key, payload: collapsedStackState(owner, routeName) };
}
```

**実物の router での確認** (設計の時点。expo-router 58.0.23 の `build/react-navigation/routers/index.js` の `StackRouter` の `getStateForAction` に、ルートの Stack の形の state `{ key: 'navigator:root', routeKeySeq: 3, index: 1, type: 'stack', stale: false, routeNames: ['index', '(tabs)', 'legal-consent', 'settings/account'], routes: [index, (tabs), settings/account] }` を渡した): いまの部分の state (`{ type: 'RESET', payload: { index: 0, routes: [{ name: 'legal-consent' }] } }`) は警告を 1 回出して受け付けない (Unhandled)。上の `collapseStackAction` の形 (key の無い route) は受け付け、`routes` が `[{ name: 'legal-consent', key: 'legal-consent:3' }]`・`routeKeySeq` が 4 になる。同意画面の route (`legal-consent:3`) を持つ state に key ありの形を渡すと、その key のまま `[legal-consent]` になる。§13.2 の T-ML12 がこの 3 つをテストにする。

コメントの直し: 既存の「`@react-navigation の CommonActions.reset`」「`beforeRemove`」「`navigationRef.reset`」の語を、`usePreventRemove` / `navigationRef.dispatch` (完全な state の RESET) の現在形に。origin/main で当たる所は、13 行 (ファイルの冒頭の説明の「取り除く操作 (beforeRemove) を通すか止めるか」→「取り除く操作を止めるか (usePreventRemove)」)・36 行 (`LEGAL_CONSENT_SCREEN_ROUTE_NAME` の説明の「(navigationRef.reset)」→「(navigationRef.dispatch。完全な state の RESET)」)・193 行 (`RESET_ACTION_TYPE` の説明。上のブロックの文に替える)・225 行 (`LegalConsentScreenRemovalDecision` の説明。型と一緒に消す) の 4 か所 (設計書 13b の行は §15.2)。

### 9.5 `apps/mobile/app/legal-consent.tsx` の差分 (説明用)

```tsx
// tsc:skip (expo-router 58 の usePreventRemove の型が要る)
import { router, usePreventRemove } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
// … ほかの import は同じ。useNavigation は使わない

export default function LegalConsentScreen() {
  // … session / state / mode の計算は同じ (sawRequiredRef も同じ。modeRef は消す)
  // 凍結の状態 (#1861。src/providers/AccountFrozenProvider の useAccountFrozen。import を 1 行足す)
  const { state: frozenState } = useAccountFrozen();
  /** この画面が自分で閉じる途中 (「閉じる」・ログアウトに失敗したとき・未ログインで開かれたとき)。ref は effect の同期の判定に、state は hook の引数に使う。以後の取り除く操作は止めない */
  const closingRef = useRef(false);
  const [closing, setClosing] = useState(false);

  // 取り除く操作 (GO_BACK・POP・POP_TO_TOP・REPLACE・NAVIGATE・同意画面を含まない RESET) を止める。止めた操作は捨てる (repeat は呼ばない)。
  // awaiting-consent で止めた置き換えの行き先は、同意の後に入口が profile から決め直す (cross/13b S1 の (B))。
  // 凍結中は止めない (凍結のゲートが Stack を凍結の画面 1 つに畳む RESET を通す。#1861)
  const disablePrevention = usePreventRemove(
    legalConsentScreenPreventsRemoval(mode, closing, frozenState === "frozen"),
    () => {},
  );

  const close = useCallback(() => {
    closingRef.current = true;
    // 次の描画で usePreventRemove の第 1 引数を false にそろえる (hook は、解いたのに引数が true のままだと警告する)
    setClosing(true);
    // いま積む遷移を止めない
    disablePrevention();
    // 下に画面があれば (deep link で上に開かれた同意画面) その画面へ戻る。無ければ (ゲートが畳んだ同意画面) 入口へ
    if (router.canGoBack()) router.back();
    else router.replace(ENTRY_SCREEN_PATH);
  }, [disablePrevention]);

  // 未ログインのまま開かれた同意画面・afterSignOut・描画 (header の「閉じる」) は同じ。beforeRemove の effect は消す
}
```

ほかの差分: `const navigation = useNavigation();` (43 行) と、`beforeRemove` の受け手だけが読んでいた `modeRef` (51〜52 行) を消す (`usePreventRemove` は描画のたびの `mode` を引数に取るので、ref は要らない)。`legalConsentScreenRemovalDecision` の import (11 行) を `legalConsentScreenPreventsRemoval` に替える。ファイルの冒頭の説明のコメントは、30 行の「ゲートの畳み直し (RESET) のほかの取り除く操作 (…) を止める」を「取り除く操作 (ログインの直後の routeAfterSignIn の replace など) を全部止める (同意のゲートの畳み直しは同意画面の route を key ごと再利用するので、取り除かれない)。ただし凍結中 (#1861) は止めない (凍結が先。凍結のゲートの畳み直しは同意画面の route を取り除くので、止めると expo-router 58 が RESET ごと捨て、凍結の画面へ畳めない)」に、32 行の「(アプリが背面へ。beforeRemove は流れない)」を「(アプリが背面へ。usePreventRemove の止めには当たらない)」に、40 行 (modeRef の説明) を消す。

```tsx
// tsc:skip (消す行の確かめ。origin/main の 63〜69 行。段 A の V-2 が許す型エラーはこの範囲)
  useEffect(() => {
    return navigation.addListener("beforeRemove", (event) => {
      if (closingRef.current) return;
      if (legalConsentScreenRemovalDecision(modeRef.current, event.data.action.type) === "allow") return;
      event.preventDefault();
    });
  }, [navigation]);
```

### 9.6 `apps/mobile/src/components/legal/LegalConsentGate.tsx` の差分 (説明用)

いまの effect の `state === "required"` の分岐の終わりの 1 か所 (`navigationRef.reset({ index: 0, routes: [{ name: LEGAL_CONSENT_SCREEN_ROUTE_NAME }] })` から `return;` まで。前面が同意画面で `openedRef` が無いときと、前面が対象のパスのときの両方がここを通る) を次にする。import は `ENTRY_SCREEN_PATH`・`LEGAL_CONSENT_SCREEN_ROUTE_NAME`・`isMobileLegalConsentExemptPath` に `findNavigatorOwningRoute`・`collapseStackAction` を足す。冒頭の説明のコメントの「`navigationRef.reset`」は「`navigationRef.dispatch` (完全な state の RESET)」に直す。

```tsx
// tsc:skip (expo-router 58 の NavigationContainerRef の型が要る)
import {
  ENTRY_SCREEN_PATH,
  LEGAL_CONSENT_SCREEN_ROUTE_NAME,
  findNavigatorOwningRoute,
  isMobileLegalConsentExemptPath,
  collapseStackAction,
} from "../../lib/legal-consent";

// effect の中の、state === "required" の分岐の終わり:
const owner = findNavigatorOwningRoute(navigationRef.getRootState(), LEGAL_CONSENT_SCREEN_ROUTE_NAME);
if (owner === null) {
  // ルートの Stack の state がまだそろっていない。openedRef を立てず、次の描画 (pathname か state が変わる) で試す
  console.warn("[LegalConsentGate] root stack is not ready; retry on next render");
  return;
}
// expo-router 58 の RESET は完全な state (key・index・routeNames・routeKeySeq・stale: false) だけを受け付ける。
// 持ち主の navigator に宛てる。58 では dispatch は commit の後に流れる。同意画面の route が既にあれば key ごと再利用し、取り除かない
navigationRef.dispatch(collapseStackAction(owner, LEGAL_CONSENT_SCREEN_ROUTE_NAME));
openedRef.current = true;
closingRef.current = false;
return;
```

`getRootState(): NavigationState` と `dispatch(action: NavigationAction): void` は expo-router 58 の `NavigationContainerRef` にある (`build/react-navigation/core/types.d.ts`。`NavigationAction` は `Readonly<{ type: string; payload?: object; source?: string; target?: string }>`)。`NavigationState` は `NavigatorStateLike` に代入できる (`routes[].state` の `PartialState` も同じ部分型に入る)。`CollapseStackAction` は `NavigationAction` に代入できる。`navigationRef.reset(state)` (`state: PartialState<NavigationState> | NavigationState`) は使わない: `PartialState` は `stale?: true` で、`NavigationState` は route の `key` が必須なので、`stale: false` と key の無い route の組をどちらの型でも表せない。`as` で型を合わせない。

`apps/mobile/app/_layout.tsx` (118 行) のコメントも B-2 で現在形にする (コードは変えない。`gestureEnabled: false` は残し、`__tests__/app/root-layout-config.test.tsx` の期待もそのまま):

```tsx
// tsc:skip (JSX のコメント 1 行の差分)
// 前: {/* #1442: 同意画面。iOS のスワイプで閉じさせない (ほかの取り除く操作は画面の beforeRemove が扱う) */}
// 後: {/* #1442: 同意画面。iOS のスワイプで閉じさせない (ほかの取り除く操作は画面の usePreventRemove が止める) */}
```

### 9.6b `apps/mobile/src/components/AccountFrozenGate.tsx` の差分 (説明用。#1861 が足した凍結のゲート)

凍結のゲートは同意のゲート (§9.6) と同じ形で、`state === "frozen"` の分岐の終わりの 1 か所 (`navigationRef.reset({ index: 0, routes: [{ name: FROZEN_SCREEN_ROUTE_NAME }] })` から `return;` まで) が expo-router 58 で捨てられる (部分の state。§7.1 の B-2 の根拠のとおり)。同意のゲートと**同じ部品** (`findNavigatorOwningRoute`・`collapseStackAction`。`src/lib/legal-consent.ts` から import する。凍結のゲートは `ENTRY_SCREEN_PATH`・`routeNameOf` をすでにここから import している) を、凍結の画面の route の名前 `FROZEN_SCREEN_ROUTE_NAME` (`src/lib/account-frozen.ts`) で呼ぶ。部品を `account-frozen.ts` に複製しない。

```tsx
// tsc:skip (expo-router 58 の NavigationContainerRef の型が要る)
import { ENTRY_SCREEN_PATH, collapseStackAction, findNavigatorOwningRoute, routeNameOf } from "../lib/legal-consent";

// effect の中の、state === "frozen" の分岐の終わり:
const owner = findNavigatorOwningRoute(navigationRef.getRootState(), FROZEN_SCREEN_ROUTE_NAME);
if (owner === null) {
  // ルートの Stack の state がまだそろっていない。openedRef を立てず、次の描画 (pathname か state が変わる) で試す
  console.warn("[AccountFrozenGate] root stack is not ready; retry on next render");
  return;
}
navigationRef.dispatch(collapseStackAction(owner, FROZEN_SCREEN_ROUTE_NAME));
openedRef.current = true;
closingRef.current = false;
return;
```

冒頭の説明のコメントの「`navigationRef.reset`」は「`navigationRef.dispatch` (完全な state の RESET)」に直す。`src/lib/account-frozen.ts` の `FROZEN_SCREEN_ROUTE_NAME` の説明のコメント (「`navigationRef.reset`」) も同じ語に直す。`routeNames` に `frozen` が入っている (`app/frozen.tsx` が root の Stack の画面) ことは、`findNavigatorOwningRoute` が持ち主を探す条件そのもの (§9.4)。凍結の画面の route が既にあれば `key` ごと再利用するので、凍結の画面は取り除かれない。

### 9.7 `tests/mobile-toolchain-contract.test.ts` (新規。正典)

```ts
/**
 * #1591 モバイルのツールチェーンの版の組と、OTA の設定の固定
 *
 * モバイルの React は react-native に入っているレンダラーと「完全に同じ版」でないと動かない (ルート CLAUDE.md)。
 * Expo は SDK ごとに合う版を expo/bundledNativeModules.json に持ち、`npx expo install --fix` がそれに合わせる。
 * Dependabot の react-native のパッチ更新 (許している) や手作業の更新で片方だけが上がると、起動時に落ちる。
 * ここでは次を固定する。
 *   1. apps/mobile の react / react-native / react-native-reanimated / expo-router / jest-expo の宣言が、
 *      入っている expo の bundledNativeModules.json の値と同じ (react-test-renderer は react と同じ版)
 *   2. package-lock.json で apps/mobile から解決される react と react-test-renderer が同じ版で、react-native が宣言と同じ
 *   3. jest は 30 系で、jest-expo の必須の peer @react-native/jest-preset が react-native と同じ版
 *   3b. lockfile の置き場: react-native・@react-native/jest-preset・react-test-renderer・jest・jest-expo・expo はルートに巻き上がり、
 *      apps/mobile の入れ子は react と @types/react だけ (@react-native/jest-preset は自分の場所から react-native を
 *      Node の require.resolve で引き、jest.config.js の moduleNameMapper は react-test-renderer をルートに写すため。
 *      lockfile を 1 回で作り直すと react-native ほかが入れ子になり、Jest が preset の読み込みで止まる。docs/design/mobile/07 §2.4)
 *   4. app.json の runtimeVersion は fingerprint の方針 (トップレベルだけ) で、更新は無効のまま
 *      (OTA を使う設計が通ったら、その設計がこの 2 行の期待を書き換える)
 *   5. expo-file-system は /legacy の入口だけを読む (新旧の API を混ぜない)。アプリのソースに加えて Jest のテストの
 *      jest.mock と import も見る (テストが既定の入口から mock の関数を取り出すと、SDK 58 では mock でない本物の入口になって落ちる)
 *   6. 使っていないので消した依存が、import の無いまま戻っていない
 *   7. expo install --check から外すのは typescript だけ (ルートと同じ 1 つの typescript に据え置く。ほかの依存のずれは --check に報告させる)。
 *      Jest の resolver は react-native-reanimated/jest/resolver (Reanimated 4 の内部ファイルを Jest の下で読む。docs/design/mobile/07 §7.2 C-10)
 * 落ちたら: SDK の更新としてまとめて上げる (docs/design/mobile/07-toolchain-upgrade.md §6)。片方だけ上げない。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MOBILE_DIR = 'apps/mobile';
const MOBILE_PACKAGE_JSON = `${MOBILE_DIR}/package.json`;
const MOBILE_APP_JSON = `${MOBILE_DIR}/app.json`;
const MOBILE_JEST_CONFIG = `${MOBILE_DIR}/jest.config.js`;
const LOCKFILE = 'package-lock.json';
/** expo が SDK ごとに決める版の表 (expo install --fix / --check が読む)。ルートの node_modules に巻き上がる */
const BUNDLED_NATIVE_MODULES = 'node_modules/expo/bundledNativeModules.json';
/** Jest のメジャー (jest-expo 58 が Jest 30 の依存で組まれている) */
const JEST_MAJOR = 30;
/** runtimeVersion の方針。ネイティブに効く依存と設定のハッシュ (docs/design/mobile/07 §11) */
const RUNTIME_VERSION_POLICY = 'fingerprint';
/** 宣言を bundledNativeModules と逐語で合わせるパッケージ */
const BUNDLED_PINNED = ['react', 'react-native', 'react-native-reanimated', 'react-native-worklets', 'expo-router', 'jest-expo'] as const;
/** #1591 で消した、使っていない依存。戻すなら import する所と一緒に足し、ここから外す */
const REMOVED_UNUSED = ['@react-native-community/slider', 'expo-haptics', 'expo-image-manipulator'] as const;
/** ルートに巻き上がっていなければならないツールチェーン (docs/design/mobile/07 §2.4・§10.1) */
const HOISTED_TOOLCHAIN = ['react-native', '@react-native/jest-preset', 'react-test-renderer', 'jest', 'jest-expo', 'expo'] as const;
/** apps/mobile/node_modules に入れ子で持ってよいもの (Web と版が違う React とその型だけ) */
const MOBILE_NESTED_ALLOWED = ['@types/react', 'react'] as const;
/** lockfile の packages のキーで、apps/mobile の入れ子の接頭辞 */
const MOBILE_NESTED_PREFIX = `${MOBILE_DIR}/node_modules/`;
/** expo-file-system の指定子を見るディレクトリ (アプリのソースと Jest のテスト) */
const FILE_SYSTEM_SCAN_DIRS = [`${MOBILE_DIR}/app`, `${MOBILE_DIR}/src`, `${MOBILE_DIR}/__tests__`];
const SOURCE_FILE = /\.(ts|tsx)$/;
/** import の from・require・jest.mock の第 1 引数にある expo-file-system の指定子 (第 1 グループは /legacy などの下の入口) */
const FILE_SYSTEM_SPECIFIER = /(?:from\s+|require\(\s*|jest\.mock\(\s*)['"]expo-file-system(\/[^'"]*)?['"]/g;
const FILE_SYSTEM_LEGACY_SUBPATH = '/legacy';
/** FILE_SYSTEM_SPECIFIER が拾う形の見本。subpath は第 1 グループ (下の入口。既定の入口は undefined) */
interface FileSystemSpecifierSample {
  label: string;
  sample: string;
  subpath: string | undefined;
}
/**
 * 走査の it は「既定の入口が 0 件」しか確かめないので、正規表現の 3 つの選択肢 (`from`・`require(`・`jest.mock(`) の
 * どれかが欠けても、違反を見逃したまま緑になる。見本で拾う力を固定する。jest.mock の見本は、後から足された Jest のテストが
 * mock の指定子を既定の入口のまま書いた形 (__tests__/settings/export-rows.test.tsx。#1876)
 */
const FILE_SYSTEM_SPECIFIER_SAMPLES: readonly FileSystemSpecifierSample[] = [
  { label: '既定の入口の import', sample: "import * as FileSystem from 'expo-file-system';", subpath: undefined },
  { label: '/legacy の import', sample: 'import * as FileSystem from "expo-file-system/legacy";', subpath: FILE_SYSTEM_LEGACY_SUBPATH },
  { label: '/legacy でない下の入口の import', sample: "import { File } from 'expo-file-system/next';", subpath: '/next' },
  { label: '既定の入口の require', sample: "const FileSystem = require('expo-file-system');", subpath: undefined },
  { label: '既定の入口の jest.mock', sample: "jest.mock('expo-file-system', () => ({", subpath: undefined },
  { label: '改行をはさんだ既定の入口の jest.mock', sample: "jest.mock(\n  'expo-file-system',\n  () => ({}),\n);", subpath: undefined },
  { label: '/legacy の jest.mock', sample: "jest.mock('expo-file-system/legacy', () => ({", subpath: FILE_SYSTEM_LEGACY_SUBPATH },
];
/**
 * expo install --check から外す依存 (apps/mobile/package.json の expo.install.exclude)。typescript だけ:
 * SDK 58 の --check は Expo の API の relatedPackages (typescript ~6.0.3) とも突き合わせるが、ルートと同じ 5.9.3 に据え置く
 * (docs/design/mobile/07 §6.4)。ほかの依存を足すと、その依存の SDK とのずれを --check が報告しなくなる
 */
const EXPO_INSTALL_EXCLUDED = ['typescript'] as const;
/** jest.config.js の resolver (Reanimated 4 の Jest の resolver。docs/design/mobile/07 §7.2 C-10・§9.2) */
const MOBILE_JEST_RESOLVER = 'react-native-reanimated/jest/resolver';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  expo?: { install?: { exclude?: unknown } };
}
interface Lockfile {
  packages: Record<string, { version?: string }>;
}
interface AppJson {
  expo: {
    runtimeVersion?: unknown;
    ios?: { runtimeVersion?: unknown };
    android?: { runtimeVersion?: unknown };
    updates?: { enabled?: unknown; checkAutomatically?: unknown };
  };
}

const readText = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = <T>(rel: string): T => JSON.parse(readText(rel)) as T;

const mobilePkg = readJson<PackageJson>(MOBILE_PACKAGE_JSON);
const lock = readJson<Lockfile>(LOCKFILE);
const bundled = readJson<Record<string, string>>(BUNDLED_NATIVE_MODULES);
const appJson = readJson<AppJson>(MOBILE_APP_JSON);

/** package-lock.json 上で fromDir ('' はルート) から見て name がどの版に解決されるか。入れ子を先に探し、無ければルートへ戻る */
function resolveInLock(fromDir: string, name: string): { location: string; version: string } {
  const segments = fromDir === '' ? [] : fromDir.split('/');
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const base = segments.slice(0, depth).join('/');
    const location = `${base === '' ? '' : `${base}/`}node_modules/${name}`;
    const version = lock.packages[location]?.version;
    if (version !== undefined) return { location, version };
  }
  throw new Error(`package-lock.json に ${name} が見つかりません (${fromDir === '' ? 'ルート' : fromDir} から解決)`);
}

/** "~30.5.2" / "^19.0.0" / "19.3.0" → 30 / 19 / 19 */
function majorOf(range: string | undefined, what: string): number {
  const match = range === undefined ? null : /\d+/.exec(range);
  if (match === null) throw new Error(`${what} のバージョンを読み取れません: ${String(range)}`);
  return Number(match[0]);
}

function listSourceFiles(dirRel: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dirRel), { withFileTypes: true })) {
    const rel = `${dirRel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '__tests__' && entry.name !== '__mocks__') out.push(...listSourceFiles(rel));
    } else if (SOURCE_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(rel);
    }
  }
  return out;
}

describe('#1591 apps/mobile の版の組 (bundledNativeModules と同じ)', () => {
  it.each(BUNDLED_PINNED)('%s の宣言は expo/bundledNativeModules.json の値と同じ', (name) => {
    const declared = mobilePkg.dependencies?.[name] ?? mobilePkg.devDependencies?.[name];
    expect(declared, `${name} が apps/mobile/package.json に無い`).toBeDefined();
    expect(bundled[name], `${name} が bundledNativeModules.json に無い`).toBeDefined();
    expect(declared).toBe(bundled[name]);
  });

  it('react-test-renderer の宣言は react と同じ版 (レンダラーは React と完全に同じ版でないと動かない)', () => {
    expect(mobilePkg.devDependencies?.['react-test-renderer']).toBe(mobilePkg.dependencies?.react);
  });

  it('package-lock.json: apps/mobile から見た react と react-test-renderer が同じ版で、react-native が宣言と同じ', () => {
    const react = resolveInLock(MOBILE_DIR, 'react').version;
    expect(react).toBe(mobilePkg.dependencies?.react);
    expect(resolveInLock(MOBILE_DIR, 'react-test-renderer').version).toBe(react);
    expect(resolveInLock(MOBILE_DIR, 'react-native').version).toBe(mobilePkg.dependencies?.['react-native']);
  });

  it(`jest は ${JEST_MAJOR} 系で、jest-expo の必須の peer @react-native/jest-preset は react-native と同じ版`, () => {
    expect(majorOf(mobilePkg.devDependencies?.jest, 'jest')).toBe(JEST_MAJOR);
    expect(majorOf(resolveInLock(MOBILE_DIR, 'jest').version, 'jest (lock)')).toBe(JEST_MAJOR);
    expect(mobilePkg.devDependencies?.['@react-native/jest-preset']).toBe(mobilePkg.dependencies?.['react-native']);
  });

  it('package-lock.json: react-native・@react-native/jest-preset・react-test-renderer・jest・jest-expo・expo はルートにあり、apps/mobile の入れ子は react と @types/react だけ', () => {
    for (const name of HOISTED_TOOLCHAIN) {
      expect(lock.packages[`node_modules/${name}`]?.version, `${name} がルートの node_modules に無い`).toBeDefined();
    }
    const nested = Object.keys(lock.packages)
      .filter((location) => location.startsWith(MOBILE_NESTED_PREFIX))
      .map((location) => location.slice(MOBILE_NESTED_PREFIX.length))
      .sort();
    expect(nested).toEqual([...MOBILE_NESTED_ALLOWED].sort());
  });

  it.each(REMOVED_UNUSED)('使っていないので消した %s が宣言に戻っていない', (name) => {
    expect(mobilePkg.dependencies?.[name]).toBeUndefined();
    expect(mobilePkg.devDependencies?.[name]).toBeUndefined();
  });
});

describe('#1591 OTA の設定 (app.json)', () => {
  it(`runtimeVersion はトップレベルの { policy: '${RUNTIME_VERSION_POLICY}' } だけ (ios / android の直書きは無い)`, () => {
    expect(appJson.expo.runtimeVersion).toEqual({ policy: RUNTIME_VERSION_POLICY });
    expect(appJson.expo.ios?.runtimeVersion).toBeUndefined();
    expect(appJson.expo.android?.runtimeVersion).toBeUndefined();
  });

  it('更新は無効のまま (enabled: false・checkAutomatically: NEVER)。OTA を使う設計が通るまで変えない', () => {
    expect(appJson.expo.updates?.enabled).toBe(false);
    expect(appJson.expo.updates?.checkAutomatically).toBe('NEVER');
  });
});

describe('#1591 expo-file-system は /legacy の入口だけを読む', () => {
  it('app/・src/・__tests__ の import・require・jest.mock の指定子はすべて expo-file-system/legacy', () => {
    const offenders: string[] = [];
    let imports = 0;
    for (const file of FILE_SYSTEM_SCAN_DIRS.flatMap(listSourceFiles)) {
      const text = readText(file);
      const pattern = new RegExp(FILE_SYSTEM_SPECIFIER.source, 'g');
      let match: RegExpExecArray | null = pattern.exec(text);
      while (match !== null) {
        imports += 1;
        if (match[1] !== FILE_SYSTEM_LEGACY_SUBPATH) offenders.push(`${file}: expo-file-system${match[1] ?? ''}`);
        match = pattern.exec(text);
      }
    }
    expect(imports, '走査が空振りしていない (expo-file-system を読むファイルがある)').toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it.each(FILE_SYSTEM_SPECIFIER_SAMPLES)('指定子の正規表現は $label を拾い、下の入口を読み分ける', ({ sample, subpath }) => {
    const match = new RegExp(FILE_SYSTEM_SPECIFIER.source, 'g').exec(sample);
    expect(match, `拾えていない: ${sample}`).not.toBeNull();
    expect(match?.[1]).toBe(subpath);
  });
});

describe('#1591 expo install --check と Jest の resolver', () => {
  it('expo install --check から外すのは typescript だけで、apps/mobile の typescript はルートと同じ 1 つ (入れ子にしない)', () => {
    expect(mobilePkg.expo?.install?.exclude).toEqual([...EXPO_INSTALL_EXCLUDED]);
    expect(resolveInLock(MOBILE_DIR, 'typescript').location).toBe('node_modules/typescript');
  });

  it(`jest.config.js の resolver は ${MOBILE_JEST_RESOLVER} で、apps/mobile から解決できる`, () => {
    const config = readText(MOBILE_JEST_CONFIG);
    expect(config).toContain(`resolver: require.resolve('${MOBILE_JEST_RESOLVER}')`);
    const requireFromMobile = createRequire(path.join(ROOT, MOBILE_PACKAGE_JSON));
    expect(fs.existsSync(requireFromMobile.resolve(MOBILE_JEST_RESOLVER))).toBe(true);
  });
});
```

### 9.8 npm audit の根の advisory を数える手順 (段 A の検証。実装者はそのまま流す)

```js
// node -e の本文。`npm audit --json > audit.json` (作業用の場所。コミットしない) のあと、この本文を node -e に渡し、引数に audit.json を付けて流す。
// 出力: 根の advisory の一覧 (パッケージ名と GHSA) と、名前が jest 系で始まる high の一覧 (空であること)
const report = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const highOrCritical = Object.entries(report.vulnerabilities).filter(([, v]) => v.severity === 'high' || v.severity === 'critical');
const roots = highOrCritical
  .filter(([, v]) => v.via.some((x) => typeof x === 'object'))
  .map(([name, v]) => `${name}: ${v.via.filter((x) => typeof x === 'object').map((x) => x.url.split('/').pop()).join(',')}`);
const jestFamily = highOrCritical.map(([name]) => name).filter((name) => /^(jest|@jest\/|babel-jest|create-jest|expect$|jest-expo)/.test(name));
console.log(JSON.stringify({ totals: report.metadata.vulnerabilities, roots, jestFamily }, null, 2));
```

合格: `roots` が `braces: GHSA-vfj7-8cjw-p6xm` と `node-forge: GHSA-86w9-cpqp-85rv` の 2 行 (順不同) だけ。`jestFamily` が空。`image-size` と `postcss` の行が無い。`totals` は PR の本文に写す (数は合否に使わない)。`--omit=dev` でも同じ手順で流し、`roots` が同じ 2 行であること。

### 9.9 設計上の約束

- `as any` を新しく書かない (A-3 で `blood-tests.tsx` の 2 行が減る。ほかの 26 行は本冊の範囲外で残る)。`as` で型を合わせない (B-2 は `dispatch` で型を通す。§9.6)。
- 版の文字列は `bundledNativeModules.json` の逐語。`^` / `~` を自分で付け替えない (`expo` と `jest` だけ本冊が決めた範囲)。
- `package-lock.json` は手で編集しない。作り直しの手順 (§10.1) だけ。
- 設計正典 (`docs/design/**`・ルート `CLAUDE.md`) は実装レーンが書き換えない (§15.2 は専権 PATCH)。

### 9.10 `apps/mobile/app/(tabs)/_layout.tsx` の隠しタブの書き方 (B-1)

設定の画面は `(tabs)` の中の隠しタブのまま置き、`href: null` の代わりに、expo-router 5 が `href: null` を中で展開していた 2 つ (`tabBarButton` と `tabBarItemStyle`) を直接書く。置き場・パス・設定の画面のコード・遷移は変えない。

**expo-router 58.0.23 の実物で、こう決まる** (npm の tarball の `build/` を読んだ):

| 段 | 実物 | 設定の画面 (本冊の書き方) | `href: null` のままなら |
|---|---|---|---|
| 1. options の前処理 | `build/layouts/TabsClient.js:85-127` の `processScreens`。`href` があるときだけ手を入れ、`href: null` は `hidden: true` に置き換える (91〜99 行。92 行に「タブを隠す手引きを新しい redirect の挙動に合わせて書き換える」の TODO)。`href` と `tabBarButton` を一緒に書くと例外 (88〜89 行)。`href` の無い画面はそのまま返す (127 行) | そのまま (`hidden` が付かない) | `hidden: true` |
| 2. タブの一覧 | `build/standard-navigation/useVisibleTabsWithRedirect.js:35-40`。layout で宣言した (`routeSource === 'layout'`) 画面のうち、`options.hidden !== true` のものだけを一覧に入れる | 一覧に入る | 一覧から外れる |
| 3. 前面の route が一覧に無いとき | 同 81〜88 行。navigator が前面なら、最初のタブ (無ければ一覧の先頭) へ `router.replace` | 一覧にあるので流れない。設定の画面が描かれる | 歯車の直後に最初のタブ (ホーム) へ戻される |
| 4. タブバーの項目 | `build/react-navigation/bottom-tabs/views/BottomTabBar.js:315-380`。一覧の route ごとに項目を描き、項目の外側の View の style に `options.tabBarItemStyle` を足し (372〜377 行)、中に `options.tabBarButton` を渡す (361 行)。`BottomTabItem.js:123-132` は外側の View の中に `button(...)` の戻り値だけを描く | 外側の View は `display: 'none'` で枠を取らず、中は `null` | (一覧に無いので項目も無い) |

expo-router 5.1.11 (いま) の `build/layouts/TabsClient.js:18-42` は、`href: null` を `tabBarItemStyle: { display: 'none' }` と、`null` を返す `tabBarButton` に展開していた。本冊の書き方はこの展開と同じ値なので、タブバーの見え方 (設定のボタンも枠も無い)・`(tabs)` の state に settings の route があること・歯車で届くことは、いまと同じになる。型: 58 の `TabsScreenOptions` (`build/layouts/TabsClient.d.ts`) は `BottomTabNavigationOptions & { href?: Href | null }` で、`tabBarButton?: (props: BottomTabBarButtonProps) => React.ReactNode` (`build/react-navigation/bottom-tabs/types.d.ts:153`)・`tabBarItemStyle?: StyleProp<ViewStyle>` (同 173 行) なので、`() => null` と `{ display: "none" }` はそのまま型が通る (`as` は要らない)。

`apps/mobile/app/(tabs)/_layout.tsx` の差分 (118〜119 行。ほかの行は変えない):

```tsx
// tsc:skip (JSX の 2 行の差分)
// 前:
        {/* タブバーに表示しないが(tabs)グループ内に必要なファイル */}
        <Tabs.Screen name="settings" options={{ href: null }} />
// 後:
        {/* 設定の画面 (マイページの歯車から開く)。(tabs) の中に置き、タブバーには出さない: ボタンを描かず (tabBarButton が null)、枠も取らない (display: none)。
            href: null は使わない (expo-router 58 では route を届かなくし、最初のタブへ戻す。expo-router 5 の href: null はこの 2 つへの展開だった。#1591) */}
        <Tabs.Screen name="settings" options={{ tabBarButton: () => null, tabBarItemStyle: { display: "none" } }} />
```

`apps/mobile/app/(tabs)/profile.tsx` の 10 行のコメント (コードは変えない。`NATIVE_SETTINGS_ROUTE = '/(tabs)/settings'` もそのまま):

```tsx
// tsc:skip (コメント 1 行の差分)
// 前:  * 設定画面は (tabs) の中の、タブバーに出さない画面 (_layout.tsx の href: null)。
// 後:  * 設定画面は (tabs) の中の、タブバーに出さない画面 (_layout.tsx の tabBarButton: () => null と tabBarItemStyle の display: none。#1591)。
```

変えないもの: `app/(tabs)/settings.tsx` (段 A の A-1 の import の 1 行だけ)・`(tabs)/_layout.tsx` のほかの行 (31 行の session の止め・35 行の同意の状態のスピナー・44〜50 行の初期設定への振り分け・`AIFloatingFab`・`ErrorBoundary`)・`app/_layout.tsx` のルートの Stack・`NotificationRouter`。歯車からの `router.push('/(tabs)/settings')` は、いまと同じく `(tabs)` の navigator へ降りてタブを切り替える (`build/global-state/resolveNavigationDestination.js` が、ルートの Stack の前面の route (`(tabs)`) と行き先の名前が同じなので下の navigator へ降り、`build/react-navigation/routers/TabRouter.js` は PUSH を NAVIGATE と同じくタブの切り替えとして扱う)。

テスト: `tab-layout.test.tsx` の settings の it (§13.2) が layout の options の形を、`home/tabs-hidden-route.test.ts` (§9.12) が上の表の 1〜3 段を実物で見張る。4 段 (見え方) は実機 (§16 の M-2)。

### 9.11 V-1 の lockfile の形の検査 (段 A の検証。実装者はそのまま流す)

```js
// node <この本文を書いたファイル> <origin/main の package-lock.json の写し> <作り直した package-lock.json> <ルートの package.json>
// 作業用のファイルはリポジトリの外 (offload の行き先の一時の場所) に置き、コミットしない。出力が "V-1 OK" で終了コード 0 なら合格
const fs = require('node:fs');
const [beforePath, afterPath, rootPkgPath] = process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(beforePath, 'utf8')).packages;
const after = JSON.parse(fs.readFileSync(afterPath, 'utf8')).packages;
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
const MOBILE_NESTED_PREFIX = 'apps/mobile/node_modules/';
const versionAt = (lock, location) => lock[location]?.version;
const majorOf = (version) => (version === undefined ? undefined : Number(version.split('.')[0]));
const problems = [];
const expectAt = (location, predicate, label) => {
  const version = versionAt(after, location);
  if (!predicate(version)) problems.push(`${location}: ${label} (実際: ${version ?? '無し'})`);
};
// 1. ルートに巻き上がっていること (モバイルのツールチェーン)
expectAt('node_modules/react-native', (v) => v === '0.88.0', '0.88.0');
expectAt('node_modules/@react-native/jest-preset', (v) => v === '0.88.0', '0.88.0');
expectAt('node_modules/react-test-renderer', (v) => v === '19.3.0', '19.3.0');
expectAt('node_modules/react-native-reanimated', (v) => v === '4.7.1', '4.7.1');
expectAt('node_modules/react-native-worklets', (v) => v === '0.13.0', '0.13.0');
expectAt('node_modules/expo', (v) => majorOf(v) === 58, 'expo 58 系');
expectAt('node_modules/expo-router', (v) => majorOf(v) === 58, 'expo-router 58 系');
expectAt('node_modules/jest-expo', (v) => majorOf(v) === 58, 'jest-expo 58 系');
expectAt('node_modules/jest', (v) => majorOf(v) === 30, 'jest 30 系');
expectAt('node_modules/babel-jest', (v) => majorOf(v) === 30, 'babel-jest 30 系');
// 2. apps/mobile の入れ子は react と @types/react の 2 つだけ (React の二重化はこの 2 つに閉じる)
const nested = Object.keys(after).filter((k) => k.startsWith(MOBILE_NESTED_PREFIX)).map((k) => k.slice(MOBILE_NESTED_PREFIX.length)).sort();
if (JSON.stringify(nested) !== JSON.stringify(['@types/react', 'react'])) problems.push(`apps/mobile の入れ子が react と @types/react だけでない: ${nested.join(', ')}`);
expectAt(`${MOBILE_NESTED_PREFIX}react`, (v) => v === '19.3.0', '19.3.0');
expectAt(`${MOBILE_NESTED_PREFIX}@types/react`, (v) => v !== undefined && v.startsWith('19.3.'), '19.3 系');
// 3. 無いこと (high の根の経路)。Jest 29 の入れ子は、あっても 30 系であること
for (const location of ['node_modules/image-size', 'node_modules/@expo/metro-config/node_modules/postcss']) {
  if (after[location] !== undefined) problems.push(`${location} が残っている`);
}
for (const location of ['node_modules/@react-native/jest-preset/node_modules/babel-jest', 'node_modules/@react-native/jest-preset/node_modules/jest-environment-node']) {
  if (after[location] !== undefined && majorOf(after[location].version) !== 30) problems.push(`${location} が 30 系でない (${after[location].version})`);
}
// 4. Web (ルートの package.json が宣言する依存) の解決は変わらない
for (const name of Object.keys({ ...rootPkg.dependencies, ...rootPkg.devDependencies })) {
  const location = `node_modules/${name}`;
  if (versionAt(before, location) !== versionAt(after, location)) problems.push(`Web の依存 ${name} の版が変わった: ${versionAt(before, location)} → ${versionAt(after, location)}`);
}
console.log(problems.length === 0 ? 'V-1 OK' : `V-1 NG\n${problems.join('\n')}`);
process.exitCode = problems.length === 0 ? 0 : 1;
```

設計の時点で、§2.4 の 2 段で作った試作の lockfile はこの検査で `V-1 OK`、1 回で作り直した lockfile は `node_modules/react-native: 0.88.0 (実際: 無し)` ほかで `V-1 NG` になった。

### 9.12 `apps/mobile/__tests__/home/tabs-hidden-route.test.ts` (新規。正典。B-1)

§9.10 の表の 1〜3 段を、実物の expo-router 58 で見張る。`processScreens` (TabsClient の中の関数で export されない) は、TabsClient を読むときに `integrateWithRouter` へ渡されるのを差し替えで受け取る。`useVisibleTabsWithRedirect` は、読む文脈 (router・プレビュー・フォーカス・layout の route・ガード・href) だけを差し替え、タブの一覧の絞り込みと replace の判定は実物のまま通す。差し替えは `jest.doMock` (巻き上げられない) に絶対パスを渡し、TabsClient と hook が `require("../…")` / `require("./…")` で読むファイルと同じモジュールに当てる。差し替える 13 個のファイルは、どれも expo-router 58.0.23 の `build/` に実在する (`link/Link.js`・`react-navigation/bottom-tabs/index.js`・`react-navigation/bottom-tabs/navigators/createBottomTabNavigator.js`・`standard-navigation/appendMissingPlaceholderTabRoutes.js`・`layouts/createBaseTabProps.js`・`standard-navigation/index.js`・`react-navigation/native/index.js`・`global-state/useRouterActions.js`・`link/preview/PreviewRouteContext.js`・`Route.js`・`routeNode.js`・`layouts/GuardContext.js`・`standard-navigation/useBuildHref.js`)。実物のまま読むのは `constants.js` と `utils/orderRoutesByRouteNames.js` (どちらも `require` を持たない) と `react` (jest の `moduleNameMapper` でモバイルの 19.3.0)。`expo-router/package.json` は exports にあり、jest-expo 58 の環境の条件 (`require`・`react-native`) で解決できる。

```ts
// tsc:skip (Jest の大域と RNTL の型が要る。実装では段 B の V-2 (apps/mobile/tsconfig.json は __tests__ も含む) で型検査に掛かる)
/**
 * #1591 設定の画面 (隠しタブ) は expo-router 58 でも届く — 実物の expo-router に通す
 *
 * (tabs)/_layout.tsx は settings を href: null でなく、tabBarButton: () => null と tabBarItemStyle: { display: 'none' } で隠す。
 * expo-router 58 の JS の Tabs は、href: null を hidden: true に置き換え (build/layouts/TabsClient.js の processScreens)、
 * hidden の route をタブの一覧から外し、それが前面になると最初のタブへ replace する
 * (build/standard-navigation/useVisibleTabsWithRedirect.js)。mock の Tabs (tab-layout.test.tsx) ではこの 2 つが見えないので、
 * ここで実物に layout と同じ options を通す。描画の部品 (タブバー・Link・navigator) と、hook が読む文脈 (router・フォーカス・
 * layout の route・ガード・href) だけを差し替え、processScreens と、タブの一覧の絞り込み・replace の判定は実物のまま。
 * 落ちたら: expo-router の更新で隠しタブの扱いが変わった。docs/design/mobile/07-toolchain-upgrade.md §9.10 を見直す
 * (Cannot find module なら、build の下の内部のファイルの置き場が変わった)。
 */
import path from 'path';
import { renderHook } from '@testing-library/react-native';

/** expo-router の build の場所。内部のモジュールを絶対パスで差し替えて読む (exports の './package.json' から引く) */
const EXPO_ROUTER_BUILD_DIR = path.join(path.dirname(require.resolve('expo-router/package.json')), 'build');
const fromBuild = (relativePath: string): string => path.join(EXPO_ROUTER_BUILD_DIR, relativePath);

/** (tabs)/_layout.tsx が宣言するタブの route の名前 (宣言の順) */
const TAB_ROUTE_NAMES: string[] = ['home', 'menus', 'meals', 'comparison', 'profile', 'settings'];
const SETTINGS_ROUTE_NAME = 'settings';
/** 最初のタブ (expo-router が、一覧に無い前面の route を戻す先) */
const INITIAL_TAB_ROUTE_NAME = 'home';
/** 差し替えた useBuildHref が作る href の頭 */
const TABS_HREF_PREFIX = '/(tabs)/';
/** layout で宣言した画面の descriptor の routeSource (expo-router 58 で、タブの一覧に入る条件の 1 つ) */
const LAYOUT_ROUTE_SOURCE = 'layout';
/** findIndex が見つけられなかったときの値 */
const NOT_FOUND_INDEX = -1;

type ScreenOptions = Record<string, unknown>;
type ScreenLike = { name: string; options?: ScreenOptions };
type ProcessScreens = (screens: ScreenLike[]) => ScreenLike[];
type TabRouteLike = { key: string; name: string };
type TabDescriptorLike = { routeSource: string; options: ScreenOptions };
type VisibleTabs = { visibleRoutes: TabRouteLike[]; focusedIndex: number; focusedFallbackRoute: TabRouteLike | undefined };
type UseVisibleTabsWithRedirect = (args: {
  routes: TabRouteLike[];
  routeNames: string[];
  focusedRouteKey: string | undefined;
  descriptors: Record<string, TabDescriptorLike>;
}) => VisibleTabs;

const mockRouterReplace = jest.fn();
let capturedProcessScreens: ProcessScreens | undefined;

// TabsClient は読み込みのときに integrateWithRouter へ processScreens を渡す。それを受け取る (TabsClient の中身は実物)
jest.doMock(fromBuild('standard-navigation'), () => ({
  integrateWithRouter: (_navigator: unknown, _router: unknown, options: { processScreens: ProcessScreens }) => {
    capturedProcessScreens = options.processScreens;
    return () => null;
  },
}));
// TabsClient が読む描画の部品は使わないので空にする (読み込みでタブバーや navigator の依存を引かない)
for (const relativePath of [
  'link/Link',
  'react-navigation/bottom-tabs',
  'react-navigation/bottom-tabs/navigators/createBottomTabNavigator',
  'standard-navigation/appendMissingPlaceholderTabRoutes',
  'layouts/createBaseTabProps',
]) {
  jest.doMock(fromBuild(relativePath), () => ({}));
}
// useVisibleTabsWithRedirect が読む文脈を差し替える (navigator は前面・プレビューでない・ガードなし・最初のタブは home)。
// react-navigation/native は TabsClient も読む (TabRouter を integrateWithRouter に渡すだけなので、無くてよい)
jest.doMock(fromBuild('react-navigation/native'), () => ({ useIsFocused: () => true }));
jest.doMock(fromBuild('global-state/useRouterActions'), () => ({ useRouterActions: () => ({ replace: mockRouterReplace }) }));
jest.doMock(fromBuild('link/preview/PreviewRouteContext'), () => ({ useIsPreview: () => false }));
jest.doMock(fromBuild('Route'), () => ({ useRouteNode: () => null }));
jest.doMock(fromBuild('routeNode'), () => ({ getValidInitialRouteName: () => INITIAL_TAB_ROUTE_NAME }));
jest.doMock(fromBuild('layouts/GuardContext'), () => ({ useGuardRedirect: () => undefined }));
jest.doMock(fromBuild('standard-navigation/useBuildHref'), () => ({
  useBuildHref: () => (route: TabRouteLike) => `${TABS_HREF_PREFIX}${route.name}`,
}));

function loadProcessScreens(): ProcessScreens {
  require(fromBuild('layouts/TabsClient'));
  if (capturedProcessScreens === undefined) {
    throw new Error('expo-router の TabsClient が integrateWithRouter に processScreens を渡していない (内部が変わった)');
  }
  return capturedProcessScreens;
}

function loadUseVisibleTabsWithRedirect(): UseVisibleTabsWithRedirect {
  const loaded: { useVisibleTabsWithRedirect: UseVisibleTabsWithRedirect } = require(fromBuild('standard-navigation/useVisibleTabsWithRedirect'));
  return loaded.useVisibleTabsWithRedirect;
}

/** (tabs)/_layout.tsx の settings の options と同じ形 (§9.10) */
const hiddenTabOptions = (): ScreenOptions => ({ tabBarButton: () => null, tabBarItemStyle: { display: 'none' } });

const routes: TabRouteLike[] = TAB_ROUTE_NAMES.map((name, position) => ({ key: `${name}-${position}`, name }));
const settingsRouteKey: string | undefined = routes.find((route) => route.name === SETTINGS_ROUTE_NAME)?.key;

/** タブの descriptor (どれも layout で宣言した画面)。settings だけ、processScreens を通した options にする */
function descriptorsWith(settingsOptions: ScreenOptions): Record<string, TabDescriptorLike> {
  const descriptors: Record<string, TabDescriptorLike> = {};
  for (const route of routes) {
    descriptors[route.key] = {
      routeSource: LAYOUT_ROUTE_SOURCE,
      options: route.name === SETTINGS_ROUTE_NAME ? settingsOptions : { title: route.name },
    };
  }
  return descriptors;
}

describe('#1591 設定の画面 (隠しタブ) は expo-router 58 でも届く (実物の processScreens と useVisibleTabsWithRedirect)', () => {
  const processScreens = loadProcessScreens();
  const useVisibleTabsWithRedirect = loadUseVisibleTabsWithRedirect();
  const processedSettingsOptions = (options: ScreenOptions): ScreenOptions =>
    processScreens([{ name: SETTINGS_ROUTE_NAME, options }])[0]?.options ?? {};

  beforeEach(() => {
    mockRouterReplace.mockClear();
  });

  it('T-TB1: tabBarButton: () => null と tabBarItemStyle: display none の settings は、processScreens がそのまま返す (hidden を付けない)', () => {
    const screen: ScreenLike = { name: SETTINGS_ROUTE_NAME, options: hiddenTabOptions() };
    const [processed] = processScreens([screen]);
    expect(processed).toBe(screen);
    expect(processed?.options?.hidden).toBeUndefined();
  });

  it('T-TB2: href: null は processScreens が hidden: true に置き換える (expo-router 58 の挙動。本冊が href: null を使わない理由)', () => {
    expect(processedSettingsOptions({ href: null })).toEqual({ hidden: true });
  });

  it('T-TB3: 隠しタブの settings が前面でも、タブの一覧に残り、最初のタブへ replace しない', () => {
    const descriptors = descriptorsWith(processedSettingsOptions(hiddenTabOptions()));
    const { result } = renderHook(() =>
      useVisibleTabsWithRedirect({ routes, routeNames: TAB_ROUTE_NAMES, focusedRouteKey: settingsRouteKey, descriptors }),
    );
    expect(result.current.visibleRoutes.map((route) => route.name)).toEqual(TAB_ROUTE_NAMES);
    expect(result.current.focusedIndex).toBe(TAB_ROUTE_NAMES.indexOf(SETTINGS_ROUTE_NAME));
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it('T-TB4: href: null (hidden) の settings が前面だと、一覧から外れ、最初のタブへ 1 回 replace する (この番兵が実物の判定を見ていることの確かめ)', () => {
    const descriptors = descriptorsWith(processedSettingsOptions({ href: null }));
    const { result } = renderHook(() =>
      useVisibleTabsWithRedirect({ routes, routeNames: TAB_ROUTE_NAMES, focusedRouteKey: settingsRouteKey, descriptors }),
    );
    expect(result.current.visibleRoutes.map((route) => route.name)).not.toContain(SETTINGS_ROUTE_NAME);
    expect(result.current.focusedIndex).toBe(NOT_FOUND_INDEX);
    expect(mockRouterReplace).toHaveBeenCalledTimes(1);
    expect(mockRouterReplace).toHaveBeenCalledWith(`${TABS_HREF_PREFIX}${INITIAL_TAB_ROUTE_NAME}`);
  });
});
```

T-TB2 と T-TB4 は、58 の `href: null` の挙動 (本冊が `href: null` を使わない理由) が実物にあることの確かめで、expo-router の更新で `href: null` の扱いが変わったら赤になる。そのときは §9.10 の表を読み直し、`href: null` に戻せるかを決める (§17 の 10)。

---

## 10. 検証 (段ごと。合格の数)

実行は offload の行き先 (M2 で直接打たない)。全件は `npx vitest run` ではなくローカル CI の段 (`bash scripts/local-ci.sh --only unit,mobile`) で流し、`mobile:jest` / `mobile:core` / `unit:vitest` の行の GREEN と実数で判定する。

| # | 検査 | コマンド | 合格 | 段 |
|---|---|---|---|---|
| V-0 | Node の版 | `node -v` (offload の行き先) | 22.13.0 以上の 22 系 (k270 は v22.23.3) | A |
| V-1 | lockfile の形 | `npm ci --dry-run --ignore-scripts` と §9.11 の検査 (§10.1 の 3) | `npm ci --dry-run` が成功。§9.11 が `V-1 OK` (ルートの巻き上げ・入れ子は `react` と `@types/react` だけ・無いもの・Web の依存の版が origin/main と同じ) | A |
| V-2 | モバイルの型検査 | `npx tsc -p apps/mobile/tsconfig.json --noEmit --pretty false` | **段 A の後**: §2.2 の 6 件の部分集合に加えて、`apps/mobile/app/legal-consent.tsx` の `beforeRemove` の effect (いまの 63〜69 行。`useEffect(() => { return navigation.addListener("beforeRemove", …) }, [navigation])` の範囲) の中のエラーだけを許す (エラーの番号は問わない)。expo-router 58 の `useNavigation()` の既定の型のイベントの一覧に `beforeRemove` が無いためで、B-2 がこの effect を消す (§4.2 の S4・§12 の E-17)。段 A ではこのファイルを触らない。ほかの新しい file:line は 0 (A-8 で直す)。**段 B の後**: エラー 6 件以下で、file:line が §2.2 の 6 件の部分集合 (新しい file:line が 0。`legal-consent.tsx` の分も残っていない) | A・B |
| V-3 | モバイルの Jest 全件 | `bash scripts/local-ci.sh --only mobile` の `mobile:jest` | GREEN。収集は段 A で 121 ファイル、段 B 以降は 123 ファイル (`--listTests`。新設の `home/tabs-hidden-route.test.ts` と `app/legal-consent-frozen-collapse.test.tsx`。数は origin/main `d34f18d8` のもの。段 A の前に main を取り込んで Jest のテストが増えていたら、その数を PR の本文に写す)。failed 0。pending は現行と同じ数 | A・B・C |
| V-4 | npm audit (根の集合) | §9.8 (`npm audit --json` と `--omit=dev --json` の 2 回) | `roots` = braces・node-forge の 2 行。`jestFamily` 空。image-size・postcss 無し | A |
| V-5 | `packages/core` | `mobile:core` の行 | GREEN (変わらない) | A |
| V-6 | Expo の版の突き合わせ | `cd apps/mobile && npx expo install --check` | `typescript` だけを `expo.install.exclude` で外し (出力の「Skipped checking dependencies: typescript」)、ほかのずれ 0 件 (「Dependencies are up to date」) | A |
| V-7 | ルートの vitest 全件 (番兵) | `unit:vitest` の行 | GREEN。`tests/react-types-version-contract.test.ts`・`zod-single-copy-1444`・`mobile-easignore-bundle-inputs`・`native-app-tabs-contract`・`mobile-sign-out-doc-callers`・`ai-consent-settings-entry`・`data-share-not-consent`・`jst-today-source-scan`・`ai-daily-limit-mobile-raw-fetch`・`mobile-removed-files-references`・`security-workflow`・`local-ci-workflow-sync`・`webview-download-export-limit-contract`・`legal-consent-mobile-contract`・`handson-tour-files-structure-doc`・`maestro-flow-testids`・`faq-guide-wording-1859`・`src/__tests__/app/faq/account-answers.test.ts` と新設の `mobile-toolchain-contract` が緑 | A・B・C |
| V-8 | `runtimeVersion` の解決 | `cd apps/mobile && npx expo-updates runtimeversion:resolve --platform ios` (ネットワーク不要。`@expo/fingerprint` で計算) | 文字列 (fingerprint のハッシュ) が返り、`1.0.0` でない。PR の本文に写す | A |
| V-9 | expo-doctor | `cd apps/mobile && npx expo-doctor@latest` (ネットワークが要る) | 全項目が通る。通らない項目は、名前・文面・理由を PR の本文に写し (例: Expo Go の SDK 58 が未公開)、設定の誤り (スキーマ) は 0 件。「重複する依存」の項目は `react` (モバイル 19.3.0・ルート 19.2.8) だけを挙げる既知の項目で、PR の本文に写す (Web と別の React を持つ設計のため) | A |
| V-10 | ローカルの型検査 (ルート) | `unit:vitest` の前に local-ci が流す `tsc` (ルート) | 変わらない (モバイルのファイルはルートの tsconfig の対象外) | A |

段 B の後は V-2・V-3・V-7、段 C の後は V-3・V-7 を流し直す。

### 10.1 lockfile の作り直し (段 A の最初の手順。逐語)

1 回で作り直すと置き場が崩れる (§2.4) ので、2 段で作る。どちらの段も `package-lock.json` を手で編集しない。

1. `apps/mobile/package.json` を §6.1、ルート `package.json` の `overrides` を §6.2 にして commit (作業ツリーを汚したまま offload に乗せられない)。
2. offload の行き先で次を流し、`package-lock.json` を持ち帰る。`--no-install` は必須 (offload の既定の `npm ci` は、作り直す前の lockfile と新しい `package.json` が合わないので失敗する)。`KEEP` は §6.1 で版を変えない外部の依存 (と `@homegohan/*`)。1 段目で、それ以外の依存を `apps/mobile/package.json` から一時的に外して作り直し、SDK 53 の古い木を lockfile から消す。2 段目で §6.1 に戻す。

```bash
# worktree の直下で流す。offload は開発の機械の道具 (コミット済みの HEAD を行き先へ送り、--fetch のファイルを持ち帰る)
offload --host auto --no-install --fetch package-lock.json -- bash -c '
set -euo pipefail
WORK="$(mktemp -d)"
cp apps/mobile/package.json "$WORK/mobile-package.full.json"
KEEP="@supabase/supabase-js,zod,lucide-react-native,@expo-google-fonts/noto-sans-jp,resolve-from,react-native-url-polyfill" node -e "
const fs = require(\"node:fs\");
const keep = new Set(process.env.KEEP.split(\",\"));
const pkg = JSON.parse(fs.readFileSync(\"apps/mobile/package.json\", \"utf8\"));
for (const section of [\"dependencies\", \"devDependencies\"]) {
  pkg[section] = Object.fromEntries(Object.entries(pkg[section] ?? {}).filter(([name]) => name.startsWith(\"@homegohan/\") || keep.has(name)));
}
fs.writeFileSync(\"apps/mobile/package.json\", JSON.stringify(pkg, null, 2) + \"\\n\");
"
npm install --package-lock-only --ignore-scripts --legacy-peer-deps
cp "$WORK/mobile-package.full.json" apps/mobile/package.json
npm install --package-lock-only --ignore-scripts || {
  npm install --package-lock-only --ignore-scripts --legacy-peer-deps
  npm install --package-lock-only --ignore-scripts
}
'
```

   2 段目の素の作り直しは ERESOLVE で止まる (`react-native-web` の peer の `react-dom` と、モバイルの `react` 19.3.0 の組。ルート CLAUDE.md の既知の ERESOLVE) ので、`--legacy-peer-deps` → 素の 1 回へ進む。設計の時点の試作では、2 段目の最後の素の 1 回は成功した。
3. 持ち帰った lockfile を検査する (手元の `node` で流してよい。JSON を読むだけで、テスト・型検査・build ではない): `git show origin/main:package-lock.json > <作業ツリーの外の一時の場所>/package-lock.before.json` (`git checkout` で戻さない) → §9.11 の本文を `<一時の場所>/v1.js` に書き → worktree の直下で `node <一時の場所>/v1.js <一時の場所>/package-lock.before.json package-lock.json package.json` が `V-1 OK`。`V-1 NG` なら E-15。
4. `git diff --stat package-lock.json` と、`apps/mobile/package.json` が §6.1 のとおりであること (1 段目の一時の書き換えが残っていないこと) を確かめて commit → V-2〜V-10 (`npm ci --dry-run` は V-1)。

## 11. `runtimeVersion` と OTA

| 項目 | 決定 | 根拠 |
|---|---|---|
| 方針 | トップレベル `"runtimeVersion": { "policy": "fingerprint" }`。`ios` / `android` の直書き `"1.0.0"` は消す | fingerprint は「ネイティブの runtime に影響しうる変更があるたびに runtime version を変える」方針で、SDK の更新を含む (SDK 58 の expo-updates の文書「automatically calculates the runtime version for you, including through changes like SDK upgrades」)。`appVersion` の方針は `expo.version` (0.1.0) を変えない限り SDK 53 と 58 のビルドが同じ値になり、将来 OTA を有効にしたときに SDK 58 の JS が SDK 53 のビルドに届く。`nativeVersion` は `buildNumber` / `versionCode` の手管理が要る (`appVersionSource: remote` と噛み合わない) |
| 更新の有効/無効 | `updates.enabled: false`・`checkAutomatically: "NEVER"`・`url` はそのまま | `mobile/01` §13「`enabled: false` のまま。大型変更時に検討」。本冊は OTA を使い始めない。`enabled: false` のビルドは埋め込みの JS だけを読む (`Updates.isEnabled` が false) |
| 既存のビルドに新しい JS が届かないこと | 構造 (更新が無効で、更新を公開する操作が無い) と方針 (fingerprint が違う) の 2 重 | §8.3 (a) |
| 番兵 | `tests/mobile-toolchain-contract.test.ts` が `runtimeVersion` の形と更新の無効を固定 | §9.7 |
| 計算の確認 | V-8 (`npx expo-updates runtimeversion:resolve --platform ios`) で値を 1 回見て PR に写す。EAS のビルドのページでも見える (§16) | SDK 58 では `expo.version` の変更はハッシュに入らない (changelog) |
| OTA を使い始めるとき (別案件) | `eas update` は `--environment` が必須 (SDK 55)。`enableBsdiffPatchSupport` の既定 true・`maxUpdatesToKeep` の既定 2。番兵の 2 行の期待をその設計が書き換える | SDK 55・56・58 の changelog |

---

## 12. エラー表 (実装中に出る失敗の読み方と対処)

| # | 症状 | 原因 | 対処 |
|---|---|---|---|
| E-1 | `node -v` が 22.13.0 未満 | SDK 58 / RN 0.88 / metro 0.87 の `engines` | その機械では流さない。offload の行き先を変える (k270 は v22.23.3)。`.nvmrc` は変えない |
| E-2 | `npm install --package-lock-only` (2 段目の素) が ERESOLVE | `react-native-web` の peer の `react-dom` とモバイルの `react` 19.3.0 の組 (既知) | §10.1 の 2 のスクリプトのとおり (`--legacy-peer-deps` → 素の 1 回)。1 段目は最初から `--legacy-peer-deps` |
| E-3 | `tests/zod-single-copy-1444.test.ts` が赤 | lockfile の作り直しで `zod` が入れ子になった | `zod` の範囲をルートと同じにしたまま、§10.1 をやり直す。入れ子が残るなら `npm dedupe --package-lock-only` を 1 回 |
| E-4 | `tests/react-types-version-contract.test.ts` が赤 | `@types/react` の置き場・tsconfig の `paths.react` | `apps/mobile/node_modules/@types/react` が 19.3.0 で、tsconfig の `paths.react` が残っていることを確かめる。ルートに巻き上がった (同じ版になった) なら番兵は自動で検査を省く |
| E-5 | Jest が `The React Native Jest preset that jest-expo relies on has moved to a separate package` で止まる | `@react-native/jest-preset` が入っていない | §6.1 の devDependencies を確かめ、lockfile を作り直す |
| E-6 | Jest が `Cannot find module 'react-native-worklets'` / `WorkletsModule` / `[Reanimated]` の例外 | C-10 の mock が効いていない・`babel-preset-expo` の plugin が入っていない | `jest.setup.js` の `jest.mock('react-native-worklets', …)` が `setupFilesAfterEnv` にあること・`react-native-worklets` が lockfile にあること。`setCSSEventHandler is not available in JSReanimated` は `jest.config.js` の `resolver` (`react-native-reanimated/jest/resolver`。C-10・§9.2) が無い。それでも落ちるテストは T-6 の `jest.useFakeTimers()` |
| E-7 | Jest が `SyntaxError: Cannot use import statement outside a module` (`node_modules/<pkg>`) | `transformIgnorePatterns` の自前の一覧が残っていて、新しい依存 (`standard-navigation` など) を変換していない | C-9 (項目を消す)。消しても出るなら、そのパッケージ名を PR の本文に写し、`jest-expo` の既定に無い理由とともに §17 へ |
| E-8 | テストが「未処理の reject」「テストの間の例外」で落ちる | T-4 (Jest 30 の厳格化) | テストの `await` / `catch` を足す。製品コードの誤りならコードを直す。期待は緩めない |
| E-9 | tsc で `react-native` の型エラーが新しく出る (ref・`NativeMethods`・深い import) | A-8 (Strict TypeScript API) | 当該の行を RN 0.87 の移行手引きの対応に書き換える。opt-out (`customConditions`) は使わない |
| E-10 | `npx expo-doctor` が app.json のスキーマで落ちる (`splash` / `assetBundlePatterns`) | C-2 / C-3 が未反映 | §9.1 のとおりにする |
| E-11 | `npx expo install --check` がずれを報告する | §6.1 と `bundledNativeModules.json` (または Expo の API の `relatedPackages`) の不一致 (expo の patch が上がった) | 報告された版に合わせ、§6.1 の表との差を PR の本文に写す (設計書の追随は専権)。例外は `typescript` だけ: `relatedPackages` が求める版 (`~6.0.3`) には合わせず、`expo.install.exclude` で外して 5.9.3 に据え置く (§6.4)。`exclude` にほかの依存を足して黙らせない |
| E-12 | `npm audit` に `image-size` か `postcss` が残る | lockfile の作り直しが古い (`@expo/metro-config` の入れ子の postcss・`metro` 0.82) | §10.1 をやり直し、`node_modules/@expo/metro-config/node_modules/postcss` と `node_modules/image-size` が lockfile に無いことを確かめる |
| E-13 | `npm audit` に `jest-haste-map` / `@jest/environment` が残る | §6.2 の overrides が効いていない | `node_modules/@react-native/jest-preset/node_modules/babel-jest` と `jest-environment-node` が lockfile に無いか、あっても 30 系であることを確かめる (§9.11 の 3。2 段で作ると巻き上がって無くなる。1 回で作ると 30 系の入れ子が残る) |
| E-14 | EAS のビルドが失敗する (オーナー) | ネイティブ側 (Xcode・scene・R8・autolinking) | §16 の手順でビルドのログを Issue #1115 に写す。本冊の範囲ではコードを変えず、別の Issue にする |
| E-15 | §9.11 が `V-1 NG` (`react-native` ほかがルートに無い・`apps/mobile` の入れ子が `react` と `@types/react` 以外にもある・Web の依存の版が変わった) | §10.1 の 1 段目を飛ばした・1 段目の `KEEP` が違う・2 段目を 1 回で済ませた | `git show origin/main:package-lock.json > package-lock.json` で作り直す前の lockfile に戻し (lockfile を手で直さない・`git checkout` は使わない)、§10.1 の 1 と 2 をやり直す。2 回やり直しても NG なら、出力を PR の本文に写し、実装ゲートの deviations に書いて止める (置き場が崩れたまま Jest や Metro の設定で回避しない) |
| E-16 | Jest が `Could not locate module react-native/setup-env mapped as: …/node_modules/react-native/setup-env` (や `react-private-interface`) で全部のスイートの準備で落ちる | `jest.config.js` の `moduleNameMapper` に `^react-native/(.*)$` が残っている (C-9 の (2)) | §9.2 のとおり `react-native` の 2 行を消す |
| E-17 | 段 A の V-2 で `app/legal-consent.tsx` の `beforeRemove` の effect (いまの 63〜69 行) に型エラー (`"beforeRemove"` がイベントの型に合わない・`event.data.action` / `event.preventDefault` が無い など) | expo-router 58 の `useNavigation()` の既定の型のイベントの一覧 (`EventMapCore`) に `beforeRemove` が無い (§4.2 の S4) | 段 A では直さない (V-2 が段 A だけ許す)。段 B の B-2 がこの effect を `usePreventRemove` に替えて消す。`as` や型引数で黙らせない。段 B の後にこのファイルのエラーが残っていたら B-2 の書き換えが足りない (§9.5) |
| E-18 | `home/tabs-hidden-route.test.ts` が `Cannot find module …/expo-router/build/…` で落ちる | lockfile の expo-router が 58.0.23 と違い、`build/` の下の内部のファイルの置き場が変わった | lockfile の `node_modules/expo-router` の版を確かめる。§6.1 の範囲 (`~58.0.23`) の別の patch なら、その版の `build/` で §9.12 の差し替えの 13 個のファイルの実在を確かめ、変わったパスを PR の本文に写して実装ゲートの deviations に書く (設計書の追随は専権)。T-TB1〜T-TB4 の期待は変えない |
| E-20 | ルートの vitest の `tests/*` が `Failed to load tsconfig 'expo/tsconfig.base': Tsconfig not found` で落ちる | C-16 | `apps/mobile/tsconfig.json` の `extends` を `expo/tsconfig.base.json` にする。期待は変えない |
| E-19 | `home/tabs-hidden-route.test.ts` の T-TB1 か T-TB3 が赤 (T-TB2・T-TB4 は緑) | expo-router の `processScreens` か `useVisibleTabsWithRedirect` が、`href` の無い宣言済みの画面を一覧から外すように変わった (§9.10 の前提が崩れた) | 期待を緩めない。出力を PR の本文に写し、実装ゲートの deviations に書いて止める (設定の画面の置き場の構造の裁定に差し戻す。§5.1 の H・I。§17 の 10) |

---

## 13. テスト一覧 (it 名)

### 13.1 新設 `tests/mobile-toolchain-contract.test.ts` (§9.7)

- `#1591 apps/mobile の版の組 (bundledNativeModules と同じ)`
  - `react の宣言は expo/bundledNativeModules.json の値と同じ` (react / react-native / react-native-reanimated / react-native-worklets / expo-router / jest-expo の 6 件)
  - `react-test-renderer の宣言は react と同じ版 (レンダラーは React と完全に同じ版でないと動かない)`
  - `package-lock.json: apps/mobile から見た react と react-test-renderer が同じ版で、react-native が宣言と同じ`
  - `jest は 30 系で、jest-expo の必須の peer @react-native/jest-preset は react-native と同じ版`
  - `package-lock.json: react-native・@react-native/jest-preset・react-test-renderer・jest・jest-expo・expo はルートにあり、apps/mobile の入れ子は react と @types/react だけ`
  - `使っていないので消した @react-native-community/slider が宣言に戻っていない` (3 件: slider・expo-haptics・expo-image-manipulator)
- `#1591 OTA の設定 (app.json)`
  - `runtimeVersion はトップレベルの { policy: 'fingerprint' } だけ (ios / android の直書きは無い)`
  - `更新は無効のまま (enabled: false・checkAutomatically: NEVER)。OTA を使う設計が通るまで変えない`
- `#1591 expo-file-system は /legacy の入口だけを読む`
  - `app/・src/・__tests__ の import・require・jest.mock の指定子はすべて expo-file-system/legacy`
  - `指定子の正規表現は 既定の入口の import を拾い、下の入口を読み分ける` (7 件: 既定の入口の import・/legacy の import・/legacy でない下の入口の import・既定の入口の require・既定の入口の jest.mock・改行をはさんだ既定の入口の jest.mock・/legacy の jest.mock。走査の it は違反 0 件しか見ないので、正規表現の選択肢が欠けたら見本で落ちる)
- `#1591 expo install --check と Jest の resolver`
  - `expo install --check から外すのは typescript だけで、apps/mobile の typescript はルートと同じ 1 つ (入れ子にしない)`
  - `jest.config.js の resolver は react-native-reanimated/jest/resolver で、apps/mobile から解決できる`

### 13.2 変える既存のテストと、足すテスト

| ファイル | 変更 | 段 |
|---|---|---|
| `apps/mobile/__tests__/lib/legal-consent.test.ts` | `legalConsentScreenRemovalDecision (T-ML6)` の describe を消し、`legalConsentScreenPreventsRemoval (T-ML6)` に: `awaiting-consent と signed-out-notice は止める (true)`・`free は止めない`・`closing なら扱いに関わらず止めない`・`凍結中 (accountFrozen) なら扱いに関わらず止めない (凍結が先。凍結のゲートの RESET は同意画面の route を取り除く。#1861)`。describe `findNavigatorOwningRoute / collapsedStackState / collapseStackAction (T-ML11)` を足す: `routeNames に legal-consent を持つ navigator を前面の枝で見つける (ルート直下・1 段下)`・`持ち主が無い・stale・key 無し・routeKeySeq 無し・root が undefined なら null`・`同意画面の route があれば key ごと再利用し、無ければ名前だけ。key・type・routeNames・routeKeySeq を写し、stale: false を付ける`・`action は type RESET・target は持ち主の key・payload は畳んだ state`。describe `expo-router 58 の StackRouter に通す (T-ML12)` を足す (`import { StackRouter, isActionHandled } from 'expo-router/build/react-navigation/routers/index'`。state は §9.4 の後の「実物の router での確認」の形。第 3 引数は `{ routeNames, routeGetIdList: {} }`): `同意画面の route が無い state に畳む action を通すと、受け付けて routes が [legal-consent] (key は router が付ける) になる`・`同意画面の route がある state に畳む action を通すと、その key のまま routes が [legal-consent] になる`・`stale: false を外した payload は受け付けない (Unhandled。この番兵が実物の router の条件を見ていることの確かめ)` (この it は `jest.spyOn(console, 'warn').mockImplementation(() => {})` で router の警告を黙らせ、呼ばれたことも確かめる) | B |
| `apps/mobile/__tests__/app/legal-consent-screen.test.tsx` | `expo-router` の mock に `usePreventRemove: (prevent, cb) => { 記録して mockDisablePrevention を返す }` を足し、`useNavigation` の mock と `removeAttempt` を消す。T-SC2 の it 名: `サインイン中で required の間は、usePreventRemove に true を渡す (取り除く操作を全部止める)`・`clear になったら false を渡す`・`beforeRemove の受け手は外れるときに解除する` を消す。T-SC3: `その間は usePreventRemove に true を渡し、押すと disablePrevention を呼んでから router.replace("/") を 1 回呼ぶ (router.canGoBack が false のとき)`・`router.canGoBack が true なら disablePrevention を呼んでから router.back を 1 回呼ぶ`。未ログインで開いた・afterSignOut の it は同じ。`AccountFrozenProvider` の mock (`mockFrozenState`) を足し、T-SC2 に: `サインイン中で required でも、凍結中 (frozen) は usePreventRemove に false を渡す (凍結のゲートの RESET を止めない。#1861)。自分では閉じない`・`凍結の状態が loading / clear / unknown なら、required の間は usePreventRemove に true を渡す (止めを解くのは frozen だけ)` (3 件)・`凍結中に false を渡した後、凍結が解ける (clear) と、required の間はまた true を渡す` | B |
| `apps/mobile/__tests__/app/legal-consent-frozen-collapse.test.tsx` (新規) | 本物の同意画面・本物の凍結のゲート・本物の expo-router 58 (`expo-router/testing-library` の `renderRouter`。`usePreventRemove` の止めの層 = `useNavigationTreeReducer` を通る) をつなぐ。認証・同意・凍結・プロフィールの Provider と `WebViewScreen`・`supabase` だけを mock にする (凍結の状態は `useSyncExternalStore` で、読む側が同じ描画で描き直す)。it: `同意待ちの同意画面は、取り除く操作 (入口への replace) を実物の止めの層で止める (この番兵が止めの層を通っていることの確かめ)`・`同意待ちの同意画面が前面のまま凍結 (frozen) になると、凍結のゲートの RESET が通り、ルートの Stack が凍結の画面 1 つに畳まれる`・`凍結の状態が loading / unknown の間は、同意画面は止めたまま (入口への replace は捨てられる) で、凍結のゲートも畳まない` (2 件) | B |
| `apps/mobile/__tests__/components/legal-consent-gate.test.tsx` | `mockNavigationRef` の `reset` を `dispatch: (...args: unknown[]) => mockDispatch(...args)` に替え (`mockReset` は `mockDispatch` に改名)、`getRootState: () => mockRootState` を足す。既定の `mockRootState` は `{ key: 'navigator:root', routeKeySeq: 3, index: 1, type: 'stack', stale: false, routeNames: ['index', '(public)', '(auth)', '(tabs)', 'legal-consent', 'settings/account'], routes: [{ key: 'index:0', name: 'index' }, { key: '(tabs):1', name: '(tabs)' }] }`。`CONSENT_RESET` を `CONSENT_RESET_ACTION = { type: 'RESET', target: 'navigator:root', payload: { key: 'navigator:root', index: 0, routeKeySeq: 3, routeNames: <既定の mockRootState の routeNames>, type: 'stack', stale: false, routes: [{ name: 'legal-consent' }] } }` に替え、T-G1 / T-G8 の `toHaveBeenCalledWith` をこれに。T-G7 (deep link で開いた同意画面) は `mockRootState` の `routes` に `{ key: 'legal-consent:2', name: 'legal-consent' }` を足し、`index: 2`、期待の `routes` を `[{ name: 'legal-consent', key: 'legal-consent:2' }]` に。T-G6 の「reset / replace が例外を投げても落ちない」は `mockDispatch` に例外を投げさせる。ほかの it の名前 (「reset を 1 回呼ぶ」の reset は RESET の action を指す) と、呼ばない期待 (T-G2 / T-G4 / T-G5) は名前の変数だけ `mockDispatch` に。足す it: `T-G9: 前面が対象の画面で、同意画面の route が Stack の下に残っている (ログアウトの前から) なら、その key を再利用した RESET の action を dispatch する`・`T-G10: ルートの Stack の state がそろっていない (routeNames に legal-consent が無い・routeKeySeq が無い) なら dispatch せず警告を残し、次の描画でそろっていれば 1 回 dispatch する` | B |
| `apps/mobile/__tests__/components/account-frozen-gate.test.tsx`・`apps/mobile/__tests__/components/account-frozen-flow.test.tsx` (#1861) | 両方: `mockReset` を `mockDispatch` に改名し、`mockNavigationRef` の `reset` を `dispatch` に替え、`getRootState: () => mockRootState` を足す (既定の `mockRootState` は `routeNames` に `frozen` を持つルートの Stack の state。`legal-consent-gate.test.tsx` と同じ形)。`FROZEN_RESET` を `FROZEN_RESET_ACTION = { type: 'RESET', target: 'navigator:root', payload: { key, index: 0, routeKeySeq, routeNames, type: 'stack', stale: false, routes: [{ name: 'frozen' }] } }` に替え、`toHaveBeenCalledWith` をこれに。it 名の「reset を 1 回呼ぶ」は「RESET の action を 1 回 dispatch する」に。`account-frozen-gate.test.tsx` に describe を 2 つ足す: `畳む action の中身`: 「凍結の画面の route が Stack の下に残っていれば、その key を再利用した RESET の action を dispatch する」・「ルートの Stack の state がそろっていない (routeNames に frozen が無い・routeKeySeq が無い) なら dispatch せず警告を残し、次の描画でそろっていれば 1 回 dispatch する」。`expo-router 58 の StackRouter に通す`: `legal-consent.test.ts` の T-ML12 と同じ形で、ゲートが dispatch した action を実物の `StackRouter` に通す 3 本 (「凍結の画面の route が無い state → routes が [frozen]・key は router が付ける」・「route がある state → その key のまま [frozen]」・「部分の state の RESET (`{ index: 0, routes: [{ name: 'frozen' }] }`) は受け付けない (Unhandled・警告)」) | B |
| `apps/mobile/__tests__/home/tab-layout.test.tsx` | 1 か所。284 行の it `settings タブは href: null (タブバー非表示)` を `settings は隠しタブ: href を持たず、tabBarButton は何も描かず (null)、tabBarItemStyle は display: none (expo-router 58 の href: null は route を届かなくするため。#1591)` に。期待は `const settings = configs.find((c) => c.name === 'settings');` のあと `expect(Object.keys(settings?.options ?? {}).sort()).toEqual(['tabBarButton', 'tabBarItemStyle'])`・`expect(settings?.options?.tabBarButton({})).toBeNull()`・`expect(settings?.options?.tabBarItemStyle).toEqual({ display: 'none' })` の 3 つ (1 つ目で `href` が無いことも見る)。217 行と 306 行の it (6 本・`[..., 'settings']`) は変えない (settings は `(tabs)` の画面のまま)。冒頭のコメント (6 行「タブの本数 (表に出す 5 本 + 設定)」) も変えない | B |
| `apps/mobile/__tests__/home/tabs-hidden-route.test.ts` (新規) | §9.12 の全文。describe `#1591 設定の画面 (隠しタブ) は expo-router 58 でも届く (実物の processScreens と useVisibleTabsWithRedirect)` の it 4 本: `T-TB1: tabBarButton: () => null と tabBarItemStyle: display none の settings は、processScreens がそのまま返す (hidden を付けない)`・`T-TB2: href: null は processScreens が hidden: true に置き換える (expo-router 58 の挙動。本冊が href: null を使わない理由)`・`T-TB3: 隠しタブの settings が前面でも、タブの一覧に残り、最初のタブへ replace しない`・`T-TB4: href: null (hidden) の settings が前面だと、一覧から外れ、最初のタブへ 1 回 replace する (この番兵が実物の判定を見ていることの確かめ)` | B |
| `apps/mobile/__tests__/settings/logout.test.tsx`・`profile-row.test.tsx`・`ai-consent-entry.test.tsx`・`sessions-entry.test.tsx`・`export-rows.test.tsx` | 5 ファイル共通: `jest.mock('expo-file-system', …)` を `jest.mock('expo-file-system/legacy', …)` に (A-1。mock の中身は変えない)。`import SettingsTab from '../../app/(tabs)/settings'`・`expo-router` の mock・期待 (`'/(tabs)/profile'`・`replace:/` ほか)・describe 名は変えない (設定の画面の置き場とコードは変わらない。§9.10)。`sessions-entry.test.tsx` は origin/main `307ae1cf` (cross/16 の段 B) で足されたもので、ほかの 3 本と同じ mock の形。`export-rows.test.tsx` は `d34f18d8` (#1876) で足されたもので、mock の `writeAsStringAsync` が `mockWriteAsStringAsync` に渡し、書き出しの行を押した it 2 本が `mockShareAsync` の回数と共有の題を見る。mock の中身と期待は変えない (指定子が既定の入口のままだと、画面の `/legacy` の `writeAsStringAsync` に mock が当たらず、その 2 本が `mockShareAsync` 0 回で落ちる) | A |
| `apps/mobile/__tests__/components/WebViewScreen.*.test.tsx` (6 本)・`__tests__/lib/webViewDownload.test.ts` | `jest.mock('expo-file-system/legacy', …)`。うち `WebViewScreen.bridge.test.tsx` (91 行)・`WebViewScreen.download.test.tsx` (84 行)・`webViewDownload.test.ts` (36 行) は `import * as FileSystem from 'expo-file-system';` も `import * as FileSystem from 'expo-file-system/legacy';` に (A-1。mock の関数の取り出し方 (`FileSystem.writeAsStringAsync as jest.Mock` など) と期待は変えない) | A |
| `apps/mobile/__tests__/home/home.test.tsx` | 51〜58 行の `@react-native-community/slider` の mock (見出しのコメントを含む) とその直後の空行を消す (§6.3)。ほかは変えない | A |
| `tests/webview-download-export-limit-contract.test.ts` (ルートの vitest) | 26 行の `vi.mock('expo-file-system', () => ({}))` を `vi.mock('expo-file-system/legacy', () => ({}))` に (A-1) | A |

### 13.3 シナリオとテストの対応

| シナリオ | 直接見るテスト・検査 |
|---|---|
| S1 | V-1 (§9.11)・`tests/zod-single-copy-1444`・`tests/react-types-version-contract`・`tests/mobile-toolchain-contract` (版の組・lockfile の置き場) |
| S2・S3 | V-3 (`mobile:jest`)・`tests/local-ci-workflow-sync` |
| S4 | V-2 |
| S5 | V-4 |
| S6・S7 | V-8・`tests/mobile-toolchain-contract` (OTA の設定)・§16 の M-0 |
| S8 | `home/tabs-hidden-route` (T-TB1・T-TB3 = 実物の `processScreens` と `useVisibleTabsWithRedirect`。T-TB2・T-TB4 が `href: null` の壊れ方)・`tab-layout` (settings の options の形)・`profile-tab-settings-entry` (歯車の `/(tabs)/settings`。変えない)・`route-targets-exist` (変えない)・`tests/native-app-tabs-contract`・M-2 |
| S9・S10・S11・S12 | `legal-consent.test.ts` (T-ML6・T-ML11・T-ML12 = 実物の `StackRouter`)・`legal-consent-screen.test.tsx` (T-SC2・T-SC3)・`legal-consent-frozen-collapse.test.tsx` (実物の expo-router 58 の止めの層。同意待ち × 凍結)・`legal-consent-gate.test.tsx` (T-G1・T-G6〜T-G10)・M-3 |
| S13 | `webViewDownload.test.ts`・`settings/*.test.tsx` (`settings/export-rows` は行を押して書き出し、共有に渡すまで)・`tests/webview-download-export-limit-contract`・`tests/mobile-toolchain-contract` (`/legacy`) |
| S14 | `handson-tour-*.test.tsx` (Reanimated 4 で描ける)・M-6 |
| S15 | V-2 (`blood-tests.tsx` の `as any` を外しても型が通る)・`health/checkup-ocr.test.tsx` |
| S16 | `components/NotificationRouter.test.tsx`・`lib/push-notifications.test.ts`・M-4 |
| S17 | `tests/mobile-toolchain-contract` (版の組) |
| S18 | V-6・V-9 |
| S19 | `tab-layout` (`session がない場合 redirect-/ が描画される`。変えない)・M-2 |
| S20 | `settings/profile-row` (`押すと、マイページのタブ (/(tabs)/profile。WebView) を開く`。変えない)・M-2 |
| S21 | `settings/logout` (`replace:/` の期待。変えない)・M-2 |
| S22 | `route-targets-exist` (行き先 `/handson-tour` の画面が実在する。変えない)・M-2 |
| S23 | `legal-consent-frozen-collapse.test.tsx` (実物の expo-router 58 の止めの層)・`legal-consent-screen.test.tsx` (T-SC2 の凍結の it)・`legal-consent.test.ts` (T-ML6 の凍結の it)・`account-frozen-gate.test.tsx` (前面が `/legal-consent` の行)・M-3 |

---

## 14. 段分け・触るファイルの母集合・新設一覧

### 14.1 段分け (1 本の B 型 WF。段ごとに 2 枚レビュー。マージは段 C の後に 1 回)

実装の worktree は、本冊が main に入った後の origin/main から新しく切る (本冊の設計の枝から切らない。設計の枝の rebase / merge は実装 WF の仕事でない)。段 A の最初に、§2.2 の数 (Jest のテスト 121・`expo-file-system` の `jest.mock` 12・`render(` 67) を worktree の HEAD で数え直す (`git ls-tree -r --name-only HEAD apps/mobile/__tests__ | grep -cE '\.test\.(ts|tsx|js)$'`・`git grep -l "jest.mock(['\"]expo-file-system['\"]" HEAD -- apps/mobile/__tests__ | wc -l`)。数が違ったら、増えたテストを §7.1 の A-1 と §15.1 の grep の語に当てて母集合に足すか判定し、PR の本文に写す (V-3 と同じ扱い)。

| 段 | 内容 | 検証 |
|---|---|---|
| A | 依存と設定: `apps/mobile/package.json` (§6.1)・ルート `package.json` の `overrides` (§6.2)・`package-lock.json` (§10.1 の 2 段)・`app.json` (§9.1)・`eas.json` (C-5)・`jest.config.js` (§9.2)・`jest.setup.js` (§9.3)・`jest.env.setup.js` / `metro.config.js` / `tsconfig.json` / `dependabot.yml` のコメント (C-7・C-8・C-11・C-13)。消す依存のテストの後始末: `home.test.tsx` の slider の mock (§6.3)。API の置き換え: A-1 (import 2 + Jest の mock 11 + ルートの vitest の mock 1)・A-2 (3)・A-3 (2)・A-8 (V-2 で出た分)・T-4 (V-3 で出た分) | V-0〜V-10 |
| B | expo-router 58 への追随: B-1 (`(tabs)/_layout.tsx` の隠しタブの書き方 (§9.10) と `(tabs)/profile.tsx` のコメント 1 行 + `tab-layout.test.tsx` の it 1 つ + 新設の `home/tabs-hidden-route.test.ts` (§9.12))・B-2 (同意画面・ゲート・`legal-consent.ts` + テスト 3 本・`app/_layout.tsx` のコメント 1 行。段 A の V-2 が許した `app/legal-consent.tsx` の型エラーもここで消える) | V-2・V-3・V-7 |
| C | 番兵と README: `tests/mobile-toolchain-contract.test.ts` (§9.7)・`apps/mobile/README.md` の「実機 (Expo Go)」の節に 1 文 (SDK 58 の Expo Go は公開待ち・push 通知は Expo Go で例外になる (SDK 55) ので preview のビルドで確かめる) | V-3・V-7 |

### 14.2 触るファイルの母集合 (閉じた一覧。これ以外を触ったら blocking)

| 段 | ファイル |
|---|---|
| A | `apps/mobile/package.json`・`package.json` (ルート。`overrides` だけ)・`package-lock.json`・`apps/mobile/app.json`・`apps/mobile/eas.json`・`apps/mobile/jest.config.js`・`apps/mobile/jest.setup.js`・`apps/mobile/jest.env.setup.js` (コメント)・`apps/mobile/metro.config.js` (コメント)・`apps/mobile/tsconfig.json` (コメントと、`extends` の指定子に拡張子を付ける 1 行。C-16)・`.github/dependabot.yml` (コメント)・`apps/mobile/app/(tabs)/settings.tsx` (A-1)・`apps/mobile/src/lib/webViewDownload.ts` (A-1)・`apps/mobile/app/handson-tour/index.tsx`・`apps/mobile/app/handson-tour/graduate.tsx`・`apps/mobile/src/components/ai/AIAdvisorSheet.tsx` (A-2)・`apps/mobile/app/health/blood-tests.tsx` (A-3)・A-1 の mock を持つ Jest のテスト 12 本 (§7.1)・`tests/webview-download-export-limit-contract.test.ts` (A-1 の vitest の mock 1 行)・`apps/mobile/__tests__/home/home.test.tsx` (slider の mock を消す)・T-6 で `jest.useFakeTimers()` を足したテスト (§7.3 の T-6 が名指しした 5 本のうち、mock だけで足りなかったものだけ)・A-8 / T-4 で V-2 / V-3 が指したファイル (PR の本文に列挙)。段 A の V-2 が許す `apps/mobile/app/legal-consent.tsx` の `beforeRemove` の effect の型エラーは、段 A では直さない (このファイルは段 B の母集合) |
| B | `apps/mobile/app/(tabs)/_layout.tsx` (118〜119 行。§9.10)・`apps/mobile/app/(tabs)/profile.tsx` (10 行のコメントだけ)・`apps/mobile/app/legal-consent.tsx`・`apps/mobile/src/components/legal/LegalConsentGate.tsx`・`apps/mobile/src/components/AccountFrozenGate.tsx` (#1861。§9.6b)・`apps/mobile/src/lib/account-frozen.ts` (コメント 1 か所だけ)・`apps/mobile/src/lib/legal-consent.ts`・`apps/mobile/app/_layout.tsx` (118 行のコメントだけ。B-2)・`apps/mobile/__tests__/components/account-frozen-gate.test.tsx`・`apps/mobile/__tests__/components/account-frozen-flow.test.tsx`・`apps/mobile/__tests__/lib/legal-consent.test.ts`・`apps/mobile/__tests__/app/legal-consent-screen.test.tsx`・`apps/mobile/__tests__/app/legal-consent-frozen-collapse.test.tsx` (新規)・`apps/mobile/__tests__/components/legal-consent-gate.test.tsx`・`apps/mobile/__tests__/home/tab-layout.test.tsx` (284 行の it だけ)・`apps/mobile/__tests__/home/tabs-hidden-route.test.ts` (新規) |
| C | `tests/mobile-toolchain-contract.test.ts` (新規)・`apps/mobile/README.md` |
| 触らない | `apps/mobile/babel.config.js`・`.github/workflows/*.yml`・`scripts/local-ci.sh`・`.easignore`・`apps/mobile/maestro/**`・`packages/**`・`src/**` (Web)・段 B での `apps/mobile/app/(tabs)/settings.tsx` (段 A の A-1 の import の 1 行だけ。置き場もコードも変えない) と、設定の画面のパスを名指しするテスト・番兵 (§15.1 の「変えない」の行。`settings/*.test.tsx` の 5 本は段 A の A-1 の mock の指定子だけを変える)・`docs/design/**` と ルート `CLAUDE.md` (§15.2 の専権 PATCH)・`supabase/**`・`apps/mobile/src/lib/supabase.ts`・`apps/mobile/src/lib/webViewBridge.ts` (`react-native-url-polyfill` は残す) |

### 14.3 新設一覧 (識別子)

| 種類 | 名前 | 場所 |
|---|---|---|
| ファイル (新規) | `tests/mobile-toolchain-contract.test.ts` | §9.7 |
| ファイル (新規) | `apps/mobile/__tests__/home/tabs-hidden-route.test.ts` | §9.12 |
| ファイル (新規) | `apps/mobile/__tests__/app/legal-consent-frozen-collapse.test.tsx` | §13.2 |
| 関数 | `legalConsentScreenPreventsRemoval(mode, closing, accountFrozen): boolean` | `apps/mobile/src/lib/legal-consent.ts` (§9.4) |
| 関数 | `findNavigatorOwningRoute(root, routeName): StackOwnerState \| null` (`root` は `NavigatorStateLike \| undefined`) | 同上 |
| 関数 | `collapsedStackState(owner, routeName): CollapsedStackState` | 同上 |
| 関数 | `collapseStackAction(owner, routeName): CollapseStackAction` | 同上 |
| 型 | `NavigatorStateLike`・`StackOwnerState`・`CollapsedStackState`・`CollapseStackAction` (export)・`CollapsedStackBase` (ファイルの中だけ) | 同上 |
| 定数 | `COLLAPSED_STACK_INDEX = 0` (ファイルの中だけ) | 同上 |
| 残す識別子 | `RESET_ACTION_TYPE` (既存。export しない。action の `type` に使う) | 同上 |
| 消す識別子 | `LegalConsentScreenRemovalDecision`・`legalConsentScreenRemovalDecision` | 同上 |
| 設定 (layout) | settings の `Tabs.Screen` の options `{ tabBarButton: () => null, tabBarItemStyle: { display: "none" } }` (旧 `{ href: null }`) | `apps/mobile/app/(tabs)/_layout.tsx` (§9.10) |
| 設定 | `expo.runtimeVersion = { policy: 'fingerprint' }`・`plugins` の `expo-splash-screen` | `apps/mobile/app.json` |
| 設定 | `overrides["@react-native/jest-preset"]` | ルート `package.json` |
| 依存 (新規) | `@expo/vector-icons`・`react-native-worklets`・`@react-native/jest-preset` | `apps/mobile/package.json` |
| 依存 (削除) | `@react-native-community/slider`・`expo-haptics`・`expo-image-manipulator` | 同上 |
| テストの定数 | `JEST_MAJOR`・`RUNTIME_VERSION_POLICY`・`BUNDLED_PINNED`・`REMOVED_UNUSED`・`HOISTED_TOOLCHAIN`・`MOBILE_NESTED_ALLOWED`・`MOBILE_NESTED_PREFIX`・`FILE_SYSTEM_SCAN_DIRS`・`FILE_SYSTEM_SPECIFIER`・`FILE_SYSTEM_SPECIFIER_SAMPLES` (型 `FileSystemSpecifierSample`)・`MOBILE_JEST_CONFIG`・`EXPO_INSTALL_EXCLUDED`・`MOBILE_JEST_RESOLVER` | `tests/mobile-toolchain-contract.test.ts` |
| テストの定数・型・関数 (Jest) | `EXPO_ROUTER_BUILD_DIR`・`fromBuild`・`TAB_ROUTE_NAMES`・`SETTINGS_ROUTE_NAME`・`INITIAL_TAB_ROUTE_NAME`・`TABS_HREF_PREFIX`・`LAYOUT_ROUTE_SOURCE`・`NOT_FOUND_INDEX`・`mockRouterReplace`・`capturedProcessScreens`・`loadProcessScreens`・`loadUseVisibleTabsWithRedirect`・`hiddenTabOptions`・`descriptorsWith`・型 `ScreenOptions`・`ScreenLike`・`ProcessScreens`・`TabRouteLike`・`TabDescriptorLike`・`VisibleTabs`・`UseVisibleTabsWithRedirect` | `apps/mobile/__tests__/home/tabs-hidden-route.test.ts` (§9.12) |
| テストの定数 (Jest) | `mockRootState`・`CONSENT_RESET_ACTION`・`mockDispatch` (旧 `CONSENT_RESET`・`mockReset`) | `apps/mobile/__tests__/components/legal-consent-gate.test.tsx` (§13.2) |
| テストの定数 (Jest) | `mockDisablePrevention`・`mockFrozenState` | `apps/mobile/__tests__/app/legal-consent-screen.test.tsx` (§13.2) |
| テストの定数・関数 (Jest) | `mockSignedIn`・`mockRefreshProfile`・`mockFrozenState`・`mockFrozenListeners`・`mockRefreshFrozen`・`FROZEN_SCREEN_PATH`・`setFrozenState`・`RootLayout`・`EntryScreen`・`FrozenScreen`・`rootStackRouteNames`・`renderAtLegalConsent` | `apps/mobile/__tests__/app/legal-consent-frozen-collapse.test.tsx` (§13.2) |
| 検証の手順 (コミットしない) | §9.8 の根の advisory の数え方・§9.11 の V-1 の検査・§10.1 の 2 段の作り直しのスクリプト | 実装者が一時の場所で流す |

---

## 15. 追随表

### 15.1 既存の番兵 (契約テスト・走査テスト) の追随

grep の語で `tests/`・`scripts/`・`src/__tests__/`・`apps/mobile/__tests__/` を引いた結果 (origin/main 904f9e8f。1d69d88b で引き直し、9dd73f23 で `(tabs)/settings`・`href: null`・`tabBarButton`・`(tabs)/_layout` の語を引き直した。0ca17773 で、`9dd73f23` から足された・変わったテスト 6 本 (`tests/cron-secret-drift-monitor-contract`・`cron-secret-probe-edge`・`cron-secret`・`edge-function-cors`・`faq-guide-wording-1859`・`security-workflow`) に `apps/mobile`・`expo`・`react-native`・`metro`・`jest`・`dependabot`・`package-lock`・`overrides`・`(tabs)`・`legal-consent`・`app.json`・`eas.json` の語を引き直した。反応したのは `faq-guide-wording-1859` (下の行) と、行がある `security-workflow` (#1863 の差分は `.gitleaks.toml` の検査だけ) の 2 本。d34f18d8 で、`835fbe7c` から足された・変わったテスト 18 本に同じ語を引き直した。反応したのは `apps/mobile/__tests__/settings/export-rows.test.tsx` (#1876。A-1 の mock。§7.1・§13.2) と、行がある `faq-guide-wording-1859` (#1876 で走査の場所を Web とアプリに分けた。下の行) の 2 本。行がある `security-workflow` の差分は `.gitleaks.toml` の検査だけ。cf6393c3 (#1877) で足された・変わったテスト 11 本 (`src/__tests__/` の 8 本と `tests/` の 3 本) にも同じ語を引き直した。反応したものは無い)。「反応」は本冊の変更に反応する番兵、「直し方」は実装の段。

| 番兵 | grep の語 | 反応 | 直し方 | 段 |
|---|---|---|---|---|
| `tests/react-types-version-contract.test.ts` | `apps/mobile/package.json`・`@types/react`・`paths` | `@types/react` のメジャー (19) と入れ子・tsconfig の固定 | 変えない。§6.1 の `~19.3.0` と `paths.react` の維持で緑。ルートと同じ版になったら自動で省く | A |
| `tests/zod-single-copy-1444.test.ts` | `zod`・`package-lock.json` | lockfile の作り直し | 変えない。E-3 | A |
| `tests/webview-download-export-limit-contract.test.ts` | `expo-file-system`・`apps/mobile/src/lib/webViewDownload` | 26 行の `vi.mock('expo-file-system', …)` が A-1 の後の `expo-file-system/legacy` の import に当たらない | 26 行を `vi.mock('expo-file-system/legacy', () => ({}))` に (§13.2) | A |
| `tests/mobile-account-frozen-contract.test.ts` (#1861) | `apps/mobile/src/lib/account-frozen`・`apps/mobile/app/_layout`・`AccountFrozenGate` | 凍結の画面の route の名前・パスと、凍結中も通す API の一覧 | 変えない (`account-frozen.ts` はコメント 1 か所だけを変え、番兵が読む定数・文は同じ。`tsconfig` の指定子 (C-16) が無いと、このテストは `Tsconfig not found` で落ちる) | A・B |
| `tests/legal-consent-mobile-contract.test.ts` | `apps/mobile/src/lib/legal-consent` | このファイルを import する (`LEGAL_CONSENT_ACCEPTED_MESSAGE_TYPE`・`LEGAL_CONSENT_SCREEN_PATH`・`parseLegalConsentMessage`) | 変えない (B-2 の後も `legal-consent.ts` は純で、この 3 つは変えない) | B |
| `src/__tests__/app/faq/account-answers.test.ts` (Web 側) | `apps/mobile/app/(tabs)/settings.tsx` | 238 行が画面のファイルを読んで文字列を確かめる | 変えない (置き場も文字列も変わらない。A-1 は import の 1 行だけ) | – |
| `tests/mobile-easignore-bundle-inputs.test.ts` | `apps/mobile/app`・`apps/mobile/src`・`.easignore` | import の推移 (A-1 の `/legacy` は外部のパッケージ) | 変えない | A |
| `tests/native-app-tabs-contract.test.ts` | `apps/mobile/app/(tabs)` | `(tabs)/_layout.tsx` に `name="<タブ>"` があること・`(tabs)` の画面の一覧 (settings は `WebViewScreen` を出さないので表に無い) | 変えない (B-1 は settings の options だけを変え、`name` も画面のファイルも同じ) | B |
| `tests/mobile-sign-out-doc-callers.test.ts`・`tests/ai-daily-limit-mobile-raw-fetch.test.ts`・`tests/data-share-not-consent.test.ts`・`tests/ai-consent-settings-entry.test.ts`・`tests/jst-today-source-scan.test.ts` | `apps/mobile/app/(tabs)/settings.tsx` (`CALLER_SCREENS`・`::handleExportJson` / `::handleExportCsv` のキー・期待のパス・読むファイル・走査の表) | 設定の画面のファイルを名指しして読む | 変えない (置き場は変わらない。A-1 の import の書き換えは、どの番兵の見る語 (サインアウトの呼び出し・生の fetch・文字列・日付) にも当たらない) | A |
| `tests/mobile-removed-files-references.test.ts` | `apps/mobile/<パス>`・タブの title | 消したファイルの名指し・タブの名前 | 変えない (設定の画面は消したものの一覧に無い。タブの title は変わらない) | B |
| `tests/design-doc-removed-mobile-screens.test.ts` | `docs/design/**`・`(tabs)/settings.tsx` | 設計書の中の消した画面の名指し (257 行は `(tabs)/settings.tsx` が「消した画面でない」ことの検査) | 変えない (本冊は消した画面を名指ししない) | – |
| `tests/design-doc-push-paths-resolve.test.ts` | `docs/design/mobile/*push*.md` | Push の設計書だけ | 変えない (本冊のファイル名は対象外。`03-push-notification.md` の `app/(tabs)/settings.tsx` は通知の行き先 (`path: '/…'`) の書き方でないので拾わない) | – |
| `tests/handson-tour-files-structure-doc.test.ts` | `docs/design/family/09-onboarding-handson-tour/16-files-structure.md` の §5 の木・`apps/mobile/app/` | 木が名指しする `apps/mobile/app/(tabs)/settings.tsx` (306 行) が実在すること | 変えない (設定の画面のファイルは在り続ける) | – |
| `tests/security-workflow.test.ts` | `.github/dependabot.yml` の `ignore` | 規則の有無 | 変えない (C-13 はコメントだけ) | A |
| `tests/local-ci-workflow-sync.test.ts` | `mobile-test.yml`・`stage_mobile` | yml と sh の同期 | 変えない (どちらも触らない) | – |
| `tests/types-supabase-local-1631.test.ts` | `apps/mobile/package.json` の `scripts` | `gen types` の有無 | 変えない (scripts は同じ) | A |
| `tests/posthog-not-adopted-contract.test.ts` | `apps/mobile/package.json` | posthog の依存が無い | 変えない | A |
| `apps/mobile/__tests__/app/route-targets-exist.test.ts` | `app/` の画面と `router.push` / `replace` / `navigate` / `dismissTo` の行き先・「残した画面」の一覧 | 歯車の `/(tabs)/settings`・設定の画面の行き先・254 行の「残した画面」の `(tabs)/settings.tsx` | 変えない (行き先も画面のファイルも変わらない) | – |
| `tests/maestro-flow-testids.test.ts` | ソースの `testID` / `tabBarButtonTestID` (`(tabs)/_layout.tsx` を含む) | layout の testID の集め方 | 変えない (B-1 は testID を足しも消しもしない。`tabBarButton` は名前に testID を含まない) | B |
| `apps/mobile/__tests__/theme/font-family-guard.test.ts` | `app.json` の `plugins` | `expo-font` の plugin が無い (配列の要素 `[name, opts]` も読む) | 変えない (`expo-splash-screen` の要素が増えるだけ) | A |
| `apps/mobile/__tests__/app/error-boundaries.test.tsx` | `app/**/_layout.tsx` の `ErrorBoundary` | layout の一覧 | 変えない (layout は増減しない) | B |
| `apps/mobile/__tests__/app/root-layout-config.test.tsx` | `app/_layout`・`gestureEnabled`・`legal-consent` | `Stack.Screen "legal-consent"` の `options` が `{ gestureEnabled: false }` | 変えない (B-2 で `app/_layout.tsx` は 118 行のコメントだけ変え、`options` は同じ) | B |
| `tests/faq-guide-wording-1859.test.ts` | `apps/mobile/app`・`apps/mobile/src` (`MOBILE_SCREEN_SOURCE_DIRS`。#1876 で Web の `WEB_SCREEN_SOURCE_DIRS` と分けた。コメントを除いた画面のソースに、FAQ とガイドが「」で挙げる名前があること) | 画面のソースの文言 | 変えない (本冊は画面の文言を足しも消しもしない。A-1・A-2・A-3 は import と引数、B-1 は options、B-2 は同意の畳み直しの処理だけを変える) | – |
| `apps/mobile/__tests__/lib/env-example.test.ts`・`jest-timeouts.test.ts` | `env.example`・`jest.timeouts.js` | – | 変えない | – |

### 15.2 他の文書への追随 (専権 PATCH。本冊の設計ゲート PASS 後、実装のマージと同じ PR か直後。実装レーンは触らない)

| 文書 | 行・節 | 直し方 |
|---|---|---|
| `docs/design/mobile/CLAUDE.md` | ファイル一覧の表 | `07-toolchain-upgrade.md` の行を足す: 「ツールチェーンの更新 (Expo SDK 58 / RN 0.88 / Jest 30)・`runtimeVersion` の方針・設定の画面 (隠しタブ) の隠し方・同意画面の止め (`usePreventRemove`)」・要件参照 `#1591` |
| 同上 | 「React Native + Expo SDK 53 によるモバイルアプリ」(ドメインの役割) と図の「(React Native + Expo SDK 53)」 | `SDK 58` に |
| `docs/design/mobile/01-architecture.md` | §1「Expo SDK 53」・§3.1 の表「React Native (Expo SDK 53)」「Expo Router v4」 | `SDK 58`・`Expo Router 58` に (v4 はもとから 5.1 の誤記) |
| 同上 | §3.2 の 52 行「設定画面はタブバーに出さない (`app/(tabs)/_layout.tsx` の `href: null`)」 | 「設定画面はタブバーに出さない (`app/(tabs)/_layout.tsx` の `tabBarButton: () => null` と `tabBarItemStyle: { display: "none" }`。expo-router 58 の `href: null` は route を届かなくするので使わない。mobile/07 §9.10)」に (表の 50 行の `app/(tabs)/settings.tsx` は変えない) |
| 同上 | 279 行付近のファイルの木の `settings.tsx             # ネイティブ設定画面 (OS API 使用。タブバーには出さない: href: null)` | 末尾の「`href: null`」を「`tabBarButton: () => null` と `display: none`」に (木の置き場は変えない)。530 行付近の表の `apps/mobile/app/(tabs)/settings.tsx` は変えない |
| 同上 | §7.1 の app.json の抜粋 | `runtimeVersion: { policy: 'fingerprint' }` と `plugins` の `expo-splash-screen` を足す |
| 同上 | §13 の「OTA Update (expo-updates) \| 低 \| `enabled: false` のまま。大型変更時に検討」 | 「`enabled: false` のまま。`runtimeVersion` は fingerprint (mobile/07 §11)。番兵 `tests/mobile-toolchain-contract.test.ts`」に |
| `docs/design/cross/13b-legal-consent-mobile.md` | §0.3 の表の `beforeRemove` の行 (77 行付近)・`reset` の行 (74 行付近)・§6.6.8 / 6.6.11 (339・366・419〜430 行付近の「RESET だけ通す」の規則)・232〜233 行のファイルの説明・461・641〜688 行の `legal-consent.ts` の抜粋・808〜846 行の `LegalConsentGate.tsx` の抜粋・1062 行の `app/_layout.tsx` の抜粋のコメント (「ほかの取り除く操作は画面の beforeRemove が扱う」) | expo-router 58 の形に (本冊 §7.1 の B-2・§8.3 (b)・§9.4〜9.6): 「`beforeRemove` で止める」→「`usePreventRemove` で止める (全部)」、「RESET だけ通す」→「ゲートの `reset` は同意画面の route を key ごと再利用するので同意画面を取り除かない」、「`reset` は `routingQueue` を通らずその場で届く」→「58 では `dispatch` は commit の後に流れる」、`navigationRef.reset({ index: 0, routes: [...] })` → `navigationRef.dispatch(collapseStackAction(owner, …))` (完全な state: `key`・`index`・`routeNames`・`routeKeySeq`・`stale: false`。`target` は持ち主の key)、1062 行の抜粋のコメントは本冊 §9.6 の後の注記の「後」の文に。§0.3 の node_modules の行番号 (7.17.2) は当時の記録として残し、冒頭に「expo-router 5 (SDK 53) 時点の事実。58 は mobile/07」と 1 文 |
| ルート `CLAUDE.md` | 198 行付近「モバイルの `apps/mobile` は Expo 53 + React 19.0 で … (モバイルの更新は #1591)」 | 「Expo 58 + React 19.3 (#1591 で 53 から上げた)」に |
| 同上 | 207 行付近「モバイルは自前の `@types/react ~19.0.10` を …」 | `~19.3.0` に |
| 同上 | 45 行付近 (npm audit の説明) | 変えない (critical で止める運用は同じ。high の残りの経緯は本冊 §2.3 と Issue #1591 が持つ) |
| 同上 | 210 行付近 (ルートで依存を更新する `npm install` が ERESOLVE になるときの手順) | 1 文を足す: 「Expo の SDK の更新のように、モバイルの依存の版をまとめて変えるときは、1 回で作り直すと `react-native` ほかが `apps/mobile/node_modules` に入れ子になる。mobile/07 §10.1 の 2 段 (先に版を変える依存を宣言から外して作り直し、次に戻す) で作り、§9.11 の検査を通す」 |
| `tests/design-doc-followup-owned-edits.test.ts` | `OWNED_EDITS` | 本表の逐語の書き換えの行 (「`A` を `B` に」の形) を見張りに足すかは、専権 PATCH と同じ PR でオーケストレーターが決める (§17) |
| `docs/design/mobile/05-auth-session.md`・`docs/design/mobile/03-push-notification.md`・`docs/design/cross/05-i18n-a11y.md`・`docs/design/cross/16-auth-history-sessions.md`・`docs/design/family/09-onboarding-handson-tour/` の `12-phases.md`・`13-integration.md`・`16-files-structure.md` | 設定の画面のファイル `app/(tabs)/settings.tsx` の名指し (mobile/03 の 270・278・486・493 行・cross/05 の 570 行・cross/16 の 1862・1990・2050・2082・2128 行付近・family/09 の 12-phases 119 行・13-integration 23・366 行・16-files-structure 176 行と §5 の木 306 行)・設定の画面から出る遷移 (13-integration 366 行の下の `router.push('/handson-tour?force=1')`)・「設定タブ」の語 (mobile/05 の 115 行)・mobile/05 の設定画面の `signOutOnDevice` | 変えない (設定の画面は `(tabs)` の中の隠しタブのままで、置き場・コード・遷移は変わらない。§7.1 の B-1) |
| `docs/design/mobile/04-storage-camera.md` | 129・134 行 (`expo-image-manipulator` を使う)・486・492・499 行 (要追加・`npx expo install`・公式の確認) | 変えない。未実装の設計で、§6.3 で依存を消した後は「要追加」がそのまま正しい (いまは使わないまま宣言だけがある) |
| `docs/design/00-architecture.md` | 17 行「React Native (Expo SDK 53)」 | `Expo SDK 58` に |
| `docs/design/family/09-onboarding-handson-tour/16-files-structure.md` | 471 行 §7「@react-native-masked-view の Expo SDK 53 互換性 (要バージョン確認)」 | 変えない (計画の時点の残不確実性の記録。SDK 58 の版は本冊 §6.1 の `0.3.2`) |
| `.github/dependabot.yml` | コメント「(いまは 19.0.0)」 | 実装の段 A で直す (C-13。専権ではない) |

### 15.3 共有面の台帳 (2 つ以上の PR が触る面)

| 面 | 本冊 | 並行しうる案件 | 直列化 |
|---|---|---|---|
| `package-lock.json` | 作り直す (§10.1) | Web の依存の更新 (Dependabot の minor/patch のまとめ・`@supabase/*`) | 本冊のマージの前に main の lockfile を取り込んで §10.1 をやり直す (衝突の手解消はしない) |
| ルート `package.json` の `overrides` | 2 つ足す | Web の `overrides` を足す案件 | 同上 |
| `apps/mobile/app/(tabs)/settings.tsx` (A-1 の import の 1 行)・`apps/mobile/app/(tabs)/_layout.tsx` (B-1 の 118〜119 行)・`profile.tsx` (B-1 のコメント 1 行) | A-1・B-1 | cross/16 の段 B (設定の画面に「ログイン中の端末」の行)・mobile の画面の案件 | cross/16 の段 B は本冊より先に main に入った (PR #1838・origin/main `307ae1cf`。行 1 つと `sessions-entry.test.tsx`)。本冊の段 A の前に main を取り込む (§13.2・§14.2 の `sessions-entry.test.tsx` の mock)。#1876 (origin/main `d34f18d8`) も本冊より先に main に入った (書き出しの 2 行の副題と CSV の共有の題・`export-rows.test.tsx`)。取り込んだら `export-rows.test.tsx` の mock の指定子も A-1 で `/legacy` にする (§13.2)。本冊は設定の画面の置き場を変えないので、ほかの案件の設定の画面の差分とは行の単位でしか重ならない |
| `apps/mobile/app/legal-consent.tsx`・`LegalConsentGate.tsx`・`legal-consent.ts`・`app/_layout.tsx` (コメント 1 行) | B-2 | 13b の後続 | 本冊が先 |

---

## 16. オーナー作業との境目 (協調リリース #1115)

本冊の実装 (段 A〜C) のマージまでが開発側。マージ後は次の順でオーナーが進める。本冊はビルド・提出・ストアの操作をしない (R-8)。

| # | 作業 | 内容 |
|---|---|---|
| O-1 | eas-cli の更新 | `npm i -g eas-cli@latest` (25.0.0 以上。`eas.json` の `cli.version` が止める) |
| O-2 | preview のビルド | `cd apps/mobile && eas build --platform ios --profile preview` と `--platform android --profile preview` (apk)。ビルドのページの runtime version が fingerprint のハッシュ (M-0) |
| O-3 | 実機の確認 (下の M-0〜M-8 と、#1115 のコメントに積んである #1722・#588・#1822・#1442 の項目) | 結果を #1115 に書く。落ちたら、ビルドのログかクラッシュの内容を #1115 に写す (本冊の範囲外の修正は別 Issue) |
| O-4 | production のビルドと提出 | `eas build --platform ios --profile production` → `eas submit`。Android は `track: internal` のまま |
| O-5 | (後日) Expo Go | SDK 58 の Expo Go がストアに出たら、README の案内のとおり実機の簡易確認に使える (push 通知は Expo Go では例外。SDK 55) |

**実機の確認 (M-n)**

| # | 確認 | 期待 | 由来 |
|---|---|---|---|
| M-0 | EAS のビルドのページの Runtime version | `1.0.0` でない (fingerprint のハッシュ)。iOS と Android で違ってよい | §11 |
| M-1 | 起動 → ログイン → 5 つのタブ (WebView) → AI のシート | 全部開く。白い画面・クラッシュが無い | N-2・N-3 (scene・Hermes V1・Metro の ESM) |
| M-2 | マイページの歯車 → 設定 (ホームへ戻されないこと) → 別のタブ → もう一度歯車。設定 → アカウント → 戻る。設定 → プロフィール。設定 → 使い方ガイドをもう一度見る → ツアーを抜ける。設定 → ログアウト → ログイン。設定の画面で Android の戻るボタン | 歯車で設定の画面が開き、最初のタブ (ホーム) へ戻されない。タブバーは 5 つの項目だけ (設定のボタンも空いた枠も無い)。AI の FAB は設定の画面でも出る。ほかの遷移と Android の戻るボタンの行き先は SDK 53 のビルドと同じ (アカウントから戻ると設定・プロフィールでマイページのタブ・ツアーを抜けるとホーム・ログアウトで入口・ログインでタブ) | B-1 |
| M-3 | 同意が要るアカウントでログイン (#1442 の 5 項目: 同意画面 1 枚・ほかの戻る操作が止まる・iOS はスワイプで戻れず Android の戻るは OS へ・同意の後は入口から振り分け・「同意しない」の後の案内と「閉じる」) | #1115 のコメントの期待どおり | B-2 |
| M-4 | Push 通知 (前面で受ける・タップで行き先へ) | 前面でバナーが出る。タップで行き先の画面 | A-6 (#1722 の前提の `EXPO_ACCESS_TOKEN` 等は #1115) |
| M-5 | deep link (`homegohan://…`) をアプリ未起動で開く | 行き先の画面が開く | N-2 (scene の URL の受け渡し) |
| M-6 | ハンズオンツアーの最初・卒業の画面と AI のシートを Android 16 の端末で | 文字が status bar / ナビゲーションバーの下に潜らない。バッジのアニメーションが動く | A-2・A-5・N-1 |
| M-7 | スプラッシュ (iOS / Android) | iOS は今までと同じ全画面の画像。Android 12 以降は中央の画像 + 背景色 `#FFF7ED` (小さければ §17 の 4) | C-2 |
| M-8 | Android の apk (preview) で全体のスモーク | R8 で壊れていない (クラッシュ・空の画面が無い) | N-1 |

---

## 17. 未解決事項 (openQuestions)

1. **braces・node-forge の修正版**: 2026-10-17 時点で無い。Dependabot のパッチ更新で入る (`braces` は `micromatch` 経由、`node-forge` は `@expo/cli` 経由で `^` の範囲)。上流が修正版を出すまで high として残る。CI の `npm audit` は critical でしか止めないので運用に影響しない。
2. **RNTL 14 への移行**: expo-router 58 は `@testing-library/react-native >= 14` を任意の peer に、`expo-router/testing-library` は必須にする。本冊は 13.3.3 のままで `expo-router/testing-library` を使わない。67 ファイルの書き換えは別案件 (起票はオーケストレーター)。
3. **`react-native-web` と `expo start --web`**: `react-dom` を宣言していないので、ルートの `react-dom` (19.2.x) と `react` (19.3.0) が合わず、Web の起動は以前から保証していない。README の「C) Expo Web で確認 (補助)」は残すか消すか (本冊は触らない)。
4. **Android のスプラッシュの画像**: `expo-splash-screen` の plugin は Android 12 以降で中央の画像 (`imageWidth` の既定 100) を使う。2000×2000 のワードマーク (`splash-ios.png`) を縮めると小さい。専用の画像 (アイコンの寸法) を用意するかはオーナーの判断 (M-7 の見え方で決める)。
5. **`expo-doctor` の通らない項目**: Expo Go (SDK 58) が未公開の間、Expo Go に関する項目が警告になる可能性がある。V-9 で文面を写して判断する。
6. **`@react-native/jest-preset` の overrides**: §10.1 の 2 段の試作では、`babel-jest` / `jest-environment-node` は 30.5.2 でルートにまとまり、入れ子は残らなかった。`npm install` が 29 系の入れ子を作る場合は、E-13 の確認で分かる。その場合は overrides を外し、残る 2 経路 (dev のみ) を PR の本文に写して §2.3 の表に足す (専権)。
7. **同意画面の畳み直しの実機の挙動**: 完全な state の RESET の action が router に受け付けられることは T-ML12 が実物の `StackRouter` で確かめる。`usePreventRemove` との組と、`dispatch` が commit の後に流れる順は単体テストでは mock 越しにしか見えない。M-3 (#1442 の 5 項目) が実機の確認で、落ちた場合は 13b と本冊の両方を見直す (構造の裁定への差し戻し事由)。
8. **lockfile の 2 段の作り直しが npm の版で変わる可能性**: §10.1 の手順は、設計の時点の npm (10 系) の解決で `V-1 OK` になった。offload の行き先の npm の版で結果が違えば E-15 で止まる。手順を変えるときは本冊の §10.1 と §9.11 を一緒に直す (専権)。
9. **追随表の見張り**: `tests/design-doc-followup-owned-edits.test.ts` は「追随表に逐語の書き換えの行を足したら `OWNED_EDITS` にも足す」と決めている。本冊 §15.2 の逐語の行を `OWNED_EDITS` に足すか (足すなら、専権 PATCH と同じ PR) はオーケストレーターが決める。
10. **隠しタブの書き方が expo-router の内部に依ること (B-1)**: 58 の `processScreens` は `href` の無い画面をそのまま通し、`useVisibleTabsWithRedirect` は `hidden` でない宣言済みの route をタブの一覧に残す (§9.10)。公式の「タブを隠す」手引きは 58 の新しい挙動に合わせた書き換え待ち (`build/layouts/TabsClient.js:92` の TODO) で、`useVisibleTabsWithRedirect.js:85` には「前面の隠しタブを formsheet で出す」の TODO がある。expo-router の更新でこの扱いが変わると、`home/tabs-hidden-route.test.ts` が赤になる (T-TB1・T-TB3 なら §12 の E-19、T-TB2・T-TB4 なら `href: null` の扱いが変わった)。そのときは、設定の画面を `(tabs)` の外に出す形 (§5.1 の H) か、マイページのタブの中の Stack (§5.1 の I) か、`href: null` に戻すかを、その時点の expo-router の手引きで選び直す (別案件。起票はオーケストレーター)。

---

## 改定履歴

| 版 | 日付 | 変更 |
|---|---|---|
| v1.0 | 2026-10-17 | 初版 (A 型・4 相。origin/main 904f9e8f の事実・npm registry と Expo / React Native / Jest / Reanimated の公式の文書から) |
| v1.5 | 2026-10-18 | 網羅性の反映 (周 4): §2.2 に origin/main `0ca17773` との突き合わせと「数の基準」(数は origin/main のもの・設計の枝の古さは実装に届かない) を足した・§14.1 に実装の worktree を origin/main から切ることと段 A の最初の数え直しの手順・§15.1 を `0ca17773` で引き直し `tests/faq-guide-wording-1859.test.ts` の行を足した (§10 の V-7 にも) |
| v1.4 | 2026-10-18 | 設計ゲート R3 の指摘の反映: 設定の画面を `(tabs)` の中の隠しタブのまま置き、`href: null` を expo-router 5 の展開と同じ `tabBarButton: () => null` と `tabBarItemStyle: { display: "none" }` にする形に構造を替えた (§5.1 の G。v1.1〜v1.3 の移設 (H) と、その部品 (session の止め・設定の画面の遷移 4 つの直し・`ENTRY_SCREEN_ROUTE_NAME`・`session-guard.test.tsx`・設定のパスの番兵と設計書の追随) を消した。§3・§4.2・§7.1 の B-1・§8.2・§8.3 (c)・§9.4・§9.10・§13〜§17)・実物の expo-router 58 の `processScreens` と `useVisibleTabsWithRedirect` に通す `home/tabs-hidden-route.test.ts` (§9.12)・段 A の V-2 で `app/legal-consent.tsx` の `beforeRemove` の effect の型エラーだけを許す (B-2 が消す。§10・§12 の E-17)・§12 の E-18 / E-19・origin/main `9dd73f23` との突き合わせ |
| v1.3 | 2026-10-17 | 網羅性の反映 (周 3): §15.2 に `mobile/03`・`mobile/04` (変えない)・`mobile/05` の 115 行・`00-architecture`・`cross/05`・`family/09` の 3 冊の行・§15.1 に `tests/handson-tour-files-structure-doc.test.ts` (段 B で赤になる番兵)・§17 の 12。origin/main `307ae1cf` (cross/16 の段 B・PR #1838) の取り込み: 設定の画面の「ログイン中の端末」の行 (`/settings/sessions`)・`sessions-entry.test.tsx` (A-1 の mock・移設の import。§13.2・§14.2)・Jest のテストの数 (115 → 段 B 以降 116)・`render(` の数 (62)・§15.3 の cross/16 の段 B の順 |
| v1.2 | 2026-10-17 | 設計ゲート R2 の指摘の反映: 設定の画面から出る遷移を、ルートの Stack に設定の画面や 2 つ目の `(tabs)` を残さない形に (「プロフィール」= `router.dismissTo`・「使い方ガイド」= `router.replace`・ログアウトと session の切れ = 入口 1 つに畳む完全な state の RESET。§9.10・§8.3 (c) の表を実物の expo-router 58 の行き先の決め方で書き直し)・畳む関数を route の名前の汎用の名前に (`collapseStackAction` ほか)・`ENTRY_SCREEN_ROUTE_NAME`・`expo-file-system` を import するテスト 3 本の import も `/legacy` に・番兵が `__tests__` の指定子も見る・シナリオ S20〜S22・§17 の 10 (既存の 2 つ目の `(tabs)`) と 11 (構造の代案) |
| v1.1 | 2026-10-17 | 設計ゲート R1 の指摘の反映: ゲートの畳み直しを完全な state (`stale: false`・`routeKeySeq`) の RESET の action の `dispatch` に・jest の `react-native` の mapper を消す・lockfile を 2 段で作り直し置き場を V-1 と番兵で固定・`react-native-url-polyfill` を残す・設定の画面に session の止め・追随の漏れ (vitest の mock・タブの it 2 つ・残した画面の一覧・FAQ のテスト)・`as any` の数の訂正 |
