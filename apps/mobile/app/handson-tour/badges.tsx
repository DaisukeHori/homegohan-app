// handson-tour/badges.tsx — Step 3 バッジ確認 (ハンズオン専用)
// Canonical: docs/design/family/09-onboarding-handson-tour/05-step3-badges.md
// 注意: apps/mobile/app/badges/index.tsx (通常バッジ画面、P3-B 改修) とは別ファイル

import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  HANDSON_TOUR_CONSTANTS,
  HANDSON_TOUR_I18N_JA,
  HANDSON_TOUR_ROUTES,
  STEP3_SUB_STEP_TO_TARGET,
  personalize,
} from '@homegohan/handson-tour-shared';
import type { SubStepOfStep3 } from '@homegohan/handson-tour-shared';

import { useProfile } from '../../src/providers/ProfileProvider';
import { TourOverlay } from '../../src/handson-tour/TourOverlay';
import { getApi } from '../../src/lib/api';

const i18n = HANDSON_TOUR_I18N_JA.tour;

function safeNickname(raw: string | null | undefined): string {
  if (!raw) return 'あなた';
  const trimmed = raw.trim();
  if (!trimmed) return 'あなた';
  if (trimmed.length > 30) return `${trimmed.slice(0, 30)}…`;
  return trimmed;
}

export default function HandsonTourBadges() {
  const router = useRouter();
  const { profile } = useProfile();
  const nickname = safeNickname(profile?.nickname);

  const [subStep, setSubStep] = useState<SubStepOfStep3>('3.0');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  const advanceSubStep = (next: SubStepOfStep3) => {
    setSubStep(next);
  };

  // バッジ情報の取得
  useEffect(() => {
    const fetchBadges = async () => {
      try {
        await getApi().get('/api/badges');
        // first_bite と planner が獲得済みであることを期待
        setIsLoading(false);
        advanceSubStep('3.1');
      } catch {
        setError(true);
        setIsLoading(false);
      }
    };

    void fetchBadges();
  }, []);

  // サブステップ自動進行
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (subStep === '3.1') {
      timer = setTimeout(
        () => advanceSubStep('3.2'),
        HANDSON_TOUR_CONSTANTS.STEP3_INTRO_AUTO_MS
      );
    }

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [subStep]);

  const handleSkip = () => {
    router.replace('/home' as never);
  };

  const handleNext = () => {
    switch (subStep) {
      case '3.2':
        advanceSubStep('3.3');
        break;
      case '3.3':
        advanceSubStep('3.4');
        break;
      case '3.4':
        router.push(HANDSON_TOUR_ROUTES.step4 as never);
        break;
      default:
        break;
    }
  };

  const getBubble = (): {
    title?: string;
    body: string;
    position: 'top' | 'bottom' | 'left' | 'right' | 'auto';
  } => {
    switch (subStep) {
      case '3.0':
        return {
          body: i18n.step3.loading_text,
          position: 'auto',
        };
      case '3.1':
        return {
          title: personalize(i18n.step3.intro_title, { nickname }),
          body: i18n.step3.intro_title,
          position: 'auto',
        };
      case '3.2':
        return {
          title: i18n.step3.first_bite_title,
          body: i18n.step3.first_bite_bubble,
          position: 'bottom',
        };
      case '3.3':
        return {
          title: i18n.step3.planner_title,
          body: i18n.step3.planner_bubble,
          position: 'bottom',
        };
      case '3.4':
        return {
          title: i18n.step3.tutorial_complete_title,
          body: i18n.step3.tutorial_complete_bubble,
          position: 'bottom',
        };
      default:
        return { body: '', position: 'auto' };
    }
  };

  const isManualStep = ['3.2', '3.3', '3.4'].includes(subStep);

  if (isLoading) {
    return (
      <View style={styles.loadingContainer} testID="tour-step-3-loading">
        <ActivityIndicator size="large" color="#2563EB" />
        <Text style={styles.loadingText}>{i18n.step3.loading_text}</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.errorText}>{i18n.step3.error_title}</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }} testID="tour-step-3">
      {/* P3-B が BadgesPage に tutorial-mode サポートを追加する。現在はプレースホルダー */}
      <View style={{ flex: 1, backgroundColor: '#F9FAFB' }} />

      <TourOverlay
        targetTestId={STEP3_SUB_STEP_TO_TARGET[subStep] as string | null}
        targetTestIds={
          Array.isArray(STEP3_SUB_STEP_TO_TARGET[subStep])
            ? (STEP3_SUB_STEP_TO_TARGET[subStep] as string[])
            : undefined
        }
        bubble={getBubble()}
        progress={{ current: 4, total: 5 }}
        primaryAction={
          isManualStep
            ? {
                label: i18n.step3.next_button,
                onPress: handleNext,
              }
            : undefined
        }
        showSkip={false}
        onSkip={handleSkip}
        accessibilityLabel={personalize(i18n.step3.a11y_title, { nickname })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    gap: 16,
  },
  loadingText: {
    fontSize: 15,
    color: '#6B7280',
  },
  errorText: {
    fontSize: 16,
    color: '#EF4444',
    textAlign: 'center',
    paddingHorizontal: 32,
  },
});
