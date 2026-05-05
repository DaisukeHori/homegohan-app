import { Search, Trash2 } from "lucide-react-native";
import { Pressable, Text, TextInput, View } from "react-native";

import { getDishConfig } from "@homegohan/shared";
import { colors, radius, spacing } from "../../theme";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DishItem {
  name: string;
  role: string;
  kcal: number | null;
}

interface Props {
  dish: DishItem;
  index: number;
  onChange: (d: DishItem) => void;
  onDelete: () => void;
  onOpenCatalog: () => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ROLES = ["main", "side", "soup", "rice", "salad", "dessert"] as const;

const ROLE_LABELS: Record<string, string> = {
  main: "主菜",
  side: "副菜",
  soup: "汁物",
  rice: "ご飯",
  salad: "サラダ",
  dessert: "デザート",
};

// ─── Component ───────────────────────────────────────────────────────────────

export function DishEditor({ dish, index, onChange, onDelete, onOpenCatalog }: Props) {
  return (
    <View
      testID={`manual-edit-dish-${index}`}
      style={{
        backgroundColor: colors.card,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        padding: spacing.md,
        gap: spacing.sm,
      }}
    >
      {/* Header: 料理番号 + 削除 */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: colors.textMuted }}>
          料理 {index + 1}
        </Text>
        <Pressable
          onPress={onDelete}
          hitSlop={8}
          style={{
            padding: 4,
            borderRadius: radius.sm,
          }}
        >
          <Trash2 size={16} color={colors.error} />
        </Pressable>
      </View>

      {/* 料理名 + kcal */}
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <TextInput
          value={dish.name}
          onChangeText={(name) => onChange({ ...dish, name })}
          placeholder="料理名"
          placeholderTextColor={colors.textMuted}
          style={{
            flex: 1,
            backgroundColor: colors.bg,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.border,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            fontSize: 14,
            color: colors.text,
          }}
          autoCorrect={false}
        />
        <TextInput
          value={dish.kcal != null ? String(dish.kcal) : ""}
          onChangeText={(k) => {
            const n = k === "" ? null : Number(k.replace(/[^0-9]/g, ""));
            onChange({ ...dish, kcal: n });
          }}
          placeholder="kcal"
          placeholderTextColor={colors.textMuted}
          keyboardType="numeric"
          style={{
            width: 72,
            backgroundColor: colors.bg,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.border,
            paddingHorizontal: spacing.sm,
            paddingVertical: spacing.sm,
            fontSize: 14,
            color: colors.text,
            textAlign: "center",
          }}
        />
      </View>

      {/* Role pills */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
        {ROLES.map((r) => {
          const cfg = getDishConfig(r);
          const isActive = dish.role === r;
          const roleColor = colors[cfg.colorKey as keyof typeof colors] as string;
          return (
            <Pressable
              key={r}
              testID={`manual-edit-role-${r}`}
              onPress={() => onChange({ ...dish, role: r })}
              style={{
                paddingHorizontal: spacing.sm,
                paddingVertical: 4,
                borderRadius: radius.full,
                backgroundColor: isActive ? roleColor + "22" : colors.bg,
                borderWidth: 1,
                borderColor: isActive ? roleColor : colors.border,
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: isActive ? "700" : "500",
                  color: isActive ? roleColor : colors.textMuted,
                }}
              >
                {ROLE_LABELS[r] ?? r}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* カタログ検索 */}
      <Pressable
        testID="manual-edit-catalog-search"
        onPress={onOpenCatalog}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.xs,
          paddingVertical: spacing.xs,
        }}
      >
        <Search size={13} color={colors.accent} />
        <Text style={{ fontSize: 12, color: colors.accent, fontWeight: "600" }}>
          カタログから検索
        </Text>
      </Pressable>
    </View>
  );
}
