import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useState } from "react";
import { Pressable, StyleSheet } from "react-native";

import { colors, shadows } from "../../theme";
import { AIAdvisorSheet } from "./AIAdvisorSheet";

// ============================================================
// Component
// ============================================================

export const AIFloatingFab: React.FC = () => {
  const [visible, setVisible] = useState(false);

  return (
    <>
      <Pressable
        testID="ai-floating-fab"
        onPress={() => setVisible(true)}
        style={styles.fab}
      >
        <LinearGradient
          colors={[colors.accent, colors.warning]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.fabGradient}
        >
          <Ionicons name="sparkles" size={20} color="#FFF" />
        </LinearGradient>
      </Pressable>

      <AIAdvisorSheet visible={visible} onClose={() => setVisible(false)} />
    </>
  );
};

// ============================================================
// Styles
// ============================================================

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    bottom: 120,
    right: 16,
    width: 56,
    height: 56,
    borderRadius: 28,
    ...shadows.lg,
    zIndex: 1000,
    elevation: 10,
  },
  fabGradient: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },
});
