import { Link } from "expo-router";
import { Text, View } from "react-native";

export default function MenusScreen() {
  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "800" }}>献立</Text>
      <Text style={{ color: "#666" }}>週間献立の表示・生成・編集をここから行います。</Text>

      <View style={{ gap: 10, marginTop: 8 }}>
        <Link href="/menus/weekly">週間献立を見る</Link>
        <Link href="/menus/weekly/request">AIで週間献立を作成</Link>
      </View>
    </View>
  );
}


