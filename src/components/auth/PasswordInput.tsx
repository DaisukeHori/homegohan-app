'use client';

/**
 * パスワード表示切替(目アイコン)付きの共通入力コンポーネント
 * Issue #1057 (UX1-06) 対応
 *
 * reset-password には表示切替が既にあるが login/signup には無く、
 * 画面ごとに挙動が不一致だった。共通化して login/signup でも同じ操作性を提供する。
 */

import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input, type InputProps } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface PasswordInputProps extends Omit<InputProps, 'type'> {
  /** 表示/非表示切替ボタンの aria-label をカスタマイズする場合 */
  showLabel?: string;
  hideLabel?: string;
}

export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, showLabel = 'パスワードを表示する', hideLabel = 'パスワードを非表示にする', ...props }, ref) => {
    const [visible, setVisible] = React.useState(false);

    return (
      <div className="relative">
        <Input
          ref={ref}
          type={visible ? 'text' : 'password'}
          className={cn('pr-12', className)}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? hideLabel : showLabel}
          className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
        >
          {visible ? <EyeOff size={20} /> : <Eye size={20} />}
        </button>
      </div>
    );
  }
);
PasswordInput.displayName = 'PasswordInput';
