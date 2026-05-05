import { Plus, RefreshCw, ShoppingCart, Trash2, Users, X } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

import { getApi, getApiBaseUrl } from '../../lib/api';
import { supabase } from '../../lib/supabase';
import { colors, radius, spacing, typography } from '../../theme';
import { AddShoppingModal } from './AddShoppingModal';
import { type ShoppingItemData, ShoppingItem } from './ShoppingItem';

// スーパーの動線に合わせたカテゴリ順序
const CATEGORY_ORDER = [
  '青果（野菜・果物）',
  '精肉',
  '鮮魚',
  '乳製品・卵',
  '豆腐・練り物',
  '米・パン・麺',
  '調味料',
  '油・香辛料',
  '乾物・缶詰',
  '冷凍食品',
  '飲料',
  // 旧カテゴリとの互換性
  '野菜',
  '肉',
  '魚',
  '乳製品',
  '卵',
  '豆腐・大豆',
  '麺・米',
  '乾物',
  '食材',
  'その他',
];

function groupByCategoryOrder(items: ShoppingItemData[]): Array<[string, ShoppingItemData[]]> {
  const map = new Map<string, ShoppingItemData[]>();
  for (const item of items) {
    const key = item.category ?? 'その他';
    const arr = map.get(key) ?? [];
    arr.push(item);
    map.set(key, arr);
  }
  return Array.from(map.entries()).sort((a, b) => {
    const idxA = CATEGORY_ORDER.indexOf(a[0]);
    const idxB = CATEGORY_ORDER.indexOf(b[0]);
    return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
  });
}

interface Props {
  visible: boolean;
  onClose: () => void;
  onOpenAdd: () => void;   // ShoppingListModal 内で AddShoppingModal を開く場合の外部トリガー (未使用だが設計書 props 準拠)
  onOpenRange: () => void; // 再生成モーダル (本 PR では placeholder)
  onOpenServings?: () => void; // 人数設定モーダルを開く
}

export const ShoppingListModal: React.FC<Props> = ({
  visible,
  onClose,
  onOpenRange,
  onOpenServings,
}) => {
  const [items, setItems] = useState<ShoppingItemData[]>([]);
  const [loading, setLoading] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);
  const [addModalVisible, setAddModalVisible] = useState(false);

  const grouped = useMemo(() => groupByCategoryOrder(items), [items]);
  const totalCount = items.length;
  const uncheckedCount = items.filter((i) => !i.is_checked).length;

  // データ取得
  const load = useCallback(async () => {
    if (!visible) return;
    setLoading(true);
    try {
      const api = getApi();
      const data = await api.get<{ items: ShoppingItemData[] }>('/api/shopping-list');
      setItems(data?.items ?? []);
    } catch (e: any) {
      Alert.alert('読み込み失敗', e?.message ?? 'データの取得に失敗しました。');
    } finally {
      setLoading(false);
    }
  }, [visible]);

  useEffect(() => {
    if (visible) {
      load();
    }
  }, [visible, load]);

  // チェック切替 (楽観的更新)
  const handleToggleCheck = useCallback(async (id: string, next: boolean) => {
    // 楽観的に更新
    setItems((prev) =>
      prev.map((x) => (x.id === id ? { ...x, is_checked: next } : x))
    );
    try {
      const api = getApi();
      await api.patch(`/api/shopping-list/${id}`, { isChecked: next });
    } catch (e: any) {
      // 失敗時は revert
      setItems((prev) =>
        prev.map((x) => (x.id === id ? { ...x, is_checked: !next } : x))
      );
      Alert.alert('更新失敗', e?.message ?? '更新に失敗しました。');
    }
  }, []);

  // バリアント切替 (楽観的更新)
  const handleToggleVariant = useCallback(async (item: ShoppingItemData) => {
    if (!item.quantity_variants || item.quantity_variants.length <= 1) return;
    const nextIndex =
      ((item.selected_variant_index ?? 0) + 1) % item.quantity_variants.length;
    const nextQuantity = item.quantity_variants[nextIndex]?.display ?? item.quantity;

    // 楽観的に更新
    setItems((prev) =>
      prev.map((x) =>
        x.id === item.id
          ? { ...x, selected_variant_index: nextIndex, quantity: nextQuantity }
          : x
      )
    );
    try {
      const api = getApi();
      const res = await api.patch<{ item?: ShoppingItemData }>(`/api/shopping-list/${item.id}`, {
        selectedVariantIndex: nextIndex,
      });
      if (res?.item) {
        setItems((prev) =>
          prev.map((x) =>
            x.id === item.id
              ? { ...x, quantity: res.item!.quantity, selected_variant_index: nextIndex }
              : x
          )
        );
      }
    } catch {
      // 失敗時は revert
      setItems((prev) =>
        prev.map((x) =>
          x.id === item.id
            ? { ...x, selected_variant_index: item.selected_variant_index, quantity: item.quantity }
            : x
        )
      );
    }
  }, []);

  // 削除 (楽観的)
  const handleDelete = useCallback((id: string) => {
    Alert.alert('削除', 'この項目を削除しますか？', [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '削除',
        style: 'destructive',
        onPress: async () => {
          const prev = items;
          setItems((cur) => cur.filter((x) => x.id !== id));
          try {
            const api = getApi();
            await api.del(`/api/shopping-list/${id}`);
          } catch (e: any) {
            setItems(prev);
            Alert.alert('削除失敗', e?.message ?? '削除に失敗しました。');
          }
        },
      },
    ]);
  }, [items]);

  // 全削除
  const handleClearAll = useCallback(() => {
    if (items.length === 0) return;
    Alert.alert('全削除', `${items.length} 件すべてを削除しますか？`, [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '全削除',
        style: 'destructive',
        onPress: async () => {
          setClearingAll(true);
          const snapshot = items;
          setItems([]);
          try {
            const { data } = await supabase.auth.getSession();
            const token = data.session?.access_token ?? null;
            const baseUrl = getApiBaseUrl();
            const itemIds = snapshot.map((i) => i.id);
            const res = await fetch(`${baseUrl}/api/shopping-list`, {
              method: 'DELETE',
              headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify({ itemIds }),
            });
            if (!res.ok) throw new Error('全削除に失敗しました');
          } catch (e: any) {
            setItems(snapshot);
            Alert.alert('削除失敗', e?.message ?? '全削除に失敗しました。');
          } finally {
            setClearingAll(false);
          }
        },
      },
    ]);
  }, [items]);

  return (
    <>
      <Modal
        testID="shopping-list-modal"
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={onClose}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.card }}>
          <View style={styles.sheet}>
            {/* ヘッダー */}
            <View style={styles.header}>
              <View style={styles.headerLeft}>
                <ShoppingCart size={18} color={colors.accent} />
                <Text style={styles.headerTitle}>買い物リスト</Text>
              </View>
              <View style={styles.headerRight}>
                {onOpenServings && (
                  <Pressable
                    testID="shopping-list-servings-btn"
                    onPress={onOpenServings}
                    style={styles.servingsBtn}
                    hitSlop={8}
                  >
                    <Users size={20} color={colors.textLight} />
                  </Pressable>
                )}
                <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={8}>
                  <X size={18} color={colors.textLight} />
                </Pressable>
              </View>
            </View>

            {/* サブタイトル */}
            {!loading && (
              <View style={styles.subtitle}>
                <Text style={styles.subtitleText}>
                  {totalCount} 件（未チェック {uncheckedCount} 件）
                </Text>
              </View>
            )}

            {/* リスト */}
            {loading ? (
              <View style={styles.loadingBox}>
                <ActivityIndicator color={colors.accent} />
              </View>
            ) : items.length === 0 ? (
              <View style={styles.emptyBox}>
                <ShoppingCart size={40} color={colors.textMuted} />
                <Text style={styles.emptyText}>買い物リストが空です</Text>
              </View>
            ) : (
              <ScrollView
                style={styles.list}
                contentContainerStyle={styles.listContent}
                showsVerticalScrollIndicator={false}
              >
                {grouped.map(([category, catItems]) => (
                  <View key={category}>
                    {/* カテゴリヘッダー */}
                    <View style={styles.categoryHeader}>
                      <Text style={styles.categoryHeaderText}>
                        {category} ({catItems.length})
                      </Text>
                    </View>
                    {/* アイテム */}
                    {catItems.map((item) => (
                      <ShoppingItem
                        key={item.id}
                        item={item}
                        onToggleCheck={handleToggleCheck}
                        onToggleVariant={handleToggleVariant}
                        onDelete={handleDelete}
                      />
                    ))}
                  </View>
                ))}
              </ScrollView>
            )}

            {/* フッターボタン */}
            <View style={styles.footer}>
              <Pressable
                testID="shopping-list-add-btn"
                style={styles.addBtn}
                onPress={() => setAddModalVisible(true)}
              >
                <Plus size={14} color={colors.textMuted} />
                <Text style={styles.addBtnText}>追加</Text>
              </Pressable>

              <Pressable
                testID="shopping-list-regenerate-btn"
                style={styles.regenBtn}
                onPress={onOpenRange}
              >
                <RefreshCw size={14} color="#fff" />
                <Text style={styles.regenBtnText}>献立から再生成</Text>
              </Pressable>

              <Pressable
                testID="shopping-list-clear-all-btn"
                style={[styles.clearBtn, (clearingAll || items.length === 0) && styles.clearBtnDisabled]}
                onPress={handleClearAll}
                disabled={clearingAll || items.length === 0}
              >
                {clearingAll ? (
                  <ActivityIndicator size="small" color={colors.textMuted} />
                ) : (
                  <Trash2 size={16} color={colors.textMuted} />
                )}
              </Pressable>
            </View>
          </View>
        </SafeAreaView>
      </Modal>

      {/* 追加モーダル (ShoppingListModal の上にスタック) */}
      <AddShoppingModal
        visible={addModalVisible}
        onClose={() => setAddModalVisible(false)}
        onAdded={() => {
          setAddModalVisible(false);
          load();
        }}
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
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
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
  servingsBtn: {
    width: 28,
    height: 28,
    borderRadius: radius.full,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    ...typography.h3,
    color: colors.text,
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: radius.full,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  subtitle: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  subtitleText: {
    ...typography.small,
    color: colors.textMuted,
  },
  loadingBox: {
    padding: spacing['3xl'],
    alignItems: 'center',
  },
  emptyBox: {
    padding: spacing['3xl'],
    alignItems: 'center',
    gap: spacing.md,
  },
  emptyText: {
    ...typography.body,
    color: colors.textMuted,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  categoryHeader: {
    backgroundColor: colors.accentLight,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginBottom: spacing.sm,
    marginTop: spacing.sm,
  },
  categoryHeaderText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.accent,
  },
  footer: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingBottom: spacing['2xl'],
  },
  addBtn: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
  },
  addBtnText: {
    ...typography.small,
    color: colors.textMuted,
  },
  regenBtn: {
    flex: 2,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.accent,
  },
  regenBtnText: {
    ...typography.smallBold,
    color: '#fff',
  },
  clearBtn: {
    width: 44,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  clearBtnDisabled: {
    opacity: 0.5,
  },
});
