import { createLogger } from '@/lib/db-logger';
import { checkRateLimit, rateLimitExceededResponse, type RateLimitResult } from '@/lib/rate-limit';
import { createClient } from '@/lib/supabase/server';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

// #1044 (F6-19): 入力を Zod で厳密検証する
const contactInquirySchema = z.object({
  inquiryType: z.enum(['general', 'support', 'bug', 'feature'], {
    message: 'inquiryType の値が不正です',
  }),
  email: z.string().email('有効なメールアドレスを入力してください'),
  subject: z.string().min(1, '件名は必須です').max(100, '件名は100文字以内です'),
  message: z.string().min(1, 'お問い合わせ内容は必須です').max(5000, 'お問い合わせ内容は5000文字以内です'),
});

// GET で返す列は必要最小限に限定する (admin_notes 等の内部情報は返さない)
const INQUIRY_SAFE_COLUMNS =
  'id, inquiry_type, subject, message, status, created_at, updated_at, resolved_at';

async function sendAdminNotification(inquiry: {
  id: string;
  inquiry_type: string;
  email: string;
  subject: string;
  message: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;

  if (!apiKey || !adminEmail) {
    console.error('Admin notification skipped: RESEND_API_KEY or ADMIN_NOTIFICATION_EMAIL not set');
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'ほめゴハン <noreply@homegohan.app>',
        to: [adminEmail],
        subject: `[お問い合わせ] ${inquiry.subject}`,
        text: [
          '新しいお問い合わせが届きました。',
          '',
          `ID: ${inquiry.id}`,
          `種別: ${inquiry.inquiry_type}`,
          `送信者: ${inquiry.email}`,
          `件名: ${inquiry.subject}`,
          '',
          '--- 内容 ---',
          inquiry.message,
        ].join('\n'),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('Admin notification failed:', res.status, body);
    }
  } catch (err) {
    console.error('Admin notification error:', err);
  }
}

export async function POST(request: NextRequest) {
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
    const body = await request.json();

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

    // DBに保存
    const { data, error } = await supabase
      .from('inquiries')
      .insert({
        user_id: userId,
        inquiry_type: inquiryType,
        email,
        subject,
        message,
        status: 'pending',
      })
      .select()
      .single();

    if (error) {
      console.error('Failed to save inquiry:', error);
      return NextResponse.json(
        { error: 'お問い合わせの保存に失敗しました' },
        { status: 500 },
      );
    }

    // 管理者へメール通知（env未設定時はsilent succeed）
    await sendAdminNotification(data);

    return NextResponse.json({
      success: true,
      message: 'お問い合わせを受け付けました。内容を確認の上、ご連絡いたします。',
      inquiryId: data.id,
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
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { data, error } = await supabase
      .from('inquiries')
      .select(INQUIRY_SAFE_COLUMNS)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

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
