import { useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../src/theme/colors';

export default function MealsScanTab() {
  const router = useRouter();
  const [analyzing, setAnalyzing] = useState(false);

  const pickAndAnalyze = async (source: 'camera' | 'library') => {
    let result: ImagePicker.ImagePickerResult;

    if (source === 'camera') {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('権限が必要です', 'カメラへのアクセスを許可してください。');
        return;
      }
      result = await ImagePicker.launchCameraAsync({
        base64: true,
        quality: 0.7,
        mediaTypes: ['images'] as any,
      });
    } else {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('権限が必要です', '写真ライブラリへのアクセスを許可してください。');
        return;
      }
      result = await ImagePicker.launchImageLibraryAsync({
        base64: true,
        quality: 0.7,
        mediaTypes: ['images'] as any,
      });
    }

    if (result.canceled || !result.assets?.[0]?.base64) return;

    setAnalyzing(true);
    try {
      const base64 = result.assets[0].base64!;
      const webUrl = process.env.EXPO_PUBLIC_WEB_URL ?? 'https://homegohan-app.vercel.app';
      const response = await fetch(`${webUrl}/api/ai/analyze-meal-photo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: [{ base64, mimeType: 'image/jpeg' }],
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error((err as any)?.error ?? `HTTP ${response.status}`);
      }

      const data = await response.json();
      const prefill = encodeURIComponent(JSON.stringify(data));
      router.push(`/web-prefill?path=/meals/new&prefill=${prefill}`);
    } catch (e) {
      Alert.alert('解析失敗', String(e));
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
        gap: 16,
        backgroundColor: colors.bg,
      }}
    >
      <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 24 }}>
        食事を記録
      </Text>

      <Pressable
        testID="meals-scan-camera"
        onPress={() => pickAndAnalyze('camera')}
        disabled={analyzing}
        style={{
          flexDirection: 'row',
          gap: 8,
          padding: 16,
          backgroundColor: colors.accent,
          borderRadius: 12,
          width: '100%',
          justifyContent: 'center',
          alignItems: 'center',
          opacity: analyzing ? 0.6 : 1,
        }}
      >
        <Ionicons name="camera" size={20} color="#FFF" />
        <Text style={{ color: '#FFF', fontWeight: '700', fontSize: 15 }}>撮影する</Text>
      </Pressable>

      <Pressable
        testID="meals-scan-library"
        onPress={() => pickAndAnalyze('library')}
        disabled={analyzing}
        style={{
          flexDirection: 'row',
          gap: 8,
          padding: 16,
          backgroundColor: colors.card,
          borderRadius: 12,
          width: '100%',
          justifyContent: 'center',
          alignItems: 'center',
          borderWidth: 1,
          borderColor: colors.border,
          opacity: analyzing ? 0.6 : 1,
        }}
      >
        <Ionicons name="image-outline" size={20} color={colors.text} />
        <Text style={{ color: colors.text, fontWeight: '700', fontSize: 15 }}>ライブラリから選ぶ</Text>
      </Pressable>

      {analyzing && (
        <View style={{ marginTop: 24, alignItems: 'center' }}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={{ marginTop: 8, color: colors.textMuted }}>AI が解析中...</Text>
        </View>
      )}
    </View>
  );
}
