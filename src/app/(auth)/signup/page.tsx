"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SignupPage() {
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  const handleGoogleSignup = async () => {
    try {
      setIsLoading(true);
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
    } catch (error) {
      console.error('Error signing up with Google:', error);
      alert('Google登録に失敗しました。');
    } finally {
      setIsLoading(false);
    }
  };

  const handleEmailSignup = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsLoading(true);
    const formData = new FormData(e.currentTarget);
    const email = formData.get('email') as string;
    const password = formData.get('password') as string;

    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      if (error) {
        console.error('Signup error:', error);
        alert(`登録に失敗しました: ${error.message}`);
        return;
      }

      // メール確認画面へ
      if (data.user && !data.session) {
        // メール確認が必要な場合
        router.push(`/auth/verify?email=${encodeURIComponent(email)}`);
      } else if (data.session) {
        // 自動ログインされた場合（メール確認が不要な設定の場合）
        router.push('/onboarding');
      }
    } catch (error: any) {
      console.error('Signup error:', error);
      alert(`予期せぬエラーが発生しました: ${error.message || '不明なエラー'}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6 animate-fade-up">
      <div className="space-y-2 text-center lg:text-left">
        <h1 className="text-3xl font-bold tracking-tight text-gray-900">アカウント作成</h1>
        <p className="text-gray-500">30秒で完了します。クレジットカードは不要です。</p>
      </div>

      <div className="space-y-4">
        <Button 
          variant="outline" 
          onClick={handleGoogleSignup}
          disabled={isLoading}
          className="w-full py-6 rounded-xl border-gray-200 hover:bg-gray-50 hover:border-gray-300 transition-all font-bold text-gray-700 flex items-center gap-3 relative overflow-hidden group"
        >
           <svg className="w-5 h-5" viewBox="0 0 24 24">
             <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
             <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
             <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
             <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
           </svg>
           {isLoading ? '処理中...' : 'Googleで登録'}
        </Button>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-gray-100" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-white px-2 text-gray-400">またはメールアドレスで</span>
          </div>
        </div>

        <form onSubmit={handleEmailSignup} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">メールアドレス</Label>
            <Input 
              id="email" 
              name="email"
              type="email" 
              placeholder="name@example.com" 
              required
              className="py-6 rounded-xl border-gray-200 focus:ring-2 focus:ring-[#FF8A65]/20 focus:border-[#FF8A65] transition-all"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">パスワード</Label>
            <Input 
              id="password" 
              name="password"
              type="password" 
              required
              className="py-6 rounded-xl border-gray-200 focus:ring-2 focus:ring-[#FF8A65]/20 focus:border-[#FF8A65] transition-all"
            />
          </div>
          <Button 
            type="submit"
            disabled={isLoading}
            className="w-full py-6 rounded-full bg-[#FF8A65] hover:bg-[#FF7043] text-white font-bold shadow-lg hover:shadow-xl hover:shadow-[#FF8A65]/30 transition-all duration-300"
          >
            {isLoading ? '登録処理中...' : '登録して始める'}
          </Button>
        </form>

        <p className="text-center text-sm text-gray-500">
          すでにアカウントをお持ちですか？{" "}
          <Link href="/login" className="font-bold text-[#FF8A65] hover:text-[#FF7043] hover:underline underline-offset-4">
            ログイン
          </Link>
        </p>

        <p className="text-xs text-center text-gray-400 mt-8">
          続行することで、<Link href="#" className="underline">利用規約</Link>および<Link href="#" className="underline">プライバシーポリシー</Link>に同意したものとみなされます。
        </p>
      </div>
    </div>
  );
}
