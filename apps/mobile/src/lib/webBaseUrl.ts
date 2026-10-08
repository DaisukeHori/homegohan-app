/**
 * アプリが WebView で開く Web のベース URL (#1159)
 *
 * WebViewScreen が WebView に読み込ませる URL と、download メッセージの送信元として信用するオリジン
 * (webViewDownload.ts の isTrustedDownloadSender) は、必ず同じ値から決める。
 * 既定値や「空文字を設定ありと見るか」が食い違うと、WebView が開いたページからの正規のエクスポートが
 * 「送信元が違う」と黙って捨てられる (または、WebView の表示と違うオリジンを信用してしまう)。
 */

/** EXPO_PUBLIC_WEB_URL が無い (未設定・空文字) ときの Web のオリジン */
export const DEFAULT_WEB_URL = 'https://homegohan-app.vercel.app';

/**
 * Web のベース URL。環境変数 EXPO_PUBLIC_WEB_URL (ビルド時に埋め込まれる) か、無ければ DEFAULT_WEB_URL。
 * 空文字は「無い」として扱う (空文字のまま WebView の URL にすると、相対 URL になって何も開けない)。
 * 呼ぶたびに読む (テストで環境変数を差し替えられるように)。
 */
export function getWebBaseUrl(): string {
  return process.env.EXPO_PUBLIC_WEB_URL || DEFAULT_WEB_URL;
}

/**
 * Web のパス (例: "/terms") を、Web のオリジンにつないだ絶対 URL にする。
 * 「Web版を開く」リンク (PublicPage) のように、人が見る Web ページの場所に使う。
 * ベース URL の末尾のスラッシュと、パス先頭のスラッシュの有無は吸収する。
 *
 * 行き先は API の基点 (EXPO_PUBLIC_API_BASE_URL。src/lib/api.ts) とは別の設定値。
 * 以前は PublicPage が API の基点を流用していたため、API の向き先を変えると Web 版リンクまで変わり、
 * 未設定だとリンク自体が出なかった (#1049 F7-19)。
 */
export function buildWebPageUrl(path: string): string {
  const base = getWebBaseUrl().replace(/\/+$/, '');
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalized}`;
}
