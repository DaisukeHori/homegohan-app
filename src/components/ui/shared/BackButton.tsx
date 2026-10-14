"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Icons } from "@/components/icons";

interface BackButtonProps {
  className?: string;
  label?: string;
  /** 指定時はブラウザ履歴の router.back() ではなく、この URL へ遷移する (#1058: common/PageHeader の backUrl を統合) */
  href?: string;
}

export function BackButton({ className = "", label = "戻る", href }: BackButtonProps) {
  const router = useRouter();

  if (href) {
    return (
      <Link
        href={href}
        className={`inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-800 transition-colors group ${className}`}
      >
        <Icons.Back className="w-5 h-5 group-hover:-translate-x-1 transition-transform" />
        {label}
      </Link>
    );
  }

  return (
    <Button
      variant="ghost"
      onClick={() => router.back()}
      className={`pl-0 hover:bg-transparent hover:text-gray-800 text-gray-500 gap-2 transition-colors group ${className}`}
    >
      <Icons.Back className="w-5 h-5 group-hover:-translate-x-1 transition-transform" />
      {label}
    </Button>
  );
}

