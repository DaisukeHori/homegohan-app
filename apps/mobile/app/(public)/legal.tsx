import { Text } from "react-native";

import { PublicPage } from "../../src/components/PublicPage";

export default function LegalPage() {
  return (
    <PublicPage title="法的情報" webPath="/legal">
      <Text style={{ color: "#666" }}>
        特商法・表示関連はWeb版にてご確認ください。
      </Text>
    </PublicPage>
  );
}



