import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
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

    // TODO: メール通知を送信（管理者へ）
    // await sendAdminNotification(data);

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

