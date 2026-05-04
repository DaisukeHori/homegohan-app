import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { Alert, Pressable, Switch, Text, View } from "react-native";

import { radius, spacing } from "../../theme";

// ============================================================
// Color constants (V4GenerateModal と共有の定数に揃える)
// ============================================================
const C = {
  bg: "#F7F6F3",
  card: "#FFFFFF",
  text: "#2D2D2D",
  textLight: "#6B6B6B",
  textMuted: "#A0A0A0",
  purple: "#7C6BA0",
  border: "#E8E8E8",
} as const;

// ============================================================
// Props
// ============================================================
interface Props {
  /** 将来用プレースホルダ。本 PR では常に false (disabled) */
  enabled?: boolean;
}

// ============================================================
// UltimateModeToggle
// ============================================================
export const UltimateModeToggle: React.FC<Props> = ({ enabled = false }) => {
  const handlePress = () => {
    if (!enabled) {
      Alert.alert(
        "究極モード",
        "究極モードは Premium プラン準備中です。今しばらくお待ちください。"
      );
    }
  };

  return (
    <Pressable
      testID="ultimate-mode-toggle"
      onPress={handlePress}
      style={{
        padding: spacing.md,
        borderRadius: radius.xl,
        backgroundColor: C.bg,
        opacity: enabled ? 1 : 0.65,
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
          backgroundColor: C.border,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name="ribbon" size={20} color={C.purple} />
      </View>

      {/* テキスト */}
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ fontSize: 14, fontWeight: "700", color: C.text }}>
            究極モード
          </Text>
          <View
            style={{
              backgroundColor: "#FEF3C7",
              paddingHorizontal: 6,
              paddingVertical: 2,
              borderRadius: radius.sm,
            }}
          >
            <Text style={{ fontSize: 10, fontWeight: "700", color: "#D97706" }}>
              Premium
            </Text>
          </View>
          <Text style={{ fontSize: 11, color: C.textMuted }}>準備中</Text>
        </View>
        <Text style={{ fontSize: 12, color: C.textLight, marginTop: 2 }}>
          AIが献立を自動で見直し、栄養バランスを改善
        </Text>
      </View>

      {/* トグルスイッチ (常に off / disabled) */}
      <Switch
        value={false}
        disabled={!enabled}
        trackColor={{ false: C.border, true: C.border }}
        thumbColor={C.card}
      />
    </Pressable>
  );
};
