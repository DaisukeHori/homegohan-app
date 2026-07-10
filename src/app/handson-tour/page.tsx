'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import Image from 'next/image';
import { createClient } from '@/lib/supabase/client';
import { TourProgress } from '@/components/handson-tour/TourProgress';
import { useReducedMotion } from '@/components/handson-tour/useReducedMotion';
import { useTour } from '@/contexts/TourContext';
import {
  HANDSON_TOUR_I18N_JA,
  HANDSON_TOUR_ROUTES,
  personalize,
  fireAnalytics,
} from '@homegohan/handson-tour-shared';

function safeNickname(raw: string | null | undefined): string {
  if (!raw) return 'あなた';
  const trimmed = raw.trim();
  if (!trimmed) return 'あなた';
  if (trimmed.length > 30) return `${trimmed.slice(0, 30)}…`;
  return trimmed;
}

export default function HandsonTourWelcomePage() {
  const router = useRouter();
  const prefersReducedMotion = useReducedMotion();
  const mountTime = useRef(Date.now());

  const [nickname, setNickname] = useState('あなた');
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  // #1045 round-2 (Fable Warning): force フローが /handson-tour/replay 経由の
  // HttpOnly Cookie に移った (F6-05) ため、このページで URL クエリの force フラグを
  // 読んでも常に false になり、設定画面からの「もう一度見る」でも entry_source が
  // 'auto' になって settings_force が計測されなくなっていた。
  // layout.tsx がサーバー側で Cookie を判定して TourProvider に渡した entrySource を
  // 参照することで、この画面でも正しい entry_source を使う。
  const { entrySource } = useTour();

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      setUserId(user.id);
      supabase
        .from('user_profiles')
        .select('nickname')
        // #1045 round-2 (ついでに修正・#1025 同型バグ): user_profiles の PK は `id`
        // (auth.users(id) 参照) で `user_id` 列は存在しない。以前は .eq('user_id', ...)
        // が黙って 0 件ヒットし、ニックネームが常に「あなた」固定になっていた。
        .eq('id', user.id)
        .single()
        .then(({ data }) => {
          if (data?.nickname) {
            setNickname(safeNickname(data.nickname));
          }
        });
    });
  }, []);

  // mount 時に eligible + step_viewed (step=0) を発火
  useEffect(() => {
    if (!userId) return;
    const now = new Date().toISOString();
    const common = {
      user_id: userId,
      timestamp: now,
      platform: 'web' as const,
      app_version: '1.0.0',
    };
    fireAnalytics('handson_tour_eligible', { ...common, entry_source: entrySource });
    fireAnalytics('handson_tour_step_viewed', { ...common, step: 0 });
  }, [userId, entrySource]);

  const i18n = HANDSON_TOUR_I18N_JA.tour.step0;

  const title = personalize(i18n.title, { nickname });
  const subtitle = i18n.subtitle;

  const handleStart = () => {
    if (isTransitioning) return;
    setIsTransitioning(true);
    if (userId) {
      const now = new Date().toISOString();
      const dwell_ms = Date.now() - mountTime.current;
      const common = { user_id: userId, timestamp: now, platform: 'web' as const, app_version: '1.0.0' };
      fireAnalytics('handson_tour_started', { ...common, entry_source: entrySource });
      fireAnalytics('handson_tour_step_completed', { ...common, step: 0, dwell_ms });
    }
    router.push(HANDSON_TOUR_ROUTES.step1);
  };

  const handleSkip = async () => {
    if (userId) {
      const now = new Date().toISOString();
      fireAnalytics('handson_tour_skipped', {
        user_id: userId,
        timestamp: now,
        platform: 'web' as const,
        app_version: '1.0.0',
        step: 0,
        reason: 'user_action',
      });
    }
    try {
      await fetch('/api/handson-tour/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 0, reason: 'user_action' }),
      });
    } catch {
      // ネットワークエラー時もローカルでスキップ
    }
    router.push('/home');
  };

  const transition = prefersReducedMotion
    ? { duration: 0.1 }
    : { duration: 0.3, ease: [0, 0, 0.58, 1] as [number, number, number, number] };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" aria-hidden="true" />

      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-step0-title"
        aria-describedby="tour-step0-subtitle"
        data-testid="tour-step-0"
        initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
        transition={transition}
        className="relative bg-white rounded-2xl mx-4 w-full max-w-[480px] p-8 flex flex-col items-center text-center shadow-2xl"
        style={{ maxHeight: '100dvh', overflowY: 'auto' }}
      >
        <div className="mt-4 mb-8">
          <Image
            src="/icon.png"
            alt=""
            aria-hidden="true"
            width={96}
            height={96}
            className="rounded-2xl shadow-md"
          />
        </div>

        <h1
          id="tour-step0-title"
          data-testid="tour-step-0-title"
          className="text-2xl font-bold text-gray-900 mb-4"
          style={{ maxWidth: 320 }}
        >
          {title}
        </h1>

        <p
          id="tour-step0-subtitle"
          data-testid="tour-step-0-subtitle"
          className="text-base text-gray-600 mb-10 leading-relaxed"
          style={{ maxWidth: 280, lineHeight: 1.5 }}
        >
          {subtitle}
        </p>

        <TourProgress current={1} total={5} />

        <div className="mt-10 w-full flex flex-col items-center gap-4">
          <button
            data-testid="tour-step-0-start"
            onClick={handleStart}
            disabled={isTransitioning}
            aria-label="ハンズオンを はじめる"
            className="bg-blue-600 text-white font-semibold rounded-xl w-4/5 disabled:opacity-50 flex items-center justify-center"
            style={{ height: 56, maxWidth: 320 }}
          >
            {i18n.start_button}
          </button>

          <button
            data-testid="tour-step-0-skip"
            onClick={handleSkip}
            aria-label="チュートリアルを終了する"
            className="text-gray-500 hover:text-gray-700 font-medium"
            style={{ minHeight: 44, minWidth: 88, padding: '12px 24px' }}
          >
            {i18n.later_button}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
