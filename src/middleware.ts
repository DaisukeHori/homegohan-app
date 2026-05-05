import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function middleware(request: NextRequest) {
  const res = await updateSession(request)

  // ?mode=app が付いていれば is_native_app Cookie をセット
  // これにより SSR 初回レンダリング時に cookies() で native 判定できる
  const isAppMode = request.nextUrl.searchParams.get('mode') === 'app'
  const existingCookie = request.cookies.get('is_native_app')?.value
  if (isAppMode && existingCookie !== '1') {
    res.cookies.set('is_native_app', '1', {
      maxAge: 60 * 60 * 24 * 30,
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
    })
  }

  return res
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - manifest.json (PWA manifest — must not be redirected to /login)
     * - robots.txt (crawler instructions)
     * - sw.js / workbox-* (service worker files)
     * Feel free to modify this pattern to include more paths.
     */
    '/((?!_next/static|_next/image|favicon\\.ico|manifest\\.json|robots\\.txt|sw\\.js|workbox-|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}



