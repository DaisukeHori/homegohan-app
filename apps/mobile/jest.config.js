const path = require('path');

// test-auth worktree has no local node_modules; reuse mobile-test-infra's installs.
// __dirname = /Users/horidaisuke/homegohan/.claude/worktrees/test-auth/apps/mobile
// mobile-test-infra is a sibling worktree under .claude/worktrees/
const MOBILE_TEST_INFRA = '/Users/horidaisuke/homegohan/.claude/worktrees/mobile-test-infra/apps/mobile';
const mobileNodeModules = path.resolve(MOBILE_TEST_INFRA, 'node_modules');
const worktreeNodeModules = path.resolve(MOBILE_TEST_INFRA, '../../node_modules');

/** @type {import('jest-expo').JestExpoConfig} */
module.exports = {
  // Point preset to the absolute path where jest-expo is installed
  preset: path.join(worktreeNodeModules, 'jest-expo'),
  // resolve all modules from mobile-test-infra's node_modules
  modulePaths: [mobileNodeModules, worktreeNodeModules],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg))',
  ],
  // Force all react-related modules to resolve from apps/mobile/node_modules
  // This prevents the monorepo root react@18 from leaking in via react-test-renderer.
  moduleNameMapper: {
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
