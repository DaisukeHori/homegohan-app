import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { TourProvider } from '@/contexts/TourContext';

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
      const baseUrl =
        process.env.NEXT_PUBLIC_APP_URL ??
        (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
      const res = await fetch(`${baseUrl}/api/handson-tour/status`, {
        headers: {
          Cookie: (await import('next/headers')).cookies().toString(),
        },
        cache: 'no-store',
      });

      if (res.ok) {
        const status = (await res.json()) as { should_show: boolean };
        if (!status.should_show) {
          redirect('/home');
        }
      }
    } catch {
      // ネットワークエラー時はそのまま表示する
    }
  }

  return (
    <TourProvider entrySource={entrySource} forceMode={isForce}>
      {children}
    </TourProvider>
  );
}
