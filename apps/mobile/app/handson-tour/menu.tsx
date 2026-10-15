// handson-tour/menu.tsx — Step 2 AI による献立追加
// Canonical: docs/design/family/09-onboarding-handson-tour/04-step2-menu.md
//
// V4GenerateModal は React Native <Modal> を使うため、TourOverlay も別の <Modal> で
// ラップして V4GenerateModal の上に重ねる必要がある (TourSandboxWrapper は非使用)。

import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Modal, View } from 'react-native';

import {
  HANDSON_TOUR_CONSTANTS,
  HANDSON_TOUR_I18N_JA,
  HANDSON_TOUR_ROUTES,
  MOCK_MENU_RESPONSE,
  STEP2_SUB_STEP_TO_TARGET,
  fireAnalytics,
} from '@homegohan/handson-tour-shared';
import type { Step2ResultBubbleProfile, SubStepOfStep2 } from '@homegohan/handson-tour-shared';

import { V4GenerateModal } from '../../src/components/menu/V4GenerateModal';
import { TourOverlay } from '../../src/handson-tour/TourOverlay';
import {
  EMPTY_MENU_TOUR_PROFILE,
  fetchMenuTourProfile,
  type MenuTourProfileFailure,
} from '../../src/handson-tour/menu-tour-profile';
import { buildMenuTourBubble } from '../../src/handson-tour/tour-bubbles';
import { getAnalyticsAppVersion } from '../../src/lib/app-version';
import { useProfile } from '../../src/providers/ProfileProvider';
import { safeNickname } from '../../src/handson-tour/safe-nickname';

const i18n = HANDSON_TOUR_I18N_JA.tour;

/**
 * 2.6 の吹き出しに使うプロフィールの取得の失敗を記録する (Web の reportTourProfileFailures と同じ error_code)。
 * ツアーは体験モードなので止めないが、黙って握りつぶすと「パーソナライズが全員分効いていない」に気づけない (#1040)。
 * 記録するのはテーブル名と PostgREST のエラーコードだけ (値や文面は出さない)。
 */
function reportMenuTourProfileFailure(userId: string, failure: MenuTourProfileFailure): void {
  const detail = `${failure.table} select failed${failure.code ? ` (${failure.code})` : ''}`;
  console.warn(`[handson-tour] step 2 profile fetch: ${detail}`);
  // 計測の失敗 (開発時の payload 検証エラーなど) でツアーを止めない
  try {
    fireAnalytics('handson_tour_step_error', {
      user_id: userId,
      timestamp: new Date().toISOString(),
      platform: 'ios' as const,
      app_version: getAnalyticsAppVersion(),
      step: 2,
      // 取得は画面を開いた直後 (Step 2 の最初の sub_step) に行う
      sub_step: '2.1',
      error_code: 'profile_fetch_failed',
      error_message: detail,
    });
  } catch {
    // 計測の失敗は無視
  }
}

export default function HandsonTourMenu() {
  const router = useRouter();
  const { profile } = useProfile();
  const nickname = safeNickname(profile?.nickname);

  const [subStep, setSubStep] = useState<SubStepOfStep2>('2.1');
  // 2.6 の吹き出し (除外する食材・料理の経験) に使う。取れるまで / 取れなければ既定値 (除外なし・beginner 扱い)
  const [tourProfile, setTourProfile] = useState<Step2ResultBubbleProfile>(EMPTY_MENU_TOUR_PROFILE);
  const mountTimeRef = React.useRef(Date.now());

  useEffect(() => {
    const userId = profile?.id;
    if (!userId) return;
    let cancelled = false;
    void fetchMenuTourProfile(userId).then(({ profile: loaded, failure }) => {
      if (cancelled) return;
      setTourProfile(loaded);
      if (failure) reportMenuTourProfileFailure(userId, failure);
    });
    return () => {
      cancelled = true;
    };
  }, [profile?.id]);

  const advanceSubStep = (next: SubStepOfStep2) => {
    setSubStep(next);
  };

  // mount 時に step_viewed (step=2) を発火
  useEffect(() => {
    if (!profile?.id) return;
    fireAnalytics('handson_tour_step_viewed', {
      user_id: profile.id,
      timestamp: new Date().toISOString(),
      platform: 'ios' as const,
      app_version: getAnalyticsAppVersion(),
      step: 2,
      sub_step: '2.1',
    });
  }, [profile?.id]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    switch (subStep) {
      case '2.1':
        timer = setTimeout(
          () => advanceSubStep('2.2'),
          HANDSON_TOUR_CONSTANTS.STEP2_INTRO_AUTO_MS
        );
        break;
      case '2.5':
        timer = setTimeout(
          () => advanceSubStep('2.6'),
          HANDSON_TOUR_CONSTANTS.STEP2_LOADING_DURATION_MS
        );
        break;
      case '2.9':
        // Step 3 へ遷移
        router.push(HANDSON_TOUR_ROUTES.step3 as never);
        break;
      default:
        break;
    }

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [subStep]);

  const handleSkip = () => {
    router.replace('/home' as never);
  };

  const handleSandboxComplete = () => {
    if (profile?.id) {
      const dwell_ms = Date.now() - mountTimeRef.current;
      fireAnalytics('handson_tour_step_completed', {
        user_id: profile.id,
        timestamp: new Date().toISOString(),
        platform: 'ios' as const,
        app_version: getAnalyticsAppVersion(),
        step: 2,
        dwell_ms,
      });
    }
    advanceSubStep('2.8');
    setTimeout(() => advanceSubStep('2.9'), 500);
  };

  const isAutoStep = ['2.1', '2.5', '2.8', '2.9'].includes(subStep);

  const getPrimaryAction = () => {
    if (isAutoStep) return undefined;
    switch (subStep) {
      case '2.2':
        return {
          label: i18n.step2.next_button,
          onPress: () => advanceSubStep('2.3'),
        };
      case '2.3':
        return {
          label: i18n.step2.next_button,
          onPress: () => advanceSubStep('2.4'),
        };
      case '2.4':
        return {
          label: i18n.step2.generate_button,
          onPress: () => advanceSubStep('2.5'),
        };
      case '2.6':
        return {
          label: i18n.step2.next_button,
          onPress: () => advanceSubStep('2.7'),
        };
      case '2.7':
        return {
          label: i18n.step2.add_button,
          onPress: () => handleSandboxComplete(),
        };
      default:
        return undefined;
    }
  };

  const target = STEP2_SUB_STEP_TO_TARGET[subStep];
  const targetTestId = typeof target === 'string' ? target : null;
  const targetTestIds = Array.isArray(target) ? target : undefined;

  return (
    <View style={{ flex: 1 }} testID="tour-step-2">
      {/* V4GenerateModal は内部で React Native <Modal> を使うため常時表示 */}
      <V4GenerateModal
        mode="sandbox"
        visible={true}
        onClose={() => {
          // Tour 中は onClose を無効化 (TourOverlay のスキップで制御)
        }}
        prefilled={MOCK_MENU_RESPONSE}
        loadingDurationMs={HANDSON_TOUR_CONSTANTS.STEP2_LOADING_DURATION_MS}
        apiOptions={{ source: 'handson_tour', sandbox: true }}
        onSandboxComplete={handleSandboxComplete}
      />

      {/* TourOverlay を別 Modal でラップして V4GenerateModal の上に重ねる */}
      <Modal
        visible={true}
        transparent
        animationType="none"
        statusBarTranslucent
        onRequestClose={handleSkip}
      >
        <TourOverlay
          targetTestId={targetTestId}
          targetTestIds={targetTestIds}
          bubble={buildMenuTourBubble(subStep, { nickname, profile: tourProfile })}
          progress={{ current: 3, total: 5 }}
          primaryAction={getPrimaryAction()}
          showSkip={false}
          onSkip={handleSkip}
          accessibilityLabel={i18n.step2.a11y_title}
        />
      </Modal>
    </View>
  );
}
