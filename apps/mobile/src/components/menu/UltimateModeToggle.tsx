import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { Pressable, Switch, Text, View } from "react-native";

import { radius, spacing } from "../../theme";

// ============================================================
// Color constants (V4GenerateModal と共有の定数に揃える)
// ============================================================
const C = {
  bg: "#F7F6F3",
  card: "#FFFFFF",
  text: "#2D2D2D",
  textLight: "#6B6B6B",
  accent: "#E07A5F",
  accentLight: "#FDF0ED",
  border: "#E8E8E8",
} as const;

// ============================================================
// Props
// ============================================================
interface Props {
  /** 究極モードが ON か */
  value: boolean;
  /** 押されたとき、切り替え後の値を渡す */
  onValueChange: (next: boolean) => void;
  /** 生成中など、操作させないとき */
  disabled?: boolean;
}

// ============================================================
// UltimateModeToggle
// ============================================================
// 究極モード: AIが献立を自動で見直し、栄養バランスを改善する。
// 以前は Premium プラン向けとして常に OFF・操作不可 (「準備中」) だったが、
// プランによる制限は無く、全員が使える (#1142)。WEB の AI アシスタントと同じ。
export const UltimateModeToggle: React.FC<Props> = ({
  value,
  onValueChange,
  disabled = false,
}) => {
  return (
    <Pressable
      testID="ultimate-mode-toggle"
      accessibilityRole="switch"
      accessibilityLabel="究極モード"
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      style={{
        padding: spacing.md,
        borderRadius: radius.xl,
        backgroundColor: value ? C.accentLight : C.bg,
        opacity: disabled ? 0.6 : 1,
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.md,
      }}
    >
      {/* アイコン */}
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          backgroundColor: value ? C.accent : C.border,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons
          name="color-wand"
          size={20}
          color={value ? C.card : C.textLight}
        />
      </View>

      {/* テキスト */}
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14, fontWeight: "700", color: C.text }}>
          究極モード
        </Text>
        <Text style={{ fontSize: 12, color: C.textLight, marginTop: 2 }}>
          AIが献立を自動で見直し、栄養バランスを改善
        </Text>
        <Text style={{ fontSize: 12, color: C.textLight }}>
          通常より生成に時間がかかります
        </Text>
      </View>

      {/* スイッチ (見た目だけ)。押す操作は行全体の Pressable が受けるので、Switch 自身は触れないようにして二重に切り替わるのを防ぐ */}
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Switch
          value={value}
          disabled={disabled}
          trackColor={{ false: C.border, true: C.accent }}
          thumbColor={C.card}
        />
      </View>
    </Pressable>
  );
};
