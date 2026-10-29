'use client';

/**
 * 運営の審査の画面 (/admin/moderation の一覧・/admin/moderation/{type}/{id} の詳細) の、読み込みの失敗の表示 (#2086 V7)
 *
 * 一覧・詳細は Server Component で、API の失敗・通信の失敗を 0 件・「無い」(404) と分けてこの部品を描く。
 * 「再読み込み」は router.refresh() でサーバーの画面を描き直す (サーバー側のデータを取り直す)。
 * 文は呼ぶ側 (サーバーの画面) が src/lib/admin/moderation-load-failure.ts の定数を渡す。
 */

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MODERATION_RELOAD_LABEL, MODERATION_RELOADING_LABEL } from '@/lib/admin/moderation-load-failure';

export type ModerationLoadFailureProps = {
  /** 読み込みの失敗の文 */
  message: string;
};

export default function ModerationLoadFailure({ message }: ModerationLoadFailureProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const reload = () => {
    startTransition(() => {
      router.refresh();
    });
  };

  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      <p>{message}</p>
      <button
        type="button"
        onClick={reload}
        disabled={isPending}
        className="mt-3 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
      >
        {isPending ? MODERATION_RELOADING_LABEL : MODERATION_RELOAD_LABEL}
      </button>
    </div>
  );
}
