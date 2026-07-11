'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { TourOverlay } from '@/components/handson-tour/TourOverlay';
import {
  HANDSON_TOUR_I18N_JA,
  HANDSON_TOUR_ROUTES,
  HANDSON_TOUR_CONSTANTS,
  STEP3_SUB_STEP_TO_TARGET,
  personalize,
  fireAnalytics,
  type SubStepOfStep3,
} from '@homegohan/handson-tour-shared';
import { createClient } from '@/lib/supabase/client';

type BadgeItem = {
  code: string;
  name: string;
  description: string;
  icon_url: string | null;
  obtained_at: string | null;
};

function safeNickname(raw: string | null | undefined): string {
  if (!raw) return 'あなた';
  const trimmed = raw.trim();
  if (!trimmed) return 'あなた';
  if (trimmed.length > 30) return `${trimmed.slice(0, 30)}…`;
  return trimmed;
}

const BADGE_ICON_MAP: Record<string, string> = {
  first_bite: '🥄',
  planner: '📝',
  tutorial_complete: '🎓',
  streak_3: '🔥',
  streak_7: '📅',
};

function buildBubble(subStep: SubStepOfStep3, nickname: string) {
  const i18n = HANDSON_TOUR_I18N_JA.tour.step3;

  switch (subStep) {
    case '3.0':
      return { body: '', position: 'auto' as const };
    case '3.1':
      return {
        body: personalize(i18n.intro_title, { nickname }),
        position: 'auto' as const,
      };
    case '3.2':
      return {
        title: i18n.first_bite_title,
        body: i18n.first_bite_bubble,
        position: 'bottom' as const,
      };
    case '3.3':
      return {
        title: i18n.planner_title,
        body: i18n.planner_bubble,
        position: 'bottom' as const,
      };
    case '3.4':
      return {
        title: i18n.tutorial_complete_title,
        body: i18n.tutorial_complete_bubble,
        position: 'bottom' as const,
      };
    default:
      return { body: '', position: 'auto' as const };
  }
}

export default function HandsonTourBadgesPage() {
  const router = useRouter();
  const [subStep, setSubStep] = useState<SubStepOfStep3>('3.0');
  const [badges, setBadges] = useState<BadgeItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [nickname, setNickname] = useState('あなた');
  const [userId, setUserId] = useState<string | null>(null);
  const mountTimeRef = useRef(Date.now());

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      setUserId(user.id);
      supabase
        .from('user_profiles')
        .select('nickname')
        .eq('user_id', user.id)
        .single()
        .then(({ data }) => {
          if (data?.nickname) setNickname(safeNickname(data.nickname));
        });
    });

    fetch('/api/badges')
      .then((r) => r.json())
      .then((data: { badges: BadgeItem[] }) => {
        setBadges(data.badges ?? []);
        setIsLoading(false);
        setSubStep('3.1');
      })
      .catch(() => {
        setIsLoading(false);
        setSubStep('3.1');
      });
  }, []);

  // userId 確定後に step_viewed (step=3) を発火
  useEffect(() => {
    if (!userId) return;
    fireAnalytics('handson_tour_step_viewed', {
      user_id: userId,
      timestamp: new Date().toISOString(),
      platform: 'web' as const,
      app_version: '1.0.0',
      step: 3,
    });
  }, [userId]);

  const advanceSubStep = (next: SubStepOfStep3) => setSubStep(next);

  // #1057 (UX1-03): ツアー中盤に途中離脱手段が無く完走を強制していたため、
  // Step0(page.tsx)と同じパターンでスキップを追加する
  const handleSkip = async () => {
    if (userId) {
      fireAnalytics('handson_tour_skipped', {
        user_id: userId,
        timestamp: new Date().toISOString(),
        platform: 'web' as const,
        app_version: '1.0.0',
        step: 3,
        reason: 'user_action',
      });
    }
    try {
      await fetch('/api/handson-tour/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 3, reason: 'user_action' }),
      });
    } catch {
      // ネットワークエラー時もローカルでスキップ
    }
    router.push('/home');
  };

  const bubble = buildBubble(subStep, nickname);
  const i18n = HANDSON_TOUR_I18N_JA.tour.step3;

  const autoAdvanceMs = subStep === '3.1' ? HANDSON_TOUR_CONSTANTS.STEP3_INTRO_AUTO_MS : undefined;
  const onAutoAdvance = subStep === '3.1' ? () => advanceSubStep('3.2') : undefined;

  const primaryAction = (() => {
    if (subStep === '3.2') {
      return { label: i18n.next_button, onPress: () => advanceSubStep('3.3') };
    }
    if (subStep === '3.3') {
      return { label: i18n.next_button, onPress: () => advanceSubStep('3.4') };
    }
    if (subStep === '3.4') {
      return {
        label: i18n.next_button,
        onPress: () => {
          if (userId) {
            const dwell_ms = Date.now() - mountTimeRef.current;
            fireAnalytics('handson_tour_step_completed', {
              user_id: userId,
              timestamp: new Date().toISOString(),
              platform: 'web' as const,
              app_version: '1.0.0',
              step: 3,
              dwell_ms,
            });
          }
          router.push(HANDSON_TOUR_ROUTES.step4);
        },
      };
    }
    return undefined;
  })();

  const rawTarget = STEP3_SUB_STEP_TO_TARGET[subStep];
  const targetTestId = typeof rawTarget === 'string' ? rawTarget : null;
  const targetTestIds = Array.isArray(rawTarget) ? rawTarget : undefined;

  return (
    <div className="fixed inset-0 z-40 bg-white overflow-y-auto">
      {isLoading && subStep === '3.0' && (
        <div data-testid="tour-step-3-loading" className="flex flex-col items-center justify-center h-full gap-4">
          <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-600">バッジを確認中...</p>
        </div>
      )}

      {!isLoading && (
        <div className="p-6 max-w-md mx-auto">
          <h1 className="text-xl font-bold text-gray-900 mb-6 text-center">
            {personalize(i18n.intro_title, { nickname })}
          </h1>

          <div className="grid grid-cols-3 gap-4">
            {badges.map((badge) => (
              <div
                key={badge.code}
                data-testid={`badge-card-${badge.code}`}
                className={`flex flex-col items-center p-3 rounded-xl border-2 transition-all ${
                  badge.obtained_at
                    ? 'border-blue-300 bg-blue-50'
                    : badge.code === 'tutorial_complete'
                    ? 'border-gray-200 bg-gray-50 opacity-50'
                    : 'border-gray-200 bg-gray-50'
                }`}
              >
                <span className="text-3xl mb-2">
                  {BADGE_ICON_MAP[badge.code] ?? '🏅'}
                </span>
                <span className="text-xs text-center font-medium text-gray-700 leading-tight">
                  {badge.name}
                </span>
                {badge.obtained_at && (
                  <span className="text-xs text-blue-600 mt-1">獲得済</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!isLoading && subStep !== '3.0' && (
        <TourOverlay
          targetTestId={targetTestId}
          targetTestIds={targetTestIds}
          bubble={bubble}
          progress={{ current: 4, total: 5 }}
          autoAdvanceMs={autoAdvanceMs}
          onAutoAdvance={onAutoAdvance}
          primaryAction={primaryAction}
          showSkip={true}
          onSkip={handleSkip}
          accessibilityLabel={personalize(HANDSON_TOUR_I18N_JA.tour.step3.a11y_title, { nickname })}
        />
      )}
    </div>
  );
}
