"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import { BackButton } from "@/components/ui/shared/BackButton";

// ステップ定義
const STEPS = [
  { id: 1, title: "Ingredients", desc: "冷蔵庫" },
  { id: 2, title: "Personalize", desc: "設定" },
  { id: 3, title: "Conditions", desc: "条件" },
  { id: 4, title: "Confirm", desc: "確認" },
];

export default function MenuRequestWizard() {
  const router = useRouter();
  const supabase = createClient();
  const [currentStep, setCurrentStep] = useState(1);
  const [loading, setLoading] = useState(false);
  
  // ... (state definitions)

  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      {/* Header */}
      <div className="bg-white p-6 sticky top-0 z-20 border-b border-gray-100">
        <div className="flex items-center gap-2 mb-4">
          <BackButton label="" className="mr-2" />
          <h1 className="text-xl font-bold text-gray-900">Create Weekly Plan</h1>
        </div>
        {/* Progress Bar */}
        <div className="flex justify-between relative">
          <div className="absolute top-1/2 left-0 w-full h-1 bg-gray-100 -z-0 -translate-y-1/2 rounded-full" />
          <div 
            className="absolute top-1/2 left-0 h-1 bg-[#FF8A65] -z-0 -translate-y-1/2 rounded-full transition-all duration-300" 
            style={{ width: `${((currentStep - 1) / 3) * 100}%` }}
          />
          {STEPS.map((step) => (
            <div key={step.id} className="relative z-10 flex flex-col items-center">
              <div 
                className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-colors duration-300 ${
                  step.id <= currentStep ? "bg-[#FF8A65] text-white" : "bg-gray-200 text-gray-500"
                }`}
              >
                {step.id}
              </div>
              <span className={`text-[10px] mt-1 font-bold ${step.id <= currentStep ? "text-[#FF8A65]" : "text-gray-400"}`}>
                {step.title}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="p-6">
        <AnimatePresence mode="wait">
          
          {/* Step 1: Ingredients */}
          {currentStep === 1 && (
            <motion.div
              key="step1"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-6"
            >
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <h2 className="font-bold text-gray-900 mb-2">📷 Fridge Scan</h2>
                <p className="text-sm text-gray-500 mb-4">冷蔵庫の中身を撮影すると、AIが食材を自動検知します。</p>
                
                <div 
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full aspect-video rounded-xl border-2 border-dashed border-gray-200 flex flex-col items-center justify-center bg-gray-50 hover:bg-gray-100 cursor-pointer transition-colors relative overflow-hidden"
                >
                  {formData.imageUrl ? (
                    <Image src={formData.imageUrl} alt="Fridge" fill className="object-cover opacity-80" />
                  ) : (
                    <>
                      <span className="text-4xl mb-2">📸</span>
                      <span className="text-sm font-bold text-gray-400">Tap to Scan</span>
                    </>
                  )}
                  {analyzing && (
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                      <div className="w-8 h-8 border-4 border-white border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                </div>
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  className="hidden" 
                  accept="image/*" 
                  onChange={handleImageUpload} 
                />
              </div>

              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <h2 className="font-bold text-gray-900 mb-4">🥫 Ingredients List</h2>
                <div className="flex flex-wrap gap-2 mb-4">
                  {formData.ingredients.length === 0 && <p className="text-sm text-gray-400">No ingredients detected yet.</p>}
                  {formData.ingredients.map((item, i) => (
                    <span key={i} className="px-3 py-1 bg-green-50 text-green-700 rounded-full text-sm font-bold flex items-center gap-1">
                      {item}
                      <button onClick={() => removeIngredient(item)} className="w-4 h-4 rounded-full bg-green-200 flex items-center justify-center text-[10px]">✕</button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input 
                    placeholder="手動で追加..." 
                    className="rounded-full"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        addIngredient(e.currentTarget.value);
                        e.currentTarget.value = '';
                      }
                    }}
                  />
                </div>
              </div>

              <Button onClick={() => setCurrentStep(2)} className="w-full py-6 rounded-full bg-[#333] hover:bg-black font-bold text-white">
                Next: Personalize
              </Button>
            </motion.div>
          )}

          {/* Step 2: Personalize (New) */}
          {currentStep === 2 && (
            <motion.div
              key="step2"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-6"
            >
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 space-y-8">
                
                <div>
                  <Label className="mb-2 block">Family Size (人数)</Label>
                  <div className="flex items-center gap-4 bg-gray-50 p-2 rounded-xl">
                    <button 
                      onClick={() => setFormData(p => ({...p, familySize: Math.max(1, p.familySize - 1)}))}
                      className="w-12 h-12 bg-white rounded-lg shadow-sm flex items-center justify-center text-xl font-bold text-gray-600"
                    >
                      -
                    </button>
                    <div className="flex-1 text-center">
                      <span className="text-3xl font-bold text-gray-900">{formData.familySize}</span>
                      <span className="text-sm text-gray-500 ml-1">人分</span>
                    </div>
                    <button 
                      onClick={() => setFormData(p => ({...p, familySize: Math.min(10, p.familySize + 1)}))}
                      className="w-12 h-12 bg-white rounded-lg shadow-sm flex items-center justify-center text-xl font-bold text-gray-600"
                    >
                      +
                    </button>
                  </div>
                  <p className="text-xs text-gray-400 mt-2">買い物リストの分量計算に使用されます</p>
                </div>

                <div>
                  <Label className="mb-2 block">Cheat Day (好きなものを食べる日)</Label>
                  <div className="grid grid-cols-4 gap-2">
                    {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(day => (
                      <button
                        key={day}
                        onClick={() => setFormData(p => ({...p, cheatDay: p.cheatDay === day ? "" : day}))}
                        className={`p-3 rounded-xl text-sm font-bold transition-all ${
                          formData.cheatDay === day
                            ? "bg-[#FF8A65] text-white shadow-md"
                            : "bg-gray-50 text-gray-500 hover:bg-gray-100"
                        }`}
                      >
                        {day}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-gray-400 mt-2">選択した曜日はカロリー制限が緩和されます</p>
                </div>

              </div>

              <div className="flex gap-4">
                <Button variant="outline" onClick={() => setCurrentStep(1)} className="flex-1 py-6 rounded-full font-bold">
                  Back
                </Button>
                <Button onClick={() => setCurrentStep(3)} className="flex-1 py-6 rounded-full bg-[#333] hover:bg-black font-bold text-white">
                  Next: Conditions
                </Button>
              </div>
            </motion.div>
          )}

          {/* Step 3: Conditions (Old Step 2) */}
          {currentStep === 3 && (
            <motion.div
              key="step3"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-6"
            >
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 space-y-6">
                
                <div>
                  <Label>Start Date</Label>
                  <Input 
                    type="date" 
                    value={formData.startDate} 
                    onChange={(e) => setFormData({...formData, startDate: e.target.value})}
                    className="mt-2"
                  />
                </div>

                <div>
                  <Label>調理時間 (Weekday)</Label>
                  <div className="flex items-center gap-4 mt-2">
                    <input 
                      type="range" 
                      min="10" max="60" step="5"
                      value={formData.cookingTimeWeekday}
                      onChange={(e) => setFormData({...formData, cookingTimeWeekday: parseInt(e.target.value)})}
                      className="flex-1"
                    />
                    <span className="font-bold w-16 text-right">{formData.cookingTimeWeekday} min</span>
                  </div>
                </div>

                <div>
                  <Label>調理時間 (Weekend)</Label>
                  <div className="flex items-center gap-4 mt-2">
                    <input 
                      type="range" 
                      min="10" max="120" step="10"
                      value={formData.cookingTimeWeekend}
                      onChange={(e) => setFormData({...formData, cookingTimeWeekend: parseInt(e.target.value)})}
                      className="flex-1"
                    />
                    <span className="font-bold w-16 text-right">{formData.cookingTimeWeekend} min</span>
                  </div>
                </div>

                <div>
                  <Label>Theme</Label>
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    {["💰 Saving", "💪 Muscle", "⚡️ Recovery", "🥗 Diet", "🍱 Bento", "⏱️ Speed"].map(theme => (
                      <button
                        key={theme}
                        onClick={() => toggleTheme(theme)}
                        className={`p-3 rounded-xl border text-sm font-bold transition-all ${
                          formData.themes.includes(theme)
                            ? "border-[#FF8A65] bg-orange-50 text-[#FF8A65]"
                            : "border-gray-200 bg-white text-gray-500"
                        }`}
                      >
                        {theme}
                      </button>
                    ))}
                  </div>
                </div>

              </div>

              <div className="flex gap-4">
                <Button variant="outline" onClick={() => setCurrentStep(2)} className="flex-1 py-6 rounded-full font-bold">
                  Back
                </Button>
                <Button onClick={() => setCurrentStep(4)} className="flex-1 py-6 rounded-full bg-[#333] hover:bg-black font-bold text-white">
                  Next: Confirm
                </Button>
              </div>
            </motion.div>
          )}

          {/* Step 4: Confirm (Old Step 3) */}
          {currentStep === 4 && (
            <motion.div
              key="step4"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-6"
            >
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <h2 className="font-bold text-gray-900 mb-4">Summary</h2>
                
                <div className="space-y-4 text-sm">
                  <div className="flex justify-between border-b border-gray-50 pb-2">
                    <span className="text-gray-500">Start Date</span>
                    <span className="font-bold">{formData.startDate || "Not set"}</span>
                  </div>
                  <div className="flex justify-between border-b border-gray-50 pb-2">
                    <span className="text-gray-500">Inventory</span>
                    <span className="font-bold">{formData.ingredients.length} items</span>
                  </div>
                  <div className="flex justify-between border-b border-gray-50 pb-2">
                    <span className="text-gray-500">Family / Cheat Day</span>
                    <span className="font-bold">{formData.familySize} ppl / {formData.cheatDay || "None"}</span>
                  </div>
                  <div className="flex justify-between border-b border-gray-50 pb-2">
                    <span className="text-gray-500">Cook Time</span>
                    <span className="font-bold">{formData.cookingTimeWeekday}m (Weekday)</span>
                  </div>
                  <div className="flex justify-between border-b border-gray-50 pb-2">
                    <span className="text-gray-500">Themes</span>
                    <span className="font-bold">{formData.themes.join(", ") || "None"}</span>
                  </div>
                </div>

                <div className="mt-6">
                  <Label>Memo to AI</Label>
                  <textarea
                    value={formData.note}
                    onChange={(e) => setFormData({...formData, note: e.target.value})}
                    placeholder="Any specific requests?"
                    className="w-full mt-2 p-3 border border-gray-200 rounded-xl text-sm focus:ring-[#FF8A65]"
                    rows={3}
                  />
                </div>
              </div>

              <div className="flex gap-4">
                <Button variant="outline" onClick={() => setCurrentStep(3)} className="flex-1 py-6 rounded-full font-bold">
                  Back
                </Button>
                <Button 
                  onClick={handleSubmit} 
                  disabled={loading}
                  className="flex-1 py-6 rounded-full bg-gradient-to-r from-[#FF8A65] to-[#FF7043] font-bold text-white shadow-lg shadow-orange-200"
                >
                  {loading ? "Generating..." : "✨ Generate Plan"}
                </Button>
              </div>
            </motion.div>
          )}

        </AnimatePresence>
      </div>
    </div>
  );
}
