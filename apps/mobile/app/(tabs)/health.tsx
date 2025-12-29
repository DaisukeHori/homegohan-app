import { Link } from "expo-router";
import { Text, View } from "react-native";

export default function HealthScreen() {
  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "800" }}>健康</Text>
      <Text style={{ color: "#666" }}>健康記録の入力・確認を行います。</Text>

      <View style={{ gap: 10, marginTop: 8 }}>
        <Link href="/health/record">記録一覧</Link>
        <Link href="/health/record/quick">クイック入力</Link>
        <Link href="/health/graphs">グラフ</Link>
        <Link href="/health/streaks">連続記録</Link>
        <Link href="/health/insights">インサイト</Link>
        <Link href="/health/goals">目標</Link>
        <Link href="/health/challenges">チャレンジ</Link>
        <Link href="/health/blood-tests">血液検査</Link>
        <Link href="/health/settings">設定</Link>
      </View>
    </View>
  );
}


