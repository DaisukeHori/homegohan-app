const path = require('path');

// __dirname = <repo-root>/apps/mobile
// モノレポルートの node_modules を基準に解決する。
// worktree の絶対パスには依存しない。
const repoRoot = path.resolve(__dirname, '../..');
const worktreeNodeModules = path.join(repoRoot, 'node_modules');
const mobileNodeModules = path.join(__dirname, 'node_modules');
const packagesDir = path.join(repoRoot, 'packages');

/** @type {import('jest-expo').JestExpoConfig} */
module.exports = {
  preset: 'jest-expo',
  modulePaths: [mobileNodeModules, worktreeNodeModules],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg))',
  ],
  // react 系モジュールを apps/mobile/node_modules から優先解決し、
  // モノレポルートの react@18 が react-test-renderer 経由で漏れ込むのを防ぐ。
  // @homegohan/* は tsconfig の paths 設定が <rootDir>/../../... を展開するとき
  // jest が .. を解釈しないため絶対パスで上書きする。
  moduleNameMapper: {
    '^@homegohan/handson-tour-shared$': path.join(packagesDir, 'handson-tour-shared', 'src', 'index.ts'),
    '^@homegohan/handson-tour-shared/(.*)$': path.join(packagesDir, 'handson-tour-shared', 'src', '$1'),
    '^@homegohan/shared$': path.join(packagesDir, 'shared', 'src', 'index.ts'),
    '^@homegohan/shared/(.*)$': path.join(packagesDir, 'shared', 'src', '$1'),
    '^react$': path.join(mobileNodeModules, 'react'),
    '^react/(.*)$': path.join(mobileNodeModules, 'react', '$1'),
    '^react-native$': path.join(worktreeNodeModules, 'react-native'),
    '^react-native/(.*)$': path.join(worktreeNodeModules, 'react-native', '$1'),
    '^react-test-renderer$': path.join(worktreeNodeModules, 'react-test-renderer'),
    '^react-test-renderer/(.*)$': path.join(worktreeNodeModules, 'react-test-renderer', '$1'),
  },
  setupFiles: [
    '<rootDir>/jest.env.setup.js',
  ],
  setupFilesAfterEnv: [
    '<rootDir>/jest.setup.js',
  ],
};
