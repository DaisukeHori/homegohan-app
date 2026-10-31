import { createLogger } from '@/lib/db-logger';
import { checkRateLimit, rateLimitExceededResponse, type RateLimitResult } from '@/lib/rate-limit';
import { getSiteUrl } from '@/lib/site-config';
import { createClient } from '@/lib/supabase/server';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { sendEmail } from '@/lib/emails/send';
import { isEmailFailure } from '@/lib/emails/send-result';
import { maskEmailAddress } from '@/lib/emails/outbox';
import { renderContactAdminNotificationEmail } from '@/lib/emails/support/contact-admin-notification';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { LIST_ORDERS, orderListBy } from '@/lib/api/list-order';

// #1044 (F6-19): 入力を Zod で厳密検証する
const contactInquirySchema = z.object({
  inquiryType: z.enum(['general', 'support', 'bug', 'feature'], {
    message: 'お問い合わせの種類 (inquiryType) の値が不正です',
  }),
  email: z.string().email('有効なメールアドレスを入力してください'),
  subject: z.string().min(1, '件名は必須です').max(100, '件名は100文字以内です'),
  message: z.string().min(1, 'お問い合わせ内容は必須です').max(5000, 'お問い合わせ内容は5000文字以内です'),
});

// GET で返す列は必要最小限に限定する (admin_notes 等の内部情報は返さない)
const INQUIRY_SAFE_COLUMNS =
  'id, inquiry_type, subject, message, status, created_at, updated_at, resolved_at';

/** サポートの画面のお問い合わせの一覧 (src/app/(support)/support/inquiries/page.tsx) のパス */
const SUPPORT_INQUIRIES_PATH = '/support/inquiries';

/**
 * 運営 (ADMIN_NOTIFICATION_EMAIL) へお問い合わせが届いたことを知らせる (#1193)。
 * Resend を直接呼ばず、sendEmail で送信待ち (email_outbox) に登録する (送るのは worker: 記録・再試行・dead の通知・再送が効く)。
 * 問い合わせた人のメールアドレスは本文にマスクした形だけを載せ、全体はサポートの画面 (/support/inquiries) で見る
 * (docs/design/operator/10-logs-and-mail-retry.md §6.6)。
 */
async function sendAdminNotification(inquiry: {
  id: string;
  inquiry_type: string;
  email: string;
  subject: string;
  message: string;
}): Promise<void> {
  const logger = createLogger('contact');
  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (!adminEmail) {
    // 問い合わせは保存済み。通知の宛先が無いことだけを残す (変数名はログにだけ書く)
    logger.warn('ADMIN_NOTIFICATION_EMAIL が未設定のため、お問い合わせの通知メールを送りません', { inquiry_id: inquiry.id });
    return;
  }
  // sendEmail は例外を投げない (R-01)。鍵が無いとき (skipped) は sendEmail が warn を残す
  const result = await sendEmail(
    renderContactAdminNotificationEmail({
      to_email: adminEmail,
      inquiry_id: inquiry.id,
      inquiry_type: inquiry.inquiry_type,
      sender_masked: maskEmailAddress(inquiry.email),
      subject: inquiry.subject,
      message: inquiry.message,
      inquiries_url: `${getSiteUrl()}${SUPPORT_INQUIRIES_PATH}`,
    }),
  );
  if (isEmailFailure(result)) {
    logger.warn('お問い合わせの通知メールを送信待ちに登録できませんでした', { inquiry_id: inquiry.id, error_code: result.error.code });
  }
}

export async function POST(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  // #1197 レートリミットは共通ヘルパー (src/lib/rate-limit.ts) の contact カテゴリ (クライアント IP 単位で
  // 10 回/分) に一本化した。以前はこのファイルに Upstash / in-memory の制限が独自実装されていた。
  // 失敗時の扱いは共通ヘルパーに揃える。
  // - Upstash 未設定: fail-open (無制限に通す) にも hard 503 にもしない。in-memory フォールバック
  //   (+ warn ログ) で最低限の制限をかけて受け付ける。本番で Upstash が未接続の間も問い合わせフォームを
  //   止めないため (#1044 round-2)。Vercel ではインスタンスごとに数えるベストエフォートの防御になる。
  // - Upstash への問い合わせが例外: fail-closed。判定できないときは通さず 500 を返し、
  //   問い合わせの保存も管理者への通知メールも行わない。
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';
  let rateLimit: RateLimitResult;
  try {
    rateLimit = await checkRateLimit(ip, 'contact');
  } catch (error) {
    createLogger('contact').error('レート制限の判定に失敗しました (fail-closed)', error);
    return NextResponse.json(
      { error: 'サーバーエラーが発生しました' },
      { status: 500 },
    );
  }
  if (!rateLimit.success) return rateLimitExceededResponse(rateLimit);

  const supabase = await createClient();

  try {
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }

    // #1044 (F6-19): Zod による厳密バリデーション
    const parseResult = contactInquirySchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: '入力内容を確認してください', details: parseResult.error.flatten() },
        { status: 400 },
      );
    }
    const { inquiryType, email, subject, message } = parseResult.data;

    // ユーザーIDを取得（ログイン中の場合）
    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id || null;

    // DBに保存。id は route で決めて渡し、保存した行を読み返さない (RETURNING を付けない)。
    // /contact は未ログインでも送れるが、inquiries の SELECT のポリシーは authenticated だけで、anon が読める行は無い。
    // INSERT … RETURNING (insert().select()) は SELECT のポリシーも新しい行に当てるので、読み返すと未ログインの送信が
    // RLS の違反で落ちて 500 になる (tests/integration/rls/contact-anon-insert.test.ts)。
    // 書き込みは今までどおり本人のセッション (ポリシー "Anyone can create inquiries" の条件つき) で行う。
    const inquiryId = crypto.randomUUID();
    const { error } = await supabase
      .from('inquiries')
      .insert({
        id: inquiryId,
        user_id: userId,
        inquiry_type: inquiryType,
        email,
        subject,
        message,
        status: 'pending',
      });

    if (error) {
      console.error('Failed to save inquiry:', error);
      return NextResponse.json(
        { error: 'お問い合わせの保存に失敗しました' },
        { status: 500 },
      );
    }

    // 管理者へメール通知（env未設定時はsilent succeed）。保存した値 (検証済みの入力と route で決めた id) を渡す
    await sendAdminNotification({ id: inquiryId, inquiry_type: inquiryType, email, subject, message });

    return NextResponse.json({
      success: true,
      message: 'お問い合わせを受け付けました。内容を確認の上、ご連絡いたします。',
      inquiryId,
    });

  } catch (error: any) {
    console.error('Contact API error:', error);
    return NextResponse.json(
      { error: 'サーバーエラーが発生しました' },
      { status: 500 },
    );
  }
}

// 自分のお問い合わせ履歴を取得（ログインユーザーのみ）
export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  try {
    // 作った日時の新しい順。同じ日時は id の順 (#2139 T1)
    const { data, error } = await orderListBy(
      supabase.from('inquiries').select(INQUIRY_SAFE_COLUMNS).eq('user_id', user.id),
      LIST_ORDERS.contactMyInquiries,
    );

    if (error) throw error;

    return NextResponse.json({ inquiries: data });
  } catch (error: any) {
    console.error('Failed to fetch inquiries:', error);
    return NextResponse.json(
      { error: 'お問い合わせ履歴の取得に失敗しました' },
      { status: 500 },
    );
  }
}
