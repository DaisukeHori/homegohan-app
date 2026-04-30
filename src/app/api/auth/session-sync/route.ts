import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST() {
  try {
    const supabase = await createClient()
    const {
      data: { session: existingSession },
      error: sessionError,
    } = await supabase.auth.getSession()

    let session = existingSession
    let source: 'session' | 'refresh' = 'session'

    if (!session?.access_token || !session?.refresh_token) {
      const {
        data: { session: refreshedSession },
        error: refreshError,
      } = await supabase.auth.refreshSession()

      if (refreshError) {
        console.warn('Session sync refresh failed', {
          error: refreshError.message,
        })
      }

      if (refreshedSession?.access_token && refreshedSession?.refresh_token) {
        session = refreshedSession
        source = 'refresh'
      }
    }

    if (sessionError || !session?.access_token || !session?.refresh_token) {
      console.warn('Session sync unauthorized', {
        error: sessionError?.message ?? null,
        hadSession: Boolean(existingSession?.access_token),
      })
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    console.info('Session sync succeeded', {
      source,
      userId: session.user?.id ?? null,
    })

    // トークンはレスポンスボディに含めない (httpOnly Cookie で管理)
    return NextResponse.json(
      { ok: true },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
