import { Text } from "react-native";

import { PublicPage } from "../../src/components/PublicPage";

export default function TermsPage() {
  return (
    <PublicPage title="利用規約" webPath="/terms">
      <Text style={{ color: "#666" }}>
        利用規約はWeb版にて最新の内容をご確認ください。
      </Text>
    </PublicPage>
  );
}



