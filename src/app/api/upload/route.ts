import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createLogger, generateRequestId } from "@/lib/db-logger";
import { checkRateLimit, rateLimitExceededResponse } from "@/lib/rate-limit";
import { userScopedStoragePath } from "@/lib/storage-paths";


// magic bytes の 1 区間: ファイル先頭から offset バイト目以降に bytes がそのまま並んでいること
type MagicBytesPart = { offset: number; bytes: number[] };

// 許可する MIME タイプと対応する magic bytes
// MIME ごとに「候補のどれか 1 つ」に一致すればよく、1 つの候補は「全区間」が一致する必要がある
const ALLOWED_MIME_TYPES: Record<string, MagicBytesPart[][]> = {
  'image/jpeg': [
    [{ offset: 0, bytes: [0xFF, 0xD8, 0xFF] }],
  ],
  'image/png': [
    // \x89PNG\r\n\x1a\n (PNG の 8 バイトのシグネチャ全体)
    [{ offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] }],
  ],
  'image/webp': [
    // WebP は RIFF コンテナ。WAV / AVI も先頭 4 バイトは同じ 'RIFF' なので、
    // offset 4-7 のファイルサイズ欄を飛ばして offset 8-11 の 'WEBP' (FourCC) まで確認する (#1219)
    [
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
      { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // WEBP
    ],
  ],
  'application/pdf': [
    [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2D] }], // %PDF-
  ],
};
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

// 全区間が一致するか。ファイルが短くて区間が収まらない場合は範囲外を読まずに不一致とする
function matchesMagicBytes(buffer: Uint8Array, parts: MagicBytesPart[]): boolean {
  return parts.every(
    ({ offset, bytes }) =>
      buffer.length >= offset + bytes.length && bytes.every((b, i) => buffer[offset + i] === b),
  );
}

function detectMimeByMagicBytes(buffer: Uint8Array): string | null {
  for (const [mime, signatures] of Object.entries(ALLOWED_MIME_TYPES)) {
    if (signatures.some((parts) => matchesMagicBytes(buffer, parts))) {
      return mime;
    }
  }
  return null;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const logger = createLogger('POST /api/upload', generateRequestId());
  // 認証できたあとはユーザー ID 付きのログにする (認証前の失敗はユーザーなし)
  let log: Pick<typeof logger, 'error'> = logger;

  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    log = logger.withUser(user.id);

    // 認証の直後、本文 (最大 10MB) を読み込む前に、ユーザー単位の回数制限を判定する (#1164)。
    // 先に判定するのは、断るリクエストの本文を読み込んで処理を無駄に走らせないため。
    // key は認証で確定した user.id だけ (リクエストの値は使わない)。401 は上で返しているので枠を使わない。
    // 判定できないとき (Redis 障害) は例外がそのまま下の catch に届き、500 で断る (fail-close)
    const rateLimit = await checkRateLimit(user.id, 'upload');
    if (!rateLimit.success) {
      return rateLimitExceededResponse(rateLimit);
    }

    const formData = await request.formData();
    const file = formData.get('file') as File;
    const folder = formData.get('folder') as string || 'uploads';

    if (!file) {
      return NextResponse.json({ error: 'File is required' }, { status: 400 });
    }

    // サイズ検証
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        { error: `File size exceeds limit of ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB` },
        { status: 400 }
      );
    }

    // ファイルをArrayBufferに変換
    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);

    // MIME タイプ検証 (宣言値 + magic bytes 両方チェック)
    if (!Object.keys(ALLOWED_MIME_TYPES).includes(file.type)) {
      return NextResponse.json(
        { error: `File type '${file.type}' is not allowed` },
        { status: 400 }
      );
    }
    const detectedMime = detectMimeByMagicBytes(buffer);
    if (!detectedMime) {
      return NextResponse.json(
        { error: 'File content does not match an allowed type' },
        { status: 400 }
      );
    }

    // ファイル名を生成 (detectedMime から拡張子を決定)
    const extMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'application/pdf': 'pdf',
    };
    const ext = extMap[detectedMime] ?? 'bin';
    // 本人のフォルダ <user_id>/<folder>/ の下に保存する (storage.objects の RLS が本人のフォルダだけを許可する)
    const fileName = userScopedStoragePath(
      user.id,
      folder,
      `${Date.now()}-${Math.random().toString(36).substring(7)}.${ext}`,
    );

    // Supabase Storageにアップロード
    const { error: uploadError } = await supabase.storage
      .from('fridge-images')
      .upload(fileName, buffer, {
        contentType: detectedMime,
        upsert: false,
      });

    if (uploadError) {
      // 詳細は構造化ログに残し、レスポンスには汎用メッセージだけ返す (#1172)
      log.error('Upload to storage failed', uploadError, {
        path: fileName,
        content_type: detectedMime,
        size: file.size,
      });
      return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
    }

    // 公開URLを取得
    const { data: { publicUrl } } = supabase.storage
      .from('fridge-images')
      .getPublicUrl(fileName);

    return NextResponse.json({ url: publicUrl });

  } catch (error) {
    // 回数制限の判定に失敗した例外 (Redis 障害など) もここに届く。内部のエラー文はレスポンスに載せない (#1172)
    log.error('Upload API error', error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
