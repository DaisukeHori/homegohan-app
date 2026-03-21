import { View } from "react-native";
import { colors } from "../../src/theme";

// スキャンタブ - タップ時にlistenersで/meals/newに遷移するため、
// この画面自体は空（表示されない）
export default function MealsTab() {
  return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
}
