import { supabase } from './supabase';

/**
 * 冷蔵庫写真をローカル URI から Supabase Storage にアップロードし、
 * public URL を返す。
 *
 * @param localUri expo-image-picker が返す asset.uri
 * @param userId   Supabase auth user ID（Storage パスの prefix に使用）
 * @returns        Supabase Storage の public URL
 */
export async function uploadFridgePhoto(localUri: string, userId: string): Promise<string> {
  const ext = localUri.split('.').pop()?.toLowerCase() || 'jpg';
  const path = `${userId}/${Date.now()}.${ext}`;

  // fetch で Blob に変換してアップロード
  const response = await fetch(localUri);
  const blob = await response.blob();

  const { data, error } = await supabase.storage
    .from('fridge-images')
    .upload(path, blob, { contentType: `image/${ext}` });

  if (error) throw error;

  const {
    data: { publicUrl },
  } = supabase.storage.from('fridge-images').getPublicUrl(data.path);

  return publicUrl;
}
