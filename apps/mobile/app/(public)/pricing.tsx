import { Text } from "react-native";

import { PublicPage } from "../../src/components/PublicPage";

export default function PricingPage() {
  return (
    <PublicPage title="料金" webPath="/pricing">
      <Text style={{ color: "#666" }}>
        プラン・料金体系はWeb版にて最新情報をご確認ください。
      </Text>
    </PublicPage>
  );
}



