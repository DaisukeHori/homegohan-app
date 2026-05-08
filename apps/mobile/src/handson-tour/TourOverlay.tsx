// TourOverlay — Mobile 版
// Canonical: docs/design/family/09-onboarding-handson-tour/07-components.md §2.5
// MaskedView + Reanimated v3 で実装

import MaskedView from '@react-native-masked-view/masked-view';
import React, { useCallback, useEffect } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import type { TourOverlayProps } from '@homegohan/handson-tour-shared';
import { HANDSON_TOUR_CONSTANTS } from '@homegohan/handson-tour-shared';

import { TourBubble } from './TourBubble';
import { useTourOverlayLogic } from './useTourOverlayLogic';
import { useReducedMotion } from './useReducedMotion';

export function TourOverlay(props: TourOverlayProps) {
  const {
    targetTestId,
    targetTestIds,
    bubble,
    primaryAction,
    autoAdvanceMs,
    onAutoAdvance,
    autoAdvanceTappable,
    showSkip,
    onSkip,
    progress,
    dimOpacity = 0.6,
    spotlightPadding = 8,
    bubbleOffset = 12,
    accessibilityLabel = '使い方ガイド',
    forceReducedMotion,
    scrollRecalcIntervalMs,
    spotlightClickBehavior = 'block',
  } = props;

  const reducedMotion = useReducedMotion(forceReducedMotion);

  const { targetRect } = useTourOverlayLogic({
    targetTestId,
    targetTestIds,
    autoAdvanceMs,
    onAutoAdvance,
    scrollRecalcIntervalMs,
  });

  // Fade in アニメーション
  const opacity = useSharedValue(0);

  useEffect(() => {
    const duration = reducedMotion
      ? 0
      : HANDSON_TOUR_CONSTANTS.OVERLAY_FADE_IN_MS;
    opacity.value = withTiming(1, { duration });
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  // Android ハードバック対応
  const handleSkip = useCallback(() => {
    if (onSkip) onSkip();
  }, [onSkip]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (onSkip) {
        onSkip();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [onSkip]);

  // Spotlight の外タップ処理
  const handleOutsideTap = useCallback(() => {
    if (autoAdvanceTappable && onAutoAdvance) {
      onAutoAdvance();
    }
  }, [autoAdvanceTappable, onAutoAdvance]);

  // Mask element 構築
  const maskElement = (
    <View style={StyleSheet.absoluteFill}>
      {/* ベース: 黒 (マスクされる領域 = dim) */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'black' }]} />
      {/* 穴: 透明 (Spotlight = 見える領域) */}
      {targetRect && (
        <View
          style={{
            position: 'absolute',
            left: targetRect.x - spotlightPadding,
            top: targetRect.y - spotlightPadding,
            width: targetRect.width + spotlightPadding * 2,
            height: targetRect.height + spotlightPadding * 2,
            backgroundColor: 'transparent',
            borderRadius: 12,
          }}
        />
      )}
    </View>
  );

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, animatedStyle, styles.container]}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID="tour-overlay"
    >
      {/* Spotlight マスクで穴抜き背景 */}
      <MaskedView
        style={StyleSheet.absoluteFill}
        maskElement={maskElement}
      >
        <Pressable
          style={[StyleSheet.absoluteFill]}
          onPress={spotlightClickBehavior === 'block' ? undefined : handleOutsideTap}
          accessible={false}
        >
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: `rgba(0,0,0,${dimOpacity})` },
            ]}
          />
        </Pressable>
      </MaskedView>

      {/* Spotlight 外タップ (autoAdvanceTappable 時) */}
      {spotlightClickBehavior === 'forward' && (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={handleOutsideTap}
          accessible={false}
        />
      )}

      {/* 吹き出し */}
      <TourBubble
        target={targetRect}
        bubble={bubble}
        position={bubble.position}
        primaryAction={primaryAction}
        progress={progress}
        offset={bubbleOffset}
      />

      {/* スキップボタン */}
      {showSkip && (
        <Pressable
          testID="tour-skip-button"
          onPress={handleSkip}
          style={styles.skipButton}
          accessibilityRole="button"
          accessibilityLabel="チュートリアルを終了する"
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={styles.skipText}>あとで</Text>
        </Pressable>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    zIndex: 999,
  },
  skipButton: {
    position: 'absolute',
    top: 50,
    right: 16,
    paddingVertical: 8,
    paddingHorizontal: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  skipText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 15,
    fontWeight: '500',
  },
});
