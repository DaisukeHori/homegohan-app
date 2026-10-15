/**
 * #1665: 食事の区分ごとの見た目の表 (モバイル) の値を固定する。
 *
 * 食事の詳細・週間献立のカード・『食事タイプを選択』モーダルが手書きの表で持っていた
 * アイコン・色・短い名前を、src/lib/meal-type-visuals.ts の表へ移した。画面の見た目は変えないので、
 * 表の値は移す前の各画面の値と同じであることを確かめる。期待する値は、移す前の画面のソースにあった値を手で書く。
 * Web と共通のパッケージの表は tests/meal-type-visuals-1665.test.ts が固定する。
 */
import { CloudMoon, Coffee, Moon, Sun, SunMedium } from "lucide-react-native";
import { MEAL_ORDER } from "@homegohan/shared";

import {
  MEAL_TYPE_COLORS,
  MEAL_TYPE_IONICONS,
  MEAL_TYPE_LUCIDE_ICONS,
  MEAL_TYPE_SHORT_LABELS,
} from "../../src/lib/meal-type-visuals";

describe("モバイルの区分の見た目の表 (#1665)", () => {
  it("Ionicons の名前は、移す前の食事の詳細・『食事タイプを選択』モーダルの表と同じ", () => {
    expect(MEAL_TYPE_IONICONS).toEqual({
      breakfast: "sunny",
      lunch: "partly-sunny",
      dinner: "moon",
      snack: "cafe",
      midnight_snack: "cloudy-night",
    });
  });

  it("lucide のアイコンは、移す前の週間献立のカードの表と同じ部品", () => {
    expect(MEAL_TYPE_LUCIDE_ICONS.breakfast).toBe(Sun);
    expect(MEAL_TYPE_LUCIDE_ICONS.lunch).toBe(SunMedium);
    expect(MEAL_TYPE_LUCIDE_ICONS.dinner).toBe(Moon);
    expect(MEAL_TYPE_LUCIDE_ICONS.snack).toBe(Coffee);
    expect(MEAL_TYPE_LUCIDE_ICONS.midnight_snack).toBe(CloudMoon);
    // 部品が読み込めずに undefined 同士で一致していない
    for (const mealType of MEAL_ORDER) {
      expect(MEAL_TYPE_LUCIDE_ICONS[mealType]).toBeDefined();
    }
  });

  it("色は、移す前の食事の詳細・週間献立のカード・『食事タイプを選択』モーダルの表と同じ", () => {
    expect(MEAL_TYPE_COLORS).toEqual({
      breakfast: "#FF9800",
      lunch: "#4CAF50",
      dinner: "#7C4DFF",
      snack: "#E91E63",
      midnight_snack: "#3F51B5",
    });
  });

  it("短い名前は、移す前の週間献立のカードの表と同じ (夕食は「夕」)", () => {
    expect(MEAL_TYPE_SHORT_LABELS).toEqual({
      breakfast: "朝",
      lunch: "昼",
      dinner: "夕",
      snack: "おやつ",
      midnight_snack: "夜食",
    });
  });
});
