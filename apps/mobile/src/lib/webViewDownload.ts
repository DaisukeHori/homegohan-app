/**
 * WebView (Web 側) から postMessage で届く `download` メッセージの検証と保存 (#1159)
 *
 * Web の設定画面は、iOS の WebView で <a download> が動かないため、CSV の本文を postMessage で
 * ネイティブへ渡し、ネイティブが端末に書き出して共有シートを開く。
 * メッセージの中身 (filename / content / mimeType) と、メッセージを送ってきたページは、
 * WebView の中で動く JS が自由に作れる。以前は filename をそのまま `${documentDirectory}${filename}` に
 * 繋いでいたため、'../' を含む名前でアプリのサンドボックス内の意図しない場所に書けた。
 *
 * ここでは何も信用せず、書き込みを次の範囲に閉じる:
 *   1. 送信元が自アプリの Web オリジン (EXPO_PUBLIC_WEB_URL) のページであること
 *   2. ファイル名を無害化する (ディレクトリ区切り・'..'・制御文字・長すぎる名前・許可外の拡張子を許さない)
 *   3. 本文は文字列で、上限以下のサイズであること
 *   4. 保存先は cacheDirectory の専用フォルダの中だけにする (documentDirectory には書かない)
 *
 * Web 側で書き出せる形式を増やすときは、ALLOWED_EXTENSIONS と docs/design/mobile/01-architecture.md の
 * 「download メッセージの制約」を合わせて直すこと。
 */
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

// ── 定数 ──────────────────────────────────────────────────────────────────────

/**
 * 書き出しを許す拡張子と、共有シートに渡す MIME タイプ。
 * 本文は UTF-8 の文字列として書くので、テキスト形式だけに限る (画像や PDF は壊れる)。
 */
const ALLOWED_EXTENSIONS = ['csv', 'json', 'txt'] as const;
type DownloadExtension = (typeof ALLOWED_EXTENSIONS)[number];
const MIME_TYPE_BY_EXTENSION: Record<DownloadExtension, string> = {
  csv: 'text/csv',
  json: 'application/json',
  txt: 'text/plain',
};

/** ファイル名 (拡張子込み) の最大文字数。端末のファイルシステムの上限 (255 バイト) よりずっと短くする */
export const MAX_DOWNLOAD_FILENAME_LENGTH = 100;

/** 名前が使えない・空のときの代わりの名前 (拡張子の前の部分) */
const FALLBACK_FILENAME_STEM = 'homegohan-export';

/**
 * 本文の最大文字数 (JS の文字列の長さ)。
 * 食事記録 CSV は、毎日記録して何年使っても数 MB 以下 (API が返す日数にも上限がある) なので、通常の使い方では届かない。
 * 上限に引っかかると利用者のエクスポートが黙って失敗するため、余裕を持たせてある。
 * UTF-8 の日本語は 1 文字 3 バイトなので、ディスクに書くのは最大でこの 3 倍 (約 30MB)。
 */
export const MAX_DOWNLOAD_CONTENT_LENGTH = 10 * 1024 * 1024;

/** 保存先: cacheDirectory の下の専用フォルダ。OS が空き容量不足のときに消してよい場所で、バックアップにも入らない */
export const DOWNLOAD_DIRECTORY_NAME = 'webview-downloads/';

/** この時間より古い書き出しファイルは、次の書き出しのときに消す */
export const STALE_DOWNLOAD_MS = 60 * 60 * 1000;

/** EXPO_PUBLIC_WEB_URL が無いときの Web のオリジン。WebViewScreen の既定値と同じ */
const DEFAULT_WEB_URL = 'https://homegohan-app.vercel.app';

// ── ファイル名 ────────────────────────────────────────────────────────────────

function isAllowedExtension(value: string): value is DownloadExtension {
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(value);
}

/** 送られてきた mimeType から拡張子を決める。許可リストに無ければ txt */
function extensionFromMimeType(mimeType: unknown): DownloadExtension {
  if (typeof mimeType === 'string') {
    // 'text/csv; charset=utf-8' のようなパラメータ付きも受ける
    const essence = mimeType.split(';')[0].trim().toLowerCase();
    const match = ALLOWED_EXTENSIONS.find((extension) => MIME_TYPE_BY_EXTENSION[extension] === essence);
    if (match) return match;
  }
  return 'txt';
}

/**
 * Web から送られてきたファイル名を、端末に書いてよい安全な名前にする。
 * 弾かずに必ず使える名前を返すので、呼び出し側は結果をそのまま保存先に繋いでよい。
 *
 *   - ディレクトリ区切り ('/' '\') より前は捨てる:  '../../x.csv' → 'x.csv'
 *   - 英数字と '.' '_' '-' 以外は '_' にする (制御文字・空白・'%'・日本語など)
 *   - '..' を作らない。先頭 (隠しファイル) と末尾の '.' は落とす
 *   - 拡張子は csv / json / txt だけ。無い・許可外のときは mimeType から決め、決まらなければ txt
 *   - 長さは MAX_DOWNLOAD_FILENAME_LENGTH まで。使える部分が残らなければ 'homegohan-export.<拡張子>'
 */
export function sanitizeDownloadFilename(filename: unknown, mimeType?: unknown): string {
  const raw = typeof filename === 'string' ? filename : '';

  // ベース名だけを残す。'%2e%2e%2f' のようなパーセントエンコードは、次の置き換えで '%' が消えるので
  // '..' や '/' に戻らない (ネイティブ側が URL として解釈するときにデコードされても安全)
  const baseName = raw.split(/[\\/]/).pop() ?? '';
  const name = baseName
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');

  const dot = name.lastIndexOf('.');
  const candidate = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  const extension = isAllowedExtension(candidate) ? candidate : extensionFromMimeType(mimeType);

  // 許可外の拡張子 (report.pdf の '.pdf' など) は本体に残さず、決めた拡張子に置き換える
  const stem = (dot >= 0 ? name.slice(0, dot) : name)
    .slice(0, MAX_DOWNLOAD_FILENAME_LENGTH - extension.length - 1)
    .replace(/\.+$/, '');

  // '_' や '-' しか残らない名前 (日本語だけの名前など) は、意味のある名前ではないので代わりの名前にする
  return `${/[A-Za-z0-9]/.test(stem) ? stem : FALLBACK_FILENAME_STEM}.${extension}`;
}

/** 無害化済みのファイル名から、共有シートに渡す MIME タイプを決める (送られてきた mimeType は使わない) */
export function mimeTypeForFilename(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  return isAllowedExtension(extension) ? MIME_TYPE_BY_EXTENSION[extension] : MIME_TYPE_BY_EXTENSION.txt;
}

// ── 送信元 ────────────────────────────────────────────────────────────────────

/**
 * URL から 'スキーム://ホスト[:ポート]' を取り出して小文字にする。
 * 解釈できないもの・認証情報 ('@') やバックスラッシュ・空白を含むものは null (= 信用しない側に倒す)。
 * RN の URL 実装は origin / host を持たない (URL ポリフィルに頼らない) ため、URL クラスは使わず、
 * 厳しめの正規表現で判定する。
 */
function originOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const match = /^(https?):\/\/([^/?#\\@\s]+)(?:[/?#]|$)/i.exec(url);
  return match ? `${match[1].toLowerCase()}://${match[2].toLowerCase()}` : null;
}

/**
 * download メッセージを送ってきたページが、自アプリの Web オリジンか。
 * senderUrl は onMessage の event.nativeEvent.url:
 *   - iOS: メッセージを送ったフレームの URL (パス付き)
 *   - Android: 送ったフレームのオリジン (パス無し)。古い WebView ではトップフレームの URL
 * どちらも 'スキーム://ホスト[:ポート]' が一致するかだけを見る。
 * 'https://homegohan-app.vercel.app.evil.example' や 'https://homegohan-app.vercel.app@evil.example' は一致しない。
 */
export function isTrustedDownloadSender(senderUrl: unknown): boolean {
  const trusted = originOf(process.env.EXPO_PUBLIC_WEB_URL || DEFAULT_WEB_URL);
  const sender = originOf(senderUrl);
  return trusted !== null && sender !== null && sender === trusted;
}

// ── 保存と共有 ────────────────────────────────────────────────────────────────

export type DownloadRejectReason = 'untrusted-sender' | 'invalid-payload' | 'too-large' | 'no-cache-directory';

export type DownloadResult =
  | { ok: true; uri: string; shared: boolean }
  | { ok: false; reason: DownloadRejectReason | 'failed' };

function reject(reason: DownloadRejectReason): DownloadResult {
  // 中身 (ファイル名・本文) は、攻撃者が選べる文字列なのでログに出さない
  console.warn(`[webViewDownload] download rejected: ${reason}`);
  return { ok: false, reason };
}

/**
 * 保存先フォルダにある古いファイル (STALE_DOWNLOAD_MS より前のもの) を消す。
 * 共有した直後に消すと、Android では共有先のアプリがまだ読み終えていないことがあり (shareAsync は
 * 共有先を選んだ時点で終わる)、iOS では shareAsync が終わらないこともあるため、次の書き出しのときに消す。
 * 失敗しても書き出しそのものは止めない。
 */
async function pruneStaleDownloads(directory: string): Promise<void> {
  try {
    const names = await FileSystem.readDirectoryAsync(directory);
    const threshold = Date.now() - STALE_DOWNLOAD_MS;
    await Promise.all(
      names.map(async (name) => {
        try {
          const uri = `${directory}${name}`;
          const info = await FileSystem.getInfoAsync(uri);
          // modificationTime は秒 (エポック)
          if (info.exists && info.modificationTime * 1000 < threshold) {
            await FileSystem.deleteAsync(uri, { idempotent: true });
          }
        } catch {
          // 1 件消せなくても続ける
        }
      }),
    );
  } catch {
    // 掃除に失敗しても書き出しは続ける
  }
}

/**
 * WebView から届いた `download` メッセージを検証して、cacheDirectory に書き、共有シートを開く。
 * 検証に通らないメッセージは何も書かずに捨てる。例外は投げない (失敗はログに出して結果で返す)。
 *
 * @param message JSON.parse 済みのメッセージ { type: 'download', filename, content, mimeType }
 * @param senderUrl onMessage の event.nativeEvent.url (メッセージを送ってきたページの URL)
 */
export async function handleWebViewDownload(message: unknown, senderUrl: unknown): Promise<DownloadResult> {
  try {
    if (!isTrustedDownloadSender(senderUrl)) return reject('untrusted-sender');

    const payload = (typeof message === 'object' && message !== null ? message : {}) as Record<string, unknown>;
    const { filename, content, mimeType } = payload;
    if (typeof content !== 'string') return reject('invalid-payload');
    if (content.length > MAX_DOWNLOAD_CONTENT_LENGTH) return reject('too-large');

    const cacheDirectory = FileSystem.cacheDirectory;
    if (!cacheDirectory) return reject('no-cache-directory');

    const safeFilename = sanitizeDownloadFilename(filename, mimeType);
    const directory = `${cacheDirectory}${cacheDirectory.endsWith('/') ? '' : '/'}${DOWNLOAD_DIRECTORY_NAME}`;
    const fileUri = `${directory}${safeFilename}`;

    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    await pruneStaleDownloads(directory);
    await FileSystem.writeAsStringAsync(fileUri, content, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    const canShare = await Sharing.isAvailableAsync();
    if (canShare) {
      await Sharing.shareAsync(fileUri, {
        mimeType: mimeTypeForFilename(safeFilename),
        dialogTitle: safeFilename,
      });
    }
    return { ok: true, uri: fileUri, shared: canShare };
  } catch (e) {
    console.error('[webViewDownload] download failed', e);
    return { ok: false, reason: 'failed' };
  }
}
