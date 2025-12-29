import { Text } from "react-native";

import { PublicPage } from "../../src/components/PublicPage";

export default function ContactPage() {
  return (
    <PublicPage title="お問い合わせ" webPath="/contact">
      <Text style={{ color: "#666" }}>
        お問い合わせフォームはWeb版をご利用ください（モバイル内導線は今後拡充します）。
      </Text>
    </PublicPage>
  );
}



