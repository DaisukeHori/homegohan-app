import { Text } from "react-native";

import { PublicPage } from "../../src/components/PublicPage";

export default function GuidePage() {
  return (
    <PublicPage title="ガイド" webPath="/guide">
      <Text style={{ color: "#666" }}>
        使い方ガイドはWeb版で詳しく案内しています。モバイル版は要点を順次追加します。
      </Text>
    </PublicPage>
  );
}



