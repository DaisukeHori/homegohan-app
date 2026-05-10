'use client';

// src/components/membership/InviteLayout.tsx
// (設計書 03-ui-spec.md §2.2)
// 共通レイアウト: scope_name / role / invited_by_name / expires_at 表示

import { type ReactNode } from 'react';

interface InviteLayoutProps {
  scope: 'organization' | 'family';
  scopeName?: string;
  inviterName?: string;
  role?: string;
  expiresAt?: string;
  children: ReactNode;
}

export function InviteLayout({
  scope,
  scopeName,
  inviterName,
  expiresAt,
  children,
}: InviteLayoutProps) {
  const scopeLabel = scope === 'organization' ? '組織' : '家族グループ';

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* ヘッダー */}
      <header className="bg-white border-b border-gray-100 px-6 py-4 flex items-center gap-3">
        <span className="text-2xl">🍚</span>
        <h1 className="text-base font-bold text-gray-900">ほめゴハン 招待</h1>
      </header>

      {/* メインコンテンツ */}
      <main className="flex-1 flex flex-col items-center justify-center p-6">
        {scopeName && inviterName && (
          <div className="max-w-sm w-full mb-4 text-center text-sm text-gray-500">
            <span className="font-medium text-gray-700">{inviterName}</span> 様から
            「<span className="font-medium text-gray-700">{scopeName}</span>」
            {scopeLabel}への招待が届いています
          </div>
        )}

        {children}

        {expiresAt && (
          <p className="mt-4 text-xs text-gray-400 text-center">
            期限: {new Date(expiresAt).toLocaleDateString('ja-JP')} まで
          </p>
        )}
      </main>

      {/* フッター */}
      <footer className="py-6 text-center text-xs text-gray-400 border-t border-gray-100">
        <p>
          不正利用のおそれがある場合は{' '}
          <a href="mailto:support@homegohan.app" className="underline">
            support@homegohan.app
          </a>{' '}
          までご連絡ください
        </p>
      </footer>
    </div>
  );
}
