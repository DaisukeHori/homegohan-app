import { View } from "react-native";
import { colors } from "../../src/theme";

// マイページタブ - タップ時にlistenersで/profileに遷移するため、
// この画面自体は空（表示されない）
export default function SettingsTab() {
  return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
}
