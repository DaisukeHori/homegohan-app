import { Text } from "react-native";

import { PublicPage } from "../../src/components/PublicPage";

export default function AboutPage() {
  return (
    <PublicPage title="このアプリについて" webPath="/about">
      <Text style={{ color: "#666" }}>
        「ほめゴハン」は、食事を“責めずに続けられる”体験を最重視した食事管理アプリです。
      </Text>
    </PublicPage>
  );
}



