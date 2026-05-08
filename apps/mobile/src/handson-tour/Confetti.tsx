// Confetti — Step 4 紙吹雪 (Reanimated v3 自前実装)
// Canonical: docs/design/family/09-onboarding-handson-tour/06-step4-graduation.md §3.3
// react-confetti は React DOM 専用のため独自実装
// CONFETTI_PARTICLE_COUNT=300, CONFETTI_DURATION_MS=3000

import React, { useEffect, useMemo } from 'react';
import { Dimensions, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { HANDSON_TOUR_CONSTANTS } from '@homegohan/handson-tour-shared';

import { useReducedMotion } from './useReducedMotion';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Primary カラーパレット + アクセントカラー (紙吹雪用)
const CONFETTI_COLORS = [
  '#2563EB', // blue-600
  '#10B981', // emerald-500
  '#F59E0B', // amber-500
  '#EF4444', // red-500
  '#8B5CF6', // violet-500
  '#EC4899', // pink-500
  '#06B6D4', // cyan-500
  '#F97316', // orange-500
];

type ParticleData = {
  id: number;
  x: number;
  startY: number;
  color: string;
  size: number;
  rotationSpeed: number;
  fallSpeed: number;
  delay: number;
  shape: 'rect' | 'circle' | 'ribbon';
};

function seededRandom(seed: number): number {
  const x = Math.sin(seed + 1) * 10000;
  return x - Math.floor(x);
}

function generateParticles(count: number): ParticleData[] {
  return Array.from({ length: count }, (_, i) => {
    const r1 = seededRandom(i * 7 + 1);
    const r2 = seededRandom(i * 7 + 2);
    const r3 = seededRandom(i * 7 + 3);
    const r4 = seededRandom(i * 7 + 4);
    const r5 = seededRandom(i * 7 + 5);
    const r6 = seededRandom(i * 7 + 6);

    const shapes: ParticleData['shape'][] = ['rect', 'circle', 'ribbon'];
    const shape = shapes[Math.floor(r6 * shapes.length)]!;

    return {
      id: i,
      x: r1 * SCREEN_WIDTH,
      startY: -20 - r2 * 80, // 画面上部からスタート
      color: CONFETTI_COLORS[Math.floor(r3 * CONFETTI_COLORS.length)]!,
      size: 6 + r4 * 8, // 6-14px
      rotationSpeed: 200 + r5 * 600, // 200-800ms で 1 回転
      fallSpeed: (HANDSON_TOUR_CONSTANTS.CONFETTI_DURATION_MS / 1000) * 0.7 + r6 * 1.5, // 2.1-3.6s で落下
      delay: r1 * (HANDSON_TOUR_CONSTANTS.CONFETTI_DURATION_MS * 0.3), // 最大 900ms の遅延
      shape,
    };
  });
}

function ConfettiParticle({ particle }: { particle: ParticleData }) {
  const translateY = useSharedValue(particle.startY);
  const translateX = useSharedValue(particle.x);
  const opacity = useSharedValue(1);
  const rotate = useSharedValue(0);

  useEffect(() => {
    const duration = particle.fallSpeed * 1000;
    const delay = particle.delay;

    // 落下アニメーション
    translateY.value = withDelay(
      delay,
      withTiming(SCREEN_HEIGHT + 20, {
        duration,
        easing: Easing.linear,
      })
    );

    // 横揺れ (sin 波形っぽく)
    translateX.value = withDelay(
      delay,
      withSequence(
        withTiming(particle.x + 30, { duration: duration / 3, easing: Easing.inOut(Easing.ease) }),
        withTiming(particle.x - 20, { duration: duration / 3, easing: Easing.inOut(Easing.ease) }),
        withTiming(particle.x + 10, { duration: duration / 3, easing: Easing.inOut(Easing.ease) })
      )
    );

    // 回転
    rotate.value = withDelay(
      delay,
      withTiming(360 * 3, {
        duration,
        easing: Easing.linear,
      })
    );

    // フェードアウト (落下の終盤)
    opacity.value = withDelay(
      delay + duration * 0.7,
      withTiming(0, {
        duration: duration * 0.3,
        easing: Easing.out(Easing.ease),
      })
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { rotate: `${rotate.value}deg` },
    ],
    opacity: opacity.value,
  }));

  const { size, color, shape } = particle;

  const shapeStyle = (() => {
    switch (shape) {
      case 'circle':
        return {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
        };
      case 'ribbon':
        return {
          width: size * 0.3,
          height: size * 2,
          borderRadius: 2,
          backgroundColor: color,
        };
      case 'rect':
      default:
        return {
          width: size,
          height: size * 0.6,
          borderRadius: 2,
          backgroundColor: color,
        };
    }
  })();

  return (
    <Animated.View
      style={[
        styles.particle,
        { left: 0, top: 0 },
        animatedStyle,
      ]}
      accessible={false}
      importantForAccessibility="no"
    >
      <View style={shapeStyle} />
    </Animated.View>
  );
}

interface ConfettiProps {
  /** 紙吹雪を表示するか */
  visible: boolean;
  /** 動きを強制的に減らす (テスト用) */
  forceReducedMotion?: boolean;
}

export function Confetti({ visible, forceReducedMotion }: ConfettiProps) {
  const reducedMotion = useReducedMotion(forceReducedMotion);

  const particles = useMemo(
    () => generateParticles(HANDSON_TOUR_CONSTANTS.CONFETTI_PARTICLE_COUNT),
    []
  );

  if (!visible) return null;

  // prefers-reduced-motion 時は静的アイコン表示
  if (reducedMotion) {
    return (
      <View style={styles.reducedMotionContainer} accessible={false}>
        <Text style={styles.reducedMotionIcon}>🎓</Text>
      </View>
    );
  }

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" accessible={false}>
      {particles.map((particle) => (
        <ConfettiParticle key={particle.id} particle={particle} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  particle: {
    position: 'absolute',
  },
  reducedMotionContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  reducedMotionIcon: {
    fontSize: 64,
  },
});
