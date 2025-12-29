import { Text } from "react-native";

import { PublicPage } from "../../src/components/PublicPage";

export default function FaqPage() {
  return (
    <PublicPage title="よくある質問" webPath="/faq">
      <Text style={{ color: "#666" }}>
        FAQはWeb版にまとまっています。モバイル版は要点を順次掲載します。
      </Text>
    </PublicPage>
  );
}



