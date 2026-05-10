import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { TourProvider } from '@/contexts/TourContext';
import { getHandsonTourStatusInternal } from '@/lib/handson-tour/getStatus';

interface HandsonTourLayoutProps {
  children: React.ReactNode;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function HandsonTourLayout({
  children,
  searchParams,
}: HandsonTourLayoutProps) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  const resolvedParams = searchParams ? await searchParams : {};
  const forceParam = resolvedParams['force'];
  const isForce = forceParam === '1';
  const entrySource: 'auto' | 'settings_force' = isForce ? 'settings_force' : 'auto';

  if (!isForce) {
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
      if (!status.should_show) {
        redirect('/home');
      }
    } catch {
      // プロファイル未取得・タイムアウト時はそのまま表示する
    }
  }

  return (
    <TourProvider entrySource={entrySource} forceMode={isForce}>
      {children}
    </TourProvider>
  );
}
