// handson-tour/graduate.tsx — Step 4 卒業
// Canonical: docs/design/family/09-onboarding-handson-tour/06-step4-graduation.md

import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import {
  HANDSON_TOUR_CONSTANTS,
  HANDSON_TOUR_I18N_JA,
  personalize,
} from '@homegohan/handson-tour-shared';

import { useProfile } from '../../src/providers/ProfileProvider';
import { Confetti } from '../../src/handson-tour/Confetti';
import { getApi } from '../../src/lib/api';

const i18n = HANDSON_TOUR_I18N_JA.tour;

type CompleteResponse = {
  completed_at: string;
  badge_awarded: {
    code: string;
    name: string;
    obtained_at: string;
    icon_url: string | null;
  };
  already_completed: boolean;
};

function safeNickname(raw: string | null | undefined): string {
  if (!raw) return 'あなた';
  const trimmed = raw.trim();
  if (!trimmed) return 'あなた';
  if (trimmed.length > 30) return `${trimmed.slice(0, 30)}…`;
  return trimmed;
}

export default function HandsonTourGraduate() {
  const router = useRouter();
  const { profile } = useProfile();
  const nickname = safeNickname(profile?.nickname);

  const [subStep, setSubStep] = useState<'4.0' | '4.1' | '4.2' | '4.3'>('4.0');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);
  const [homeButtonEnabled, setHomeButtonEnabled] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [completeData, setCompleteData] = useState<CompleteResponse | null>(null);

  // アニメーション
  const badgeScale = useSharedValue(0.5);
  const contentOpacity = useSharedValue(0);
  const badgeAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: badgeScale.value }],
  }));
  const contentAnimatedStyle = useAnimatedStyle(() => ({
    opacity: contentOpacity.value,
  }));

  // POST /api/handson-tour/complete (マウント直後 100ms 後)
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const res = await getApi().post<CompleteResponse>('/api/handson-tour/complete', {});
        setCompleteData(res);
        setIsLoading(false);
        setSubStep('4.1');
        startGraduateAnimation();
      } catch {
        setError(true);
        setIsLoading(false);
      }
    }, HANDSON_TOUR_CONSTANTS.STEP4_SAVING_DELAY_MS);

    return () => clearTimeout(timer);
  }, []);

  const startGraduateAnimation = () => {
    // 🎓 スプリングアニメーション
    badgeScale.value = withSpring(1, { damping: 10, stiffness: 100 });

    // コンテンツ fade in
    contentOpacity.value = withTiming(1, { duration: 600, easing: Easing.out(Easing.ease) });

    // 5 秒後にホームボタン活性化
    const enableTimer = setTimeout(() => {
      setHomeButtonEnabled(true);
      setSubStep('4.2');
    }, HANDSON_TOUR_CONSTANTS.STEP4_BUTTON_ACTIVATION_MS);

    return () => clearTimeout(enableTimer);
  };

  // 画面タップでアニメーションスキップ
  const handleScreenTap = () => {
    if (subStep === '4.1') {
      setHomeButtonEnabled(true);
      setSubStep('4.2');
    }
  };

  const handleGoHome = async () => {
    if (!homeButtonEnabled || isTransitioning) return;
    setIsTransitioning(true);
    setSubStep('4.3');
    router.replace('/home' as never);
  };

  if (isLoading) {
    return (
      <View style={styles.loadingContainer} testID="tour-step-4-saving">
        <ActivityIndicator size="large" color="#2563EB" />
        <Text style={styles.loadingText}>{i18n.step4.saving_text}</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.errorTitle}>{i18n.step4.error_title}</Text>
        <Text style={styles.errorSubtitle}>{i18n.step4.error_subtitle}</Text>
        <Pressable
          onPress={() => {
            setError(false);
            setIsLoading(true);
            // リトライ
            getApi()
              .post<CompleteResponse>('/api/handson-tour/complete', {})
              .then((res) => {
                setCompleteData(res);
                setIsLoading(false);
                setSubStep('4.1');
                startGraduateAnimation();
              })
              .catch(() => {
                setIsLoading(false);
                setError(true);
              });
          }}
          style={styles.retryButton}
          accessibilityRole="button"
          accessibilityLabel="もう一度"
        >
          <Text style={styles.retryButtonText}>{i18n.step4.retry_button}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable
      style={{ flex: 1 }}
      onPress={handleScreenTap}
      testID="tour-step-4-graduate"
      accessible={false}
    >
      <View style={styles.container}>
        {/* 紙吹雪 */}
        <Confetti visible={subStep === '4.1' || subStep === '4.2'} />

        <SafeAreaView style={styles.content}>
          {/* 🎓 アイコン */}
          <Animated.View style={[styles.badgeContainer, badgeAnimatedStyle]}>
            <Text style={styles.badgeIcon}>🎓</Text>
          </Animated.View>

          <Animated.View style={[styles.textContainer, contentAnimatedStyle]}>
            {/* タイトル */}
            <Text
              style={styles.title}
              accessibilityRole="header"
              accessibilityLiveRegion="assertive"
            >
              {i18n.step4.title}
            </Text>

            {/* サブタイトル */}
            <Text style={styles.subtitle}>
              {personalize(i18n.step4.subtitle, { nickname })}
            </Text>

            {/* バッジカード */}
            <View style={styles.badgeCard}>
              <Text style={styles.badgeCardIcon}>
                {completeData?.badge_awarded?.icon_url ? '🏆' : '🎓'}
              </Text>
              <Text style={styles.badgeLabel}>{i18n.step4.badge_label}</Text>
            </View>

            {/* バッジ disclaimer */}
            <Text
              style={styles.badgeDisclaimer}
              testID="tour-step-4-badge-disclaimer"
              accessibilityLabel="バッジの注意書き"
              accessibilityRole="text"
            >
              {i18n.step4.badge_disclaimer_body}
            </Text>

            {/* ホームへボタン */}
            <Pressable
              testID="tour-step-4-go-home"
              onPress={handleGoHome}
              disabled={!homeButtonEnabled || isTransitioning}
              accessibilityRole="button"
              accessibilityLabel="ホーム画面へ進む"
              style={[
                styles.homeButton,
                (!homeButtonEnabled || isTransitioning) && styles.homeButtonDisabled,
              ]}
            >
              <Text style={styles.homeButtonText}>{i18n.step4.home_button}</Text>
            </Pressable>
          </Animated.View>
        </SafeAreaView>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    gap: 16,
  },
  loadingText: {
    fontSize: 15,
    color: '#6B7280',
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#EF4444',
    textAlign: 'center',
    marginBottom: 8,
  },
  errorSubtitle: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    paddingHorizontal: 32,
    marginBottom: 24,
  },
  retryButton: {
    backgroundColor: '#2563EB',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 32,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  badgeContainer: {
    width: 80,
    height: 80,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  badgeIcon: {
    fontSize: 64,
  },
  textContainer: {
    alignItems: 'center',
    width: '100%',
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: '#111827',
    textAlign: 'center',
    marginBottom: 12,
    maxWidth: 320,
  },
  subtitle: {
    fontSize: 16,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 32,
    maxWidth: 280,
  },
  badgeCard: {
    backgroundColor: '#EFF6FF',
    borderRadius: 12,
    paddingVertical: 20,
    paddingHorizontal: 32,
    alignItems: 'center',
    marginBottom: 40,
    maxWidth: 240,
    width: '100%',
    minHeight: 120,
    justifyContent: 'center',
  },
  badgeCardIcon: {
    fontSize: 52,
    marginBottom: 8,
  },
  badgeLabel: {
    fontSize: 14,
    color: '#2563EB',
    fontWeight: '600',
    textAlign: 'center',
  },
  badgeDisclaimer: {
    fontSize: 12,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 32,
    maxWidth: 280,
    paddingHorizontal: 8,
  },
  homeButton: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 16,
    width: '80%',
    maxWidth: 320,
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
  },
  homeButtonDisabled: {
    opacity: 0.4,
  },
  homeButtonText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '600',
  },
});
