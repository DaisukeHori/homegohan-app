import { Redirect } from 'expo-router';

// 認証は WebView 内 (Web 版の middleware) で処理するため、
// 起動時に直接 (tabs)/home へリダイレクト
export default function Index() {
  return <Redirect href="/(tabs)/home" />;
}
