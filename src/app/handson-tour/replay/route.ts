import { NextResponse } from 'next/server';
import {
  HANDSON_TOUR_FORCE_COOKIE,
  HANDSON_TOUR_FORCE_COOKIE_MAX_AGE_SECONDS,
} from '@/lib/handson-tour/force-cookie';

// #1045 (F6-05): /handson-tour/layout.tsx (Server Component) は searchParams を
// 受け取れないため、設定画面からの「もう一度見る」導線 (?force=1) が layout 側では
// 常に無視されていた。代わりに専用ルートで Cookie を発行し、layout はその Cookie
// (next/headers の cookies() は layout からでも参照可能) を見て force 判定する。
//
// クライアント側は router.push ではなく完全なブラウザナビゲーション
// (window.location.href 等) でこの route にアクセスする必要がある。
export async function GET(request: Request) {
  const url = new URL(request.url);
  const res = NextResponse.redirect(new URL('/handson-tour', url.origin));
  res.cookies.set(HANDSON_TOUR_FORCE_COOKIE, '1', {
    maxAge: HANDSON_TOUR_FORCE_COOKIE_MAX_AGE_SECONDS,
    httpOnly: true,
    sameSite: 'lax',
    path: '/handson-tour',
  });
  return res;
}
