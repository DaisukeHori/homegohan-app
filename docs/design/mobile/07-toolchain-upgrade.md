# mobile/07 モバイルのツールチェーンのメジャー更新 — Expo SDK 53 → 58 (React Native 0.79 → 0.88・Jest 29 → 30)

| | |
|---|---|
| 版 | v1.0 (2026-10-17) |
| Status | 設計ゲート審査中 (R1)。実装は §14.1 の段分け (段 A → B → C を 1 本の WF・1 本の PR) で進める。未着手 |
| Issue | #1591 (モバイルのツールチェーン (expo・react-native・metro・jest) のメジャー更新 — npm audit の high の残りの原因。#1444 から分割)。載せる先のネイティブのビルドは #1115 (協調リリース) |
| 範囲の正本 | Issue #1591 の本文とコメント。本書はその上で決めた上げ先・壊れる所・直し方・検証・段分け・オーナー作業との境目 |
| 実装者 | Sonnet 5.5 が本書だけを読んで手を止めずに実装できることを完成条件にする (設計ゲートを省くなら Opus 5.5) |

オーナーの選択 (2026-10-17): 「今から始める。設計 → 実装 → マージし、次のネイティブのビルド (#1115) に載せる。」

本冊は、`apps/mobile` のツールチェーン (`expo` / `expo-updates` / `react-native` / `metro` / `jest` / `jest-expo`) を **Expo SDK 58 (React Native 0.88.0・React 19.3.0・Jest 30.5) に一度に上げる**。Issue #1591 が挙げた npm audit の high のうち、**image-size・postcss・jest 系 (jest-haste-map・@jest/environment ほか) と metro-transform-worker の経路は消える**。**braces と node-forge は 2026-10-17 時点で修正版が公開されていない** (npm の latest がそれぞれ 3.0.3・1.4.0 で、どちらも脆弱な範囲) ので、どの版に上げても残る (§2.3)。したがって「high が消える最小の組み合わせ」は存在せず、上げ先は「残る 2 系統以外を全部消し、いまの安定版に乗る」SDK 58 にする (§5)。

---

## 0. 分冊判定・範囲・読み方

### 0.1 分冊判定 (相 1 で実施)

| 目安 | 本冊 | 判定 |
|---|---|---|
| 設計書 800 行超 | 超える (壊れる所の表・正典の設定ファイル・表 3 点・トレースを 1 冊に持つため) | 該当 |
| 消費先レーン 3 以上 | 依存の宣言 (`package.json` ×2・`package-lock.json`)・アプリの設定 (`app.json` / `eas.json` / Metro / Babel / tsconfig)・Jest の基盤・アプリのコード (expo-router 58 への追随 2 か所・API の置き換え 3 か所)・番兵のテスト = 5 | 該当 |
| 共有面 2 つ以上 | ルートの `package.json` の `overrides`・`package-lock.json` (Web と共有)・`.github/dependabot.yml` のコメント・設計正典 (`mobile/01`・`mobile/CLAUDE.md`・`cross/13b`・`cross/16`・ルート `CLAUDE.md`) | 該当 |

判定: **設計は 1 冊 (本書) のまま、実装は 1 本の B 型 WF の中で 3 段 (A: 依存と設定 / B: expo-router 58 への追随 / C: 番兵と README) に分け、段ごとに 2 枚レビューを挟み、マージは最後に 1 回**。理由: どの段も同じネイティブのビルド (#1115) に載るまで利用者には届かず、段 A だけをマージすると、設定の画面に届かない (§7.1 の B-1) ・同意画面の止めが効かない (B-2) 状態の main ができる。核と配線に分けても、分かれた冊が参照する「マージ済みの核」が無い (全部が同じ `package-lock.json` の 1 回の作り直しに依る) ので、分けても行数も周回も減らない。

### 0.2 本冊の範囲と、対象外

| 本冊 | 対象外 (別の案件) |
|---|---|
| `apps/mobile` の依存を Expo SDK 58 の版 (`expo/bundledNativeModules.json`) にそろえ、ルートの `package-lock.json` を作り直す | Web (`src/`・ルートの `next` / `react` / `eslint-config-next`) の更新。`eslint-config-next` → `fast-glob` → `micromatch` → `braces` の high (dev) は Web 側の案件 |
| 上げ先で壊れる所 (API・設定・テスト) の全列挙と直し方 (§7) | `@testing-library/react-native` 14 への移行 (`render` / `fireEvent` / `act` が Promise を返すようになり、`render(` を使うテスト 59 ファイルの書き換えになる。§5.1 の C) |
| `runtimeVersion` の方針 (fingerprint) と、OTA を使わない現状の固定 (§11) | OTA (EAS Update) を使い始めること (`mobile/01` §13 の「大型変更時に検討」のまま) |
| Jest 29 → 30 への追随と、Reanimated 4 (worklets) の Jest の設定 (§7.3) | `expo-file-system` の新しい API (`File` / `Directory`) への移行 (`/legacy` の入口を使い続ける。§7.1 の A-3) |
| 使っていない依存 4 つの削除 (§6.3) | `expo-dev-client` の導入 (`eas.json` の `development` プロファイルは、いまも入っていない。変えない) |
| 検証 (tsc・local-ci の mobile:jest / mobile:core・npm audit・expo-doctor・`expo install --check`) と合格の数 (§10) | ネイティブのビルド・提出・実機の確認 (オーナー作業。§16 に手順と確認の表を置く) |
| 番兵 (版の組・`runtimeVersion`・`/legacy` の入口) の新設 (§9.6) | `react-native-web` / `expo start --web` の整備 (`react-dom` を宣言していない現状のまま。既知の制約として §17) |

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
| `docs/design/cross/13b-legal-consent-mobile.md` | 同意ゲート。`beforeRemove` と `navigationRef.reset` の規則 (§0.3・§6.6.8〜6.6.11) が expo-router 58 で変わる (§7.1 の B-2) |
| `docs/design/cross/16-auth-history-sessions.md` | `app/(tabs)/settings.tsx` を名指しする追随の行 (4 行。§15.2) |
| `docs/design/mobile/05-auth-session.md` | 設定画面の `signOutOnDevice` (ファイル名は書いていない)。番兵 `tests/mobile-sign-out-doc-callers.test.ts` が画面のファイルを持つ |
| Dependabot PR #1589 (postcss・expo・next) / #1590 (minor/patch のまとめ) | どちらも閉 (10/14・10/16)。#1590 の `@supabase/ssr` は #1768 (PR #1841) で別に上げた。本冊で扱う残りは無い |

### 2.2 現行の事実 (origin/main `904f9e8f` で採取。2026-10-17)

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
| @react-native-community/slider | 4.5.7 | 4.5.7 | `apps/mobile/node_modules`。**import している所は無い** |
| react-native-url-polyfill / expo-haptics / expo-image-manipulator | 宣言あり | – | **import している所は無い** |

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
| `expo-file-system` | `app/(tabs)/settings.tsx` と `src/lib/webViewDownload.ts` が `import * as FileSystem from "expo-file-system"` で旧 API (`cacheDirectory` / `documentDirectory` / `writeAsStringAsync` / `makeDirectoryAsync` / `readDirectoryAsync` / `getInfoAsync` / `deleteAsync` / `EncodingType`) を使う。テスト 10 ファイルが `jest.mock('expo-file-system', …)` |
| `react-native` の `SafeAreaView` | `app/handson-tour/index.tsx`・`app/handson-tour/graduate.tsx`・`src/components/ai/AIAdvisorSheet.tsx` の 3 ファイル (ほかは `react-native-safe-area-context` の `SafeAreaView`) |
| `expo-router` | `Stack` / `Tabs` / `Link` / `Redirect` / `router` / `useRouter` / `useNavigation` / `useLocalSearchParams` / `usePathname` / `useSegments` / `useRootNavigationState` / `useNavigationContainerRef`。`(tabs)/_layout.tsx` が `<Tabs.Screen name="settings" options={{ href: null }} />`、`(tabs)/profile.tsx` が `router.push('/(tabs)/settings')`。`app/legal-consent.tsx` が `navigation.addListener("beforeRemove", …)` + `preventDefault()`。`src/components/legal/LegalConsentGate.tsx` が `navigationRef.reset({ index: 0, routes: [{ name: 'legal-consent' }] })`。`navigation.addListener('tabPress' / 'blur')`・`getParent`・`getState`・`isFocused`・`setParams` |
| `react-native-reanimated` | `Animated.View`・`useSharedValue`・`useAnimatedStyle`・`withTiming`・`withSpring` (`{ damping, stiffness }`)・`withDelay`・`withSequence`・`Easing` の 4 ファイル (handson-tour の index / graduate・`src/handson-tour/TourOverlay.tsx` / `Confetti.tsx`) |
| `expo-notifications` | `setNotificationHandler` (`shouldShowBanner` ほか)・`getExpoPushTokenAsync`・`get/requestPermissionsAsync`・`setNotificationChannelAsync`・`AndroidImportance`・`getLastNotificationResponseAsync`・`clearLastNotificationResponseAsync`・`addNotificationResponseReceivedListener` |
| `expo-image-picker` | `launchCameraAsync` / `launchImageLibraryAsync` / `requestCameraPermissionsAsync` / `requestMediaLibraryPermissionsAsync`。`app/health/blood-tests.tsx` の 2 か所が `mediaTypes: ["images"] as any` |
| React Native 0.87 以降で消える・型が変わるもの | `InteractionManager`・`Touchable`・`NativeMethods`・`ImageBackground`・`StatusBar` の `backgroundColor` / `translucent`・`Modal` の `animated`・`react-native/Libraries/*` の深い import: **どれも使っていない** (0 件) |
| `@react-navigation/*` の直接 import | 無し (コメントに 1 か所) |

**Jest のテスト** (`apps/mobile/__tests__`: 111 ファイル)

- 使っている API: `jest.fn` / `jest.mock` / `jest.spyOn` / `jest.useFakeTimers` / `jest.advanceTimersByTime(Async)` / `jest.isolateModules` / `jest.requireActual` / `jest.replaceProperty` / `jest.SpyInstance` 型 / `jest.Mock` 型。Jest 30 で消える別名の matcher (`toBeCalled` / `toThrowError` / `lastCalledWith` …) は **0 件**。`--testPathPattern` の利用は **0 件**。`done` コールバック **0 件**。`@jest-environment` の docblock **0 件**。
- `@testing-library/jest-native` の matcher: `toHaveTextContent` 21・`toBeEnabled` 20・`toBeDisabled` 16・`toContainElement` 4・`toHaveStyle` 2。
- `render(` を使うファイル: 59。

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

---

## 3. 相 1 外形固定

### 3.1 要件行列

| # | 要件 | 由来 | 満たす場所 |
|---|---|---|---|
| R-1 | 上げ先の版と理由を決める | Issue 本文・設計で決めること | §5・§6 |
| R-2 | image-size・postcss・jest 系・metro-transform-worker の high の経路を消す | Issue 本文 | §2.3・§10.4 |
| R-3 | 修正版の無い根 (braces・node-forge) は、残ることと経路を明記し、合否から外す | §2.3 の事実 | §2.3・§10.4・§17 |
| R-4 | 壊れる所 (API の廃止・設定・テスト) を全列挙し、直し方を表にする | 設計で決めること | §7 |
| R-5 | `runtimeVersion` の扱いを決め、既存のビルドに OTA で新しい JS が届かないことを固定する | 設計で決めること | §11・§9.6 |
| R-6 | 段分けと検証 (local-ci の mobile:jest・mobile:core・tsc・npm audit の数) を決める | 設計で決めること | §10・§14 |
| R-7 | オーナー作業 (EAS のビルド・提出・実機) との境目を決める | 設計で決めること | §16 |
| R-8 | 本番 (Supabase・HubSpot 等) に触らない。ネイティブのビルドはしない | 制約 | 全体 (本冊はサーバーにも DB にも触れない) |
| R-9 | `@react-native-community/slider` 4.5.7 の扱い (SDK の推奨より上のパッチ) | Issue 本文 | §6.3 (使っていないので消す) |
| R-10 | Dependabot #1589 / #1590 の仕分け | Issue 本文 | §2.1 (どちらも閉。残りは無い) |
| R-11 | `as any` を使わない。業務上の意味を持つ数値は名前付き定数 | 全体の規律 | §7.1 の A-5 (既存の `as any` 2 件を外す)・§9 |
| R-12 | 既存の番兵 (契約テスト・走査テスト) の追随を全列挙する | 設計の完成条件 | §15.1 |
| R-13 | 上げた後の React とレンダラーの版のずれを番兵で止める | ルート CLAUDE.md「完全に同じ版でないと動かない」 | §9.6 |
| R-14 | Node の最低版 (SDK 58: `^22.13.0 \|\| ^24.3.0 \|\| ^26`) を満たす | SDK 58 の要件 | §6.4 |

### 3.2 ユーザーシナリオ (18 本)

「利用者」はアプリの利用者、「実装者」は本冊の実装、「オーナー」は EAS のビルドと提出をする人。

| # | シナリオ |
|---|---|
| S1 | 実装者が `apps/mobile/package.json` とルートの `overrides` を §6 の版に書き換え、`package-lock.json` を作り直す。ルート (Web) の `react` 19.2.8 と `apps/mobile` の `react` 19.3.0 は別の置き場に解決される |
| S2 | CI (`mobile-test.yml`) が `npm ci` のあと `apps/mobile` で `npm test -- --ci --coverage` を Jest 30 で流し、111 ファイルが緑になる |
| S3 | ローカル CI の `mobile:jest` / `mobile:core` が同じ結果を JSON (`numPassedTests` / `numFailedTests`) で返し、`parse jest` が読める |
| S4 | 実装者が `npx tsc -p apps/mobile/tsconfig.json --noEmit` を流す。React Native 0.88 の Strict TypeScript API の既定で新しい型エラーが出ないか見る。既存の 6 件以外は 0 件 |
| S5 | 実装者が `npm audit --json` を流し、根の advisory が braces と node-forge の 2 系統だけになり、image-size と postcss の GHSA と `jest*` / `@jest/*` の経路が無いことを数える |
| S6 | オーナーが `eas build --platform ios --profile preview` を流す。`runtimeVersion` は fingerprint の方針でビルド時に計算され、SDK 53 のビルドの `1.0.0` とは別の値になる |
| S7 | 利用者の端末に残る SDK 53 のビルド (`runtimeVersion` 1.0.0・更新は無効) は、起動しても更新を確認せず (`checkAutomatically: NEVER`・`enabled: false`)、新しい JS が届くことは無い。将来 OTA を有効にしても、fingerprint が違うので SDK 58 の JS は SDK 53 のビルドに届かない |
| S8 | 利用者がマイページの歯車を押す。`router.push('/settings')` で設定の画面 (`app/settings/index.tsx`) がルートの Stack に積まれ、ログアウト・通知・退会の行が使える。戻る (iOS のスワイプ・Android の戻る) でマイページのタブへ戻る |
| S9 | 同意が要る利用者がログインする。ゲートがルートの Stack の持ち主の state から「同意画面 1 つ」の完全な state を作って `reset` し、Stack が同意画面だけになる。ログイン直後の `routeAfterSignIn` の `replace` は、同意画面の `usePreventRemove` が止める |
| S10 | 同意画面で Android の戻るボタンを押す。Stack の唯一の route なので OS に渡り、アプリが背面へ移る。iOS のスワイプは `gestureEnabled: false` |
| S11 | 利用者が Web の同意画面で同意する。合図 `legal-consent-accepted` で state が `clear` になり、同意画面の止めが外れ、ゲートが `router.replace('/')` で入口へ移す |
| S12 | 同意を待つ間に Web で「同意しない」を押してログアウトした。同意画面は案内と「閉じる」を出し、取り除く操作を全部止める。「閉じる」で止めを解いて入口へ移る |
| S13 | 利用者が設定の「データの書き出し (JSON)」を押す。`expo-file-system/legacy` の `writeAsStringAsync` で書き、`expo-sharing` で共有する |
| S14 | 利用者がハンズオンツアーの最初の画面と卒業の画面を Android 16 の端末で開く。edge-to-edge が強制されるので、`react-native-safe-area-context` の `SafeAreaView` が上下の余白を取り、文字が status bar の下に潜らない。Reanimated 4 の `withTiming` / `withSpring` でバッジが動く |
| S15 | 利用者が血液検査の画面でカメラ/ライブラリから写真を選ぶ。`expo-image-picker` 58 の `mediaTypes: ["images"]` は型が付くので `as any` が無い |
| S16 | 前面で Push 通知が届く。`setNotificationHandler` が `shouldShowBanner: true` を返すので表示される (SDK 58 の既定も表示)。通知をタップすると `NotificationRouter` が `getLastNotificationResponseAsync` / `clearLastNotificationResponseAsync` で行き先へ移す |
| S17 | Dependabot が `react-native` のパッチ更新 (例 0.88.1) の PR を出す。`tests/mobile-toolchain-contract.test.ts` が、`react-native` と `react` が `expo/bundledNativeModules.json` の版と一致しないので赤にし、SDK ごとの組で上げるよう促す |
| S18 | 実装者が `npx expo install --check` と `npx expo-doctor@latest` を流す。`--check` は「Dependencies are up to date」(ずれ 0 件)、expo-doctor は app.json のスキーマ (SDK 58 に無い `splash` を消し、`assetBundlePatterns` を消した) と依存の重複を通る |

---

## 4. 相 2 構想

### 4.1 構造 (発明相の結論)

1. **一度に SDK 58 へ上げる** (54 → 55 → … と段階を踏まない)。Expo の changelog (54・55・56・57・58) の破壊的変更を §7 に全部列挙し、各版の差を本冊で吸収する。ネイティブのビルドは 1 回で済み、中間の版でビルドして確かめる工程を置かない。
2. **版は `expo/bundledNativeModules.json` (58.0.14) の逐語**。`npx expo install --fix` の結果と同じ版を `package.json` に手で書き、`package-lock.json` を `--package-lock-only` で作り直す (§6.1・§10.1)。
3. **React は入れ子のまま** (ルート 19.2.8 / モバイル 19.3.0)。`metro.config.js` の `resolveRequest` と jest の `moduleNameMapper` は残し、コメントだけ現在形にする (§5.2)。
4. **Jest は 30.5 + jest-expo 58 + `@react-native/jest-preset` 0.88**。`@react-native/jest-preset` が持つ Jest 29 の依存 (`babel-jest` / `jest-environment-node`) はルートの `overrides` で 30 にそろえ、jest 29 の経路を lockfile から消す (§6.2)。jest-expo 58 自身は `babel-jest` と環境を自分の Jest 30 の依存から `require.resolve` するので、実行時は overrides の有無に依らず Jest 30 で動く。
5. **RNTL は 13.3.3 のまま、`react-test-renderer` を 19.3.0 (React と同じ版) に固定**。RNTL 14 は別案件 (§0.2)。
6. **expo-router 58 への追随は 2 か所だけ**: 設定の画面を `(tabs)` の外 (`app/settings/index.tsx`) へ移す / 同意画面の止めを `usePreventRemove` に、ゲートの `reset` を完全な state (持ち主の navigator の `key` / `routeNames` / `type` を写し、同意画面の route があれば `key` ごと再利用) にする。
7. **API の置き換えは 3 種**: `expo-file-system` → `expo-file-system/legacy` (2 ファイル + mock 10 ファイル) / `react-native` の `SafeAreaView` → `react-native-safe-area-context` (3 ファイル) / `mediaTypes` の `as any` を外す (2 か所)。
8. **`runtimeVersion` は fingerprint の方針をトップレベルに置き、更新は無効のまま**。番兵が固定する (§11・§9.6)。
9. **使っていない依存 4 つを消す** (`@react-native-community/slider`・`react-native-url-polyfill`・`expo-haptics`・`expo-image-manipulator`)。`@expo/vector-icons` (expo 58 が依存しなくなった) と `react-native-worklets` (Reanimated 4 の peer) と `@react-native/jest-preset` を新しく宣言する。
10. **段 A (依存と設定・API の置き換え) → 段 B (expo-router 58 への追随) → 段 C (番兵・README)** を 1 本の WF で直列に積み、マージは最後に 1 回。設計正典の追随 (`mobile/01`・`mobile/CLAUDE.md`・`cross/13b`・`cross/16`・ルート `CLAUDE.md`) はオーケストレーターの専権 PATCH (§15.2)。

### 4.2 シナリオのトレース (上の構造で手で走らせたもの)

| # | トレース |
|---|---|
| S1 | `apps/mobile/package.json` を §6.1 に、ルート `package.json` の `overrides` を §6.2 にする → commit → offload の行き先で `npm install --package-lock-only --ignore-scripts` (ERESOLVE なら `--legacy-peer-deps` で 1 回、続けて素の `--package-lock-only` を 1 回。ルート CLAUDE.md の手順) → `package-lock.json` を持ち帰る → `node_modules/react-native` 0.88.0・`apps/mobile/node_modules/react` 19.3.0・`node_modules/react-test-renderer` 19.3.0・`apps/mobile/node_modules/@types/react` 19.3.0・`node_modules/jest` 30.5.x・`node_modules/@expo/metro-config/node_modules/postcss` 無し・`node_modules/image-size` 無し・`node_modules/@react-native/jest-preset/node_modules/babel-jest` 無し・ワークスペースの下の入れ子の `zod` 無し、を lockfile で確かめる (§10.1) |
| S2 | `npm ci` が lockfile どおりに入れる → `jest-expo` 58 の preset が `@react-native/jest-preset` (0.88.0) を読み、`babel-jest` と環境は jest-expo 自身の Jest 30 の依存を `require.resolve` → `jest.config.js` の `moduleNameMapper` が `react` / `react-native` / `react-test-renderer` を固定 → `jest.setup.js` が worklets の mock と Reanimated の `setUpTests()`・jest-native・RNTL の `configure` を入れる → 111 ファイルが流れ、`--coverage` (babel-plugin-istanbul 8) も出る |
| S3 | `stage_mobile` は `npm test --silent -- --listTests --json` と `npm test -- --ci --coverage --json --outputFile=…` を流す。Jest 30 の JSON も `testResults` / `numPassedTests` / `numFailedTests` / `numPendingTests` を持つので `parse jest` は変えない |
| S4 | `expo/tsconfig.base` (58) は `module: preserve`・`moduleResolution: bundler`・`customConditions: ["react-native"]`・`${configDir}` (TypeScript 5.5 以降) → モバイルの `typescript ~5.9.3` で読める。`react-native/Libraries/*` の深い import は 0 件なので Strict API で消える型は無い。`SafeAreaView` を `react-native-safe-area-context` から読むと `edges` 付きの型になる。`mediaTypes: ["images"]` は `MediaType[]` で通る → 既存の 6 件だけ残る |
| S5 | `npm audit --json` の `vulnerabilities` を走査 → `via` にオブジェクトを持つ項目 = `braces` と `node-forge` だけ → `image-size`・`postcss` の項目が無い → 名前が `jest` / `@jest/` / `babel-jest` / `create-jest` / `expect` / `jest-expo` で始まる high が無い → 合格 (§10.4)。high の総数 (想定 13〜15。経路は `micromatch` / `metro-file-map` / `metro` / `metro-config` / `@react-native/community-cli-plugin` / `react-native` と `@expo/code-signing-certificates` / `@expo/cli` / `expo` / `expo-updates`。dev では `fast-glob` / `@next/eslint-plugin-next` / `eslint-config-next`) は記録する |
| S6 | `app.json` の `runtimeVersion: { "policy": "fingerprint" }` → EAS が `@expo/fingerprint` (expo 58 の依存) でネイティブに効く依存と設定のハッシュを計算し、ビルドの runtime version にする。`expo.version` の変更はハッシュに入らない (SDK 58) |
| S7 | SDK 53 のビルド: `updates.enabled: false` のため `Updates.isEnabled` は false で埋め込みの JS だけを読む。`checkAutomatically: NEVER` のため起動時の確認もしない。更新を公開する操作 (`eas update`) は本冊に無い (R-8)。将来 `enabled: true` にしても、SDK 58 のビルドの fingerprint と `1.0.0` は一致しない |
| S8 | `(tabs)/profile.tsx` の `NATIVE_SETTINGS_ROUTE = '/settings'` → `router.push('/settings')` → ファイルの route `app/settings/index.tsx` がルートの Stack に積まれる (ルートの `Stack` は `headerShown: false`。画面は自前の見出しと `useSafeAreaInsets`) → 行の `router.push('/settings/account')` などは変わらない → 戻ると `(tabs)` が前面に戻り、マイページのタブ (WebView) はそのまま |
| S9 | state が `required`・前面が `(tabs)`・pathname `/home` → ゲート: `navigationRef.getRootState()` から前面の枝を降り、`routeNames` に `legal-consent` を持つ navigator (ルートの Stack) の state を取る → `legalConsentCollapsedState` が `{ key, index: 0, type, routeNames, routes: [{ name: 'legal-consent' }] }` を作る (同意画面の route が無いので名前だけ。`stale` は持たない) → `navigationRef.reset(…)` (58 では commit の後に流れる) → Stack が [同意画面] → `openedRef` を立てる。`routeAfterSignIn` の `router.replace('/onboarding/welcome')` が後から流れると、同意画面の `usePreventRemove(true)` が REPLACE を止める (callback は `repeat` を呼ばず捨てる) |
| S10 | Stack の route が 1 つなので `canGoBack()` は false → コンテナは `BackHandler` で OS に渡す → アプリが背面へ。`usePreventRemove` は呼ばれない (取り除く操作が無い)。iOS は `gestureEnabled: false` |
| S11 | `clear` → 同意画面: `legalConsentScreenPreventsRemoval('free', false)` = false → ゲート: 前面が同意画面で `clear` → `refreshProfile()` → `canGoBack()` false → `router.replace('/')` → REPLACE は止められず [入口] → 入口が profile から振り分ける |
| S12 | session 無し・`sawRequired` → `signed-out-notice` → `usePreventRemove(true)`。「閉じる」: `closingRef` を立て、`setClosing(true)` (次の描画で `preventRemove` が false)、返り値の `disablePrevention()` を呼び、`router.canGoBack()` ? `back()` : `replace('/')` → 止められずに入口へ |
| S13 | `app/settings/index.tsx` の `import * as FileSystem from "expo-file-system/legacy"` → `FileSystem.documentDirectory` / `writeAsStringAsync` は SDK 58 の `expo-file-system/legacy` にある (exports に `./legacy`) → `Sharing.shareAsync` |
| S14 | `app/handson-tour/index.tsx` の `SafeAreaView` を `react-native-safe-area-context` から読む (既定の edges = 上下左右) → Android の edge-to-edge でも inset を取る。Reanimated 4.7.1 の `withSpring(1, { damping: 10, stiffness: 100 })` は 4 系でも同じ引数 (`restDisplacementThreshold` / `restSpeedThreshold` / `duration` は使っていない)。`babel-preset-expo` 58 が `react-native-worklets/plugin` を自動で入れる |
| S15 | `expo-image-picker` 58 の `ImagePickerOptions.mediaTypes` は `MediaType \| MediaType[]` (`'images'` を含む) → `mediaTypes: ["images"]` で型が通る |
| S16 | `expo-notifications` 58: `setNotificationHandler` / `getLastNotificationResponseAsync` / `clearLastNotificationResponseAsync` / `addNotificationResponseReceivedListener` はいずれも SDK 58 の API 一覧にあり非推奨でない (`shouldShowAlert` だけ非推奨で、使っていない)。前面の通知は handler が返す `shouldShowBanner: true` で出る |
| S17 | Dependabot の PR は `apps/mobile/package.json` の `react-native` を `0.88.1` に、lockfile も変える → `tests/mobile-toolchain-contract.test.ts`: `react-native` の宣言 ≠ `node_modules/expo/bundledNativeModules.json` の `react-native` (`0.88.0`) → 赤 → PR のマージはできず、SDK の更新 (expo も一緒) で上げる |
| S18 | `npx expo install --check` は `bundledNativeModules.json` と `package.json` を突き合わせる → 全部一致 (§6.1 は逐語なので) → `npx expo-doctor@latest` は app.json をスキーマで検査 (SDK 58 のスキーマに `splash` は無い・`assetBundlePatterns` は非推奨) → どちらも消してあるので通る。重複するネイティブモジュールの警告は、入れ子が `react` / `@types/react` (JS) だけなので出ない |

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
| F | RNTL 14 を同時に入れる | expo-router 58 の任意の peer と expo-router/testing-library の要件 (≥ 14) を満たす | `render` / `fireEvent` / `act` が Promise になり 59 ファイルを書き換える。本冊の差分が「ツールチェーン」から「テストの書き方」に広がる | 却下 (別案件) |

### 5.2 「縁の発生源を消すより単純な構造は無いか」

| 縁 | 消せるか | 判断 |
|---|---|---|
| React の二重化 (ルート 19.2.x と モバイル 19.3.0)。`metro.config.js` の `resolveRequest`・jest の `moduleNameMapper`・tsconfig の `paths.react`・ルートの `overrides` がこのために在る | 消すには Web (Next 16.4.1) とモバイル (react-native 0.88.0 のレンダラーが要求する 19.3.0 と完全に同じ版) の `react` をそろえる必要がある。Web の `react` を 19.3.0 の固定にすると、Web の更新がモバイルの SDK に縛られる (逆も)。いまの Next 16.4.1 と React 19.3 の組は未検証 | **消さない**。二重化は残し、固定の仕組み (4 か所) は版だけ更新する。番兵 (§9.6) で「モバイルの `react` = bundledNativeModules の `react` = `react-test-renderer`」を固定し、ずれの発生を止める |
| jest 29 の経路 (`@react-native/jest-preset` の依存) | `overrides` で 30 にそろえれば lockfile から消える (実行時は jest-expo が自分の 30 を使うので挙動は変わらない) | 消す (§6.2) |
| 根の advisory (braces・node-forge) | 上流に修正版が無い。`metro-file-map` と `@expo/cli` を使わない構造は Expo を使わない構造 | 消せない。残ることを合否の外に置き (§10.4)、修正版が出たら Dependabot のパッチ更新で入る |
| `(tabs)` の中の隠しタブ (settings) | `href: null` が 58 で「届かない route」になった。隠しタブという構造そのものを消し、普通の Stack の画面にする | 消す (§7.1 の B-1)。残る縁は `NATIVE_SETTINGS_ROUTE` の値 1 つ |
| 同意画面の「RESET だけ通す」規則 (13b) | ゲートの `reset` が同意画面の route を `key` ごと再利用すれば、同意画面は取り除かれず、RESET を通す規則そのものが要らない | 消す (§7.1 の B-2)。残る縁は「取り除く操作は全部止める / 自分で閉じるときだけ解く」の 1 つ |

### 5.3 確定した構造

§4.1 の 10 点を確定する。以後の周で上げ先の版 (SDK 58) と段分け (A → B → C・1 PR) は蒸し返さない。仕上げ中に出る指摘は、§6〜§15 の表のセルに対して行う。

---

## 6. 上げ先の版 (正典)

### 6.1 `apps/mobile/package.json` (dependencies / devDependencies の全行。逐語)

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
| `typescript ~5.9.3` | ルートと同じ (重複の入れ子を消す)。`expo/tsconfig.base` (58) の `${configDir}` は TypeScript 5.5 以降。Jest 30 の型は 5.4 以降 |
| `@testing-library/react-native ^13.3.3`・`@testing-library/jest-native ^5.4.3`・`@types/jest ^30.0.0`・`resolve-from`・`zod`・`@supabase/supabase-js`・`@homegohan/*`・`lucide-react-native`・`@expo-google-fonts/noto-sans-jp` | 変えない (zod はルートと同じ範囲でないと `tests/zod-single-copy-1444.test.ts` が赤) |
| 消す行 | `@react-native-community/slider` / `react-native-url-polyfill` / `expo-haptics` / `expo-image-manipulator` (§6.3) |

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

| パッケージ | 現行 | 根拠 (grep の語: パッケージ名。母集合: `apps/mobile` と `packages` の `.ts` / `.tsx` / `.js` / `.mjs` / `.yaml`、`package.json` と lockfile を除く) |
|---|---|---|
| `@react-native-community/slider` | 4.5.7 (`apps/mobile/node_modules` に入れ子) | 0 件。Issue #1591 が「SDK 53 の推奨 (4.5.6) より上のパッチ」と確認を求めた行。SDK 58 の推奨は 5.2.1 (メジャー) で、使っていないネイティブモジュールを上げる理由が無い。消すと `expo install --check` の対象から外れる |
| `react-native-url-polyfill` | ^2.0.0 | 0 件 (`react-native-url-polyfill/auto` の import も無い)。入れても読まれていない |
| `expo-haptics` | ~14.1.4 | 0 件。ネイティブモジュールなのでビルドにだけ入っていた |
| `expo-image-manipulator` | ~13.1.7 | 0 件。同上 |

消したあと、`tests/mobile-toolchain-contract.test.ts` (§9.6) が「宣言に戻っていない」ことを見張る (戻すときは import する所と一緒に足し、番兵の一覧から外す)。

### 6.4 Node・Xcode・eas-cli

| 項目 | 要件 | 本冊 |
|---|---|---|
| Node | SDK 58 / react-native 0.88 / metro 0.87: `^22.13.0 \|\| ^24.3.0 \|\| ^26.0.0` (奇数版は不可) | `.nvmrc` `22`・`engines.node "22.x"` は変えない。CI の `actions/setup-node` の `'22'` は 22 系の最新 (22.13 以上)。offload の行き先 (k270) は v22.23.3 (実測)。実装者は段 A で `node -v` を記録し、22.13.0 未満なら止める (§12 の E-1) |
| Xcode | SDK 55 以降は Xcode 26 が最低。SDK 56 以降 26.4。EAS Build のクラウドが用意する | オーナーの手元には不要 (EAS でビルド)。ローカルビルドはしない |
| eas-cli | `eas.json` の `cli.version` を `">= 25.0.0"` に上げる (25.0.0 は SDK 58 公開と同日 2026-10-15 の版) | オーナーは `npm i -g eas-cli@latest` (§16) |
| TypeScript | 5.9.3 (ルートと同じ) | SDK 56 の案内 (テンプレートは 6.0.3) は採らない (`bundledNativeModules.json` に `typescript` は無く、`expo install --check` の対象にならない) |

---

## 7. 壊れる所の全列挙と直し方

各行の「段」は §14.1。「検証」は §10 の番号。SDK 54〜58 の changelog・React Native 0.80〜0.88 の告知・Jest 30 の移行手引き・Reanimated 4 の移行手引きから、本アプリが触れる行だけを抜いた (触れないものは §7.5 に「該当なし」として残す)。

### 7.1 API の廃止・変更 (アプリのコード)

| # | 壊れる所 | 事実 (出典) | 直し方 | 触るファイル | 段 | 検証 |
|---|---|---|---|---|---|---|
| A-1 | `expo-file-system` の既定の export が新しい API (`File` / `Directory`) になり、旧 API は `expo-file-system/legacy` | SDK 54 changelog (expo-file-system 19.0.0「Make the modern filesystem API the default, move previous one to `expo-file-system/legacy`」)。58.0.9 の exports に `./legacy` がある。jest-expo 55.0.7 の mock も `/legacy` を向く | import を `"expo-file-system/legacy"` にする (使う関数は変えない)。テストの `jest.mock('expo-file-system', …)` を `jest.mock('expo-file-system/legacy', …)` にする (mock の中身は変えない) | `app/settings/index.tsx` (段 B で移す前は `app/(tabs)/settings.tsx`)・`src/lib/webViewDownload.ts`・`__tests__/settings/ai-consent-entry.test.tsx`・`profile-row.test.tsx`・`logout.test.tsx`・`__tests__/components/WebViewScreen.error-cleanup-tabs.test.tsx`・`WebViewScreen.download.test.tsx`・`WebViewScreen.legal-consent.test.tsx`・`WebViewScreen.auth-messages.test.tsx`・`WebViewScreen.test.tsx`・`WebViewScreen.bridge.test.tsx`・`__tests__/lib/webViewDownload.test.ts` | A | V-2・V-3・V-7 |
| A-2 | `react-native` の `SafeAreaView` は非推奨 (SDK 54 / RN 0.81)。Android 16 の edge-to-edge が強制 (SDK 54) で、`react-native` の `SafeAreaView` は Android で何もしないので文字が status bar の下に潜る | SDK 54 changelog「React Native `<SafeAreaView>`: Deprecated. Use `react-native-safe-area-context` instead」「Android edge-to-edge: Enabled on all Android apps and cannot be disabled」 | `import { SafeAreaView } from 'react-native'` の行から `SafeAreaView` を外し、`import { SafeAreaView } from 'react-native-safe-area-context'` を足す。`edges` は付けない (既定の上下左右 = `react-native` 版の iOS の挙動と同じ)。style はそのまま | `app/handson-tour/index.tsx`・`app/handson-tour/graduate.tsx`・`src/components/ai/AIAdvisorSheet.tsx` (AIAdvisorSheet を描くテストの `react-native-safe-area-context` の mock 3 つ (`__tests__/ai/service-unavailable.test.tsx`・`advisor-sheet-legal-consent.test.tsx`・`stopped-by-server-raw-fetch.test.tsx`) は `SafeAreaView` を持っているので変えない。handson-tour の index / graduate を描くテストは無い) | A | V-2・V-3・実機 (§16 の M-6) |
| A-3 | `expo-image-picker` の `mediaTypes` は `MediaType \| MediaType[]` (`'images'` …) で型が付く | SDK 52 以降の型。58.0.10 でも同じ | `mediaTypes: ["images"] as any` の `as any` を外す (2 か所)。型が通らなければ `ImagePicker.MediaType` の配列として書く (`["images"] satisfies ImagePicker.MediaType[]`)。`as any` は残さない | `app/health/blood-tests.tsx` (253 行・264 行) | A | V-2 |
| A-4 | `@expo/vector-icons` を `expo` が依存しなくなった | SDK 56 changelog「`expo` no longer depends on `@expo/vector-icons`. If you use it, add it to `package.json` yourself」 | `dependencies` に `"@expo/vector-icons": "^15.0.2"` を足す (§6.1)。コードは変えない。`@react-native-vector-icons/*` への移行 (SDK 56 の非推奨) はしない | `apps/mobile/package.json` | A | V-1・V-2・V-3 |
| A-5 | Reanimated 3 → 4: `react-native-worklets` が別パッケージ。Babel プラグインは `react-native-worklets/plugin` | Reanimated 4 の移行手引き。SDK 54 changelog「Don't edit `babel.config.js` manually, since `babel-preset-expo` handles it」 | `react-native-worklets` を宣言する (§6.1)。`babel.config.js` は変えない。アプリが使う `Animated.View` / `useSharedValue` / `useAnimatedStyle` / `withTiming` / `withSpring` / `withDelay` / `withSequence` / `Easing` は 4 系で同じ (消えたのは `useWorkletCallback` / `useAnimatedGestureHandler` / `combineTransition` / `runOnJS` 等の改名で、どれも使っていない。`withSpring` の `restDisplacementThreshold` / `restSpeedThreshold` / `duration` も使っていない) | `apps/mobile/package.json` (Jest 側は §7.3 の T-4) | A | V-2・V-3・実機 (M-6) |
| A-6 | `expo-notifications` 58: 前面の通知は handler が答えないと既定で表示。`shouldShowAlert` は非推奨 | SDK 58 changelog・SDK 58 の API 一覧 | 変えない (handler は `shouldShowBanner` を返している。使っている関数はすべて SDK 58 の一覧にあり非推奨でない) | – | – | V-2・実機 (M-4) |
| A-7 | `expo-updates` 58: `maxUpdatesToKeep` / `enableBsdiffPatchSupport` (既定 true) が増えた | SDK 56・58 changelog | 変えない (更新は無効のまま。§11) | – | – | V-8 |
| A-8 | React Native 0.87 の Strict TypeScript API が既定 (深い import・`NativeMethods`・`Touchable`・`*Properties` 型が消える。ref の型が `ViewInstance` 等に) | RN 0.87 / 0.88 の告知。SDK 58 changelog「opt-out は 0.88 まで」 | opt-out (`customConditions` に `react-native-legacy-deep-imports`) は使わない。深い import は 0 件なので、V-2 で新しく出た型エラーを個別に直す (ref の型なら `React.ElementRef<typeof X>` を `XInstance` に) | V-2 で出たファイルだけ | A | V-2 |
| A-9 | `expo-router` 58: `useNavigation` が navigator の外で例外。`navigation.dispatch` は commit 後に流れる (`dispatchSync` が即時)。モジュールの `router` は最初の描画の前に例外 | SDK 57→58 の移行手引き | 変えない。`useNavigation` を使う 4 か所 (`app/legal-consent.tsx` (B-2 で外す)・`src/lib/webViewAuthMessages.ts`・`src/components/web/WebViewScreen.tsx`・`useResetInitialPathOnBlur.ts`) はすべて route の中。`router.*` は effect と押下の中だけ | – | – | V-3・実機 (M-1〜M-3) |
| B-1 | `expo-router` 58: JS の Tabs で `href: null` は「タブを隠し、その route を届かない (initial tab へ redirect) にする」 | expo-router 58.0.0 changelog「Make `href: null` hide JS tabs and make their routes unreachable, redirecting navigation to the initial tab」。移行手引きの Tabs の例は「宣言した画面だけを出す」 | 設定の画面を `(tabs)` の外へ移す: `git mv "apps/mobile/app/(tabs)/settings.tsx" apps/mobile/app/settings/index.tsx` (相対 import の深さは同じで変えない)。`(tabs)/_layout.tsx` の `<Tabs.Screen name="settings" options={{ href: null }} />` と前のコメント行を消す。`(tabs)/profile.tsx` の `NATIVE_SETTINGS_ROUTE` を `'/settings'` に。設定の画面はルートの Stack (`headerShown: false`) に積まれ、`AIFloatingFab` と `(tabs)` の ErrorBoundary の外になる (ルートの ErrorBoundary が受ける) | `app/settings/index.tsx` (移設)・`app/(tabs)/_layout.tsx`・`app/(tabs)/profile.tsx` + §15.1 の番兵 11 本 | B | V-3・V-7・実機 (M-2) |
| B-2 | `expo-router` 58: `beforeRemove` は止められない (`usePreventRemove` に)。`CommonActions.reset` は完全な state が要る。`resetRoot` は消えた | expo-router 58.0.0 changelog「Make `beforeRemove` non-preventable and add `removePrevented` event」「Export `usePreventRemove` from `expo-router`」「Require complete state in `CommonActions.reset`」。移行手引き §11「Spread `...state` so keys and route names are preserved」 | 同意画面: `navigation.addListener("beforeRemove", …)` を `usePreventRemove(legalConsentScreenPreventsRemoval(mode, closing), () => {})` に (止めた操作は捨てる。`repeat` は呼ばない)。自分で閉じるとき (`close`) は `setClosing(true)` + 返り値の `disablePrevention()` を呼んでから遷移。ゲート: `navigationRef.getRootState()` から `legal-consent` を `routeNames` に持つ navigator を探し (`findNavigatorOwningRoute`)、その `key` / `type` / `routeNames` を写した完全な state (`legalConsentCollapsedState`) で `reset`。同意画面の route が既にあれば `key` ごと再利用する (同じ key は同じ画面なので取り除かれず、止めにも当たらない)。`legalConsentScreenRemovalDecision` と `RESET_ACTION_TYPE` は消す (§9.4) | `app/legal-consent.tsx`・`src/components/legal/LegalConsentGate.tsx`・`src/lib/legal-consent.ts` + テスト 3 本 (§13.2) | B | V-3・実機 (M-3) |
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
| C-9 | `jest.config.js` の `transformIgnorePatterns` の自前の一覧に `standard-navigation` (expo-router 58 の依存) が無い | jest-expo 58 の既定は `/node_modules/(?!(.pnpm\|react-native\|@react-native\|@react-native-community\|expo\|@expo\|@expo-google-fonts\|react-navigation\|@react-navigation\|@sentry/react-native\|native-base\|standard-navigation))` + `react-native-reanimated/plugin` と `@react-native/babel-preset` の除外。自前の一覧の `react-native-svg` / `@unimodules` / `sentry-expo` は `react-native` の前方一致か、使っていない | `transformIgnorePatterns` の項目を消し、preset の既定に任せる (§9.2)。`moduleNameMapper` / `modulePaths` / `setupFiles` / `setupFilesAfterEnv` / `testTimeout` は変えない (型注釈 `@type {import('jest-expo').JestExpoConfig}` もそのまま) | A | V-3 |
| C-10 | `jest.setup.js` に worklets / Reanimated 4 の Jest の設定が無い | react-native-worklets の Jest の手引き (mock `react-native-worklets/src/mock` を推奨)・Reanimated の Jest の手引き (`setUpTests()`) | `jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'))` と `require('react-native-reanimated').setUpTests()` を足す (§9.3)。`resolver` の差し替え (`react-native-reanimated/jest/resolver`) は使わない (`@react-native/jest-preset` の resolver を外すことになる) | A | V-3 (handson-tour / Confetti / TourOverlay を描くテスト: `__tests__/app/handson-tour-*.test.tsx`・`__tests__/handson-tour/*.test.ts`) |
| C-11 | `jest.env.setup.js` のコメント (root は react@18・Node 20 に WebSocket が無い) | 事実が古い (root は 19.2・Node 22 には `WebSocket` がある。`if (typeof global.WebSocket === 'undefined')` の分岐は無害) | コメントを現在形に (ロジックは変えない。`RNTL_SKIP_DEPS_CHECK=1` も残す) | A | – |
| C-12 | ルート `package.json` の `overrides` | §6.2 | §6.2 のとおり | A | V-1・V-4 |
| C-13 | `.github/dependabot.yml` のコメント「(いまは 19.0.0)」 | 事実が古い | `19.3.0` に (ignore の規則は変えない。`tests/security-workflow.test.ts` は規則だけを見る) | A | V-7 |
| C-14 | `.github/workflows/mobile-test.yml`・`scripts/local-ci.sh` の `stage_mobile` | Jest 30 でも `--ci` / `--coverage` / `--json` / `--outputFile` / `--listTests` は同じ。JSON の `numPassedTests` 等も同じ | 変えない (`tests/local-ci-workflow-sync.test.ts` の対象) | – | V-3 |
| C-15 | Node の版 | §6.4 | `.nvmrc` / `engines` は変えない。段 A の最初に `node -v` を記録 | A | V-0 |

### 7.3 テスト (Jest 29 → 30・jest-expo 58・Reanimated 4・RNTL)

| # | 壊れる所 | 事実 (Jest 30 の移行手引き・changelog) | 直し方 | 段 | 検証 |
|---|---|---|---|---|---|
| T-1 | 別名の matcher (`toBeCalled` / `toBeCalledTimes` / `toBeCalledWith` / `lastCalledWith` / `nthCalledWith` / `toReturn*` / `toThrowError`) が消えた | Jest 30 | 該当なし (0 件。§2.2)。新しく書くテストでも使わない | – | V-3 |
| T-2 | `--testPathPattern` → `--testPathPatterns`。`--init` 削除。値の無いフラグはエラー | Jest 30 | 該当なし (使っていない) | – | V-3 |
| T-3 | `jest.mock` のパスが大文字小文字を区別する。`.mjs` / `.cjs` / `.mts` / `.cts` が既定の `testMatch` に入る | Jest 30 | 該当なし (`__tests__` は `.ts` / `.tsx` だけ。mock のパスは実在の綴り。CI の Linux で既に区別されている) | – | V-3 |
| T-4 | テストの間の未処理の例外・未処理の reject で落ちる (1 ターン待ってから判定)。`expect.objectContaining` と等値で非列挙のプロパティを無視。Error の `cause` が snapshot に出る | Jest 30 | 実行して出た分を直す。直し方の規則: 製品コードが正しいときだけテストを直す。`await` / `catch` を足して reject を処理する。期待を緩めない (`toEqual` を `toMatchObject` に変える等は、非列挙の差が原因のときだけ)。snapshot は使っていない | A | V-3 |
| T-5 | jest-expo 58 の環境は `nativeEnvironment.js` (Jest 30 の `jest-environment-node` を継承)。`jsdom` は 26 | jest-expo 58 の preset | 該当なし (`@jest-environment` の指定は 0 件。すべて native の環境) | – | V-3 |
| T-6 | Reanimated 4 のコンポーネントを描くテストが、worklets のネイティブモジュールを要る | C-10 | C-10 の mock と `setUpTests()`。描くテスト: `__tests__/app/handson-tour-photo-save.test.tsx`・`handson-tour-menu-bubble.test.tsx`・`handson-tour-hard-back-step2-3.test.tsx`・`handson-tour-layout-login.test.tsx`・`__tests__/components/TourBubble.testid.test.tsx` (TourOverlay / Confetti 経由)。mock で足りなければ、Reanimated の手引きの `jest.useFakeTimers()` をそのテストの `beforeEach` に足す (アニメーションの完了を待つ test だけ) | A | V-3 |
| T-7 | `react-test-renderer` が React と違う版 (いま 19.2.5 / 19.0.0) | §6.1 | `19.3.0` の固定で React と一致。`jest.config.js` の `^react-test-renderer$` の固定先 (ルートの `node_modules`) は変えない (ルートに宣言が無いので巻き上がる。lockfile で確かめる §10.1) | A | V-1・V-3 |
| T-8 | `@testing-library/jest-native` 5.4.3 (非推奨) | RNTL 13.3.3 の組み込み matcher で代替できるが、`jest.setup.js` の `extend-expect` を外すと `toHaveTextContent` 等の登録の経路が変わる | 変えない (本冊の範囲外。RNTL 14 の案件で一緒に外す) | – | V-3 |
| T-9 | `expo-file-system` の mock の指定子 | A-1 | A-1 のとおり 10 ファイル | A | V-3 |
| T-10 | 設定の画面の移設に伴うテスト (`import SettingsTab from '../../app/(tabs)/settings'` ×3・`'/(tabs)/settings'` の期待・`href: null` の test・パスの一覧) | B-1 | §13.2 と §15.1 の行のとおり | B | V-3・V-7 |
| T-11 | 同意画面・ゲートのテスト (`beforeRemove` の mock・`reset` の期待) | B-2 | §13.2 のとおり | B | V-3 |

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
| typescript | 5.8.3 (入れ子) → ~5.9.3 (ルートと共有) | minor | tsc | – | V-2 |
| @react-native-community/slider / react-native-url-polyfill / expo-haptics / expo-image-manipulator | 消す | 削除 | 無し (grep 0 件) | §6.3 | V-7 |
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
| npm audit high (全体 / --omit=dev) | 47 / 22 | 記録する (想定 13〜15 / 11〜13)。合否は根の集合 |
| `runtimeVersion` | `ios` / `android` に `"1.0.0"` の直書き | トップレベル `{ "policy": "fingerprint" }` |
| OTA | 無効 (`enabled: false`・`NEVER`) | 同じ (番兵で固定) |
| 設定の画面 | `app/(tabs)/settings.tsx` (隠しタブ・`href: null`)・`router.push('/(tabs)/settings')` | `app/settings/index.tsx` (ルートの Stack)・`router.push('/settings')` |
| 同意画面の止め | `beforeRemove` + `preventDefault` (RESET だけ通す) | `usePreventRemove` (全部止める。自分で閉じるときだけ解く)。ゲートの `reset` は完全な state で、同意画面の route を `key` ごと再利用 |
| `expo-file-system` | 既定の入口 (旧 API) | `/legacy` の入口 (同じ関数) |
| `SafeAreaView` (3 ファイル) | `react-native` (Android で無効) | `react-native-safe-area-context` |
| `as any` (apps/mobile の `app/` `src/`) | 2 件 (`blood-tests.tsx`) | 0 件 |
| `app.json` の `splash` / `assetBundlePatterns` | あり | 無し (`expo-splash-screen` の plugin へ / 削除) |
| `eas.json` の `cli.version` | `>= 12.0.0` | `>= 25.0.0` |
| `jest.config.js` の `transformIgnorePatterns` | 自前の一覧 | preset の既定 |
| `jest.setup.js` | jest-native・RNTL・AsyncStorage・Alert | + worklets の mock・Reanimated の `setUpTests()` |
| 宣言している依存の数 (apps/mobile) | dependencies 36・devDependencies 9 | dependencies 34 (−4 +2: `@expo/vector-icons`・`react-native-worklets`)・devDependencies 10 (+1: `@react-native/jest-preset`) |
| mobile tsc のエラー | 6 件 | 6 件 (同じ file:line。新規 0) |
| Jest のテストファイル | 111 | 111 (移設 0・新規 0。名前の変更は無し) |
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

**(b) 同意画面の route (状態 = `LegalConsentScreenMode` × 自分で閉じる途中か)**

| 状態 | 操作 | 遷移先 | ガード (`usePreventRemove` の第 1 引数) | 副作用 |
|---|---|---|---|---|
| awaiting-consent・閉じていない | 取り除く操作 (GO_BACK / POP / POP_TO_TOP / REPLACE / NAVIGATE / 同意画面を含まない RESET) | 同じ (操作は捨てる) | true | 無し (`repeat` を呼ばない) |
| awaiting-consent | ゲートの `reset` (同意画面の route を `key` ごと再利用) | 同じ画面 (上の route だけ外れる) | 取り除かれないので判定に入らない | WebView は読み込み直さない |
| awaiting-consent | state が `clear` / `unknown` | free | – | ゲートが入口へ (`router.replace('/')`。止めない) |
| awaiting-consent | session 無し (Web の sign-out) | signed-out-notice | – | 案内と「閉じる」 |
| signed-out-notice | 取り除く操作 | 同じ | true | 無し |
| signed-out-notice | 「閉じる」 | 閉じる途中 | – | `closingRef` / `setClosing(true)` / `disablePrevention()` → `back()` か `replace('/')` |
| free | 取り除く操作 | 取り除かれる | false | – |
| 閉じる途中 | 取り除く操作 | 取り除かれる | false (`closing`) | – |

**(c) 設定の画面 (状態 = ルートの Stack)**

| 状態 | 操作 | 遷移先 | ガード | 副作用 |
|---|---|---|---|---|
| [(tabs) (マイページ)] | 歯車 (`router.push('/settings')`) | [(tabs), settings] | session あり (タブの layout の `Redirect` は変わらない) | 設定の画面がルートの Stack に積まれる。`AIFloatingFab` は出ない |
| [(tabs), settings] | 戻る (iOS スワイプ / Android 戻る) | [(tabs)] | – | マイページのタブに戻る |
| [(tabs), settings] | 行 (`/settings/account` / `/health/blood-tests` / `/profile/nutrition-targets` / AI の同意 / `/handson-tour?force=1`) | [(tabs), settings, その画面] | – | 今までと同じ (`router.push`) |
| [(tabs), settings] | ログアウト (`router.replace("/")`) | [入口] | – | 今までと同じ |
| [(tabs), settings] | 通知のタップ (`NotificationRouter`) | 行き先 | `NOTIFICATION_ROUTES` (設定は含まない) | 今までと同じ |

---

## 9. 正典コード

### 9.0 正典の TS の型検査の手順 (設計ゲート用。実装者は読まなくてよい)

`ts` のフェンスのブロックは 1 つずつ独立のモジュールとして `tsc --noEmit --strict` に掛ける (`import` を省かない)。1 行目が `// tsc:skip` のブロック (`tsx` のフェンス) は説明用 (expo-router 58 の型や JSX を含み、origin/main の `node_modules` では検査できない)。JSON / JS のブロックは検査しない。

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
  // transformIgnorePatterns は書かない。jest-expo の既定 (react-native* / @react-native* / expo* / @expo* / @expo-google-fonts /
  // react-navigation / standard-navigation などを変換し、react-native-reanimated/plugin と @react-native/babel-preset は変換しない)
  // に任せる。自前の一覧を持つと、expo-router の新しい依存 (standard-navigation など) が一覧から漏れて SyntaxError になる (#1591)。
  // react 系モジュールを apps/mobile/node_modules から優先解決し、
  // モノレポルートの react (Web 用の 19.2 系) が react-test-renderer 経由で漏れ込むのを防ぐ。
  moduleNameMapper: {
    '^react$': path.join(mobileNodeModules, 'react'),
    '^react/(.*)$': path.join(mobileNodeModules, 'react', '$1'),
    '^react-native$': path.join(worktreeNodeModules, 'react-native'),
    '^react-native/(.*)$': path.join(worktreeNodeModules, 'react-native', '$1'),
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
// (react-native-worklets の Jest の手引き。resolver の差し替えは @react-native/jest-preset の resolver を外すので使わない。#1591)
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

消すもの: `RESET_ACTION_TYPE`・`LegalConsentScreenRemovalDecision` 型・`legalConsentScreenRemovalDecision`。足すもの (次のブロック。型は同じファイルの既存の `LegalConsentScreenMode` を使う。ブロックは独立に検査するため再掲している):

```ts
/** 同意画面の route の扱い (既存の型。src/lib/legal-consent.ts に定義済み) */
export type LegalConsentScreenMode = "awaiting-consent" | "signed-out-notice" | "free";

/**
 * 同意画面の route を取り除く操作を止めるか (expo-router の usePreventRemove の第 1 引数)。
 *   awaiting-consent   同意が要る間は全部止める (ログインの直後の routeAfterSignIn の REPLACE など)。
 *                      ゲートの畳み直し (reset) は同意画面の route を key ごと再利用するので、同意画面は取り除かれず、ここには来ない
 *   signed-out-notice  ログアウトの後の案内。全部止める (「閉じる」でだけ閉じる)
 *   free               何も止めない
 * closing = 同意画面が自分で閉じる途中 (「閉じる」・未ログインで開かれたとき・afterSignOut)。止めない
 */
export function legalConsentScreenPreventsRemoval(mode: LegalConsentScreenMode, closing: boolean): boolean {
  if (closing) return false;
  return mode !== "free";
}

/**
 * ナビゲーターの state のうち、畳むのに読む欄 (expo-router の NavigationState / PartialState の部分型。
 * 入れ子の navigator の state は routes[].state。rehydrate 前の state は stale: true で key を持たないことがある)
 */
export type NavigatorStateLike = {
  readonly key?: string;
  readonly index?: number;
  readonly type?: string;
  readonly routeNames?: string[];
  readonly stale?: boolean;
  readonly routes: ReadonlyArray<{ readonly key?: string; readonly name: string; readonly state?: NavigatorStateLike }>;
};

/** navigationRef.reset に渡す、同意画面 1 つに畳んだ state (完全な state: 持ち主の navigator の key・type・routeNames を写す。stale は持たない) */
export type LegalConsentCollapsedState = {
  key: string;
  index: 0;
  type?: string;
  routeNames?: string[];
  routes: Array<{ name: string; key?: string }>;
};

/**
 * routeNames に routeName を持つ (= その route の持ち主の) navigator の state を、ルートから前面の枝を降りて探す。
 * expo-router 58 の CommonActions.reset は完全な state (key・routeNames を持つ) を求めるので、ゲートはこの持ち主の state から畳む。
 * 持ち主が無い・rehydrate 前 (stale・key 無し) なら null (ゲートは何もせず、次の描画で試す)
 */
export function findNavigatorOwningRoute(
  root: NavigatorStateLike,
  routeName: string,
): (NavigatorStateLike & { key: string }) | null {
  let current: NavigatorStateLike | undefined = root;
  while (current !== undefined) {
    if (current.routeNames?.includes(routeName)) {
      return current.stale === true || current.key === undefined ? null : { ...current, key: current.key };
    }
    const focusedIndex = current.index ?? 0;
    current = current.routes[focusedIndex]?.state;
  }
  return null;
}

/**
 * 持ち主の navigator の state を、同意画面 1 つに畳んだ完全な state にする。
 * 同意画面の route が既にあればその route (key を含む) を再利用する (同じ key は同じ画面。取り除かれず、usePreventRemove の止めにも当たらない)。
 * 無ければ名前だけの route を置く (key は expo-router が付ける)。index: 0 は「最初の route を前面にする」の慣用の値
 */
export function legalConsentCollapsedState(
  owner: NavigatorStateLike & { key: string },
  routeName: string,
): LegalConsentCollapsedState {
  const existing = owner.routes.find((route) => route.name === routeName);
  return {
    key: owner.key,
    index: 0,
    ...(owner.type === undefined ? {} : { type: owner.type }),
    ...(owner.routeNames === undefined ? {} : { routeNames: owner.routeNames }),
    routes: [existing?.key === undefined ? { name: routeName } : { name: routeName, key: existing.key }],
  };
}
```

コメントの直し: 既存の「`@react-navigation の CommonActions.reset`」「`beforeRemove`」の語を、`usePreventRemove` / `navigationRef.reset` の現在形に (設計書 13b の行は §15.2)。

### 9.5 `apps/mobile/app/legal-consent.tsx` の差分 (説明用)

```tsx
// tsc:skip (expo-router 58 の usePreventRemove の型が要る)
import { router, usePreventRemove } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
// … ほかの import は同じ。useNavigation は使わない

export default function LegalConsentScreen() {
  // … session / state / mode の計算は同じ (sawRequiredRef・modeRef も同じ)
  /** この画面が自分で閉じる途中 (「閉じる」・ログアウトに失敗したとき・未ログインで開かれたとき)。ref は effect の同期の判定に、state は hook の引数に使う */
  const closingRef = useRef(false);
  const [closing, setClosing] = useState(false);

  // 取り除く操作 (GO_BACK・POP・POP_TO_TOP・REPLACE・NAVIGATE・同意画面を含まない RESET) を止める。止めた操作は捨てる (repeat は呼ばない)。
  // awaiting-consent で止めた置き換えの行き先は、同意の後に入口が profile から決め直す (cross/13b S1 の (B))
  const disablePrevention = usePreventRemove(legalConsentScreenPreventsRemoval(mode, closing), () => {});

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

### 9.6 `apps/mobile/src/components/legal/LegalConsentGate.tsx` の差分 (説明用)

```tsx
// tsc:skip (expo-router 58 の NavigationContainerRef の型が要る)
import { findNavigatorOwningRoute, legalConsentCollapsedState, LEGAL_CONSENT_SCREEN_ROUTE_NAME } from "../../lib/legal-consent";

// effect の中の、required で畳む 2 か所 (前面が同意画面で openedRef 無し / 前面が同意画面でなく pathname が対象) を次にする:
const owner = findNavigatorOwningRoute(navigationRef.getRootState(), LEGAL_CONSENT_SCREEN_ROUTE_NAME);
if (owner === null) {
  // ルートの Stack がまだ rehydrate されていない。次の描画 (pathname か state が変わる) で試す
  console.warn("[LegalConsentGate] root stack is not ready; retry on next render");
  return;
}
// 58 では reset は commit の後に流れる。同意画面の route が既にあれば key ごと再利用し、取り除かない
navigationRef.reset(legalConsentCollapsedState(owner, LEGAL_CONSENT_SCREEN_ROUTE_NAME));
openedRef.current = true;
closingRef.current = false;
return;
```

`getRootState()` と `reset(state: PartialState<State> | State)` は expo-router 58 の `NavigationContainerRef` にある (`resetRoot` だけが消えた)。`legalConsentCollapsedState` の返り値は `stale` を持たず、`key` / `index` / `type` / `routeNames` / `routes` だけなので `PartialState` に収まる。

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
 *   4. app.json の runtimeVersion は fingerprint の方針 (トップレベルだけ) で、更新は無効のまま
 *      (OTA を使う設計が通ったら、その設計がこの 2 行の期待を書き換える)
 *   5. expo-file-system は /legacy の入口だけを読む (新旧の API を混ぜない)
 *   6. 使っていないので消した依存が、import の無いまま戻っていない
 * 落ちたら: SDK の更新としてまとめて上げる (docs/design/mobile/07-toolchain-upgrade.md §6)。片方だけ上げない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MOBILE_DIR = 'apps/mobile';
const MOBILE_PACKAGE_JSON = `${MOBILE_DIR}/package.json`;
const MOBILE_APP_JSON = `${MOBILE_DIR}/app.json`;
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
const REMOVED_UNUSED = ['@react-native-community/slider', 'react-native-url-polyfill', 'expo-haptics', 'expo-image-manipulator'] as const;
/** アプリのソース (テストと mock を除く) */
const MOBILE_SOURCE_DIRS = [`${MOBILE_DIR}/app`, `${MOBILE_DIR}/src`];
const SOURCE_FILE = /\.(ts|tsx)$/;
const FILE_SYSTEM_IMPORT = /from\s+['"]expo-file-system(\/[^'"]*)?['"]/g;
const FILE_SYSTEM_LEGACY_SUBPATH = '/legacy';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
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
  it('app/ と src/ の import の指定子はすべて expo-file-system/legacy', () => {
    const offenders: string[] = [];
    let imports = 0;
    for (const file of MOBILE_SOURCE_DIRS.flatMap(listSourceFiles)) {
      const text = readText(file);
      const pattern = new RegExp(FILE_SYSTEM_IMPORT.source, 'g');
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

- `as any` を書かない (A-3 で 2 件減る)。
- 版の文字列は `bundledNativeModules.json` の逐語。`^` / `~` を自分で付け替えない (`expo` と `jest` だけ本冊が決めた範囲)。
- `package-lock.json` は手で編集しない。作り直しの手順 (§10.1) だけ。
- 設計正典 (`docs/design/**`・ルート `CLAUDE.md`) は実装レーンが書き換えない (§15.2 は専権 PATCH)。

---

## 10. 検証 (段ごと。合格の数)

実行は offload の行き先 (M2 で直接打たない)。全件は `npx vitest run` ではなくローカル CI の段 (`bash scripts/local-ci.sh --only unit,mobile`) で流し、`mobile:jest` / `mobile:core` / `unit:vitest` の行の GREEN と実数で判定する。

| # | 検査 | コマンド | 合格 | 段 |
|---|---|---|---|---|
| V-0 | Node の版 | `node -v` (offload の行き先) | 22.13.0 以上の 22 系 (k270 は v22.23.3) | A |
| V-1 | lockfile の形 | `npm ci --dry-run` と、lockfile の `packages` を読む `node -e` (§4.2 S1 の一覧) | `npm ci --dry-run` が成功。一覧のとおり (入れ子・巻き上げ・無いもの) | A |
| V-2 | モバイルの型検査 | `npx tsc -p apps/mobile/tsconfig.json --noEmit --pretty false` | エラー 6 件以下で、file:line が §2.2 の 6 件の部分集合 (新しい file:line が 0) | A・B |
| V-3 | モバイルの Jest 全件 | `bash scripts/local-ci.sh --only mobile` の `mobile:jest` | GREEN。収集 111 ファイル (`--listTests`)。failed 0。pending は現行と同じ数 | A・B・C |
| V-4 | npm audit (根の集合) | §9.8 (`npm audit --json` と `--omit=dev --json` の 2 回) | `roots` = braces・node-forge の 2 行。`jestFamily` 空。image-size・postcss 無し | A |
| V-5 | `packages/core` | `mobile:core` の行 | GREEN (変わらない) | A |
| V-6 | Expo の版の突き合わせ | `cd apps/mobile && npx expo install --check` | ずれ 0 件 (「Dependencies are up to date」) | A |
| V-7 | ルートの vitest 全件 (番兵) | `unit:vitest` の行 | GREEN。`tests/react-types-version-contract.test.ts`・`zod-single-copy-1444`・`mobile-easignore-bundle-inputs`・`native-app-tabs-contract`・`mobile-sign-out-doc-callers`・`ai-consent-settings-entry`・`data-share-not-consent`・`jst-today-source-scan`・`ai-daily-limit-mobile-raw-fetch`・`mobile-removed-files-references`・`security-workflow`・`local-ci-workflow-sync` と新設の `mobile-toolchain-contract` が緑 | A・B・C |
| V-8 | `runtimeVersion` の解決 | `cd apps/mobile && npx expo-updates runtimeversion:resolve --platform ios` (ネットワーク不要。`@expo/fingerprint` で計算) | 文字列 (fingerprint のハッシュ) が返り、`1.0.0` でない。PR の本文に写す | A |
| V-9 | expo-doctor | `cd apps/mobile && npx expo-doctor@latest` (ネットワークが要る) | 全項目が通る。通らない項目は、名前・文面・理由を PR の本文に写し (例: Expo Go の SDK 58 が未公開)、設定の誤り (スキーマ・依存の重複) は 0 件 | A |
| V-10 | ローカルの型検査 (ルート) | `unit:vitest` の前に local-ci が流す `tsc` (ルート) | 変わらない (モバイルのファイルはルートの tsconfig の対象外) | A |

段 B の後は V-2・V-3・V-7、段 C の後は V-3・V-7 を流し直す。

### 10.1 lockfile の作り直し (段 A の最初の手順。逐語)

1. `apps/mobile/package.json` を §6.1、ルート `package.json` の `overrides` を §6.2 にして commit (作業ツリーを汚したまま offload に乗せられない)。
2. offload の行き先で `npm install --package-lock-only --ignore-scripts` を流し、`package-lock.json` を持ち帰る (`--fetch package-lock.json`)。ERESOLVE で止まったら、ルート CLAUDE.md の手順: `npm install --package-lock-only --ignore-scripts --legacy-peer-deps` → 続けて `npm install --package-lock-only --ignore-scripts` を 1 回。
3. 持ち帰った lockfile を `node -e` で読み、§4.2 S1 の一覧 (置き場・版・無いもの) を確かめる。ワークスペースの下の入れ子の `zod` が無いこと。
4. commit → V-1〜V-9。

---

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
| E-2 | `npm install --package-lock-only` が ERESOLVE | ルートとモバイルの React の版の違い (既知) | §10.1 の 2 (`--legacy-peer-deps` → 素の 1 回) |
| E-3 | `tests/zod-single-copy-1444.test.ts` が赤 | lockfile の作り直しで `zod` が入れ子になった | `zod` の範囲をルートと同じにしたまま、§10.1 をやり直す。入れ子が残るなら `npm dedupe --package-lock-only` を 1 回 |
| E-4 | `tests/react-types-version-contract.test.ts` が赤 | `@types/react` の置き場・tsconfig の `paths.react` | `apps/mobile/node_modules/@types/react` が 19.3.0 で、tsconfig の `paths.react` が残っていることを確かめる。ルートに巻き上がった (同じ版になった) なら番兵は自動で検査を省く |
| E-5 | Jest が `The React Native Jest preset that jest-expo relies on has moved to a separate package` で止まる | `@react-native/jest-preset` が入っていない | §6.1 の devDependencies を確かめ、lockfile を作り直す |
| E-6 | Jest が `Cannot find module 'react-native-worklets'` / `WorkletsModule` / `[Reanimated]` の例外 | C-10 の mock が効いていない・`babel-preset-expo` の plugin が入っていない | `jest.setup.js` の `jest.mock('react-native-worklets', …)` が `setupFilesAfterEnv` にあること・`react-native-worklets` が lockfile にあること。それでも落ちるテストは T-6 の `jest.useFakeTimers()` |
| E-7 | Jest が `SyntaxError: Cannot use import statement outside a module` (`node_modules/<pkg>`) | `transformIgnorePatterns` の自前の一覧が残っていて、新しい依存 (`standard-navigation` など) を変換していない | C-9 (項目を消す)。消しても出るなら、そのパッケージ名を PR の本文に写し、`jest-expo` の既定に無い理由とともに §17 へ |
| E-8 | テストが「未処理の reject」「テストの間の例外」で落ちる | T-4 (Jest 30 の厳格化) | テストの `await` / `catch` を足す。製品コードの誤りならコードを直す。期待は緩めない |
| E-9 | tsc で `react-native` の型エラーが新しく出る (ref・`NativeMethods`・深い import) | A-8 (Strict TypeScript API) | 当該の行を RN 0.87 の移行手引きの対応に書き換える。opt-out (`customConditions`) は使わない |
| E-10 | `npx expo-doctor` が app.json のスキーマで落ちる (`splash` / `assetBundlePatterns`) | C-2 / C-3 が未反映 | §9.1 のとおりにする |
| E-11 | `npx expo install --check` がずれを報告する | §6.1 と `bundledNativeModules.json` の不一致 (expo の patch が上がった) | 報告された版に合わせ、§6.1 の表との差を PR の本文に写す (設計書の追随は専権) |
| E-12 | `npm audit` に `image-size` か `postcss` が残る | lockfile の作り直しが古い (`@expo/metro-config` の入れ子の postcss・`metro` 0.82) | §10.1 をやり直し、`node_modules/@expo/metro-config/node_modules/postcss` と `node_modules/image-size` が lockfile に無いことを確かめる |
| E-13 | `npm audit` に `jest-haste-map` / `@jest/environment` が残る | §6.2 の overrides が効いていない | `node_modules/@react-native/jest-preset/node_modules/babel-jest` と `jest-environment-node` が lockfile に無いことを確かめる |
| E-14 | EAS のビルドが失敗する (オーナー) | ネイティブ側 (Xcode・scene・R8・autolinking) | §16 の手順でビルドのログを Issue #1115 に写す。本冊の範囲ではコードを変えず、別の Issue にする |

---

## 13. テスト一覧 (it 名)

### 13.1 新設 `tests/mobile-toolchain-contract.test.ts` (§9.7)

- `#1591 apps/mobile の版の組 (bundledNativeModules と同じ)`
  - `react の宣言は expo/bundledNativeModules.json の値と同じ` (react / react-native / react-native-reanimated / react-native-worklets / expo-router / jest-expo の 6 件)
  - `react-test-renderer の宣言は react と同じ版 (レンダラーは React と完全に同じ版でないと動かない)`
  - `package-lock.json: apps/mobile から見た react と react-test-renderer が同じ版で、react-native が宣言と同じ`
  - `jest は 30 系で、jest-expo の必須の peer @react-native/jest-preset は react-native と同じ版`
  - `使っていないので消した @react-native-community/slider が宣言に戻っていない` (4 件)
- `#1591 OTA の設定 (app.json)`
  - `runtimeVersion はトップレベルの { policy: 'fingerprint' } だけ (ios / android の直書きは無い)`
  - `更新は無効のまま (enabled: false・checkAutomatically: NEVER)。OTA を使う設計が通るまで変えない`
- `#1591 expo-file-system は /legacy の入口だけを読む`
  - `app/ と src/ の import の指定子はすべて expo-file-system/legacy`

### 13.2 変える既存のテスト (apps/mobile)

| ファイル | 変更 | 段 |
|---|---|---|
| `__tests__/lib/legal-consent.test.ts` | `legalConsentScreenRemovalDecision (T-ML6)` の describe を消し、`legalConsentScreenPreventsRemoval (T-ML6)` に: `awaiting-consent と signed-out-notice は止める (true)`・`free は止めない`・`closing なら扱いに関わらず止めない`。`findNavigatorOwningRoute / legalConsentCollapsedState (T-ML11)` を足す: `routeNames に legal-consent を持つ navigator を前面の枝で見つける (ルート直下・1 段下)`・`持ち主が無い・stale・key 無しなら null`・`同意画面の route があれば key ごと再利用し、無ければ名前だけ。key・type・routeNames を写し、stale を持たない` | B |
| `__tests__/app/legal-consent-screen.test.tsx` | `expo-router` の mock に `usePreventRemove: (prevent, cb) => { 記録して mockDisablePrevention を返す }` を足し、`useNavigation` の mock と `removeAttempt` を消す。T-SC2 の it 名: `サインイン中で required の間は、usePreventRemove に true を渡す (取り除く操作を全部止める)`・`clear になったら false を渡す`・`beforeRemove の受け手は外れるときに解除する` を消す。T-SC3: `その間は usePreventRemove に true を渡し、押すと disablePrevention を呼んでから router.replace("/") を 1 回呼ぶ (router.canGoBack が false のとき)`・`router.canGoBack が true なら disablePrevention を呼んでから router.back を 1 回呼ぶ`。未ログインで開いた・afterSignOut の it は同じ | B |
| `__tests__/components/legal-consent-gate.test.tsx` | `mockNavigationRef` に `getRootState: () => mockRootState` を足し (`mockRootState` は `{ key: 'root-key', index: 0, type: 'stack', routeNames: ['index', '(tabs)', 'legal-consent', …], routes: [...] }`)、`CONSENT_RESET` を `{ key: 'root-key', index: 0, type: 'stack', routeNames: […], routes: [{ name: 'legal-consent' }] }` に。T-G1 / T-G7 / T-G8 の `reset` の期待をこの形に。足す it: `T-G9: 同意画面の route が既にあれば、その key を再利用した state で reset を呼ぶ`・`T-G10: ルートの Stack が rehydrate 前 (routeNames が無い・stale) なら reset を呼ばず、警告を残す` | B |
| `__tests__/home/tab-layout.test.tsx` | `settings タブは href: null (タブバー非表示)` を `settings は (tabs) の画面に無い (Tabs.Screen の name に 'settings' が無い)` に | B |
| `__tests__/app/profile-tab-settings-entry.test.tsx` | 期待を `'/settings'` に。it 名の `(/(tabs)/settings)` を `(/settings)` に。冒頭のコメントも | B |
| `__tests__/settings/logout.test.tsx`・`profile-row.test.tsx`・`ai-consent-entry.test.tsx` | `import SettingsTab from '../../app/settings/index'`。`jest.mock('expo-file-system/legacy', …)`。describe 名の「設定タブ」は「設定の画面」に (3 ファイル) | A (mock) / B (import) |
| `__tests__/components/WebViewScreen.*.test.tsx` (6 本)・`__tests__/lib/webViewDownload.test.ts` | `jest.mock('expo-file-system/legacy', …)` | A |
| `__tests__/lib/date-basis-jst.test.tsx` | `'app/(tabs)/settings.tsx'` → `'app/settings/index.tsx'` | B |

### 13.3 シナリオとテストの対応

| シナリオ | 直接見るテスト・検査 |
|---|---|
| S1 | V-1 (lockfile の一覧)・`tests/zod-single-copy-1444`・`tests/react-types-version-contract`・`tests/mobile-toolchain-contract` (版の組) |
| S2・S3 | V-3 (`mobile:jest`)・`tests/local-ci-workflow-sync` |
| S4 | V-2 |
| S5 | V-4 |
| S6・S7 | V-8・`tests/mobile-toolchain-contract` (OTA の設定)・§16 の M-0 |
| S8 | `profile-tab-settings-entry`・`tab-layout`・`route-targets-exist` (`/settings` → `app/settings/index.tsx`)・`tests/native-app-tabs-contract`・`tests/mobile-sign-out-doc-callers`・M-2 |
| S9・S10・S11・S12 | `legal-consent.test.ts` (T-ML6・T-ML11)・`legal-consent-screen.test.tsx` (T-SC2・T-SC3)・`legal-consent-gate.test.tsx` (T-G1・T-G7〜T-G10)・M-3 |
| S13 | `webViewDownload.test.ts`・`settings/*.test.tsx`・`tests/mobile-toolchain-contract` (`/legacy`) |
| S14 | `handson-tour-*.test.tsx` (Reanimated 4 で描ける)・M-6 |
| S15 | V-2 (`as any` 無し)・`health/checkup-ocr.test.tsx` |
| S16 | `components/NotificationRouter.test.tsx`・`lib/push-notifications.test.ts`・M-4 |
| S17 | `tests/mobile-toolchain-contract` (版の組) |
| S18 | V-6・V-9 |

---

## 14. 段分け・触るファイルの母集合・新設一覧

### 14.1 段分け (1 本の B 型 WF。段ごとに 2 枚レビュー。マージは段 C の後に 1 回)

| 段 | 内容 | 検証 |
|---|---|---|
| A | 依存と設定: `apps/mobile/package.json` (§6.1)・ルート `package.json` の `overrides` (§6.2)・`package-lock.json` (§10.1)・`app.json` (§9.1)・`eas.json` (C-5)・`jest.config.js` (§9.2)・`jest.setup.js` (§9.3)・`jest.env.setup.js` / `metro.config.js` / `tsconfig.json` / `dependabot.yml` のコメント (C-7・C-8・C-11・C-13)。API の置き換え: A-1 (import 2 + mock 10)・A-2 (3)・A-3 (2)・A-8 (V-2 で出た分)・T-4 (V-3 で出た分) | V-0〜V-10 |
| B | expo-router 58 への追随: B-1 (設定の画面の移設 + テスト 6 本 + ルートの番兵 7 本の行)・B-2 (同意画面・ゲート・`legal-consent.ts` + テスト 3 本) | V-2・V-3・V-7 |
| C | 番兵と README: `tests/mobile-toolchain-contract.test.ts` (§9.7)・`apps/mobile/README.md` の「実機 (Expo Go)」の節に 1 文 (SDK 58 の Expo Go は公開待ち・push 通知は Expo Go で例外になる (SDK 55) ので preview のビルドで確かめる) | V-3・V-7 |

### 14.2 触るファイルの母集合 (閉じた一覧。これ以外を触ったら blocking)

| 段 | ファイル |
|---|---|
| A | `apps/mobile/package.json`・`package.json` (ルート。`overrides` だけ)・`package-lock.json`・`apps/mobile/app.json`・`apps/mobile/eas.json`・`apps/mobile/jest.config.js`・`apps/mobile/jest.setup.js`・`apps/mobile/jest.env.setup.js` (コメント)・`apps/mobile/metro.config.js` (コメント)・`apps/mobile/tsconfig.json` (コメント)・`.github/dependabot.yml` (コメント)・`apps/mobile/app/(tabs)/settings.tsx` (A-1)・`apps/mobile/src/lib/webViewDownload.ts` (A-1)・`apps/mobile/app/handson-tour/index.tsx`・`apps/mobile/app/handson-tour/graduate.tsx`・`apps/mobile/src/components/ai/AIAdvisorSheet.tsx` (A-2)・`apps/mobile/app/health/blood-tests.tsx` (A-3)・A-1 の mock を持つテスト 10 本 (§7.1)・A-8 / T-4 で V-2 / V-3 が指したファイル (PR の本文に列挙) |
| B | `apps/mobile/app/(tabs)/settings.tsx` → `apps/mobile/app/settings/index.tsx` (git mv)・`apps/mobile/app/(tabs)/_layout.tsx`・`apps/mobile/app/(tabs)/profile.tsx`・`apps/mobile/app/legal-consent.tsx`・`apps/mobile/src/components/legal/LegalConsentGate.tsx`・`apps/mobile/src/lib/legal-consent.ts`・`apps/mobile/__tests__/lib/legal-consent.test.ts`・`apps/mobile/__tests__/app/legal-consent-screen.test.tsx`・`apps/mobile/__tests__/components/legal-consent-gate.test.tsx`・`apps/mobile/__tests__/home/tab-layout.test.tsx`・`apps/mobile/__tests__/app/profile-tab-settings-entry.test.tsx`・`apps/mobile/__tests__/settings/logout.test.tsx`・`profile-row.test.tsx`・`ai-consent-entry.test.tsx`・`apps/mobile/__tests__/lib/date-basis-jst.test.tsx`・`tests/mobile-sign-out-doc-callers.test.ts`・`tests/ai-daily-limit-mobile-raw-fetch.test.ts`・`tests/data-share-not-consent.test.ts`・`tests/ai-consent-settings-entry.test.ts`・`tests/jst-today-source-scan.test.ts` (§15.1 の行) |
| C | `tests/mobile-toolchain-contract.test.ts` (新規)・`apps/mobile/README.md` |
| 触らない | `apps/mobile/babel.config.js`・`.github/workflows/*.yml`・`scripts/local-ci.sh`・`.easignore`・`apps/mobile/maestro/**`・`packages/**`・`src/**` (Web)・`docs/design/**` と ルート `CLAUDE.md` (§15.2 の専権 PATCH)・`supabase/**` |

### 14.3 新設一覧 (識別子)

| 種類 | 名前 | 場所 |
|---|---|---|
| ファイル (移設) | `apps/mobile/app/settings/index.tsx` (旧 `app/(tabs)/settings.tsx`) | B-1 |
| ファイル (新規) | `tests/mobile-toolchain-contract.test.ts` | §9.7 |
| 関数 | `legalConsentScreenPreventsRemoval(mode, closing): boolean` | `apps/mobile/src/lib/legal-consent.ts` (§9.4) |
| 関数 | `findNavigatorOwningRoute(root, routeName)` | 同上 |
| 関数 | `legalConsentCollapsedState(owner, routeName): LegalConsentCollapsedState` | 同上 |
| 型 | `NavigatorStateLike`・`LegalConsentCollapsedState` | 同上 |
| 消す識別子 | `RESET_ACTION_TYPE`・`LegalConsentScreenRemovalDecision`・`legalConsentScreenRemovalDecision` | 同上 |
| 定数の値 | `NATIVE_SETTINGS_ROUTE = '/settings'` (旧 `'/(tabs)/settings'`) | `apps/mobile/app/(tabs)/profile.tsx` |
| 設定 | `expo.runtimeVersion = { policy: 'fingerprint' }`・`plugins` の `expo-splash-screen` | `apps/mobile/app.json` |
| 設定 | `overrides["@react-native/jest-preset"]` | ルート `package.json` |
| 依存 (新規) | `@expo/vector-icons`・`react-native-worklets`・`@react-native/jest-preset` | `apps/mobile/package.json` |
| 依存 (削除) | `@react-native-community/slider`・`react-native-url-polyfill`・`expo-haptics`・`expo-image-manipulator` | 同上 |
| テストの定数 | `JEST_MAJOR`・`RUNTIME_VERSION_POLICY`・`BUNDLED_PINNED`・`REMOVED_UNUSED` | `tests/mobile-toolchain-contract.test.ts` |

---

## 15. 追随表

### 15.1 既存の番兵 (契約テスト・走査テスト) の追随

grep の語で tests/ scripts/ を引いた結果 (origin/main 904f9e8f)。「反応」は本冊の変更に反応する番兵、「直し方」は実装の段。

| 番兵 | grep の語 | 反応 | 直し方 | 段 |
|---|---|---|---|---|
| `tests/react-types-version-contract.test.ts` | `apps/mobile/package.json`・`@types/react`・`paths` | `@types/react` のメジャー (19) と入れ子・tsconfig の固定 | 変えない。§6.1 の `~19.3.0` と `paths.react` の維持で緑。ルートと同じ版になったら自動で省く | A |
| `tests/zod-single-copy-1444.test.ts` | `zod`・`package-lock.json` | lockfile の作り直し | 変えない。E-3 | A |
| `tests/mobile-easignore-bundle-inputs.test.ts` | `apps/mobile/app`・`apps/mobile/src`・`.easignore` | import の推移 (A-1 の `/legacy` は外部のパッケージ) | 変えない | A |
| `tests/native-app-tabs-contract.test.ts` | `apps/mobile/app/(tabs)` | `(tabs)` の画面の一覧 (settings は `WebViewScreen` を出さないので表に無い) | 変えない (移設で `(tabs)` の下から消えても表と一致) | B |
| `tests/mobile-sign-out-doc-callers.test.ts` | `(tabs)/settings.tsx` | `CALLER_SCREENS` の設定画面のファイル | `file` を `${MOBILE_APP_DIR}/settings/index.tsx` に。冒頭のコメントも | B |
| `tests/ai-daily-limit-mobile-raw-fetch.test.ts` | `app/(tabs)/settings.tsx::handleExportJson` / `::handleExportCsv` | 生の fetch の分類の表のキー (4 か所) | キーを `app/settings/index.tsx::handleExportJson` / `::handleExportCsv` に | B |
| `tests/data-share-not-consent.test.ts` | `apps/mobile/app/(tabs)/settings.tsx` | 期待のパス (156 行) | `apps/mobile/app/settings/index.tsx` に | B |
| `tests/ai-consent-settings-entry.test.ts` | `apps/mobile/app/(tabs)/settings.tsx` | 読むファイル (123 行) | `apps/mobile/app/settings/index.tsx` に | B |
| `tests/jst-today-source-scan.test.ts` | `apps/mobile/app/(tabs)/settings.tsx` | 走査の表 (631 行・724 行) | `apps/mobile/app/settings/index.tsx` に | B |
| `tests/mobile-removed-files-references.test.ts` | `apps/mobile/<パス>`・タブの title | 消したファイルの名指し・タブの名前 | 変えない (移設した設定は #1598 の消したものの一覧に無い。タブの title は変わらない) | B |
| `tests/design-doc-removed-mobile-screens.test.ts` | `docs/design/**`・`(tabs)/settings.tsx` | 設計書の中の消した画面の名指し (257 行は `(tabs)/settings.tsx` が「消した画面でない」ことの検査) | 変えない (本冊は消した画面を名指ししない) | – |
| `tests/design-doc-push-paths-resolve.test.ts` | `docs/design/mobile/*push*.md` | Push の設計書だけ | 変えない (本冊のファイル名は対象外) | – |
| `tests/security-workflow.test.ts` | `.github/dependabot.yml` の `ignore` | 規則の有無 | 変えない (C-13 はコメントだけ) | A |
| `tests/local-ci-workflow-sync.test.ts` | `mobile-test.yml`・`stage_mobile` | yml と sh の同期 | 変えない (どちらも触らない) | – |
| `tests/types-supabase-local-1631.test.ts` | `apps/mobile/package.json` の `scripts` | `gen types` の有無 | 変えない (scripts は同じ) | A |
| `tests/posthog-not-adopted-contract.test.ts` | `apps/mobile/package.json` | posthog の依存が無い | 変えない | A |
| `apps/mobile/__tests__/app/route-targets-exist.test.ts` | `app/` の画面と `router.push` の行き先 | `/settings` → `app/settings/index.tsx` | 変えない (移設先が index で解決する) | B |
| `apps/mobile/__tests__/theme/font-family-guard.test.ts` | `app.json` の `plugins` | `expo-font` の plugin が無い (配列の要素 `[name, opts]` も読む) | 変えない (`expo-splash-screen` の要素が増えるだけ) | A |
| `apps/mobile/__tests__/app/error-boundaries.test.tsx` | `app/**/_layout.tsx` の `ErrorBoundary` | layout の一覧 | 変えない (layout は増減しない) | B |
| `apps/mobile/__tests__/lib/env-example.test.ts`・`jest-timeouts.test.ts` | `env.example`・`jest.timeouts.js` | – | 変えない | – |

### 15.2 他の文書への追随 (専権 PATCH。本冊の設計ゲート PASS 後、実装のマージと同じ PR か直後。実装レーンは触らない)

| 文書 | 行・節 | 直し方 |
|---|---|---|
| `docs/design/mobile/CLAUDE.md` | ファイル一覧の表 | `07-toolchain-upgrade.md` の行を足す: 「ツールチェーンの更新 (Expo SDK 58 / RN 0.88 / Jest 30)・`runtimeVersion` の方針・設定の画面の置き場・同意画面の止め (`usePreventRemove`)」・要件参照 `#1591` |
| 同上 | 「React Native + Expo SDK 53 によるモバイルアプリ」(ドメインの役割) と図の「(React Native + Expo SDK 53)」 | `SDK 58` に |
| 同上 | 「`(tabs)/settings.tsx` に通知種別 on/off UI 追加」(既存実装との関連) | `settings/index.tsx` に |
| `docs/design/mobile/01-architecture.md` | §1「Expo SDK 53」・§3.1 の表「React Native (Expo SDK 53)」「Expo Router v4」 | `SDK 58`・`Expo Router 58` に (v4 はもとから 5.1 の誤記) |
| 同上 | §3.2 の表「設定画面 \| `app/(tabs)/settings.tsx`」と「設定画面はタブバーに出さない (`app/(tabs)/_layout.tsx` の `href: null`)」 | 「`app/settings/index.tsx` (ルートの Stack の画面。タブバーには無い)」に。expo-router 58 で `href: null` が「届かない route」になったことを 1 文 |
| 同上 | §7.1 の app.json の抜粋 | `runtimeVersion: { policy: 'fingerprint' }` と `plugins` の `expo-splash-screen` を足す |
| 同上 | §13 の「OTA Update (expo-updates) \| 低 \| `enabled: false` のまま。大型変更時に検討」 | 「`enabled: false` のまま。`runtimeVersion` は fingerprint (mobile/07 §11)。番兵 `tests/mobile-toolchain-contract.test.ts`」に |
| `docs/design/cross/13b-legal-consent-mobile.md` | §0.3 の表の `beforeRemove` の行 (77 行付近)・`reset` の行 (74 行付近)・§6.6.8 / 6.6.11 (339・366・419〜430 行付近の「RESET だけ通す」の規則)・232〜233 行のファイルの説明・461・641〜688 行の `legal-consent.ts` の抜粋・808〜846 行の `LegalConsentGate.tsx` の抜粋 | expo-router 58 の形に (本冊 §7.1 の B-2・§8.3 (b)・§9.4〜9.6): 「`beforeRemove` で止める」→「`usePreventRemove` で止める (全部)」、「RESET だけ通す」→「ゲートの `reset` は同意画面の route を key ごと再利用するので同意画面を取り除かない」、「`reset` は `routingQueue` を通らずその場で届く」→「58 では commit の後に流れる」、`navigationRef.reset({ index: 0, routes: [...] })` → `legalConsentCollapsedState(...)`。§0.3 の node_modules の行番号 (7.17.2) は当時の記録として残し、冒頭に「expo-router 5 (SDK 53) 時点の事実。58 は mobile/07」と 1 文 |
| `docs/design/cross/16-auth-history-sessions.md` | 1862・1990・2050・2082・2128 行付近の `app/(tabs)/settings.tsx` / `(tabs)/settings.tsx` (5 か所) | `app/settings/index.tsx` に |
| ルート `CLAUDE.md` | 198 行付近「モバイルの `apps/mobile` は Expo 53 + React 19.0 で … (モバイルの更新は #1591)」 | 「Expo 58 + React 19.3 (#1591 で 53 から上げた)」に |
| 同上 | 207 行付近「モバイルは自前の `@types/react ~19.0.10` を …」 | `~19.3.0` に |
| 同上 | 45 行付近 (npm audit の説明) | 変えない (critical で止める運用は同じ。high の残りの経緯は本冊 §2.3 と Issue #1591 が持つ) |
| `docs/design/mobile/05-auth-session.md` | 設定画面の `signOutOnDevice` (ファイル名は無い) | 変えない |
| `.github/dependabot.yml` | コメント「(いまは 19.0.0)」 | 実装の段 A で直す (C-13。専権ではない) |

### 15.3 共有面の台帳 (2 つ以上の PR が触る面)

| 面 | 本冊 | 並行しうる案件 | 直列化 |
|---|---|---|---|
| `package-lock.json` | 作り直す (§10.1) | Web の依存の更新 (Dependabot の minor/patch のまとめ・`@supabase/*`) | 本冊のマージの前に main の lockfile を取り込んで §10.1 をやり直す (衝突の手解消はしない) |
| ルート `package.json` の `overrides` | 2 つ足す | Web の `overrides` を足す案件 | 同上 |
| `apps/mobile/app/(tabs)/_layout.tsx`・`profile.tsx` | B-1 | cross/16 の段 B (設定の画面に「ログイン中の端末」の行)・mobile の画面の案件 | cross/16 の段 B は本冊の後 (§15.2 の行で `settings/index.tsx` を指す) |
| `apps/mobile/app/legal-consent.tsx`・`LegalConsentGate.tsx`・`legal-consent.ts` | B-2 | 13b の後続 | 本冊が先 |

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
| M-2 | マイページの歯車 → 設定 → 戻る。設定 → アカウント → 戻る | 設定が開き、戻るとマイページ。タブバーは設定の画面では出ない | B-1 |
| M-3 | 同意が要るアカウントでログイン (#1442 の 5 項目: 同意画面 1 枚・ほかの戻る操作が止まる・iOS はスワイプで戻れず Android の戻るは OS へ・同意の後は入口から振り分け・「同意しない」の後の案内と「閉じる」) | #1115 のコメントの期待どおり | B-2 |
| M-4 | Push 通知 (前面で受ける・タップで行き先へ) | 前面でバナーが出る。タップで行き先の画面 | A-6 (#1722 の前提の `EXPO_ACCESS_TOKEN` 等は #1115) |
| M-5 | deep link (`homegohan://…`) をアプリ未起動で開く | 行き先の画面が開く | N-2 (scene の URL の受け渡し) |
| M-6 | ハンズオンツアーの最初・卒業の画面と AI のシートを Android 16 の端末で | 文字が status bar / ナビゲーションバーの下に潜らない。バッジのアニメーションが動く | A-2・A-5・N-1 |
| M-7 | スプラッシュ (iOS / Android) | iOS は今までと同じ全画面の画像。Android 12 以降は中央の画像 + 背景色 `#FFF7ED` (小さければ §17 の 4) | C-2 |
| M-8 | Android の apk (preview) で全体のスモーク | R8 で壊れていない (クラッシュ・空の画面が無い) | N-1 |

---

## 17. 未解決事項 (openQuestions)

1. **braces・node-forge の修正版**: 2026-10-17 時点で無い。Dependabot のパッチ更新で入る (`braces` は `micromatch` 経由、`node-forge` は `@expo/cli` 経由で `^` の範囲)。上流が修正版を出すまで high として残る。CI の `npm audit` は critical でしか止めないので運用に影響しない。
2. **RNTL 14 への移行**: expo-router 58 は `@testing-library/react-native >= 14` を任意の peer に、`expo-router/testing-library` は必須にする。本冊は 13.3.3 のままで `expo-router/testing-library` を使わない。59 ファイルの書き換えは別案件 (起票はオーケストレーター)。
3. **`react-native-web` と `expo start --web`**: `react-dom` を宣言していないので、ルートの `react-dom` (19.2.x) と `react` (19.3.0) が合わず、Web の起動は以前から保証していない。README の「C) Expo Web で確認 (補助)」は残すか消すか (本冊は触らない)。
4. **Android のスプラッシュの画像**: `expo-splash-screen` の plugin は Android 12 以降で中央の画像 (`imageWidth` の既定 100) を使う。2000×2000 のワードマーク (`splash-ios.png`) を縮めると小さい。専用の画像 (アイコンの寸法) を用意するかはオーナーの判断 (M-7 の見え方で決める)。
5. **`expo-doctor` の通らない項目**: Expo Go (SDK 58) が未公開の間、Expo Go に関する項目が警告になる可能性がある。V-9 で文面を写して判断する。
6. **中継された発言**: 本設計のレーンに「その選択式の質問、今聞いて」という発言が中継されたが、設計のレーンは質問を出す手段を持たない。オーケストレーターが当該の選択式の質問 (本冊では、上の 2〜4 と「上げ先を最新の SDK 58 にすること (SDK 57 は jest 系の high が残る)」) を出す。
7. **`@react-native/jest-preset` の overrides**: `babel-jest` / `jest-environment-node` を 30 にしても `npm install` が別の入れ子を作る (peer の解決の都合) 場合は、E-13 の確認で分かる。その場合は overrides を外し、残る 2 経路 (dev のみ) を PR の本文に写して §2.3 の表に足す (専権)。
8. **同意画面の `reset` の実機の挙動**: 完全な state での `reset` と `usePreventRemove` の組は、単体テストでは mock 越しにしか見えない。M-3 (#1442 の 5 項目) が実機の確認で、落ちた場合は 13b と本冊の両方を見直す (構造の裁定への差し戻し事由)。

---

## 改定履歴

| 版 | 日付 | 変更 |
|---|---|---|
| v1.0 | 2026-10-17 | 初版 (A 型・4 相。origin/main 904f9e8f の事実・npm registry と Expo / React Native / Jest / Reanimated の公式の文書から) |
