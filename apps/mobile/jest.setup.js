import '@testing-library/jest-native/extend-expect';

// Mock AsyncStorage globally for all tests
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// Globally spy on Alert.alert so tests can assert on it.
// react-native's jest/setup.js mocks NativeModules.AlertManager.alertWithArgs
// but Alert.alert itself may bypass the bridge in newer RN versions.
// We patch it here at setup time after all modules are initialized.
jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});
