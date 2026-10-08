/**
 * #1159 / #1131: モバイルアプリの WebView 書き出しと、個人データエクスポート API の整合 (contract テスト)
 *
 * 設定画面の「データをエクスポート」は、アプリ内の WebView では GET /api/account/export の本文 (JSON) を
 * download メッセージでネイティブへ渡し、ネイティブが端末に書き出して共有シートを開く。
 * ネイティブ側 (apps/mobile/src/lib/webViewDownload.ts) は、WebView 内の JS が自由に作れるメッセージを信用せず、
 * 本文の大きさとファイル名を検証する。この検証が API の出力より厳しいと、データの多い利用者の
 * 「データをエクスポート」が、エラーも出ないまま何も起きなくなる (#1159 の対応で本文の上限を 10MiB にしたところ、
 * API の上限 50MiB より小さく、レビューで見つかった)。
 *
 * API 側 (src/lib/account-export.ts) とアプリ側は別のパッケージで、型や import ではつながっていない。
 * どちらかを変えたときに、もう一方とずれたまま CI を通らないよう、ここで突き合わせる。
 *
 * このテストが落ちたとき:
 *   - API の出力を大きくした → apps/mobile/src/lib/webViewDownload.ts の MAX_DOWNLOAD_CONTENT_LENGTH を、
 *     DEFAULT_EXPORT_LIMITS.maxTotalBytes 以上にする。あわせて docs/design/mobile/01-architecture.md の表と、
 *     apps/mobile/__tests__ の上限 (WebViewScreen.download.test.tsx の MAX_CONTENT_LENGTH と
 *     webViewDownload.test.ts の範囲の確認) を直す。
 *     新しいアプリのビルドを配布するまで、配布済みのアプリでは大きいエクスポートが失敗する点に注意 (PR に書く)
 *   - API のファイル名を変えた → ネイティブの許可リスト (ALLOWED_EXTENSIONS) と、名前の無害化に収まる形にする
 */
import { describe, expect, it, vi } from 'vitest';

// webViewDownload.ts は Expo のネイティブモジュールを import するが、このテストで使うのは定数と、
// ファイル名・MIME タイプを決める純粋関数だけ。ネイティブモジュールは読み込まない
vi.mock('expo-file-system', () => ({}));
vi.mock('expo-sharing', () => ({}));

import { buildExportFilename, DEFAULT_EXPORT_LIMITS } from '@/lib/account-export';
import {
  MAX_DOWNLOAD_CONTENT_LENGTH,
  mimeTypeForFilename,
  sanitizeDownloadFilename,
} from '../apps/mobile/src/lib/webViewDownload';

describe('モバイルの WebView 書き出し (webViewDownload.ts) と個人データエクスポート API の整合', () => {
  it('本文の上限は、API が返しうる最大のサイズ (maxTotalBytes) 以上である', () => {
    // API の出力は UTF-8 で maxTotalBytes 以下。ネイティブが比べるのは JS の文字列の長さ (UTF-16 の単位数) で、
    // これは UTF-8 のバイト数以下 (ASCII は同じ、それ以外は少ない) なので、バイト数の上限と直接比べてよい
    expect(MAX_DOWNLOAD_CONTENT_LENGTH).toBeGreaterThanOrEqual(DEFAULT_EXPORT_LIMITS.maxTotalBytes);
  });

  it('API が付けるファイル名は、ネイティブの無害化で変わらず、application/json として共有される', () => {
    // 設定画面は、これと同じ形の名前 (homegohan-export-YYYY-MM-DD.json) を download メッセージで送る
    const filename = buildExportFilename(new Date('2026-10-08T03:00:00Z'));

    expect(filename).toBe('homegohan-export-2026-10-08.json');
    expect(sanitizeDownloadFilename(filename, 'application/json')).toBe(filename);
    expect(mimeTypeForFilename(filename)).toBe('application/json');
  });
});
