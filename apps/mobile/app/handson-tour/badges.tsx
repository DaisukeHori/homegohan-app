// handson-tour/badges.tsx — Step 3 バッジ確認 (ハンズオン専用)
// Canonical: docs/design/family/09-onboarding-handson-tour/05-step3-badges.md
// 注意: apps/mobile/app/badges/index.tsx (通常バッジ画面、P3-B 改修) とは別ファイル

import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
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
  fireAnalytics,
} from '@homegohan/handson-tour-shared';
import type { SubStepOfStep3 } from '@homegohan/handson-tour-shared';

import { useProfile } from '../../src/providers/ProfileProvider';
import { safeNickname } from '../../src/handson-tour/safe-nickname';
import { TourOverlay } from '../../src/handson-tour/TourOverlay';
import { buildBadgesTourBubble } from '../../src/handson-tour/tour-bubbles';
import { getApi } from '../../src/lib/api';
import { getAnalyticsAppVersion } from '../../src/lib/app-version';
import { useLeaveTour, useTourHardBack } from '../../src/handson-tour/useLeaveTour';
import { tourAnalyticsPlatform } from '../../src/handson-tour/tour-platform';

const i18n = HANDSON_TOUR_I18N_JA.tour;

export default function HandsonTourBadges() {
  const router = useRouter();
  const { profile } = useProfile();
  const nickname = safeNickname(profile?.nickname);

  const [subStep, setSubStep] = useState<SubStepOfStep3>('3.0');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);
  const mountTimeRef = React.useRef(Date.now());
  // ツアーを抜ける (skip API + handson_tour_skipped + /home。Step 1 と共通。#1642)。
  // leftTourRef = 抜けた。抜けたあとに届いたバッジの応答や 3.1 のタイマーで、先のサブステップや Step 4 へ進めない
  const { leftTourRef, leaveTour } = useLeaveTour(3, profile?.id);

  const advanceSubStep = (next: SubStepOfStep3) => {
    if (leftTourRef.current) return;
    setSubStep(next);
  };

  // mount 時に step_viewed (step=3) を発火
  useEffect(() => {
    if (!profile?.id) return;
    fireAnalytics('handson_tour_step_viewed', {
      user_id: profile.id,
      timestamp: new Date().toISOString(),
      platform: tourAnalyticsPlatform(),
      app_version: getAnalyticsAppVersion(),
      step: 3,
    });
  }, [profile?.id]);

  // バッジ情報の取得
  useEffect(() => {
    const fetchBadges = async () => {
      try {
        await getApi().get('/api/badges');
        // 応答を待つ間に端末バックでツアーを抜けていたら、ここで終える (ホームへの遷移中に吹き出しを出さない)
        if (leftTourRef.current) return;
        // ツアーが Step 3 までに付けるのは planner だけ (STEP3_BADGES_EARNED_IN_TOUR)。お試しの記録は first_bite に数えない (#1314 / #1626)
        setIsLoading(false);
        advanceSubStep('3.1');
      } catch {
        if (leftTourRef.current) return;
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

  // 端末バック (Android) でツアーを抜ける (設計書 01-trigger-flow §2.2: Step 1〜3 の端末バックは
  // skipped{reason:'hard_back'} + skipped_at + /home)。以前は /home へ遷移するだけで、skip API も handson_tour_skipped も送っていなかった。
  // 呼び元は 2 つ: TourOverlay の hardwareBackPress (overlay.onSkip。showSkip={false} なので画面のスキップボタンからは呼ばれない) と、
  // 吹き出しを出していない読み込み中・エラーの画面の端末バック (下の useTourHardBack)
  const handleHardBack = useCallback(() => leaveTour('hard_back'), [leaveTour]);

  // 読み込み中・エラーの画面は TourOverlay (= hardwareBackPress) を出さないので、ここで受けないと端末バックが画面の戻る (Step 2) になってしまう
  useTourHardBack(isLoading || error, handleHardBack);

  const handleNext = () => {
    if (leftTourRef.current) return;
    switch (subStep) {
      case '3.2':
        advanceSubStep('3.3');
        break;
      case '3.3':
        advanceSubStep('3.4');
        break;
      case '3.4':
        if (profile?.id) {
          const dwell_ms = Date.now() - mountTimeRef.current;
          fireAnalytics('handson_tour_step_completed', {
            user_id: profile.id,
            timestamp: new Date().toISOString(),
            platform: tourAnalyticsPlatform(),
            app_version: getAnalyticsAppVersion(),
            step: 3,
            dwell_ms,
          });
        }
        router.push(HANDSON_TOUR_ROUTES.step4 as never);
        break;
      default:
        break;
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
        bubble={buildBadgesTourBubble(subStep, { nickname })}
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
        onSkip={handleHardBack}
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
