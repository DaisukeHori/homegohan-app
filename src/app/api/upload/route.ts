import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";


// 許可する MIME タイプと対応する magic bytes
const ALLOWED_MIME_TYPES: Record<string, Uint8Array[]> = {
  'image/jpeg': [new Uint8Array([0xFF, 0xD8, 0xFF])],
  'image/png': [new Uint8Array([0x89, 0x50, 0x4E, 0x47])],
  'image/webp': [new Uint8Array([0x52, 0x49, 0x46, 0x46])], // RIFF header
  'application/pdf': [new Uint8Array([0x25, 0x50, 0x44, 0x46])], // %PDF
};
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

function detectMimeByMagicBytes(buffer: Uint8Array): string | null {
  for (const [mime, signatures] of Object.entries(ALLOWED_MIME_TYPES)) {
    for (const sig of signatures) {
      if (buffer.length >= sig.length && sig.every((b, i) => buffer[i] === b)) {
        return mime;
      }
    }
  }
  return null;
}

export async function POST(request: Request) {
  const supabase = await createClient();


  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
    const fileName = `${folder}/${user.id}/${Date.now()}-${Math.random().toString(36).substring(7)}.${ext}`;

    // Supabase Storageにアップロード
    const { error: uploadError } = await supabase.storage
      .from('fridge-images')
      .upload(fileName, buffer, {
        contentType: detectedMime,
        upsert: false,
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
    }

    // 公開URLを取得
    const { data: { publicUrl } } = supabase.storage
      .from('fridge-images')
      .getPublicUrl(fileName);

    return NextResponse.json({ url: publicUrl });

  } catch (error: any) {
    console.error('Upload API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
