import { createClient } from '@/lib/supabase/server';
import { NextRequest, NextResponse } from 'next/server';

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
        from: 'homegohan <noreply@homegohan.app>',
        to: [adminEmail],
        subject: `[お問い合わせ] ${inquiry.subject}`,
        text: [
          `新しいお問い合わせが届きました。`,
          ``,
          `ID: ${inquiry.id}`,
          `種別: ${inquiry.inquiry_type}`,
          `送信者: ${inquiry.email}`,
          `件名: ${inquiry.subject}`,
          ``,
          `--- 内容 ---`,
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

// IP ベース簡易レートリミット: 10req / 60s / IP (in-memory)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

export async function POST(request: NextRequest) {
  // レートリミットチェック
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';
  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: 'リクエストが多すぎます。しばらく時間をおいてからお試しください。' },
      { status: 429 }
    );
  }

  const supabase = await createClient();
  
  try {
    const body = await request.json();
    const { inquiryType, email, subject, message } = body;

    // バリデーション
    if (!inquiryType || !email || !subject || !message) {
      return NextResponse.json(
        { error: '必須項目が入力されていません' },
        { status: 400 }
      );
    }

    // メールアドレスの簡易バリデーション
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: '有効なメールアドレスを入力してください' },
        { status: 400 }
      );
    }

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
        { status: 500 }
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
      { status: 500 }
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
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return NextResponse.json({ inquiries: data });
  } catch (error: any) {
    console.error('Failed to fetch inquiries:', error);
    return NextResponse.json(
      { error: 'お問い合わせ履歴の取得に失敗しました' },
      { status: 500 }
    );
  }
}

