import Link from "next/link";

export default function NotFound() {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-6 text-center"
      style={{ backgroundColor: "#FAF9F7", fontFamily: "sans-serif" }}
    >
      <div
        className="w-20 h-20 rounded-full flex items-center justify-center text-4xl font-bold mb-6"
        style={{ backgroundColor: "#FDF0ED", color: "#E07A5F" }}
      >
        404
      </div>
      <h1 className="text-xl font-bold mb-2" style={{ color: "#1A1A1A" }}>
        ページが見つかりません
      </h1>
      <p className="text-sm mb-8 max-w-xs" style={{ color: "#9A9A9A" }}>
        お探しのページは存在しないか、URLが正しくない可能性があります。
      </p>
      <Link
        href="/home"
        className="px-6 py-3 rounded-full font-bold text-sm text-white"
        style={{ backgroundColor: "#E07A5F" }}
      >
        ホームへ戻る
      </Link>
    </div>
  );
}
