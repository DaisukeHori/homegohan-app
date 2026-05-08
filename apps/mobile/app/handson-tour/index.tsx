// handson-tour/index.tsx — Step 0 ウェルカム画面
// Canonical: docs/design/family/09-onboarding-handson-tour/02-step0-welcome.md

import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import {
  HANDSON_TOUR_I18N_JA,
  HANDSON_TOUR_ROUTES,
  personalize,
} from '@homegohan/handson-tour-shared';
import { useProfile } from '../../src/providers/ProfileProvider';
import { TourProgress } from '../../src/handson-tour/TourProgress';
import { useReducedMotion } from '../../src/handson-tour/useReducedMotion';
import { getApi } from '../../src/lib/api';

const i18n = HANDSON_TOUR_I18N_JA.tour;

function safeNickname(raw: string | null | undefined): string {
  if (!raw) return 'あなた';
  const trimmed = raw.trim();
  if (!trimmed) return 'あなた';
  if (trimmed.length > 30) return `${trimmed.slice(0, 30)}…`;
  return trimmed;
}

export default function HandsonTourWelcome() {
  const router = useRouter();
  const { profile } = useProfile();
  const reducedMotion = useReducedMotion();
  const nickname = safeNickname(profile?.nickname);

  const [isTransitioning, setIsTransitioning] = useState(false);
  const mountTimeRef = useRef(Date.now());

  // Entrance アニメーション
  const opacity = useSharedValue(0);
  const scale = useSharedValue(reducedMotion ? 1 : 0.95);

  useEffect(() => {
    const duration = reducedMotion ? 100 : 300;
    opacity.value = withTiming(1, { duration, easing: Easing.out(Easing.ease) });
    if (!reducedMotion) {
      scale.value = withTiming(1, { duration, easing: Easing.out(Easing.ease) });
    }
  }, []);

  // VoiceOver アナウンス
  useEffect(() => {
    const msg = personalize(i18n.step0.a11y_title, { nickname });
    AccessibilityInfo.announceForAccessibility(
      `${msg}。${i18n.step0.subtitle}`
    );
  }, [nickname]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  const handleStart = () => {
    if (isTransitioning) return;
    setIsTransitioning(true);
    router.push(HANDSON_TOUR_ROUTES.step1 as never);
  };

  const handleSkip = async () => {
    if (isTransitioning) return;
    setIsTransitioning(true);

    try {
      await getApi().post('/api/handson-tour/skip', {
        step: 0,
        reason: 'user_action',
      });
    } catch {
      // エラー無視、遷移は継続
    }

    router.replace('/home' as never);
  };

  return (
    <View
      style={styles.backdrop}
      testID="tour-step-0"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={personalize(i18n.step0.a11y_title, { nickname })}
    >
      <Animated.View style={[styles.modal, animatedStyle]}>
        <SafeAreaView style={styles.safeArea}>
          {/* アプリアイコン (装飾) */}
          <View
            style={styles.iconContainer}
            accessible={false}
            importantForAccessibility="no-hide-descendants"
          >
            <Text style={styles.appIcon}>🏠</Text>
          </View>

          {/* タイトル */}
          <Text
            testID="tour-step-0-title"
            accessibilityRole="header"
            style={styles.title}
          >
            {personalize(i18n.step0.title, { nickname })}
          </Text>

          {/* サブタイトル */}
          <Text testID="tour-step-0-subtitle" style={styles.subtitle}>
            {i18n.step0.subtitle}
          </Text>

          {/* 進捗ドット */}
          <View style={styles.progressContainer}>
            <TourProgress current={1} total={5} />
          </View>

          {/* はじめるボタン */}
          <Pressable
            testID="tour-step-0-start"
            onPress={handleStart}
            disabled={isTransitioning}
            accessibilityRole="button"
            accessibilityLabel="ハンズオンを はじめる"
            accessibilityHint={i18n.step0.a11y_start_hint}
            style={[styles.primaryButton, isTransitioning && styles.buttonDisabled]}
          >
            <Text style={styles.primaryButtonText}>{i18n.step0.start_button}</Text>
          </Pressable>

          {/* あとでボタン */}
          <Pressable
            testID="tour-step-0-skip"
            onPress={handleSkip}
            disabled={isTransitioning}
            accessibilityRole="button"
            accessibilityLabel="チュートリアルを終了する"
            accessibilityHint={i18n.step0.a11y_later_hint}
            style={styles.laterButton}
          >
            <Text style={styles.laterButtonText}>{i18n.step0.later_button}</Text>
          </Pressable>
        </SafeAreaView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modal: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    width: '100%',
    maxWidth: 480,
    flex: 1,
  },
  safeArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  iconContainer: {
    width: 96,
    height: 96,
    borderRadius: 24,
    backgroundColor: '#EFF6FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 32,
  },
  appIcon: {
    fontSize: 48,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111827',
    textAlign: 'center',
    marginBottom: 16,
    maxWidth: 320,
  },
  subtitle: {
    fontSize: 16,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 40,
    maxWidth: 280,
  },
  progressContainer: {
    marginBottom: 40,
  },
  primaryButton: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 16,
    width: '80%',
    maxWidth: 320,
    alignItems: 'center',
    marginBottom: 16,
    minHeight: 56,
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  laterButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  laterButtonText: {
    color: '#6B7280',
    fontSize: 15,
  },
});
