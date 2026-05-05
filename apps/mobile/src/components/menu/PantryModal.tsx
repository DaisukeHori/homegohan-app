import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { getApi } from '../../lib/api';
import { colors } from '../../theme/colors';
import { radius, spacing } from '../../theme/spacing';
import { AddFridgeModal } from './AddFridgeModal';
import { PantryItem, type PantryItemData } from './PantryItem';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export const PantryModal: React.FC<Props> = ({ visible, onClose }) => {
  const [items, setItems] = useState<PantryItemData[]>([]);
  const [loading, setLoading] = useState(true);
  const [addVisible, setAddVisible] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const api = getApi();
      const res = await api.get<{ items: PantryItemData[] }>('/api/pantry');
      setItems(res.items ?? []);
    } catch (e: any) {
      Alert.alert('取得失敗', e?.message ?? '冷蔵庫の食材を取得できませんでした。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    load();
  }, [visible, load]);

  const handleDelete = useCallback(async (id: string) => {
    Alert.alert('削除', 'この食材を削除しますか？', [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '削除',
        style: 'destructive',
        onPress: async () => {
          try {
            const api = getApi();
            await api.del(`/api/pantry/${id}`);
            setItems((prev) => prev.filter((x) => x.id !== id));
          } catch (e: any) {
            Alert.alert('削除失敗', e?.message ?? '削除に失敗しました。');
          }
        },
      },
    ]);
  }, []);

  const handleAddSuccess = useCallback(() => {
    setAddVisible(false);
    load();
  }, [load]);

  return (
    <>
      <Modal
        testID="pantry-modal"
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={onClose}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.card }}>
          <View style={styles.sheet}>
            {/* Header */}
            <View style={styles.header}>
              <View style={styles.headerLeft}>
                <Ionicons name="snow-outline" size={18} color={colors.accent} />
                <Text style={styles.title}>冷蔵庫</Text>
                {!loading && (
                  <Text style={styles.count}>{items.length}品</Text>
                )}
              </View>
              <View style={styles.headerRight}>
                <Pressable
                  testID="pantry-add-btn"
                  onPress={() => setAddVisible(true)}
                  style={styles.addBtn}
                >
                  <Ionicons name="add" size={16} color={colors.accent} />
                  <Text style={styles.addBtnText}>追加</Text>
                </Pressable>
                <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={8}>
                  <Ionicons name="close" size={20} color={colors.textMuted} />
                </Pressable>
              </View>
            </View>

            {/* Divider */}
            <View style={styles.divider} />

            {/* Content */}
            {loading ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={colors.accent} />
                <Text style={styles.loadingText}>読み込み中...</Text>
              </View>
            ) : items.length === 0 ? (
              <View style={styles.emptyContainer}>
                <Ionicons name="nutrition-outline" size={36} color={colors.textMuted} />
                <Text style={styles.emptyText}>冷蔵庫は空です</Text>
              </View>
            ) : (
              <ScrollView
                style={styles.list}
                contentContainerStyle={styles.listContent}
                showsVerticalScrollIndicator={false}
              >
                {items.map((item) => (
                  <PantryItem
                    key={item.id}
                    item={item}
                    onDelete={handleDelete}
                  />
                ))}
              </ScrollView>
            )}
          </View>
        </SafeAreaView>
      </Modal>

      <AddFridgeModal
        visible={addVisible}
        onClose={() => setAddVisible(false)}
        onSuccess={handleAddSuccess}
      />
    </>
  );
};

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
  },
  count: {
    fontSize: 13,
    color: colors.textMuted,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.accentLight,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  addBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.lg,
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing['3xl'],
  },
  loadingText: {
    fontSize: 14,
    color: colors.textMuted,
  },
  emptyContainer: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing['3xl'],
  },
  emptyText: {
    fontSize: 14,
    color: colors.textMuted,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: spacing.lg,
  },
});
