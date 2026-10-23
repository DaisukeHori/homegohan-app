/**
 * 食事写真・冷蔵庫写真の署名付き URL を返す API (#1365 段 1)。POST /api/storage/signed-urls
 *
 * 本文: { urls: string[] } (保存された写真の URL。MAX_PHOTO_URLS_PER_SIGN_REQUEST 件まで)
 * 応答: { signedUrls: { [送った URL]: 署名付き URL | null }, expiresInSeconds }
 *
 * Web の画面は、保存された写真の URL (公開 URL) をそのまま表示せず、ここで署名した URL を表示する
 * (写真を出すモバイルのネイティブの画面は #1598 で消した。アプリの写真は WebView の Web の画面が出す)
 * (packages/shared/src/signed-photo-url.ts の createSignedPhotoUrlResolver がまとめて問い合わせる)。
 * 本人の写真 (src/lib/photo-storage-signing.ts の決まり) にだけ署名し、他人の写真・2 つのバケット以外の URL は null。
 * 本人は認証 (Web は Cookie、モバイルは Authorization ヘッダー) で確かめ、本文の値は使わない。
 */
import { NextResponse } from 'next/server';
import {
  MAX_PHOTO_URL_LENGTH,
  MAX_PHOTO_URLS_PER_SIGN_REQUEST,
  type SignedPhotoUrlsResponse,
} from '@homegohan/shared';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { photoSignedUrlTtlSeconds, signOwnedPhotoUrls } from '@/lib/photo-storage-signing';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';

const ROUTE_NAME = 'POST /api/storage/signed-urls';

/** 本文を確かめる。形が違えば null */
function parseUrls(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const { urls } = body as { urls?: unknown };
  if (!Array.isArray(urls) || urls.length > MAX_PHOTO_URLS_PER_SIGN_REQUEST) return null;
  if (!urls.every((url): url is string => typeof url === 'string' && url.length > 0 && url.length <= MAX_PHOTO_URL_LENGTH)) {
    return null;
  }
  return [...new Set(urls)];
}

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
  }
  const urls = parseUrls(body);
  if (!urls) {
    return NextResponse.json(
      { error: `urls は 1〜${MAX_PHOTO_URL_LENGTH} 文字の文字列の配列 (${MAX_PHOTO_URLS_PER_SIGN_REQUEST} 件まで) で送ってください` },
      { status: 400 },
    );
  }

  try {
    const expiresInSeconds = photoSignedUrlTtlSeconds();
    // 署名は service_role で行う (旧パスと generated/ は storage.objects の RLS では署名できない)。
    // 持ち主の確認は signOwnedPhotoUrls が、認証で確かめた user.id で行う
    const result = await signOwnedPhotoUrls(getSupabaseAdmin(), user.id, urls, expiresInSeconds);
    if (result.signFailures > 0 || result.notOwned > 0) {
      // 表示できなかった写真 (本人の写真でない・ファイルが無い) がどれだけあるかを追えるよう、数だけ残す (URL は残さない)
      createLogger(ROUTE_NAME, generateRequestId())
        .withUser(user.id)
        .warn('photo urls were not signed', {
          requested: urls.length,
          signFailures: result.signFailures,
          notOwned: result.notOwned,
        });
    }
    const response: SignedPhotoUrlsResponse = { signedUrls: result.signedUrls, expiresInSeconds };
    return NextResponse.json(response, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return internalError(ROUTE_NAME, error, { userId: user.id });
  }
}
