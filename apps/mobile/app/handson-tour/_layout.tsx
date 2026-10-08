// handson-tour/_layout.tsx
// Canonical: docs/design/family/09-onboarding-handson-tour/16-files-structure.md §1.3 §1.3.3
// TourProvider でラップ + 認証ガード + status 確認

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { useAuth } from '../../src/providers/AuthProvider';
import { TourProvider } from '../../src/contexts/TourContext';
import { getApi } from '../../src/lib/api';

export default function HandsonTourLayout() {
  const { session, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ force?: string }>();
  const entrySource: 'auto' | 'settings_force' =
    params.force === '1' ? 'settings_force' : 'auto';

  const [statusChecked, setStatusChecked] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;

    // 未認証ならログイン画面へ。
    // 以前は存在しないルート '/(auth)/sign-in' へ replace していて、未ログインでツアーに入ると
    // 「Unmatched Route」になっていた (#1049 F7-14)。ログイン画面の実体は app/(auth)/login.tsx で、
    // 他のレイアウト ((org) / (admin) / onboarding など) も同じ '/login' を使う。
    if (!session) {
      router.replace('/login' as never);
      return;
    }

    // ツアー表示 status を確認
    const checkStatus = async () => {
      try {
        const api = getApi();
        const res = await api.get<{ should_show: boolean }>('/api/handson-tour/status');
        const shouldShow = res.should_show;

        // force=1 のときは should_show に関わらず表示
        if (!shouldShow && entrySource !== 'settings_force') {
          router.replace('/home' as never);
          return;
        }
      } catch {
        // API エラー → ツアーを表示 (フォールバック)
      } finally {
        setStatusLoading(false);
        setStatusChecked(true);
      }
    };

    void checkStatus();
  }, [authLoading, session, entrySource]);

  if (authLoading || statusLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color="#2563EB" />
      </View>
    );
  }

  if (!statusChecked) return null;

  return (
    <TourProvider initialEntrySource={entrySource}>
      <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="photo" />
        <Stack.Screen name="menu" />
        <Stack.Screen name="badges" />
        <Stack.Screen name="graduate" />
      </Stack>
    </TourProvider>
  );
}
