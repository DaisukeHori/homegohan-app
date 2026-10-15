// ハンズオンツアーの Step 1〜3 を途中で抜ける (skip API + handson_tour_skipped + /home)。#1625 で Step 1 に入れた形を Step 2・3 でも使う (#1642)
// Canonical:
//   - docs/design/family/09-onboarding-handson-tour/01-trigger-flow.md §2.2 (Step 1〜3 の端末バックは skipped{reason:'hard_back'} + skipped_at + /home)
//   - docs/design/family/09-onboarding-handson-tour/03-step1-photo.md §9 (handson_tour_skipped は【あとで】が 'user_action'・端末バックが 'hard_back')

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { BackHandler } from 'react-native';

import { fireAnalytics } from '@homegohan/handson-tour-shared';

import { getApi } from '../lib/api';
import { tourAnalyticsPlatform } from './tour-platform';

/** ツアーを抜けたことを記録する API (handson_tour_skipped_at を付ける。src/app/api/handson-tour/skip/route.ts) */
export const TOUR_SKIP_URL = '/api/handson-tour/skip';

/**
 * ツアーを抜ける理由 (skip API の reason。src/lib/handson-tour/schemas.ts の HandsonTourSkipRequestSchema と同じ値)。
 * 'user_action' = エラー画面の【あとで】 / 'hard_back' = Android の端末バック
 */
export type TourSkipReason = 'user_action' | 'hard_back';

/** 途中で抜けられる Step (Step 0 は Welcome の【あとで】、Step 4 は完了の扱いが別なので、ここでは扱わない) */
export type TourLeavableStep = 1 | 2 | 3;

export interface LeaveTour {
  /**
   * ツアーを抜けた (skip を送ってホームへ向かった)。抜けたあとに届いた応答やタイマーで次の Step へ進めないために、
   * 画面の進む処理はこれを見て止まる
   */
  leftTourRef: MutableRefObject<boolean>;
  /** skip API と handson_tour_skipped を送ってから /home へ。続けて呼んでも 1 回だけ送る */
  leaveTour: (reason: TourSkipReason) => Promise<void>;
}

export function useLeaveTour(step: TourLeavableStep, userId: string | undefined): LeaveTour {
  const router = useRouter();
  const leftTourRef = useRef(false);

  const leaveTour = useCallback(
    async (reason: TourSkipReason) => {
      if (leftTourRef.current) return;
      leftTourRef.current = true;
      if (userId) {
        fireAnalytics('handson_tour_skipped', {
          user_id: userId,
          timestamp: new Date().toISOString(),
          platform: tourAnalyticsPlatform(),
          app_version: '1.0.0',
          step,
          reason,
        });
      }
      try {
        await getApi().post(TOUR_SKIP_URL, { step, reason });
      } catch {
        // 通信に失敗してもホームへ進める (Step 0 の【あとで】と同じ)
      }
      router.replace('/home' as never);
    },
    [step, userId, router],
  );

  return { leftTourRef, leaveTour };
}

/**
 * 吹き出しのオーバーレイ (TourOverlay の hardwareBackPress) を出していない画面 (保存の失敗のエラー画面・読み込み中など) で、
 * 端末バック (Android) を受ける。受けないと既定の戻る (前の Step の画面) になってしまう。true を返して既定の戻るを止める
 */
export function useTourHardBack(active: boolean, onHardBack: () => void | Promise<void>): void {
  useEffect(() => {
    if (!active) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      void onHardBack();
      return true;
    });
    return () => sub.remove();
  }, [active, onHardBack]);
}
