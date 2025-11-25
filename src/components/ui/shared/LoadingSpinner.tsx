"use client";

import { motion } from "framer-motion";

export function LoadingSpinner({ message = "Loading..." }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] p-8 text-center">
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
        className="w-16 h-16 border-4 border-[#FF8A65] border-t-transparent rounded-full mb-4"
      />
      {message && <p className="text-gray-500 font-bold text-sm animate-pulse">{message}</p>}
    </div>
  );
}

