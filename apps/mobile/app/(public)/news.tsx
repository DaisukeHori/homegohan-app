import { Text } from "react-native";

import { PublicPage } from "../../src/components/PublicPage";

export default function NewsPage() {
  return (
    <PublicPage title="お知らせ" webPath="/news">
      <Text style={{ color: "#666" }}>
        最新情報はWeb版で確認できます。モバイル内一覧も順次実装します。
      </Text>
    </PublicPage>
  );
}



