import Link from "next/link";
import Image from "next/image";

export default function WelcomePage() {
  return (
    <div className="relative w-full min-h-screen bg-white overflow-x-hidden">
      
      {/* 背景の装飾（控えめで上品に） */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="blob-shape bg-orange-100 w-[600px] h-[600px] -top-[10%] -left-[10%]" />
        <div className="blob-shape bg-blue-50 w-[500px] h-[500px] top-[40%] -right-[10%]" />
      </div>

      {/* ヘッダー */}
      <header className="fixed top-0 w-full z-50 bg-white/80 backdrop-blur-md border-b border-gray-100 transition-all duration-300">
        <div className="container mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-2 group cursor-pointer">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#FF8A65] to-[#FF7043] flex items-center justify-center text-white font-bold text-lg shadow-md">
              H
            </div>
            <span className="font-bold text-xl tracking-tight text-gray-800">
              ほめゴハン
            </span>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/login" className="text-sm font-medium text-gray-600 hover:text-[#FF8A65] transition-colors px-2">
              ログイン
            </Link>
            <Link href="/signup" className="text-sm font-bold px-6 py-2.5 bg-[#333] text-white rounded-full hover:bg-black hover:shadow-lg transition-all duration-300 transform hover:-translate-y-0.5">
              はじめる
            </Link>
          </div>
        </div>
      </header>

      {/* ヒーローセクション */}
      <section className="relative pt-40 pb-24 lg:pt-52 lg:pb-40 px-6">
        <div className="container mx-auto max-w-7xl">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            
            {/* テキストエリア */}
            <div className="space-y-8 animate-fade-up">
              <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-orange-50 text-orange-600 text-xs font-bold tracking-wide border border-orange-100">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-orange-500"></span>
                </span>
                AI DIETARY PARTNER
              </div>

              <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold leading-[1.1] text-gray-900 tracking-tight">
                食卓を、もっと<br />
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#FF8A65] to-[#FF5722]">自分らしく彩る。</span>
              </h1>

              <p className="text-gray-500 text-lg md:text-xl leading-relaxed max-w-lg">
                ただカロリーを数えるだけではありません。<br/>
                AIがあなたの食事の良い点を見つけ、<br/>
                「おいしい」と「健康的」のバランスを提案します。
              </p>

              <div className="flex flex-col sm:flex-row gap-4 pt-4">
                <Link
                  href="/signup"
                  className="px-8 py-4 bg-[#FF8A65] hover:bg-[#FF7043] text-white font-bold rounded-full shadow-lg hover:shadow-[#FF8A65]/30 transition-all duration-300 text-center"
                >
                  無料で試してみる
                </Link>
                <Link
                  href="#features"
                  className="px-8 py-4 bg-white text-gray-600 font-bold rounded-full border border-gray-200 hover:bg-gray-50 transition-all duration-300 text-center"
                >
                  機能を見る
                </Link>
              </div>
              
              <div className="pt-8 flex items-center gap-8 text-sm text-gray-400">
                <div className="flex items-center gap-2">
                  <svg className="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                  登録は30秒で完了
                </div>
                <div className="flex items-center gap-2">
                  <svg className="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                  クレジットカード不要
                </div>
              </div>
            </div>

            {/* ビジュアルエリア（スマホモックアップ風） */}
            <div className="relative animate-fade-up delay-200 lg:translate-x-8">
              <div className="relative z-10 mx-auto w-[320px] md:w-[380px]">
                {/* スマホフレーム */}
                <div className="bg-white rounded-[3rem] shadow-[0_25px_60px_-15px_rgba(0,0,0,0.1)] border-[8px] border-white overflow-hidden relative z-10">
                  <div className="relative aspect-[9/19] bg-gray-50">
                    <Image 
                      src="https://images.unsplash.com/photo-1543362906-acfc16c67564?q=80&w=800&auto=format&fit=crop" 
                      fill 
                      alt="App Screen" 
                      className="object-cover"
                    />
                    {/* UIオーバーレイ */}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-6 pt-20 text-white">
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2">
                           <div className="w-8 h-8 rounded-full bg-[#FF8A65] flex items-center justify-center text-xs font-bold">AI</div>
                           <span className="font-bold text-sm">Analysis Complete</span>
                        </div>
                        <div className="bg-green-500/20 backdrop-blur px-3 py-1 rounded-full text-xs text-green-300 font-bold border border-green-500/30">Score 98</div>
                      </div>
                      <p className="text-sm leading-relaxed opacity-90">
                        彩りが素晴らしいです！<br/>
                        アボカドの良質な脂質と、野菜のビタミンがしっかり摂れていますね。
                      </p>
                    </div>
                  </div>
                </div>
                
                {/* 装飾パーツ */}
                <div className="absolute top-10 -right-12 bg-white p-4 rounded-2xl shadow-xl animate-float">
                   <div className="flex items-center gap-3">
                     <div className="bg-green-100 p-2 rounded-full text-green-600">
                       <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                     </div>
                     <div>
                       <p className="text-xs text-gray-400 font-bold">Vitamin C</p>
                       <p className="text-sm font-bold text-gray-800">Perfect!</p>
                     </div>
                   </div>
                </div>
                
                <div className="absolute bottom-20 -left-12 bg-white p-4 rounded-2xl shadow-xl animate-float-delayed">
                   <div className="flex items-center gap-3">
                     <div className="bg-orange-100 p-2 rounded-full text-orange-600">
                       <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                     </div>
                     <div>
                       <p className="text-xs text-gray-400 font-bold">Energy</p>
                       <p className="text-sm font-bold text-gray-800">On Track</p>
                     </div>
                   </div>
                </div>
              </div>
              
              {/* 背景の円 */}
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-[#FF8A65]/10 rounded-full blur-3xl -z-10" />
            </div>
          </div>
        </div>
      </section>

      {/* 機能セクション（3カラム） */}
      <section id="features" className="py-32 bg-gray-50/50">
        <div className="container mx-auto px-6">
          <div className="text-center max-w-2xl mx-auto mb-20">
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-6">
              無理なく続く、<br/>
              心地よいサイクル。
            </h2>
            <p className="text-gray-500 text-lg">
              「ほめゴハン」は、あなたの生活に溶け込むように設計されています。<br/>
              がんばる日も、力を抜きたい日も。
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                title: "撮るだけ、完了",
                desc: "面倒なカロリー入力はもう不要。写真を撮るだけで、AIが食材と栄養バランスを瞬時に解析します。",
                icon: "📸",
                delay: ""
              },
              {
                title: "ほめて、伸ばす",
                desc: "ダメ出しよりも、良い点を見つけて称賛。ポジティブなフィードバックが、明日のモチベーションを作ります。",
                icon: "✨",
                delay: "delay-100"
              },
              {
                title: "迷わない献立",
                desc: "「今日何食べよう？」の悩みを解消。あなたの好みと栄養状態に合わせて、最適な一週間を提案します。",
                icon: "🍽️",
                delay: "delay-200"
              }
            ].map((item, i) => (
              <div
                key={i}
                className={`group bg-white p-8 rounded-3xl shadow-sm border border-gray-100 hover:shadow-xl hover:-translate-y-1 transition-all duration-300 animate-fade-up ${item.delay}`}
              >
                <div className="w-14 h-14 bg-orange-50 rounded-2xl flex items-center justify-center text-2xl mb-6 group-hover:scale-110 transition-transform duration-300 text-orange-500">
                  {item.icon}
                </div>
                <h3 className="text-xl font-bold text-gray-800 mb-3">{item.title}</h3>
                <p className="text-gray-500 leading-relaxed text-sm">
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ストーリー・イメージセクション */}
      <section className="py-32 px-6 overflow-hidden">
        <div className="container mx-auto max-w-6xl">
          <div className="grid md:grid-cols-2 gap-16 items-center">
            <div className="relative">
               <div className="relative aspect-square rounded-[40px] overflow-hidden shadow-2xl">
                 <Image 
                   src="https://images.unsplash.com/photo-1490645935967-10de6ba17061?q=80&w=1000&auto=format&fit=crop" 
                   fill 
                   alt="Healthy Lifestyle" 
                   className="object-cover hover:scale-105 transition-transform duration-700"
                 />
               </div>
               {/* 装飾画像 */}
               <div className="absolute -bottom-10 -right-10 w-2/3 aspect-square rounded-[40px] overflow-hidden shadow-2xl border-8 border-white hidden md:block">
                 <Image 
                   src="https://images.unsplash.com/photo-1498837167922-ddd27525d352?q=80&w=1000&auto=format&fit=crop" 
                   fill 
                   alt="Cooking" 
                   className="object-cover hover:scale-105 transition-transform duration-700"
                 />
               </div>
            </div>
            
            <div className="md:pl-10 space-y-8">
              <h2 className="text-4xl font-bold text-gray-900 leading-tight">
                「記録する」だけで、<br/>
                意識が変わる。
              </h2>
              <p className="text-lg text-gray-500 leading-loose">
                ほめゴハンは、ただの記録アプリではありません。<br/>
                AIとの対話を通じて、あなたの食に対する「解像度」を高めるツールです。<br/><br/>
                「何が足りないか」より「何が良いか」を知ることで、
                自然と次の食事が楽しみになる。<br/>
                そんなポジティブなサイクルを生み出します。
              </p>
              <Link href="/about" className="inline-flex items-center text-[#FF8A65] font-bold hover:underline decoration-2 underline-offset-4">
                私たちの想いについて
                <svg className="w-4 h-4 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* CTAセクション */}
      <section className="py-32 bg-[#333] text-white relative overflow-hidden">
         {/* 背景画像 */}
         <div className="absolute inset-0 opacity-20">
           <Image 
             src="https://images.unsplash.com/photo-1494859802809-d069c3b71a8a?q=80&w=2000&auto=format&fit=crop" 
             fill 
             alt="Background" 
             className="object-cover"
           />
         </div>
         
         <div className="container mx-auto px-6 relative z-10 text-center max-w-3xl">
           <h2 className="text-4xl md:text-5xl font-bold mb-8 leading-tight">
             さあ、新しい食のパートナーと。
           </h2>
           <p className="text-gray-300 text-lg mb-12 leading-relaxed">
             まずは3日間、写真を撮ってみてください。<br/>
             食事が変わる感覚を、きっと実感できるはずです。
           </p>
           
           <Link
             href="/signup"
             className="inline-block px-12 py-5 bg-white text-gray-900 font-bold rounded-full shadow-[0_0_20px_rgba(255,255,255,0.3)] hover:shadow-[0_0_40px_rgba(255,255,255,0.5)] hover:scale-105 transition-all duration-300"
           >
             アカウントを作成する（無料）
           </Link>
           <p className="mt-6 text-sm text-gray-400">
             ※いつでも解約可能です
           </p>
         </div>
      </section>

      {/* シンプルなフッター */}
      <footer className="bg-white border-t border-gray-100 py-12">
        <div className="container mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-2">
             <div className="w-8 h-8 rounded-full bg-[#FF8A65] flex items-center justify-center text-white font-bold text-sm">H</div>
             <span className="font-bold text-gray-900">ほめゴハン</span>
          </div>
          <div className="flex gap-8 text-sm text-gray-500">
            <Link href="#" className="hover:text-[#FF8A65] transition-colors">利用規約</Link>
            <Link href="#" className="hover:text-[#FF8A65] transition-colors">プライバシー</Link>
            <Link href="#" className="hover:text-[#FF8A65] transition-colors">お問い合わせ</Link>
          </div>
          <div className="text-xs text-gray-400">
            © 2025 Homegohan Inc.
          </div>
        </div>
      </footer>
    </div>
  );
}
