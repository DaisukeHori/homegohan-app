import AsyncStorage from "@react-native-async-storage/async-storage";
import { LinearGradient } from "expo-linear-gradient";
import { Sparkles } from "lucide-react-native";
import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  PanResponder,
} from "react-native";

import { colors, shadows } from "../../theme";
import { AIAdvisorSheet } from "./AIAdvisorSheet";

// ============================================================
// Constants
// ============================================================

const FAB_SIZE = 56;
const STORAGE_KEY = "aiFabPosition";
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

const DEFAULT_X = SCREEN_W - FAB_SIZE - 16;
const DEFAULT_Y = SCREEN_H - FAB_SIZE - 100;

// ============================================================
// Component
// ============================================================

export const AIFloatingFab: React.FC = () => {
  const [visible, setVisible] = useState(false);

  const pan = useRef(
    new Animated.ValueXY({ x: DEFAULT_X, y: DEFAULT_Y })
  ).current;

  const dragStart = useRef<{
    t: number;
    x: number;
    y: number;
  } | null>(null);
  const isDraggingRef = useRef(false);

  // mount 時: AsyncStorage から位置を復元
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((saved) => {
        if (saved) {
          try {
            const { x, y } = JSON.parse(saved);
            pan.setValue({ x, y });
          } catch {
            // ignore malformed JSON
          }
        }
      })
      .catch(() => {
        // ignore storage error
      });
  }, [pan]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_evt, g) =>
        Math.abs(g.dx) > 5 || Math.abs(g.dy) > 5,

      onPanResponderGrant: () => {
        // Animated.ValueXY の内部値を取得するために _value を参照
        const xVal = (pan.x as any)._value as number;
        const yVal = (pan.y as any)._value as number;
        dragStart.current = { t: Date.now(), x: xVal, y: yVal };
        isDraggingRef.current = false;
      },

      onPanResponderMove: (_evt, g) => {
        if (!dragStart.current) return;
        if (Math.abs(g.dx) > 5 || Math.abs(g.dy) > 5) {
          isDraggingRef.current = true;
        }
        const newX = Math.max(
          8,
          Math.min(SCREEN_W - FAB_SIZE - 8, dragStart.current.x + g.dx)
        );
        const newY = Math.max(
          40,
          Math.min(SCREEN_H - FAB_SIZE - 100, dragStart.current.y + g.dy)
        );
        pan.setValue({ x: newX, y: newY });
      },

      onPanResponderRelease: (_evt, g) => {
        if (!dragStart.current) return;
        const elapsed = Date.now() - dragStart.current.t;
        const moved =
          Math.abs(g.dx) > 5 || Math.abs(g.dy) > 5 || elapsed > 250;

        if (moved || isDraggingRef.current) {
          // ドラッグ終了 → 位置を保存
          const xVal = (pan.x as any)._value as number;
          const yVal = (pan.y as any)._value as number;
          AsyncStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ x: xVal, y: yVal })
          ).catch(() => {
            // ignore storage error
          });
        } else {
          // タップ → シートを開く
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
          position: "absolute",
          left: pan.x,
          top: pan.y,
          zIndex: 999,
          elevation: 10,
        }}
        {...panResponder.panHandlers}
      >
        <LinearGradient
          colors={[colors.accent, colors.warning]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{
            width: FAB_SIZE,
            height: FAB_SIZE,
            borderRadius: FAB_SIZE / 2,
            alignItems: "center",
            justifyContent: "center",
            ...(shadows.lg as object),
          }}
        >
          <Sparkles size={24} color="#FFF" />
        </LinearGradient>
      </Animated.View>

      <AIAdvisorSheet visible={visible} onClose={() => setVisible(false)} />
    </>
  );
};
