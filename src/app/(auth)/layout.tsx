import Link from "next/link";
import Image from "next/image";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen w-full bg-white">
      {/* 左側：ビジュアルエリア（デスクトップのみ） */}
      <div className="hidden lg:flex lg:w-1/2 relative overflow-hidden bg-[#2D2D2D] text-white">
        <div className="absolute inset-0 z-0">
           <Image 
             src="https://images.unsplash.com/photo-1490645935967-10de6ba17061?q=80&w=2000&auto=format&fit=crop" 
             fill 
             alt="Healthy Food" 
             className="object-cover opacity-60"
           />
           <div className="absolute inset-0 bg-gradient-to-t from-[#2D2D2D] via-[#2D2D2D]/40 to-transparent" />
        </div>

        <div className="relative z-10 p-16 flex flex-col justify-between h-full w-full">
          <Link href="/" className="flex items-center gap-3 w-fit hover:opacity-80 transition-opacity">
             <div className="w-10 h-10 rounded-xl bg-white/10 backdrop-blur border border-white/20 flex items-center justify-center text-white font-bold text-lg">
               H
             </div>
             <span className="font-bold text-xl tracking-tight text-white">ほめゴハン</span>
          </Link>

          <div className="space-y-6 max-w-lg">
            <h2 className="text-4xl font-bold leading-tight">
              食べたものが、<br/>
              <span className="text-[#FF8A65]">未来のあなた</span>を作る。
            </h2>
            <p className="text-gray-300 text-lg leading-relaxed">
              AIと共に、毎日の食事からパフォーマンスを最大化しましょう。<br/>
              無理な制限ではなく、心地よいバランスを。
            </p>
          </div>

          <div className="flex items-center gap-4 text-sm text-gray-400">
            <div className="flex -space-x-3">
              {[1,2,3].map(i => (
                <div key={i} className="w-8 h-8 rounded-full border-2 border-[#2D2D2D] bg-gray-600 overflow-hidden relative">
                   {/* プレースホルダーとしてアバター画像を想定 */}
                   <div className="absolute inset-0 bg-gradient-to-br from-gray-500 to-gray-700" />
                </div>
              ))}
            </div>
            <p>10,000+ ユーザーが実践中</p>
          </div>
        </div>
      </div>

      {/* 右側：フォームエリア */}
      <div className="flex-1 flex flex-col justify-center items-center p-8 lg:p-16 relative">
        {/* モバイル用ヘッダー */}
        <div className="lg:hidden absolute top-8 left-8">
           <Link href="/" className="flex items-center gap-2">
             <div className="w-8 h-8 rounded-full bg-[#FF8A65] flex items-center justify-center text-white font-bold text-sm">H</div>
           </Link>
        </div>

        <div className="w-full max-w-md space-y-8">
          {children}
        </div>
        
        {/* 背景装飾（控えめに） */}
        <div className="absolute bottom-0 right-0 w-64 h-64 bg-orange-50 rounded-full blur-3xl opacity-50 -z-10 pointer-events-none" />
      </div>
    </div>
  )
}
