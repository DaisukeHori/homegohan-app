'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { TourSandboxWrapper } from '@/components/handson-tour/TourSandboxWrapper';
import {
  HANDSON_TOUR_I18N_JA,
  HANDSON_TOUR_ROUTES,
  HANDSON_TOUR_CONSTANTS,
  MOCK_MENU_RESPONSE,
  STEP2_SUB_STEP_TO_TARGET,
  personalize,
  type SubStepOfStep2,
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
  allergies: string[] | null;
  dislikes: string[] | null;
  cooking_experience: string | null;
};

const COOKING_EXP_TEXT: Record<string, string> = {
  beginner: '初心者でも作れる',
  intermediate: 'いつもの手順で作れる',
  advanced: 'シェフの腕前を活かせる',
};

function buildBubble(subStep: SubStepOfStep2, profile: UserProfile) {
  const i18n = HANDSON_TOUR_I18N_JA.tour.step2;
  const nickname = safeNickname(profile.nickname);

  switch (subStep) {
    case '2.1':
      return { body: i18n.intro_title, position: 'auto' as const };
    case '2.2':
      return { body: i18n.flags_bubble, position: 'auto' as const };
    case '2.3':
      return { body: i18n.note_bubble, position: 'auto' as const };
    case '2.4':
      return { body: i18n.generate_bubble, position: 'auto' as const };
    case '2.5':
      return { body: i18n.generate_bubble, position: 'auto' as const };
    case '2.6': {
      const allergies = profile.allergies ?? [];
      const dislikes = profile.dislikes ?? [];
      const excludeList = [...allergies, ...dislikes].slice(0, 3);
      const cookingExp = profile.cooking_experience ?? 'beginner';
      const cookingExpText = COOKING_EXP_TEXT[cookingExp] ?? '初心者でも作れる';

      if (excludeList.length > 0) {
        return {
          title: personalize(i18n.result_title, { nickname }),
          body: personalize(i18n.result_bubble_full, {
            exclude_list: excludeList.join('・'),
            cooking_experience_text: cookingExpText,
          }),
          position: 'bottom' as const,
        };
      }
      return {
        title: personalize(i18n.result_title, { nickname }),
        body: personalize(i18n.result_bubble_no_exclude, {
          cooking_experience_text: cookingExpText,
        }),
        position: 'bottom' as const,
      };
    }
    case '2.7':
      return { body: i18n.add_bubble, position: 'auto' as const };
    case '2.8':
    case '2.9':
      return { body: '', position: 'auto' as const };
    default:
      return { body: '', position: 'auto' as const };
  }
}

export default function HandsonTourMenuPage() {
  const router = useRouter();
  const [subStep, setSubStep] = useState<SubStepOfStep2>('2.1');
  const [profile, setProfile] = useState<UserProfile>({
    nickname: null,
    allergies: null,
    dislikes: null,
    cooking_experience: null,
  });
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      supabase
        .from('user_profiles')
        .select('nickname, allergies, dislikes, cooking_experience')
        .eq('user_id', user.id)
        .single()
        .then(({ data }) => {
          if (data) {
            const d = data as unknown as Record<string, unknown>;
            setProfile({
              nickname: (d.nickname as string | null) ?? null,
              allergies: Array.isArray(d.allergies) ? (d.allergies as string[]) : null,
              dislikes: Array.isArray(d.dislikes) ? (d.dislikes as string[]) : null,
              cooking_experience: (d.cooking_experience as string | null) ?? null,
            });
          }
        });
    });
  }, []);

  const advanceSubStep = (next: SubStepOfStep2) => setSubStep(next);

  const handleSandboxComplete = async () => {
    setSubStep('2.8');
    setIsSaving(true);
    try {
      await fetch('/api/menu-plans/add?source=handson_tour', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...MOCK_MENU_RESPONSE,
          sandbox: true,
          source: 'handson_tour',
        }),
      });
    } catch {
      // ネットワークエラーはスキップして次へ
    } finally {
      setIsSaving(false);
      router.push(HANDSON_TOUR_ROUTES.step3);
    }
  };

  const bubble = buildBubble(subStep, profile);
  const i18n = HANDSON_TOUR_I18N_JA.tour.step2;

  const autoAdvanceMs: number | undefined = (() => {
    if (subStep === '2.1') return HANDSON_TOUR_CONSTANTS.STEP2_INTRO_AUTO_MS;
    if (subStep === '2.5') return HANDSON_TOUR_CONSTANTS.STEP2_LOADING_DURATION_MS;
    return undefined;
  })();

  const onAutoAdvance = (() => {
    if (subStep === '2.1') return () => advanceSubStep('2.2');
    if (subStep === '2.5') return () => advanceSubStep('2.6');
    return undefined;
  })();

  const primaryAction = (() => {
    if (subStep === '2.2') {
      return { label: i18n.next_button, onPress: () => advanceSubStep('2.3') };
    }
    if (subStep === '2.3') {
      return { label: i18n.next_button, onPress: () => advanceSubStep('2.4') };
    }
    if (subStep === '2.4') {
      return { label: i18n.generate_button, onPress: () => advanceSubStep('2.5') };
    }
    if (subStep === '2.6') {
      return { label: i18n.next_button, onPress: () => advanceSubStep('2.7') };
    }
    if (subStep === '2.7') {
      return {
        label: i18n.add_button,
        onPress: handleSandboxComplete,
        disabled: isSaving,
        showSpinner: isSaving,
      };
    }
    return undefined;
  })();

  const V4GenerateModalPlaceholder = () => (
    <div className="w-full h-full bg-gray-50 flex flex-col items-center justify-center p-8" data-testid="v4-generate-modal">
      <div className="w-full max-w-md">
        <div className="mb-4 flex items-center gap-2">
          <div data-testid="v4-no-cook-toggle" className="flex items-center gap-2 p-3 rounded-lg border border-blue-600 bg-blue-50 cursor-pointer">
            <div className="w-5 h-5 bg-blue-600 rounded flex items-center justify-center">
              <span className="text-white text-xs">✓</span>
            </div>
            <span className="text-sm font-medium">調理しなくていい</span>
          </div>
        </div>
        <div className="mb-4">
          <textarea
            data-testid="v4-note-textarea"
            className="w-full p-3 border rounded-lg text-sm"
            placeholder="自由メモ (任意)"
            rows={3}
          />
        </div>
        <button
          data-testid="v4-generate-button"
          className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold"
        >
          AI で献立を生成
        </button>
        {(subStep === '2.5' || subStep === '2.6' || subStep === '2.7') && (
          <div className="mt-4">
            {subStep === '2.5' && (
              <div data-testid="v4-loading-spinner" className="flex flex-col items-center">
                <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
                <p className="mt-2 text-gray-600 text-sm">AI が考え中...</p>
              </div>
            )}
            {(subStep === '2.6' || subStep === '2.7') && (
              <div data-testid="v4-result-card" className="p-4 border rounded-lg bg-white shadow">
                <div data-testid="v4-result-dish-name" className="text-lg font-bold">{MOCK_MENU_RESPONSE.dish_name}</div>
                <div data-testid="v4-result-calories" className="text-gray-600">{MOCK_MENU_RESPONSE.calories} kcal</div>
                <div className="mt-2 text-sm text-gray-500">調理時間: {MOCK_MENU_RESPONSE.cooking_time_minutes}分</div>
                {subStep === '2.7' && (
                  <button
                    data-testid="v4-add-to-menu-button"
                    className="mt-3 w-full bg-green-600 text-white py-2 rounded-lg font-medium"
                  >
                    献立に追加
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-40">
      <TourSandboxWrapper
        subStep={subStep}
        subStepToTarget={STEP2_SUB_STEP_TO_TARGET}
        overlay={{
          bubble,
          progress: { current: 3, total: 5 },
          autoAdvanceMs,
          onAutoAdvance,
          primaryAction,
          showSkip: false,
          accessibilityLabel: HANDSON_TOUR_I18N_JA.tour.step2.intro_title,
        }}
        childProps={{
          initialFlags: { no_cook: true },
          prefilled: MOCK_MENU_RESPONSE,
          loadingDurationMs: HANDSON_TOUR_CONSTANTS.STEP2_LOADING_DURATION_MS,
          apiOptions: { source: 'handson_tour' as const, sandbox: true as const },
        }}
        onSandboxComplete={handleSandboxComplete}
      >
        <V4GenerateModalPlaceholder />
      </TourSandboxWrapper>
    </div>
  );
}
