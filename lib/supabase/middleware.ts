import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isAuthFlowPath, isPolicyPath, resolveOnboardingRedirect } from '@/lib/onboarding-routing'
import { isAccountFrozen } from '@/lib/auth/frozen'
import {
  isMaintenanceExemptPath,
  isMaintenanceFlagOn,
  isOperatorRoles,
  maintenanceApiResponse,
  maintenancePageResponse,
} from '@/lib/maintenance-mode'
import {
  LEGAL_CONSENT_PATH,
  LEGAL_CONSENT_PENDING_HEADER,
  buildLegalConsentNext,
  isLegalConsentEnforced,
  isLegalConsentNoticeEnabled,
  resolveLegalConsent,
} from '@/lib/legal-consent'
// Edge Runtime (middleware) で動くので、zod を持つ @/lib/env ではなく何も import しない env-required を使う (#1182)
import { getSupabasePublicConfig } from '@/lib/env-required'
import { internalError } from '@/lib/api/errors'

// #1030 (round-4 Warning fix): Authorization ヘッダーが Supabase JWT (dot 区切り
// 3 セグメント) の Bearer トークンかどうかを軽量に判定する。CRON_SECRET のような
// 非 JWT の共有シークレットを Supabase クライアントへ転送しないためのガード。
function isJwtBearerHeader(authHeader: string | null): boolean {
  if (!authHeader) return false
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!match) return false
  return match[1].split('.').length === 3
}

// #1148: メンテナンス中の応答を返すとき、この呼び出しで更新されたセッションの Cookie (トークンの更新) も引き継ぐ。
// 別の応答に差し替えると、更新したトークンがブラウザに届かず、使い捨ての更新トークンが失われてログアウトされることがあるため
function withSessionCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie)
  }
  return to
}

// #1174: 同意ゲート (利用規約・プライバシーポリシーの再同意) のために user_profiles から読む列。
// 同意済みの版の列 (migration 20261008200700) がまだ無い DB では、この select が 42703 (undefined_column) で失敗する。
// Vercel への Web のデプロイと Supabase への migration のデプロイは別々に走るので、Web が先に出る短い時間があり得る。
// その間も profileError 扱いにすると、全員の凍結判定とオンボーディングの差し戻しが一斉に止まってしまう (#348 の fail-open)。
// そこで、同意済みの版の列を除いた select でやり直し、同意ゲートだけを素通りさせる。
const PROFILE_COLUMNS = 'roles, onboarding_started_at, onboarding_completed_at, frozen_at, unban_at'
const PROFILE_COLUMNS_WITH_LEGAL = `${PROFILE_COLUMNS}, terms_version_accepted, privacy_version_accepted`
const PG_UNDEFINED_COLUMN = '42703'

interface MiddlewareProfile {
  roles?: string[] | null
  onboarding_started_at?: string | null
  onboarding_completed_at?: string | null
  frozen_at?: string | null
  unban_at?: string | null
  terms_version_accepted?: string | null
  privacy_version_accepted?: string | null
}

async function fetchMiddlewareProfile(supabase: ReturnType<typeof createServerClient>, userId: string) {
  const first = await supabase.from('user_profiles').select(PROFILE_COLUMNS_WITH_LEGAL).eq('id', userId).maybeSingle()
  if (first.error?.code === PG_UNDEFINED_COLUMN) {
    const legacy = await supabase.from('user_profiles').select(PROFILE_COLUMNS).eq('id', userId).maybeSingle()
    return {
      profile: legacy.data as MiddlewareProfile | null,
      profileError: legacy.error,
      legalColumnsAvailable: false,
    }
  }
  return {
    profile: first.data as MiddlewareProfile | null,
    profileError: first.error,
    legalColumnsAvailable: true,
  }
}

/**
 * 「同意のお願い」のお知らせを出すよう、サーバー側の画面 (layout) へヘッダーを渡す。
 * NextResponse.next({ request }) は作った時点のリクエストヘッダーを転送するので、ヘッダーを足したら作り直し、
 * それまでに溜めたセッション Cookie を引き継ぐ。お知らせが出せないだけで、ページの表示は止めない。
 */
function withLegalConsentPendingHeader(request: NextRequest, current: NextResponse): NextResponse {
  try {
    request.headers.set(LEGAL_CONSENT_PENDING_HEADER, '1')
    const next = NextResponse.next({ request })
    for (const cookie of current.cookies.getAll()) next.cookies.set(cookie)
    return next
  } catch {
    return current
  }
}

export async function updateSession(request: NextRequest) {
  // APIルートの場合は、セッション更新のみ行い、リダイレクトはしない
  // これにより、不要な getUser() 呼び出しを減らす
  const isApiRoute = request.nextUrl.pathname.startsWith('/api/')
  // #1148: メンテナンスモード (feature_flags の maintenance_mode)。このパスは、メンテナンス中でも止めない
  const maintenanceExempt = isMaintenanceExemptPath(request.nextUrl.pathname)

  // #1174: 「同意のお願い」を出すかどうかのヘッダーは、下で middleware が付けたものだけを画面に渡す。
  // クライアントが同じ名前のヘッダーを送ってきても、転送しない。
  try {
    request.headers.delete(LEGAL_CONSENT_PENDING_HEADER)
  } catch {
    // ヘッダーを書き換えられない環境でも、認証の処理は止めない
  }

  // レスポンスを作成（クッキーを蓄積するために1つのインスタンスを使い回す）
  let supabaseResponse = NextResponse.next({
    request,
  })

  // #1030 (round-3 Critical fix): モバイルアプリ (apps/mobile/src/lib/api.ts) は
  // Cookie セッションを持たず、Authorization: Bearer <token> ヘッダーのみで
  // API を呼び出す。lib/supabase/server.ts の createClient() と同様に
  // Authorization ヘッダーを Supabase クライアントへ転送しないと、cookies ハンドラ
  // 経由のセッション解決に失敗し supabase.auth.getUser() が常に user: null を返す
  // (=Bearer セッションの frozen_at チェックが no-op になる) ため、ここで転送する。
  //
  // #1030 (round-4 Warning fix): ただし /api/cron/* 等は CRON_SECRET (非 JWT の
  // 単なる共有シークレット文字列) を `Bearer <secret>` 形式で送ってくる。これを
  // そのまま Supabase クライアントへ転送すると、毎回 Supabase Auth API への実呼び出し
  // (JWT として解釈できず必ず 401) が発生し、cron (1分毎 = 1,440回/日) 相当の無駄な
  // 外部依存を生む。Supabase JWT はドット区切り3セグメント (header.payload.signature)
  // の形式であるため、その形式でない Bearer トークンは転送せず、従来どおりローカルで
  // 短絡させる (Cookie も無いため getUser() は外部呼び出しなしで user: null を返す)。
  const rawAuthHeader = request.headers.get('authorization')
  const authHeader = isJwtBearerHeader(rawAuthHeader) ? rawAuthHeader : null

  // #1182: 必須の環境変数 (Supabase の URL・anon キー) が欠けていたら、認証を素通りさせず (fail-open にしない)、
  // 汎用の 500 で止める。本文には変数名を出さず (#1172)、変数名はサーバーのログ (env-required の 1 行と、
  // internalError → db-logger の構造化ログ) にだけ残す。
  let supabaseConfig: { url: string; anonKey: string }
  try {
    supabaseConfig = getSupabasePublicConfig()
  } catch (error) {
    return internalError('middleware updateSession', error, { path: request.nextUrl.pathname })
  }

  const supabase = createServerClient(
    supabaseConfig.url,
    supabaseConfig.anonKey,
    {
      global: authHeader ? { headers: { Authorization: authHeader } } : undefined,
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value
        },
        set(name: string, value: string, options: any) {
          // リクエストとレスポンスの両方にクッキーを設定
          request.cookies.set({
            name,
            value,
            ...options,
          })
          // 同じレスポンスインスタンスにクッキーを追加（蓄積する）
          supabaseResponse.cookies.set({
            name,
            value,
            ...options,
          })
        },
        remove(name: string, options: any) {
          request.cookies.set({
            name,
            value: '',
            ...options,
          })
          supabaseResponse.cookies.set({
            name,
            value: '',
            ...options,
          })
        },
      },
    }
  )

  // APIルートの場合はセッション更新のみ（詳細な認可は各ルートで行う）
  // これにより、ミドルウェアでの認証チェックを最小限に抑える
  if (isApiRoute) {
    // getSession()でセッションを取得し、必要に応じてトークンをリフレッシュ
    // getUser()よりも軽量で、サーバーへの追加リクエストを行わない
    await supabase.auth.getSession()

    // #1030 (round-2 Critical fix): requireUser/requireRole を経由せず
    // supabase.auth.getUser() を直接呼ぶだけの API route が多数存在し
    // (meal-plans/pantry/recipes/health 等)、frozen_at を一切検査しないまま
    // 素通りしていた。ページナビゲーションと同様にここで凍結判定を行い、
    // 凍結中のアカウントは全 API 呼び出しを 403 で拒否する。
    // 認証・プロフィール取得自体に失敗した場合は各 route 側のチェックに委ねる
    // (#348 と同様、一時的な DB/ネットワーク障害で全 API を誤って止めないための
    // fail-open。frozen かどうか確定できた場合のみブロックする)。
    // #1148: メンテナンスモードの判定にも、ここで読んだユーザー ID とロールを使う (運営ロールは通す)
    let apiUserId: string | undefined
    let apiRoles: string[] | null = null
    try {
      const { data: { user: apiUser }, error: apiUserError } = await supabase.auth.getUser()

      if (!apiUserError && apiUser) {
        apiUserId = apiUser.id
        const { data: apiProfile, error: apiProfileError } = await supabase
          .from('user_profiles')
          .select('roles, frozen_at, unban_at')
          .eq('id', apiUser.id)
          .maybeSingle()

        if (!apiProfileError) {
          apiRoles = Array.isArray(apiProfile?.roles) ? apiProfile.roles : []
          const apiFrozen = isAccountFrozen({
            frozenAt: apiProfile?.frozen_at ?? null,
            unbanAt: apiProfile?.unban_at ?? null,
          })

          if (apiFrozen) {
            return NextResponse.json(
              { error: { code: 'AUTH_ACCOUNT_FROZEN', message: 'アカウントが凍結されています' } },
              { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
            )
          }
        }
      }
    } catch {
      // 認証基盤の一時障害時は各 route 側の getUser()/requireUser() チェックに委ねる
    }

    // #1148: メンテナンスモード (feature_flags の maintenance_mode)。運営ロール (admin / super_admin) 以外の API 呼び出しを
    // 503 で止める。止めないパスは isMaintenanceExemptPath (死活監視・cron・認証・フラグの取得)。
    // フラグが読めないとき・行が無いときは止めない (isMaintenanceFlagOn は例外を投げず、OFF として答える)。
    // ロールを確かめられなかった (プロフィールを読めなかった) ときは、運営かどうか分からないので、運営ではない人として扱う
    if (!maintenanceExempt && !isOperatorRoles(apiRoles) && (await isMaintenanceFlagOn(apiUserId, apiRoles))) {
      return withSessionCookies(supabaseResponse, maintenanceApiResponse())
    }

    return supabaseResponse
  }

  // ページナビゲーションの場合は getUser() で認証を確認
  // エラー時は安全側に倒して /login へリダイレクトする
  let user: { id: string } | null = null
  let getUserFailed = false
  try {
    const { data } = await supabase.auth.getUser()
    user = data.user
  } catch {
    // #86: getUser() が例外を投げた場合 (ネットワークエラー等) は未認証扱いにする
    // RSC payload fetch 時はリダイレクトよりも 200 を返す方が安全なため、フラグを立てる
    user = null
    getUserFailed = true
  }

  // #86: RSC payload fetch (_rsc クエリパラメータ) 時に getUser が例外を投げた場合は
  // リダイレクトせず supabaseResponse を返す（RSC fetch failure を防止）
  if (getUserFailed && request.nextUrl.searchParams.has('_rsc')) {
    return supabaseResponse
  }

  // 認証不要のパス (ホワイトリスト)
  // 注: '/' エントリの startsWith チェックは '//' になるため '/home' は含まれない
  // #270: /onboarding/* は原則認証必須。未認証でアクセスできるのは /onboarding/welcome のみ
  const publicPaths = [
    '/',
    '/login',
    '/signup',
    '/auth',
    '/onboarding/welcome',
    '/about',
    '/pricing',
    '/guide',
    '/faq',
    '/contact',
    '/legal',
    '/terms',  // #1174 利用規約 (サインアップ画面・LP フッターの同意リンクの着地点。未ログインで読める必要がある)
    '/privacy',  // #1174 プライバシーポリシー (同上。ストア審査に出す URL でもある)
    '/company',
    '/news',
    '/invite',  // 招待トークンページ (認証不要で内容確認できる必要がある)
    '/family/promotions',  // #1232 家族参加の本人同意ページ (メールリンク着地。/invite と同趣旨)
  ]
  const isPublicPath = publicPaths.some(
    (path) =>
      request.nextUrl.pathname === path ||
      request.nextUrl.pathname.startsWith(path + '/'),
  )

  // #1148: メンテナンスモード (未ログインの人)。ログイン画面へ回さず、メンテナンス中の画面を出す
  // (ログイン画面そのもの・/auth/*・利用規約・プライバシーポリシーは isMaintenanceExemptPath で通す)。
  // ログイン済みの人は、ロールを読んでから下で判定する (運営ロールは通す)
  if (!user && !maintenanceExempt && (await isMaintenanceFlagOn())) {
    return withSessionCookies(supabaseResponse, maintenancePageResponse())
  }

  if (!user && !isPublicPath) {
    const url = request.nextUrl.clone()
    const next = request.nextUrl.pathname + (request.nextUrl.search ?? '')
    url.pathname = '/login'
    url.search = `?next=${encodeURIComponent(next)}`
    return NextResponse.redirect(url)
  }

  if (user) {
    // user_profiles からオンボーディング状態・凍結状態・同意済みの版 (#1174) を取得
    // #348: error を必ず捕捉し、DB 参照失敗時はリダイレクト判定をスキップする
    // (RLS 拒否・カラム不在・ネットワーク障害などで data=null になった場合に
    //  not_started 扱いで /onboarding/welcome へ飛ばしてしまうバグを防ぐ)
    const { profile, profileError, legalColumnsAvailable } = await fetchMiddlewareProfile(supabase, user.id)

    // #1148: メンテナンスモード (ログイン済みの人)。運営ロール (admin / super_admin) は通し、それ以外は、
    // オンボーディングや凍結の差し戻しより先に、メンテナンス中の画面を出す。
    // プロフィールを読めなかった (ロールが分からない) ときは、運営かどうか確かめられないので、運営ではない人として扱う
    if (
      !maintenanceExempt &&
      !isOperatorRoles(profileError ? null : profile?.roles) &&
      (await isMaintenanceFlagOn(user.id, profileError ? null : profile?.roles))
    ) {
      return withSessionCookies(supabaseResponse, maintenancePageResponse())
    }

    if (!profileError) {
      // #1030: frozen_at がセットされ (かつ一時 BAN が未解除の) アカウントは
      // /frozen へリダイレクトする。無限リダイレクトを避けるため /frozen 自体は除外。
      const frozen = isAccountFrozen({
        frozenAt: profile?.frozen_at ?? null,
        unbanAt: profile?.unban_at ?? null,
      })

      if (frozen) {
        // #1030 (round-3 Warning fix): /frozen ページの「サポートに問い合わせる」
        // リンク (href="/contact") は publicPaths には含まれるが、この凍結リダイレクト
        // 判定は isPublicPath を考慮せず無条件に実行されるため、ログイン中の凍結
        // ユーザーが /contact に遷移しても即座に /frozen へ差し戻され、唯一の異議
        // 申し立て導線が事実上のデッドリンクになっていた。/contact のみ除外する。
        const frozenExemptPaths = ['/frozen', '/contact']
        // S-7b: /auth/* (ネイティブ認証ブリッジなど) も除外する。WebView に凍結中の別アカウントの
        // セッションが残っていても、ブリッジのワンタイムコードの引き換え (= アカウントの切り替え) を止めない。
        // 引き換え後の遷移先では、新しいセッションのアカウントで改めて凍結判定される。
        // #1174: 利用規約・プライバシーポリシー (/terms・/privacy) も除外する。未ログインでも読める公開の文面で、
        // 凍結の理由になる規約を本人が読めなくなるのを防ぐ (/contact と同じ扱い)。
        const isFrozenExemptPath =
          isAuthFlowPath(request.nextUrl.pathname) ||
          isPolicyPath(request.nextUrl.pathname) ||
          frozenExemptPaths.some(
            (path) =>
              request.nextUrl.pathname === path ||
              request.nextUrl.pathname.startsWith(path + '/'),
          )
        if (!isFrozenExemptPath) {
          const url = request.nextUrl.clone()
          url.pathname = '/frozen'
          url.search = ''
          return NextResponse.redirect(url)
        }
        return supabaseResponse
      }

      // #1174: 利用規約・プライバシーポリシーの同意ゲート。
      // 同意済みの版が packages/shared の LEGAL_DOCUMENTS と食い違う (未同意・古い版に同意) サインイン中の利用者を、
      //   - LEGAL_CONSENT_ENFORCE=on のとき: 同意画面 /legal-consent へ回す (戻り先は next)
      //   - LEGAL_CONSENT_NOTICE=on のとき (強制していない間): 通す。画面の上に「同意のお願い」のお知らせを出すだけ
      //   - どちらも on でない (既定): 何もしない。お知らせも出さず、誰も止めない
      // /api/* はこの分岐の手前 (上の isApiRoute) で返っているので対象外。ほかの対象外 (規約・同意画面・認証の途中・
      // 問い合わせ・凍結・ハンズオンツアー・静的ファイル) は lib/legal-consent.ts の isLegalConsentExemptPath。
      // リダイレクトは画面の取得 (GET / HEAD) にだけ掛ける (POST を 307 で同意画面へ回しても、受け取れず失敗するだけのため)。
      // オンボーディングの差し戻し (下) より先に見る: 同意の前に初期設定 (健康情報の入力) へ進ませない。
      // 同意済みの版の列がまだ無い DB (legalColumnsAvailable = false) では素通りさせる。
      if (legalColumnsAvailable) {
        const legalDecision = resolveLegalConsent({
          pathname: request.nextUrl.pathname,
          accepted: profile,
          enforce: isLegalConsentEnforced(),
          notice: isLegalConsentNoticeEnabled(),
        })

        if (legalDecision === 'redirect' && (request.method === 'GET' || request.method === 'HEAD')) {
          const url = request.nextUrl.clone()
          url.pathname = LEGAL_CONSENT_PATH
          url.search = `?next=${encodeURIComponent(buildLegalConsentNext(request.nextUrl.pathname, request.nextUrl.search))}`
          const redirect = NextResponse.redirect(url)
          // 作り直した直後のセッション Cookie (トークンの更新) を失わないよう、リダイレクトにも引き継ぐ
          for (const cookie of supabaseResponse.cookies.getAll()) redirect.cookies.set(cookie)
          return redirect
        }

        if (legalDecision === 'banner') {
          supabaseResponse = withLegalConsentPendingHeader(request, supabaseResponse)
        }
      }

      const redirectPath = resolveOnboardingRedirect({
        pathname: request.nextUrl.pathname,
        roles: profile?.roles || [],
        onboardingStartedAt: profile?.onboarding_started_at ?? null,
        onboardingCompletedAt: profile?.onboarding_completed_at ?? null,
      })

      if (redirectPath && redirectPath !== request.nextUrl.pathname) {
        const url = request.nextUrl.clone()
        url.pathname = redirectPath
        return NextResponse.redirect(url)
      }
    }
  }

  // 認証保護ルートのレスポンスを CDN にキャッシュさせない
  if (!isPublicPath) {
    supabaseResponse.headers.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  }

  return supabaseResponse
}
