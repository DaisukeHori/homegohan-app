import React, { useState, useRef, useEffect } from 'react';
import { Animated, PanResponder, useWindowDimensions, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { Sparkles } from 'lucide-react-native';
import { colors } from '../../theme/colors';
import { AIAdvisorSheet } from './AIAdvisorSheet';

const FAB_SIZE = 56;
const STORAGE_KEY = 'aiFabPosition';

export const AIFloatingFab: React.FC = () => {
  const { width: SCREEN_W, height: SCREEN_H } = useWindowDimensions();
  const [visible, setVisible] = useState(false);

  const defaultX = SCREEN_W - FAB_SIZE - 16;
  const defaultY = SCREEN_H - FAB_SIZE - 100;

  const pan = useRef(new Animated.ValueXY({ x: defaultX, y: defaultY })).current;
  // 位置を独自 ref で追跡 (._value 内部 API を避ける)
  const posRef = useRef({ x: defaultX, y: defaultY });
  const dragStart = useRef<{ t: number; x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);

  // 初回 mount: AsyncStorage から復元
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then(saved => {
      if (saved) {
        try {
          const { x, y } = JSON.parse(saved);
          if (typeof x === 'number' && typeof y === 'number') {
            pan.setValue({ x, y });
            posRef.current = { x, y };
          }
        } catch {
          // ignore malformed JSON
        }
      }
    }).catch(() => {
      // ignore storage error
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 5 || Math.abs(g.dy) > 5,
      onPanResponderGrant: () => {
        dragStart.current = { t: Date.now(), x: posRef.current.x, y: posRef.current.y };
        isDraggingRef.current = false;
      },
      onPanResponderMove: (_, g) => {
        if (!dragStart.current) return;
        if (Math.abs(g.dx) > 5 || Math.abs(g.dy) > 5) {
          isDraggingRef.current = true;
        }
        const newX = dragStart.current.x + g.dx;
        const newY = dragStart.current.y + g.dy;
        pan.setValue({ x: newX, y: newY });
        posRef.current = { x: newX, y: newY };
      },
      onPanResponderRelease: () => {
        if (isDraggingRef.current) {
          // クランプして保存
          const clampedX = Math.max(8, Math.min((SCREEN_W || 400) - FAB_SIZE - 8, posRef.current.x));
          const clampedY = Math.max(40, Math.min((SCREEN_H || 800) - FAB_SIZE - 100, posRef.current.y));
          pan.setValue({ x: clampedX, y: clampedY });
          posRef.current = { x: clampedX, y: clampedY };
          AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ x: clampedX, y: clampedY })).catch(() => {});
        } else {
          setVisible(true);
        }
        dragStart.current = null;
        isDraggingRef.current = false;
      },
    })
  ).current;

  return (
    <>
      <Animated.View
        testID="ai-floating-fab"
        style={{
          position: 'absolute',
          transform: [{ translateX: pan.x }, { translateY: pan.y }],
          left: 0,
          top: 0,
          zIndex: 999,
        }}
        {...panResponder.panHandlers}
      >
        <View
          style={{
            width: FAB_SIZE,
            height: FAB_SIZE,
            borderRadius: FAB_SIZE / 2,
            overflow: 'hidden',
            shadowColor: '#000',
            shadowOpacity: 0.2,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 4 },
            elevation: 6,
          }}
        >
          <LinearGradient
            colors={[colors.accent, colors.warning]}
            style={{
              width: FAB_SIZE,
              height: FAB_SIZE,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Sparkles size={24} color="#FFF" />
          </LinearGradient>
        </View>
      </Animated.View>
      <AIAdvisorSheet visible={visible} onClose={() => setVisible(false)} />
    </>
  );
};
