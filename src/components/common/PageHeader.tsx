"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { Icons } from "@/components/icons";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  backUrl?: string;
}

export function PageHeader({ title, subtitle, backUrl }: PageHeaderProps) {
  const router = useRouter();

  const handleBack = () => {
    if (backUrl) return;
    router.back();
  };

  return (
    <div className="bg-white p-6 pb-4 border-b border-gray-100 sticky top-0 z-20">
      <div className="mb-4">
        {backUrl ? (
          <Link href={backUrl} className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-gray-600 transition-colors group">
            <Icons.Back className="w-5 h-5 group-hover:-translate-x-1 transition-transform" />
            Back
          </Link>
        ) : (
          <button onClick={handleBack} className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-gray-600 transition-colors group">
            <Icons.Back className="w-5 h-5 group-hover:-translate-x-1 transition-transform" />
            Back
          </button>
        )}
      </div>
      <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
      {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
    </div>
  );
}

