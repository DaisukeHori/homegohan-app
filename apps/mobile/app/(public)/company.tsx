import { Text } from "react-native";

import { PublicPage } from "../../src/components/PublicPage";

export default function CompanyPage() {
  return (
    <PublicPage title="運営会社" webPath="/company">
      <Text style={{ color: "#666" }}>
        運営情報はWeb版にて随時更新します。
      </Text>
    </PublicPage>
  );
}



