import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
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

  const takePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("権限エラー", "カメラへのアクセスを許可してください");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"] as any,
      base64: true,
      quality: 0.7,
    });
    if (!result.canceled) {
      const b64 = result.assets[0].base64;
      if (b64) setPhotos((prev) => [...prev, b64]);
    }
  };

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
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
        <View
          testID="photo-edit-modal"
          style={{ flex: 1 }}
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
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <Ionicons name="camera" size={20} color={colors.text} />
              <Text style={{ fontSize: 17, fontWeight: "700", color: colors.text }}>
                写真から入力
              </Text>
            </View>
            <Pressable
              testID="photo-edit-close"
              onPress={handleClose}
              hitSlop={8}
              style={{ padding: 4 }}
            >
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </Pressable>
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: spacing["2xl"] }}
          >
            {/* 説明文 2 行 */}
            <View
              style={{
                paddingHorizontal: spacing.lg,
                paddingTop: spacing.lg,
                gap: spacing.xs,
              }}
            >
              <Text style={{ fontSize: 13, color: colors.textMuted, lineHeight: 20 }}>
                食事の写真を撮影またはアップロードすると、AIが料理を認識して栄養素を推定します。
              </Text>
              <Text style={{ fontSize: 13, color: colors.textMuted, lineHeight: 20 }}>
                複数枚の写真をまとめて追加できます。
              </Text>
            </View>

            {/* 2 大ボタン (横並び 1:1) */}
            <View
              style={{
                flexDirection: "row",
                paddingHorizontal: spacing.lg,
                paddingTop: spacing.lg,
                gap: spacing.md,
              }}
            >
              {/* 撮影する */}
              <Pressable
                testID="photo-edit-camera-btn"
                onPress={takePhoto}
                style={({ pressed }: { pressed: boolean }) => ({
                  flex: 1,
                  backgroundColor: colors.card,
                  borderRadius: radius.xl,
                  paddingVertical: spacing.xl,
                  alignItems: "center" as const,
                  justifyContent: "center" as const,
                  gap: spacing.sm,
                  opacity: pressed ? 0.75 : 1,
                  ...shadows.sm,
                })}
              >
                <Ionicons name="camera-outline" size={28} color={colors.accent} />
                <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>
                  撮影する
                </Text>
              </Pressable>

              {/* 選択する */}
              <Pressable
                testID="photo-edit-gallery-btn"
                onPress={pickPhoto}
                style={({ pressed }: { pressed: boolean }) => ({
                  flex: 1,
                  backgroundColor: colors.card,
                  borderRadius: radius.xl,
                  paddingVertical: spacing.xl,
                  alignItems: "center" as const,
                  justifyContent: "center" as const,
                  gap: spacing.sm,
                  opacity: pressed ? 0.75 : 1,
                  ...shadows.sm,
                })}
              >
                <Ionicons name="images-outline" size={28} color={colors.accent} />
                <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>
                  選択する
                </Text>
              </Pressable>
            </View>

            {/* プレビュー横スクロール (写真追加済の場合のみ表示) */}
            {photos.length > 0 && (
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
              </ScrollView>
            )}

            {/* ヒント */}
            <View
              style={{
                marginHorizontal: spacing.lg,
                marginTop: spacing.lg,
                backgroundColor: colors.warningLight,
                borderRadius: radius.lg,
                padding: spacing.md,
                flexDirection: "row",
                gap: spacing.sm,
                alignItems: "flex-start",
              }}
            >
              <Text style={{ fontSize: 16, lineHeight: 22 }}>💡</Text>
              <Text
                style={{
                  flex: 1,
                  fontSize: 13,
                  color: colors.textLight,
                  lineHeight: 20,
                }}
              >
                AIが写真から料理名、カロリー、栄養素を自動で推定します。複数枚の場合はまとめて解析します。
              </Text>
            </View>
          </ScrollView>

          {/* AIで解析する ボタン (画面下部固定) */}
          <View
            style={{
              paddingHorizontal: spacing.lg,
              paddingTop: spacing.md,
              paddingBottom: spacing["2xl"],
              borderTopWidth: 1,
              borderTopColor: colors.border,
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
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
