declare module "react-native-markdown-display" {
  import type { ComponentProps } from "react";
  import type { StyleSheet, TextStyle, ViewStyle } from "react-native";

  type MarkdownStyles = {
    [key: string]: TextStyle | ViewStyle;
  };

  type MarkdownProps = {
    children: string;
    style?: MarkdownStyles;
    onLinkPress?: (url: string) => boolean;
  };

  const Markdown: React.ComponentType<MarkdownProps>;
  export default Markdown;
}
