// TourBubble — Mobile 版 吹き出しコンポーネント
// Canonical: docs/design/family/09-onboarding-handson-tour/07-components.md §3

import React from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { TargetRect, TourBubbleProps } from '@homegohan/handson-tour-shared';

const BUBBLE_DEFAULT_MAX_WIDTH = 280;
const BUBBLE_ARROW_SIZE = 8;
const SCREEN_PADDING = 16;

type BubbleActualPosition = 'top' | 'bottom' | 'left' | 'right' | 'center';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function calculateBubblePosition(
  target: TargetRect | null,
  preferredPosition: 'top' | 'bottom' | 'left' | 'right' | 'auto',
  bubbleWidth: number,
  bubbleEstimatedHeight: number,
  offset: number
): { x: number; y: number; actualPosition: BubbleActualPosition } {
  const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

  if (!target) {
    return {
      x: (screenWidth - bubbleWidth) / 2,
      y: (screenHeight - bubbleEstimatedHeight) / 2,
      actualPosition: 'center',
    };
  }

  let resolvedPosition: 'top' | 'bottom' | 'left' | 'right' = 'bottom';

  if (preferredPosition === 'auto') {
    const spaceBelow = screenHeight - (target.y + target.height);
    const spaceAbove = target.y;
    if (spaceBelow >= bubbleEstimatedHeight + offset + SCREEN_PADDING) {
      resolvedPosition = 'bottom';
    } else if (spaceAbove >= bubbleEstimatedHeight + offset + SCREEN_PADDING) {
      resolvedPosition = 'top';
    } else {
      resolvedPosition = 'bottom';
    }
  } else {
    resolvedPosition = preferredPosition;
  }

  switch (resolvedPosition) {
    case 'top':
      return {
        x: clamp(
          target.x + target.width / 2 - bubbleWidth / 2,
          SCREEN_PADDING,
          screenWidth - bubbleWidth - SCREEN_PADDING
        ),
        y: target.y - bubbleEstimatedHeight - offset,
        actualPosition: 'top',
      };
    case 'bottom':
      return {
        x: clamp(
          target.x + target.width / 2 - bubbleWidth / 2,
          SCREEN_PADDING,
          screenWidth - bubbleWidth - SCREEN_PADDING
        ),
        y: target.y + target.height + offset,
        actualPosition: 'bottom',
      };
    case 'left':
      return {
        x: target.x - bubbleWidth - offset,
        y: clamp(
          target.y + target.height / 2 - bubbleEstimatedHeight / 2,
          SCREEN_PADDING,
          screenHeight - bubbleEstimatedHeight - SCREEN_PADDING
        ),
        actualPosition: 'left',
      };
    case 'right':
      return {
        x: target.x + target.width + offset,
        y: clamp(
          target.y + target.height / 2 - bubbleEstimatedHeight / 2,
          SCREEN_PADDING,
          screenHeight - bubbleEstimatedHeight - SCREEN_PADDING
        ),
        actualPosition: 'right',
      };
    default:
      return {
        x: clamp(
          target.x + target.width / 2 - bubbleWidth / 2,
          SCREEN_PADDING,
          screenWidth - bubbleWidth - SCREEN_PADDING
        ),
        y: target.y + target.height + offset,
        actualPosition: 'bottom',
      };
  }
}

function Arrow({ actualPosition }: { actualPosition: BubbleActualPosition }) {
  if (actualPosition === 'center') return null;

  const arrowStyle = (() => {
    switch (actualPosition) {
      case 'bottom':
        // 吹き出しが target の下 → 矢印は上向き (吹き出しトップ)
        return {
          top: -BUBBLE_ARROW_SIZE,
          left: '50%' as const,
          marginLeft: -BUBBLE_ARROW_SIZE,
          borderLeftWidth: BUBBLE_ARROW_SIZE,
          borderRightWidth: BUBBLE_ARROW_SIZE,
          borderBottomWidth: BUBBLE_ARROW_SIZE,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderBottomColor: '#FFFFFF',
        };
      case 'top':
        // 吹き出しが target の上 → 矢印は下向き (吹き出しボトム)
        return {
          bottom: -BUBBLE_ARROW_SIZE,
          left: '50%' as const,
          marginLeft: -BUBBLE_ARROW_SIZE,
          borderLeftWidth: BUBBLE_ARROW_SIZE,
          borderRightWidth: BUBBLE_ARROW_SIZE,
          borderTopWidth: BUBBLE_ARROW_SIZE,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderTopColor: '#FFFFFF',
        };
      case 'right':
        return {
          left: -BUBBLE_ARROW_SIZE,
          top: '50%' as const,
          marginTop: -BUBBLE_ARROW_SIZE,
          borderTopWidth: BUBBLE_ARROW_SIZE,
          borderBottomWidth: BUBBLE_ARROW_SIZE,
          borderRightWidth: BUBBLE_ARROW_SIZE,
          borderTopColor: 'transparent',
          borderBottomColor: 'transparent',
          borderRightColor: '#FFFFFF',
        };
      case 'left':
        return {
          right: -BUBBLE_ARROW_SIZE,
          top: '50%' as const,
          marginTop: -BUBBLE_ARROW_SIZE,
          borderTopWidth: BUBBLE_ARROW_SIZE,
          borderBottomWidth: BUBBLE_ARROW_SIZE,
          borderLeftWidth: BUBBLE_ARROW_SIZE,
          borderTopColor: 'transparent',
          borderBottomColor: 'transparent',
          borderLeftColor: '#FFFFFF',
        };
      default:
        return {};
    }
  })();

  return <View style={[styles.arrow, arrowStyle]} />;
}

export function TourBubble(props: TourBubbleProps) {
  const { target, bubble, position, primaryAction, progress, offset } = props;
  const maxWidth = bubble.maxWidth ?? BUBBLE_DEFAULT_MAX_WIDTH;

  // 高さは内容によって変わるが、概算で計算する
  const estimatedHeight = 120;

  const pos = calculateBubblePosition(target, position, maxWidth, estimatedHeight, offset);

  return (
    <View
      testID="tour-bubble"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[
        styles.bubble,
        {
          position: 'absolute',
          left: pos.x,
          top: pos.y,
          maxWidth,
        },
      ]}
    >
      <Arrow actualPosition={pos.actualPosition} />

      {/* 進捗ドット (bubble 内) */}
      {progress && (
        <View style={styles.progressContainer}>
          {Array.from({ length: progress.total }).map((_, i) => (
            <View
              key={i}
              accessible={false}
              style={[
                styles.progressDot,
                i + 1 <= progress.current ? styles.progressDotActive : styles.progressDotInactive,
              ]}
            />
          ))}
        </View>
      )}

      {/* タイトル */}
      {bubble.title && (
        <Text testID="tour-bubble-title" style={styles.title}>
          {bubble.title}
        </Text>
      )}

      {/* 本文 */}
      <Text testID="tour-bubble-body" style={styles.body}>
        {bubble.body}
      </Text>

      {/* primary action */}
      {primaryAction && (
        <Pressable
          testID="tour-next-button"
          onPress={primaryAction.onPress}
          disabled={primaryAction.disabled}
          accessibilityRole="button"
          accessibilityLabel={primaryAction.label}
          style={[styles.button, primaryAction.disabled && styles.buttonDisabled]}
        >
          {primaryAction.showSpinner ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.buttonText}>{primaryAction.label}</Text>
          )}
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 8,
  },
  arrow: {
    position: 'absolute',
    width: 0,
    height: 0,
  },
  progressContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 8,
    gap: 8,
  },
  progressDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  progressDotActive: {
    backgroundColor: '#2563EB',
  },
  progressDotInactive: {
    backgroundColor: '#D1D5DB',
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 8,
  },
  body: {
    fontSize: 14,
    color: '#374151',
    lineHeight: 20,
    marginBottom: 12,
  },
  button: {
    backgroundColor: '#2563EB',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
});
