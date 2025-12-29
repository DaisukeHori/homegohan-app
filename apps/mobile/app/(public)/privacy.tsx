import { Text } from "react-native";

import { PublicPage } from "../../src/components/PublicPage";

export default function PrivacyPage() {
  return (
    <PublicPage title="プライバシーポリシー" webPath="/privacy">
      <Text style={{ color: "#666" }}>
        プライバシーポリシーはWeb版にて最新の内容をご確認ください。
      </Text>
    </PublicPage>
  );
}



