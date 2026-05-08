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
      const status = await getHandsonTourStatusInternal(user.id);
      if (!status.should_show) {
        redirect('/home');
      }
    } catch {
      // プロファイル未取得時はそのまま表示する
    }
  }

  return (
    <TourProvider entrySource={entrySource} forceMode={isForce}>
      {children}
    </TourProvider>
  );
}
