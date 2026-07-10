import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { TourProvider } from '@/contexts/TourContext';
import { getHandsonTourStatusInternal } from '@/lib/handson-tour/getStatus';
import { HANDSON_TOUR_FORCE_COOKIE } from '@/lib/handson-tour/force-cookie';

interface HandsonTourLayoutProps {
  children: React.ReactNode;
}

export default async function HandsonTourLayout({
  children,
}: HandsonTourLayoutProps) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  // #1045 (F6-05): Next.js の layout は searchParams を受け取れない
  // (Pages と異なり、共有レイアウトはナビゲーション毎に再レンダーされないため searchParams が
  // 保証されない設計になっている)。そのため ?force=1 の判定を layout で行うことはできず、
  // 常に isForce=false になってしまっていた。/handson-tour/replay 専用ルートが発行する
  // Cookie 経由で force 判定を行う。
  const cookieStore = await cookies();
  const isForce = cookieStore.get(HANDSON_TOUR_FORCE_COOKIE)?.value === '1';
  const entrySource: 'auto' | 'settings_force' = isForce ? 'settings_force' : 'auto';

  if (!isForce) {
    // #1045 (F6-05): redirect() は内部的に NEXT_REDIRECT という特殊な例外を投げて
    // Next.js に処理させる仕組みのため、try/catch の中で呼ぶと catch に握り潰されて
    // リダイレクトが発生しなくなる (= 完了済みユーザーにもツアーが表示され続ける)。
    // ステータス判定のみ try/catch に閉じ込め、redirect() は try の外で呼ぶ。
    let shouldRedirectHome = false;
    try {
      // ステータスチェックに最大 5 秒のタイムアウトを設定する。
      // RPC 呼び出しが遅延した場合でもツアー画面を表示し続けるための安全策。
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('handson_tour_status_timeout')), 5000),
      );
      const status = await Promise.race([
        getHandsonTourStatusInternal(user.id),
        timeoutPromise,
      ]);
      shouldRedirectHome = !status.should_show;
    } catch {
      // プロファイル未取得・タイムアウト時はそのまま表示する
      shouldRedirectHome = false;
    }

    if (shouldRedirectHome) {
      redirect('/home');
    }
  }

  return (
    <TourProvider entrySource={entrySource} forceMode={isForce}>
      {children}
    </TourProvider>
  );
}
