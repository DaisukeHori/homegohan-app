/**
 * モバイルの画面が、保存された食事写真・冷蔵庫写真の URL を署名付き URL に替えるための、アプリで 1 つの問い合わせ役 (#1365 段 1)。
 * 画面では src/hooks/useSignedPhotoUrl.ts か src/components/photo/SignedPhotoImage.tsx を使う。
 * 問い合わせ先は Next.js の POST /api/storage/signed-urls (Authorization ヘッダーで本人を確かめる)。
 */
import {
  createSignedPhotoUrlResolver,
  parseSignedPhotoUrlsResponse,
  SIGNED_PHOTO_URLS_API_PATH,
  type SignedPhotoUrlResolver,
  type SignedPhotoUrlsRequest,
  type SignedPhotoUrlsResponse,
} from "@homegohan/shared";

import { getApi } from "./api";

/** 署名付き URL を問い合わせる。失敗したら例外 */
export async function fetchSignedPhotoUrls(urls: string[]): Promise<SignedPhotoUrlsResponse> {
  const body: SignedPhotoUrlsRequest = { urls };
  const json = await getApi().post<unknown>(SIGNED_PHOTO_URLS_API_PATH, body);
  const parsed = parseSignedPhotoUrlsResponse(json);
  if (!parsed) throw new Error("signed photo urls response has an unexpected shape");
  return parsed;
}

let resolver: SignedPhotoUrlResolver | null = null;

/** アプリで 1 つの問い合わせ役 (同じ時点に頼まれた URL をまとめ、期限内の答えを覚えておく) */
export function getSignedPhotoUrlResolver(): SignedPhotoUrlResolver {
  if (!resolver) resolver = createSignedPhotoUrlResolver({ fetchSigned: fetchSignedPhotoUrls });
  return resolver;
}
