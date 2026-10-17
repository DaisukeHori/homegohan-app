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
