/**
 * Supabase Storage (fridge-images バケット) の保存パス
 *
 * 先頭のフォルダを、アップロードする本人の user id にする (`<user_id>/<用途>/<ファイル名>`)。
 * storage.objects の RLS で「本人のフォルダ ((storage.foldername(name))[1] = auth.uid()) だけ」に
 * アップロード・一覧を限定するため、利用者のセッションでアップロードするパスはすべてこの形にそろえる。
 * Edge Function (analyze-meal-photo) も同じ形 (モバイルの apps/mobile/src/lib/storage.ts も同じ形だったが、#1598 で消した。
 * 使っていたネイティブの画面と一緒に消した)。
 */
export function userScopedStoragePath(userId: string, ...segments: string[]): string {
  if (!userId) {
    throw new Error('userScopedStoragePath: userId is required');
  }
  const rest = segments.map((s) => s.replace(/^\/+|\/+$/g, '')).filter((s) => s.length > 0);
  if (rest.length === 0) {
    throw new Error('userScopedStoragePath: file name is required');
  }
  return [userId, ...rest].join('/');
}
