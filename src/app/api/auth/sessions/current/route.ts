/**
 * PATCH /api/auth/sessions/current — この端末のログインに端末名を登録する (アプリ。#1189。docs/design/cross/16-auth-history-sessions.md §14.4)
 *
 * rejectNullCharacterBody → 本文 DeviceNameBodySchema (英数字・空白・()._,+- だけ。違えば 400 VALIDATION_ERROR §12.5) →
 * requireSessionUser (user_profiles の行が無い新規の利用者の最初のセッションも通る S-30) →
 * setCurrentDeviceName(service_role, { 本人・要求の JWT の session_id }) で device_name と context_source = 'mobile' を書く。
 * 端末名はメールには載せない (一覧の添え書きだけ §7.1)。
 * 応答: 200 { ok: true } / 404 AUTH_SESSION_NOT_FOUND (行が無い) / 400 VALIDATION_ERROR・INVALID_CHARACTER / 401 / 403 / 500。
 * Cache-Control: private, no-store。
 */
import { type NextRequest } from 'next/server';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { DeviceNameBodySchema } from '@/lib/auth/sessions/schemas';
import { requireSessionUser } from '@/lib/auth/sessions/session-claims';
import { sessionNotFound, sessionsFailure, sessionsJson, sessionsValidationError } from '@/lib/auth/sessions/route-support';
import { setCurrentDeviceName } from '@/lib/auth/sessions/store';
import { readJsonBody } from '@/lib/http-params';
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_NAME = 'PATCH /api/auth/sessions/current';

export async function PATCH(request: NextRequest) {
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;

  const read = await readJsonBody(request);
  if (!read.ok) return sessionsValidationError();
  const parsed = DeviceNameBodySchema.safeParse(read.body);
  if (!parsed.success) return sessionsValidationError();

  let userId: string | undefined;
  try {
    const supabase = await createClient();
    const ctx = await requireSessionUser(supabase, request.headers.get('authorization'));
    userId = ctx.user.id;
    const updated = await setCurrentDeviceName(getSupabaseAdmin(), {
      userId: ctx.user.id,
      sessionId: ctx.session.claims.session_id,
      deviceName: parsed.data.device_name,
    });
    if (!updated) return sessionNotFound();
    return sessionsJson({ ok: true });
  } catch (err) {
    return sessionsFailure(ROUTE_NAME, err, userId);
  }
}
