import { Trash2 } from "lucide-react-native";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { colors, radius, shadows, spacing } from "../../theme";

interface Props {
  visible: boolean;
  mealName: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDeleteModal({ visible, mealName, onCancel, onConfirm }: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onCancel}
    >
      <View style={styles.overlay}>
        <View testID="confirm-delete-modal" style={styles.container}>
          {/* アイコン */}
          <View style={styles.iconWrapper}>
            <Trash2 size={32} color={colors.error} />
          </View>

          {/* タイトル */}
          <Text style={styles.title}>この食事を削除しますか?</Text>

          {/* 食事名 */}
          <Text style={styles.mealName}>
            「{mealName}」を削除します。{"\n"}この操作は取り消せません。
          </Text>

          {/* ボタン行 */}
          <View style={styles.buttonRow}>
            <Pressable
              testID="confirm-delete-cancel"
              onPress={onCancel}
              style={({ pressed }) => [
                styles.cancelButton,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text style={styles.cancelText}>キャンセル</Text>
            </Pressable>

            <Pressable
              testID="confirm-delete-confirm"
              onPress={onConfirm}
              style={({ pressed }) => [
                styles.confirmButton,
                pressed && styles.confirmButtonPressed,
              ]}
            >
              <Trash2 size={16} color="#fff" />
              <Text style={styles.confirmText}>削除する</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
  },
  container: {
    backgroundColor: colors.bg,
    borderRadius: radius["2xl"],
    padding: spacing["2xl"],
    width: "100%",
    alignItems: "center",
    gap: spacing.lg,
    ...shadows.lg,
  },
  iconWrapper: {
    width: 64,
    height: 64,
    borderRadius: radius.full,
    backgroundColor: colors.errorLight,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.text,
    textAlign: "center",
  },
  mealName: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: "center",
    lineHeight: 20,
  },
  buttonRow: {
    flexDirection: "row",
    gap: spacing.md,
    width: "100%",
    marginTop: spacing.sm,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  buttonPressed: {
    opacity: 0.7,
  },
  cancelText: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.textLight,
  },
  confirmButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radius.md,
    backgroundColor: colors.error,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: spacing.xs,
  },
  confirmButtonPressed: {
    backgroundColor: "#D32F2F",
  },
  confirmText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#fff",
  },
});
