import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";

import { getApi } from "../../lib/api";
import { colors, radius, shadows, spacing } from "../../theme";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MealAnalysis {
  dishes: { name: string; kcal: number; role: string; ingredients: string[] }[];
}

interface Props {
  visible: boolean;
  onClose: () => void;
  onResult: (analysis: MealAnalysis) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function PhotoEditModal({ visible, onClose, onResult }: Props) {
  const [photos, setPhotos] = useState<string[]>([]); // base64
  const [analyzing, setAnalyzing] = useState(false);

  // モーダルが閉じたときに state をリセット
  function handleClose() {
    setPhotos([]);
    setAnalyzing(false);
    onClose();
  }

  const pickPhoto = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("権限エラー", "写真ライブラリへのアクセスを許可してください");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"] as any,
      base64: true,
      quality: 0.7,
    });
    if (!result.canceled) {
      const b64 = result.assets[0].base64;
      if (b64) setPhotos((prev) => [...prev, b64]);
    }
  };

  const removePhoto = (index: number) => {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  };

  const analyze = async () => {
    if (photos.length === 0) return;
    setAnalyzing(true);
    try {
      const api = getApi();
      const data = await api.post<MealAnalysis>("/api/ai/analyze-meal-photo", {
        images: photos.map((b64) => ({ base64: b64, mimeType: "image/jpeg" })),
      });
      onResult(data);
      handleClose();
    } catch (e: any) {
      Alert.alert("解析エラー", "写真の解析に失敗しました");
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={handleClose}
    >
      <View
        style={{
          flex: 1,
          justifyContent: "flex-end",
          backgroundColor: "rgba(0,0,0,0.4)",
        }}
      >
        <View
          testID="photo-edit-modal"
          style={{
            backgroundColor: colors.bg,
            borderTopLeftRadius: radius["2xl"],
            borderTopRightRadius: radius["2xl"],
            maxHeight: "85%",
            paddingBottom: spacing["2xl"],
            ...shadows.lg,
          }}
        >
          {/* ヘッダー */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              padding: spacing.lg,
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
            }}
          >
            <Text style={{ fontSize: 17, fontWeight: "700", color: colors.text }}>
              写真から解析
            </Text>
            <Pressable
              testID="photo-edit-close"
              onPress={handleClose}
              hitSlop={8}
              style={{ padding: 4 }}
            >
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </Pressable>
          </View>

          {/* 説明文 */}
          <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
            <Text style={{ fontSize: 13, color: colors.textMuted, lineHeight: 18 }}>
              食事の写真をアップロードすると、AIが料理名・カロリーを自動で認識します。複数枚まとめて解析できます。
            </Text>
          </View>

          {/* プレビュー横スクロール */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ marginTop: spacing.lg }}
            contentContainerStyle={{
              paddingHorizontal: spacing.lg,
              gap: spacing.sm,
              alignItems: "flex-start",
            }}
          >
            {photos.map((p, i) => (
              <View
                key={i}
                style={{
                  width: 90,
                  height: 90,
                  borderRadius: radius.lg,
                  overflow: "visible",
                  position: "relative",
                }}
              >
                <Image
                  source={{ uri: `data:image/jpeg;base64,${p}` }}
                  style={{
                    width: 90,
                    height: 90,
                    borderRadius: radius.lg,
                    backgroundColor: colors.card,
                  }}
                />
                <Pressable
                  testID={`photo-edit-remove-${i}`}
                  onPress={() => removePhoto(i)}
                  style={{
                    position: "absolute",
                    top: -6,
                    right: -6,
                    backgroundColor: colors.bg,
                    borderRadius: 10,
                    padding: 0,
                  }}
                >
                  <Ionicons name="close-circle" size={22} color={colors.error} />
                </Pressable>
              </View>
            ))}

            {/* + 写真追加ボタン */}
            <Pressable
              testID="photo-edit-add-photo"
              onPress={pickPhoto}
              style={{
                width: 90,
                height: 90,
                borderRadius: radius.lg,
                borderWidth: 1.5,
                borderColor: colors.accent,
                borderStyle: "dashed",
                backgroundColor: colors.accentLight,
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
              }}
            >
              <Ionicons name="add" size={28} color={colors.accent} />
              <Text style={{ fontSize: 11, fontWeight: "600", color: colors.accent }}>
                写真追加
              </Text>
            </Pressable>
          </ScrollView>

          {/* 解析ボタン */}
          <View
            style={{
              paddingHorizontal: spacing.lg,
              paddingTop: spacing.lg,
              paddingBottom: spacing.sm,
            }}
          >
            <Pressable
              testID="photo-edit-analyze-btn"
              onPress={analyze}
              disabled={photos.length === 0 || analyzing}
              style={({ pressed }: { pressed: boolean }) => ({
                alignItems: "center" as const,
                justifyContent: "center" as const,
                paddingVertical: spacing.md,
                borderRadius: radius.lg,
                backgroundColor: colors.accent,
                opacity: photos.length === 0 || analyzing || pressed ? 0.5 : 1,
                flexDirection: "row" as const,
                gap: spacing.sm,
              })}
            >
              {analyzing ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Ionicons name="sparkles-outline" size={18} color="#FFF" />
                  <Text style={{ fontSize: 15, fontWeight: "700", color: "#FFF" }}>
                    AIで解析する
                  </Text>
                </>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
