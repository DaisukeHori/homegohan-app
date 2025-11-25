"use client";

import { motion } from "framer-motion";

export function LoadingSpinner({ message = "Loading..." }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[300px] p-8">
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
        className="w-12 h-12 border-4 border-accent border-t-transparent rounded-full"
      />
      <p className="mt-4 text-gray-500 font-bold text-sm">{message}</p>
    </div>
  );
}

