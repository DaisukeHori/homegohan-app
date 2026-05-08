'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { TourSandboxWrapper } from '@/components/handson-tour/TourSandboxWrapper';
import {
  HANDSON_TOUR_I18N_JA,
  HANDSON_TOUR_ROUTES,
  HANDSON_TOUR_CONSTANTS,
  MOCK_PHOTO_RESPONSE,
  STEP1_SUB_STEP_TO_TARGET,
  personalize,
  type SubStepOfStep1,
} from '@homegohan/handson-tour-shared';
import { createClient } from '@/lib/supabase/client';

function safeNickname(raw: string | null | undefined): string {
  if (!raw) return 'あなた';
  const trimmed = raw.trim();
  if (!trimmed) return 'あなた';
  if (trimmed.length > 30) return `${trimmed.slice(0, 30)}…`;
  return trimmed;
}

type UserProfile = {
  nickname: string | null;
  target_kcal_per_day: number | null;
};

function buildBubble(subStep: SubStepOfStep1, profile: UserProfile) {
  const i18n = HANDSON_TOUR_I18N_JA.tour.step1;
  const nickname = safeNickname(profile.nickname);

  switch (subStep) {
    case '1.1':
      return {
        body: i18n.intro_title,
        position: 'auto' as const,
      };
    case '1.2':
      return {
        body: i18n.camera_bubble,
        position: 'auto' as const,
      };
    case '1.3':
    case '1.4':
      return {
        body: i18n.camera_bubble,
        position: 'auto' as const,
      };
    case '1.5': {
      const targetKcal = profile.target_kcal_per_day;
      if (targetKcal) {
        const percent = Math.round((MOCK_PHOTO_RESPONSE.calories / targetKcal) * 100);
        return {
          title: i18n.result_title,
          body: personalize(i18n.result_bubble_with_target, {
            nickname,
            target_kcal: String(targetKcal),
            percent: String(percent),
          }),
          position: 'bottom' as const,
        };
      }
      return {
        title: i18n.result_title,
        body: i18n.result_bubble_no_target,
        position: 'bottom' as const,
      };
    }
    case '1.6':
      return {
        body: i18n.save_bubble,
        position: 'auto' as const,
      };
    case '1.7':
      return {
        body: i18n.camera_bubble,
        position: 'auto' as const,
      };
    default:
      return {
        body: '',
        position: 'auto' as const,
      };
  }
}

export default function HandsonTourPhotoPage() {
  const router = useRouter();
  const [subStep, setSubStep] = useState<SubStepOfStep1>('1.1');
  const [profile, setProfile] = useState<UserProfile>({ nickname: null, target_kcal_per_day: null });
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      supabase
        .from('user_profiles')
        .select('nickname, target_kcal_per_day')
        .eq('user_id', user.id)
        .single()
        .then(({ data }) => {
          if (data) {
            setProfile({
              nickname: data.nickname ?? null,
              target_kcal_per_day: (data as unknown as Record<string, unknown>).target_kcal_per_day != null
                ? Number((data as unknown as Record<string, unknown>).target_kcal_per_day)
                : null,
            });
          }
        });
    });
  }, []);

  const advanceSubStep = (next: SubStepOfStep1) => {
    setSubStep(next);
  };

  const handleSandboxComplete = async () => {
    setSubStep('1.7');
    setIsSaving(true);
    try {
      await fetch('/api/meal-plans/add-from-photo?source=handson_tour', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...MOCK_PHOTO_RESPONSE,
          sandbox: true,
          source: 'handson_tour',
        }),
      });
    } catch {
      // ネットワークエラーはスキップして次へ
    } finally {
      setIsSaving(false);
      router.push(HANDSON_TOUR_ROUTES.step2);
    }
  };

  const bubble = buildBubble(subStep, profile);

  const i18n = HANDSON_TOUR_I18N_JA.tour.step1;

  const autoAdvanceMs: number | undefined = (() => {
    if (subStep === '1.1') return HANDSON_TOUR_CONSTANTS.STEP1_INTRO_AUTO_MS;
    if (subStep === '1.2') return HANDSON_TOUR_CONSTANTS.STEP1_CAMERA_AUTO_MS;
    if (subStep === '1.3') return HANDSON_TOUR_CONSTANTS.STEP1_ANALYZING_DURATION_MS;
    if (subStep === '1.4') return HANDSON_TOUR_CONSTANTS.STEP1_RESULT_TO_SPOTLIGHT_MS;
    return undefined;
  })();

  const onAutoAdvance = (() => {
    if (subStep === '1.1') return () => advanceSubStep('1.2');
    if (subStep === '1.2') return () => advanceSubStep('1.3');
    if (subStep === '1.3') return () => advanceSubStep('1.4');
    if (subStep === '1.4') return () => advanceSubStep('1.5');
    return undefined;
  })();

  const primaryAction = (() => {
    if (subStep === '1.5') {
      return {
        label: i18n.next_button,
        onPress: () => advanceSubStep('1.6'),
      };
    }
    if (subStep === '1.6') {
      return {
        label: i18n.save_button,
        onPress: handleSandboxComplete,
        disabled: isSaving,
        showSpinner: isSaving,
      };
    }
    return undefined;
  })();

  const MealNewScreenPlaceholder = () => (
    <div className="w-full h-full bg-gray-50 flex items-center justify-center" data-testid="meal-new-screen">
      <div className="text-center p-8">
        <div data-testid="meal-camera-button" className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-4">
          <span className="text-white text-2xl">📸</span>
        </div>
        {subStep >= '1.3' && (
          <div data-testid="meal-analyzing-view" className="mt-4">
            <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="mt-2 text-gray-600 text-sm">解析中...</p>
          </div>
        )}
        {subStep >= '1.4' && (
          <div data-testid="meal-result-screen" className="mt-4">
            <div data-testid="meal-result-dish-name" className="text-lg font-bold">{MOCK_PHOTO_RESPONSE.dishName}</div>
            <div data-testid="meal-result-calories" className="text-gray-600">{MOCK_PHOTO_RESPONSE.calories} kcal</div>
            <div data-testid="meal-save-button" className="mt-4 bg-blue-600 text-white px-6 py-3 rounded-lg">保存</div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-40">
      <TourSandboxWrapper
        subStep={subStep}
        subStepToTarget={STEP1_SUB_STEP_TO_TARGET}
        overlay={{
          bubble,
          progress: { current: 2, total: 5 },
          autoAdvanceMs,
          onAutoAdvance,
          primaryAction,
          showSkip: false,
          accessibilityLabel: i18n.a11y_title,
        }}
        childProps={{
          initialStep: 'result' as const,
          prefilled: MOCK_PHOTO_RESPONSE,
          apiOptions: { source: 'handson_tour' as const, sandbox: true as const },
        }}
        onSandboxComplete={handleSandboxComplete}
      >
        <MealNewScreenPlaceholder />
      </TourSandboxWrapper>
    </div>
  );
}
