import * as FileSystem from "expo-file-system";

import { base64ToArrayBuffer } from "./base64";
import { supabase } from "./supabase";

/** 冷蔵庫写真のバケット */
const FRIDGE_IMAGES_BUCKET = "fridge-images";

type ImageFormat = { ext: string; contentType: string };

/**
 * 拡張子 → 保存するファイルの拡張子と Content-Type。
 * 'image/jpg' という MIME は無いので、jpg / jpeg はどちらも 'image/jpeg' にする。
 */
const IMAGE_FORMATS: Record<string, ImageFormat> = {
  jpg: { ext: "jpg", contentType: "image/jpeg" },
  jpeg: { ext: "jpg", contentType: "image/jpeg" },
  png: { ext: "png", contentType: "image/png" },
  webp: { ext: "webp", contentType: "image/webp" },
  heic: { ext: "heic", contentType: "image/heic" },
  heif: { ext: "heif", contentType: "image/heif" },
};

/** 拡張子が無い・知らない拡張子のとき。expo-image-picker は quality を指定すると JPEG を返す */
const DEFAULT_IMAGE_FORMAT: ImageFormat = IMAGE_FORMATS.jpg;

/** 写真を読めなかった (中身が空・読み込みの失敗) ときの、画面に出せる文 */
export const FRIDGE_PHOTO_READ_FAILED_MESSAGE = "写真を読み込めませんでした。もう一度撮影するか、写真を選び直してください。";

/** ローカル URI の拡張子から、保存するファイルの拡張子と Content-Type を決める。クエリ (?…) とハッシュ (#…) は見ない */
function imageFormatOf(localUri: string): ImageFormat {
  const fileName = localUri.split(/[?#]/)[0].split("/").pop() ?? "";
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  return IMAGE_FORMATS[ext] ?? DEFAULT_IMAGE_FORMAT;
}

/** 写真の中身を ArrayBuffer で読む。読めない・空なら、画面に出せる文の Error (元の例外は cause) */
async function readPhotoBytes(localUri: string): Promise<ArrayBuffer> {
  let bytes: ArrayBuffer;
  try {
    const base64 = await FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
    bytes = base64ToArrayBuffer(base64);
  } catch (cause) {
    const error = new Error(FRIDGE_PHOTO_READ_FAILED_MESSAGE);
    Object.defineProperty(error, "cause", { value: cause, writable: true, configurable: true, enumerable: false });
    throw error;
  }
  // 空のファイルを上げると、後の AI 解析が原因の分かりにくい失敗になるので、ここで止める
  if (bytes.byteLength === 0) throw new Error(FRIDGE_PHOTO_READ_FAILED_MESSAGE);
  return bytes;
}

/**
 * 冷蔵庫写真をローカル URI から Supabase Storage にアップロードし、
 * public URL を返す。
 *
 * 写真は expo-file-system で base64 として読み、ArrayBuffer にして渡す (#1049 F7-17)。
 * 以前は fetch(localUri) の Blob を渡していたが、React Native では Blob の中身が送られず、
 * 0 バイトのファイルになることがあった (supabase-js は Blob を FormData に載せて送るため)。
 * ArrayBuffer なら、supabase-js はそのまま本文として送る (Supabase の React Native 向けの案内と同じ方式)。
 *
 * @param localUri expo-image-picker が返す asset.uri
 * @param userId   Supabase auth user ID（Storage パスの prefix に使用）
 * @returns        Supabase Storage の public URL
 */
export async function uploadFridgePhoto(localUri: string, userId: string): Promise<string> {
  const { ext, contentType } = imageFormatOf(localUri);
  const path = `${userId}/${Date.now()}.${ext}`;

  const body = await readPhotoBytes(localUri);

  const { data, error } = await supabase.storage.from(FRIDGE_IMAGES_BUCKET).upload(path, body, { contentType });

  if (error) throw error;

  const {
    data: { publicUrl },
  } = supabase.storage.from(FRIDGE_IMAGES_BUCKET).getPublicUrl(data.path);

  return publicUrl;
}
