"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Icons } from "@/components/icons";

export function BackButton({ className = "", label = "Back" }: { className?: string, label?: string }) {
  const router = useRouter();
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

