'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { motion } from 'framer-motion';
import {
  HANDSON_TOUR_I18N_JA,
  HANDSON_TOUR_CONSTANTS,
  personalize,
  type SubStepOfStep4,
} from '@homegohan/handson-tour-shared';
import { createClient } from '@/lib/supabase/client';
import { useReducedMotion } from '@/components/handson-tour/useReducedMotion';

const Confetti = dynamic(() => import('react-confetti'), { ssr: false });

function safeNickname(raw: string | null | undefined): string {
  if (!raw) return 'あなた';
  const trimmed = raw.trim();
  if (!trimmed) return 'あなた';
  if (trimmed.length > 30) return `${trimmed.slice(0, 30)}…`;
  return trimmed;
}

export default function HandsonTourGraduatePage() {
  const router = useRouter();
  const prefersReducedMotion = useReducedMotion();
  const [subStep, setSubStep] = useState<SubStepOfStep4>('4.0');
  const [nickname, setNickname] = useState('あなた');
  const [isCompleteError, setIsCompleteError] = useState(false);
  const [windowSize, setWindowSize] = useState({ width: 0, height: 0 });
  const buttonActivationRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const i18n = HANDSON_TOUR_I18N_JA.tour.step4;

  useEffect(() => {
    setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    const handleResize = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      supabase
        .from('user_profiles')
        .select('nickname')
        .eq('user_id', user.id)
        .single()
        .then(({ data }) => {
          if (data?.nickname) setNickname(safeNickname(data.nickname));
        });
    });

    const delay = setTimeout(async () => {
      try {
        const res = await fetch('/api/handson-tour/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) throw new Error('complete_failed');
        setSubStep('4.1');

        buttonActivationRef.current = setTimeout(() => {
          setSubStep('4.2');
        }, HANDSON_TOUR_CONSTANTS.STEP4_BUTTON_ACTIVATION_MS);
      } catch {
        setIsCompleteError(true);
      }
    }, HANDSON_TOUR_CONSTANTS.STEP4_SAVING_DELAY_MS);

    return () => {
      clearTimeout(delay);
      if (buttonActivationRef.current) clearTimeout(buttonActivationRef.current);
    };
  }, []);

  const handleGoHome = () => {
    router.push('/home');
  };

  const handleRetry = () => {
    setIsCompleteError(false);
    setSubStep('4.0');

    const delay = setTimeout(async () => {
      try {
        const res = await fetch('/api/handson-tour/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) throw new Error('complete_failed');
        setSubStep('4.1');
        buttonActivationRef.current = setTimeout(() => {
          setSubStep('4.2');
        }, HANDSON_TOUR_CONSTANTS.STEP4_BUTTON_ACTIVATION_MS);
      } catch {
        setIsCompleteError(true);
      }
    }, HANDSON_TOUR_CONSTANTS.STEP4_SAVING_DELAY_MS);

    return () => clearTimeout(delay);
  };

  const gradTransition = prefersReducedMotion
    ? { duration: 0.1 }
    : { duration: 0.5, ease: [0, 0, 0.58, 1] as [number, number, number, number] };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" aria-hidden="true" />

      {(subStep === '4.1' || subStep === '4.2') && !prefersReducedMotion && (
        <Confetti
          width={windowSize.width}
          height={windowSize.height}
          numberOfPieces={HANDSON_TOUR_CONSTANTS.CONFETTI_PARTICLE_COUNT}
          recycle={false}
          style={{ position: 'fixed', top: 0, left: 0, zIndex: 52, pointerEvents: 'none' }}
        />
      )}

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-step4-title"
        aria-describedby="tour-step4-subtitle"
        data-testid="tour-step-4"
        className="relative bg-white rounded-2xl mx-4 w-full max-w-[480px] p-8 flex flex-col items-center text-center shadow-2xl z-[53]"
        style={{ maxHeight: '100dvh', overflowY: 'auto' }}
      >
        {subStep === '4.0' && !isCompleteError && (
          <div data-testid="tour-step-4-saving" className="flex flex-col items-center gap-4 py-12">
            <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <p className="text-gray-600">{i18n.saving_text}</p>
          </div>
        )}

        {isCompleteError && (
          <div data-testid="tour-step-4-error" className="flex flex-col items-center gap-4 py-8">
            <p className="text-xl font-bold text-gray-900">{i18n.error_title}</p>
            <p className="text-gray-600 text-sm">{i18n.error_subtitle}</p>
            <button
              data-testid="tour-step-4-retry"
              onClick={handleRetry}
              className="bg-blue-600 text-white px-8 py-3 rounded-xl font-semibold"
            >
              {i18n.retry_button}
            </button>
            <button
              data-testid="tour-step-4-error-skip"
              onClick={handleGoHome}
              className="text-gray-500 text-sm"
              style={{ minHeight: 44, padding: '8px 16px' }}
            >
              {i18n.error_later_button}
            </button>
          </div>
        )}

        {(subStep === '4.1' || subStep === '4.2') && !isCompleteError && (
          <motion.div
            data-testid="tour-step-4-graduate"
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={gradTransition}
            className="flex flex-col items-center w-full"
          >
            <div className="text-[80px] mt-4 mb-4">🎓</div>

            <h1
              id="tour-step4-title"
              data-testid="tour-step-4-title"
              className="text-2xl font-bold text-gray-900 mb-3"
            >
              {i18n.title}
            </h1>

            <p
              id="tour-step4-subtitle"
              data-testid="tour-step-4-subtitle"
              className="text-base text-gray-600 mb-8 leading-relaxed"
              style={{ maxWidth: 280 }}
            >
              {personalize(i18n.subtitle, { nickname })}
            </p>

            <div
              data-testid="tour-step-4-badge-card"
              className="flex flex-col items-center p-4 border-2 border-blue-300 bg-blue-50 rounded-xl mb-8"
              style={{ maxWidth: 240, width: '100%' }}
            >
              <div
                data-testid="tour-step-4-badge-icon"
                className="text-[64px] mb-2"
              >
                🎓
              </div>
              <span
                data-testid="tour-step-4-badge-label"
                className="text-sm font-semibold text-blue-800"
              >
                {i18n.badge_label}
              </span>
            </div>

            <button
              data-testid="tour-step-4-go-home"
              onClick={handleGoHome}
              disabled={subStep !== '4.2'}
              className="bg-blue-600 text-white font-semibold rounded-xl w-4/5 disabled:opacity-50 flex items-center justify-center transition-opacity"
              style={{ height: 56, maxWidth: 320 }}
              aria-label="ホームへ移動する"
            >
              {i18n.home_button}
            </button>
          </motion.div>
        )}
      </div>
    </div>
  );
}
