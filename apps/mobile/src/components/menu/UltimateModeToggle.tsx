import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { Alert, Pressable, Switch, View } from "react-native";
import { Text } from "../ui/Text";

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
  /**
   * いまのプランでは究極モードを使えない (錠。billing/03 §10.6)。押しても ON にせず、有料プランの案内を出す。
   * V4GenerateModal が、契約の要約の features.ai_feature_caps.menu_generation_ultimate が 0 のときに渡す
   */
  locked?: boolean;
}

/** 錠のトグルを押したときの案内の見出しと本文 (Web の究極モードの錠の文と同じ意味。billing/03 §10.6) */
export const ULTIMATE_MODE_LOCKED_ALERT_TITLE = "プランとお支払い";
export const ULTIMATE_MODE_LOCKED_ALERT_MESSAGE =
  "究極モードは有料プランでお使いいただけます。設定の「プランとお支払い」からお申し込みいただけます。";

// ============================================================
// UltimateModeToggle
// ============================================================
// 究極モード: AIが献立を自動で見直し、栄養バランスを改善する。
// 使えるかどうかはプランで決まる (billing/03 §0.6。無料プランは使えない)。使えないプランでは locked で錠を出し、
// 押しても ON にせず、有料プランの案内 (Alert) を出す。最後の砦はサーバの 403 (AI_FEATURE_NOT_IN_PLAN)。WEB の AI アシスタントと同じ。
export const UltimateModeToggle: React.FC<Props> = ({
  value,
  onValueChange,
  disabled = false,
  locked = false,
}) => {
  const checked = value && !locked;
  const handlePress = () => {
    if (locked) {
      Alert.alert(ULTIMATE_MODE_LOCKED_ALERT_TITLE, ULTIMATE_MODE_LOCKED_ALERT_MESSAGE);
      return;
    }
    onValueChange(!value);
  };
  return (
    <Pressable
      testID="ultimate-mode-toggle"
      accessibilityRole="switch"
      accessibilityLabel={locked ? "究極モード (有料プラン)" : "究極モード"}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={handlePress}
      style={{
        padding: spacing.md,
        borderRadius: radius.xl,
        backgroundColor: checked ? C.accentLight : C.bg,
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
          backgroundColor: checked ? C.accent : C.border,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons
          name={locked ? "lock-closed" : "color-wand"}
          size={20}
          color={checked ? C.card : C.textLight}
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
        {locked ? (
          <Text testID="ultimate-mode-locked-note" style={{ fontSize: 12, color: C.accent, marginTop: 2 }}>
            有料プランでお使いいただけます
          </Text>
        ) : null}
      </View>

      {/* スイッチ (見た目だけ)。押す操作は行全体の Pressable が受けるので、Switch 自身は触れないようにして二重に切り替わるのを防ぐ */}
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Switch
          value={checked}
          disabled={disabled}
          trackColor={{ false: C.border, true: C.accent }}
          thumbColor={C.card}
        />
      </View>
    </Pressable>
  );
};
