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
    // lucide-react-native は 1.57 から package.json の exports に "react-native" の条件を持ち、ESM の .mjs を指す。
    // jest-expo は "react-native" の条件で解決するため .mjs を読むが、変換の対象は \.[jt]sx?$ だけで .mjs は変換されず、
    // 「Must use import to load ES Module」で落ちる (#1902・Dependabot #1900 の CI の赤)。
    // 1.14 までと同じく CommonJS の版 (exports の "require" の条件) を読ませる。node の require.resolve は
    // "require" の条件で解決するので、置き場所 (apps/mobile とルートのどちらに入るか) に依らない。
    // アプリ本体 (Metro) は sourceExts に mjs を持ち、"react-native" の条件で ESM の版を読んで変換する。
    '^lucide-react-native$': require.resolve('lucide-react-native', { paths: [__dirname] }),
  },
  setupFiles: [
    '<rootDir>/jest.env.setup.js',
  ],
  setupFilesAfterEnv: [
    '<rootDir>/jest.setup.js',
  ],
};
