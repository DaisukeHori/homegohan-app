import * as FileSystem from 'expo-file-system';

import { base64ToArrayBuffer } from './base64';
import { supabase } from './supabase';

const FRIDGE_BUCKET = 'fridge-images';

// 拡張子 → 保存時の拡張子と Content-Type。`image/jpg` という MIME は無いので、jpg / jpeg はどちらも `image/jpeg` にする。
const IMAGE_FORMATS: Record<string, { ext: string; contentType: string }> = {
  jpg: { ext: 'jpg', contentType: 'image/jpeg' },
  jpeg: { ext: 'jpg', contentType: 'image/jpeg' },
  png: { ext: 'png', contentType: 'image/png' },
  webp: { ext: 'webp', contentType: 'image/webp' },
  gif: { ext: 'gif', contentType: 'image/gif' },
  heic: { ext: 'heic', contentType: 'image/heic' },
  heif: { ext: 'heif', contentType: 'image/heif' },
};
const DEFAULT_IMAGE_FORMAT = IMAGE_FORMATS.jpg;

/**
 * ローカル URI の拡張子から、保存時の拡張子と Content-Type を決める。
 * クエリ (`?...`) やハッシュ (`#...`) は無視する。拡張子が無い・未知の場合は JPEG として扱う
 * (expo-image-picker は quality を指定すると JPEG を返すため)。
 */
function resolveImageFormat(localUri: string): { ext: string; contentType: string } {
  const withoutQuery = localUri.split(/[?#]/)[0] ?? '';
  const fileName = withoutQuery.split('/').pop() ?? '';
  const dot = fileName.lastIndexOf('.');
  const rawExt = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  return IMAGE_FORMATS[rawExt] ?? DEFAULT_IMAGE_FORMAT;
}

const READ_FAILED_MESSAGE = '写真を読み込めませんでした。もう一度撮影または選択してください。';

/**
 * 冷蔵庫写真をローカル URI から Supabase Storage にアップロードし、
 * public URL を返す。
 *
 * ファイルは expo-file-system で base64 として読み、ArrayBuffer にして渡す。
 * 以前は fetch(localUri).blob() を渡していたが、React Native では Blob を渡すと
 * (supabase-js が FormData に載せるため) 中身が送られず、0 バイトのファイルになることがあった (#1049 F7-17)。
 * ArrayBuffer なら、supabase-js は FormData を使わず、そのまま本文として送る。
 *
 * @param localUri expo-image-picker が返す asset.uri
 * @param userId   Supabase auth user ID（Storage パスの prefix に使用）
 * @returns        Supabase Storage の public URL
 */
export async function uploadFridgePhoto(localUri: string, userId: string): Promise<string> {
  const { ext, contentType } = resolveImageFormat(localUri);
  const path = `${userId}/${Date.now()}.${ext}`;

  let body: ArrayBuffer;
  try {
    const base64 = await FileSystem.readAsStringAsync(localUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    body = base64ToArrayBuffer(base64);
  } catch (cause) {
    throw new Error(READ_FAILED_MESSAGE, { cause });
  }
  // 空のファイルをアップロードすると、後の AI 解析が原因の分かりにくい失敗になる。ここで止める。
  if (body.byteLength === 0) {
    throw new Error(READ_FAILED_MESSAGE);
  }

  const { data, error } = await supabase.storage.from(FRIDGE_BUCKET).upload(path, body, { contentType });

  if (error) throw error;

  const {
    data: { publicUrl },
  } = supabase.storage.from(FRIDGE_BUCKET).getPublicUrl(data.path);

  return publicUrl;
}
