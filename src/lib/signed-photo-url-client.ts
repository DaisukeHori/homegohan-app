/**
 * Web の画面が、保存された食事写真・冷蔵庫写真の URL を署名付き URL に替えるための、アプリで 1 つの問い合わせ役 (#1365 段 1)。
 * 画面では src/hooks/useSignedPhotoUrl.ts か src/components/photo/SignedPhotoImage.tsx を使う。
 */
import {
  createSignedPhotoUrlResolver,
  parseSignedPhotoUrlsResponse,
  SIGNED_PHOTO_URLS_API_PATH,
  type SignedPhotoUrlResolver,
  type SignedPhotoUrlsRequest,
  type SignedPhotoUrlsResponse,
} from '@homegohan/shared';

/** POST /api/storage/signed-urls に問い合わせる (Cookie のセッションで本人を確かめる)。失敗したら例外 */
export async function fetchSignedPhotoUrls(urls: string[]): Promise<SignedPhotoUrlsResponse> {
  const body: SignedPhotoUrlsRequest = { urls };
  const res = await fetch(SIGNED_PHOTO_URLS_API_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`signed photo urls request failed (status ${res.status})`);
  const parsed = parseSignedPhotoUrlsResponse(await res.json());
  if (!parsed) throw new Error('signed photo urls response has an unexpected shape');
  return parsed;
}

let resolver: SignedPhotoUrlResolver | null = null;

/** アプリで 1 つの問い合わせ役 (同じ時点に頼まれた URL をまとめ、期限内の答えを覚えておく) */
export function getSignedPhotoUrlResolver(): SignedPhotoUrlResolver {
  if (!resolver) resolver = createSignedPhotoUrlResolver({ fetchSigned: fetchSignedPhotoUrls });
  return resolver;
}
