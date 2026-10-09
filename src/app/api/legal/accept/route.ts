// src/app/api/legal/accept/route.ts
// #1174: 利用規約・プライバシーポリシーへの同意を記録する (同意画面 /legal-consent の「同意して続ける」)
//
// 流れ:
//   1. サインイン中の本人であることを確認する (未ログインは 401)。
//   2. body の { terms_version, privacy_version } が、いま有効な版 (packages/shared の LEGAL_DOCUMENTS) と
//      一致することを確認する。古い画面を開いたまま改定されたときに、読んでいない版を「同意した」と記録しないため。
//      一致しないときは 409 で、いま有効な版を返す (画面は読み込み直す)。
//   3. DB 関数 accept_legal_documents を、本人のセッションで呼ぶ。関数は auth.uid() 本人の行だけを書く
//      (user_profiles の同意済みの版 3 列 + terms_acceptances の証跡)。他人の ID を渡す手段は無い。
//      証跡に残す IP・user_agent は、クライアントの入力ではなく、このサーバーが受け取ったリクエストから取る。
//
// 凍結中のアカウントは middleware が /api/* で 403 にする。
// 同意の記録は、同じ版なら何回呼んでも増えない (DB 関数が冪等) ので、二重送信してもよい。
//
// ログ: 成功したときは、同意した版だけを残す (IP・user_agent は残さない)。
// 失敗したときは、共通ヘルパー internalError が元のエラーを構造化ログに残し、応答は汎用メッセージの 500 にする
// (DB の生のエラー文は応答に出さない。#1172)。
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { LEGAL_DOCUMENTS, LEGAL_VERSION_MAX_LENGTH } from '@homegohan/shared';
import { createClient } from '@/lib/supabase/server';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { extractClientIp } from '@/lib/admin/audit';
import { internalError } from '@/lib/api/errors';

/** body の最大文字数 (版 2 つだけなので、数十文字で足りる) */
const MAX_BODY_CHARS = 1024;

/** user_agent の最大文字数。DB 関数 accept_legal_documents も 512 文字で切る (ここでも先に切って、巨大なヘッダーを持ち回らない) */
const MAX_USER_AGENT_LENGTH = 512;

const BodySchema = z.object({
  terms_version: z.string().min(1).max(LEGAL_VERSION_MAX_LENGTH),
  privacy_version: z.string().min(1).max(LEGAL_VERSION_MAX_LENGTH),
});

function errorResponse(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: { code, message }, ...extra }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const logger = createLogger('POST /api/legal/accept', generateRequestId());

  try {
    const supabase = createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return errorResponse(401, 'AUTH_UNAUTHENTICATED', '認証が必要です');
    }

    // 同意の証跡を、他のサイトからのフォーム送信で勝手に作らせない。JSON 以外の Content-Type (text/plain など) は、
    // ブラウザが事前確認 (CORS のプリフライト) なしで他のサイトから送れてしまうので受け付けない。
    // Cookie は SameSite=Lax で他のサイトからの POST には付かないが、念のための二重の備え (アプリの Bearer 認証には影響しない)
    if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      return errorResponse(415, 'LEGAL_UNSUPPORTED_MEDIA_TYPE', '入力値が不正です');
    }

    let body: unknown;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_CHARS) {
        return errorResponse(400, 'LEGAL_BAD_REQUEST', '入力値が不正です');
      }
      body = JSON.parse(raw);
    } catch {
      return errorResponse(400, 'LEGAL_BAD_REQUEST', '入力値が不正です');
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(400, 'LEGAL_BAD_REQUEST', '入力値が不正です');
    }
    const { terms_version, privacy_version } = parsed.data;

    const current = {
      terms_version: LEGAL_DOCUMENTS.terms_of_service.version,
      privacy_version: LEGAL_DOCUMENTS.privacy_policy.version,
    };
    if (terms_version !== current.terms_version || privacy_version !== current.privacy_version) {
      return errorResponse(
        409,
        'LEGAL_VERSION_MISMATCH',
        '利用規約・プライバシーポリシーが更新されました。画面を読み込み直して、内容をご確認ください',
        { current },
      );
    }

    // 証跡の IP・user_agent は、body ではなく、このサーバーが受け取ったリクエストのヘッダーから取る。
    // IP は DB の inet 型に渡すので、IPv4 / IPv6 として読めない値 (ポート付き・ゾーン ID 付き・ゴミ) は null にする
    // (共通の extractClientIp。監査ログ admin_audit_logs と同じ取り方)。読めなくても同意の記録は止めない。
    const userAgent = request.headers.get('user-agent')?.trim().slice(0, MAX_USER_AGENT_LENGTH) || null;
    const { data, error } = await supabase.rpc('accept_legal_documents', {
      p_terms_version: terms_version,
      p_privacy_version: privacy_version,
      p_ip: extractClientIp(request.headers),
      p_user_agent: userAgent,
    });
    if (error) {
      // 元のエラーは構造化ログにだけ残し、利用者には汎用メッセージの 500 を返す (本文の形は、この route の 4xx と同じ nested)
      return internalError(
        'POST /api/legal/accept',
        error,
        { userId: user.id, rpc: 'accept_legal_documents' },
        { shape: 'nested' },
      );
    }

    logger.withUser(user.id).info('legal documents accepted', { terms_version, privacy_version });

    const accepted = (data ?? {}) as {
      terms_version_accepted?: string | null;
      privacy_version_accepted?: string | null;
      legal_accepted_at?: string | null;
    };
    return NextResponse.json(
      {
        accepted: true,
        terms_version_accepted: accepted.terms_version_accepted ?? terms_version,
        privacy_version_accepted: accepted.privacy_version_accepted ?? privacy_version,
        legal_accepted_at: accepted.legal_accepted_at ?? null,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return internalError('POST /api/legal/accept', error, {}, { shape: 'nested' });
  }
}
