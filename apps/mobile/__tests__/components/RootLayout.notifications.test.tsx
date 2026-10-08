/**
 * RootLayout.notifications.test.tsx
 * app/_layout.tsx が通知まわりを配線していることのテスト (#1049 F7-11)
 *
 *  - アプリ起動時 (モジュール読み込み時) に、フォアグラウンド通知の設定 (setupNotificationHandler) を 1 回呼ぶ
 *  - 通知タップで遷移する NotificationRouter を、各 Provider の内側に置く
 */

import React from 'react';
import { render } from '@testing-library/react-native';

const mockSetupNotificationHandler = jest.fn();

jest.mock('../../src/lib/pushNotifications', () => ({
  registerAndSaveExpoPushToken: jest.fn().mockResolvedValue(null),
  setupNotificationHandler: (...args: unknown[]) => mockSetupNotificationHandler(...args),
}));

jest.mock('../../src/components/NotificationRouter', () => ({
  NotificationRouter: () => {
    const { View } = require('react-native');
    return <View testID="notification-router" />;
  },
}));

jest.mock('@expo-google-fonts/noto-sans-jp', () => ({
  NotoSansJP_400Regular: 1,
  NotoSansJP_500Medium: 2,
  NotoSansJP_700Bold: 3,
  useFonts: () => [true],
}));

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn().mockResolvedValue(undefined),
  hideAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-router', () => {
  const { View } = require('react-native');
  function Stack({ children }: { children?: React.ReactNode }) {
    return <View>{children}</View>;
  }
  Stack.Screen = function StackScreen() {
    return null;
  };
  return { Stack };
});

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Provider は中身に依存しないので素通しにする (NotificationRouter が内側にあることは、登録順でなく描画で確かめる)
jest.mock('../../src/providers/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => {
    const { View } = require('react-native');
    return <View testID="auth-provider">{children}</View>;
  },
  useAuth: () => ({ user: null, session: null, isLoading: false }),
}));
jest.mock('../../src/providers/ProfileProvider', () => ({
  ProfileProvider: ({ children }: { children: React.ReactNode }) => {
    const { View } = require('react-native');
    return <View testID="profile-provider">{children}</View>;
  },
}));
jest.mock('../../src/providers/PostHogProvider', () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RootLayout = require('../../app/_layout').default;

describe('RootLayout — 通知の配線', () => {
  it('起動時 (モジュール読み込み時) にフォアグラウンド通知の設定を 1 回呼ぶ', () => {
    expect(mockSetupNotificationHandler).toHaveBeenCalledTimes(1);

    // 再描画しても、設定を呼び直さない
    const view = render(<RootLayout />);
    view.rerender(<RootLayout />);
    expect(mockSetupNotificationHandler).toHaveBeenCalledTimes(1);
  });

  it('NotificationRouter が、認証とプロフィールの Provider の内側にある', () => {
    const { getByTestId } = render(<RootLayout />);

    const router = getByTestId('notification-router');
    // 祖先に ProfileProvider → AuthProvider が並んでいる (useAuth / useProfile が使える)
    let node = router.parent;
    const ancestors: string[] = [];
    while (node) {
      const id = node.props?.testID;
      if (id) ancestors.push(id);
      node = node.parent;
    }
    expect(ancestors).toEqual(expect.arrayContaining(['profile-provider', 'auth-provider']));
    expect(ancestors.indexOf('profile-provider')).toBeLessThan(ancestors.indexOf('auth-provider'));
  });
});
