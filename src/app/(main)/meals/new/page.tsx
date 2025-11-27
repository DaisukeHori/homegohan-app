"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Camera, Image as ImageIcon, X, ChevronLeft, ChevronRight, 
  Sparkles, Check, Calendar, Clock, Sun, Coffee, Moon,
  Utensils, Plus, Minus
} from 'lucide-react';

// カラーパレット
const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  success: '#6B9B6B',
  successLight: '#EDF5ED',
  warning: '#E5A84B',
  warningLight: '#FEF9EE',
  purple: '#7C6BA0',
  purpleLight: '#F5F3F8',
  blue: '#5B8BC7',
  blueLight: '#EEF4FB',
  border: '#E8E8E8',
};

type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'midnight_snack';
type DishDetail = { name: string; cal: number; role: string; ingredient?: string };
type Step = 'capture' | 'analyzing' | 'result' | 'select-date';

const MEAL_CONFIG: Record<MealType, { icon: typeof Coffee; label: string; color: string; bg: string }> = {
  breakfast: { icon: Coffee, label: '朝食', color: colors.warning, bg: colors.warningLight },
  lunch: { icon: Sun, label: '昼食', color: colors.accent, bg: colors.accentLight },
  dinner: { icon: Moon, label: '夕食', color: colors.purple, bg: colors.purpleLight },
  snack: { icon: Utensils, label: 'おやつ', color: colors.success, bg: colors.successLight },
  midnight_snack: { icon: Moon, label: '夜食', color: colors.blue, bg: colors.blueLight },
};

// Helper: ローカル日付文字列
const formatLocalDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Helper: 週の日付を取得
const getWeekDates = (startDate: Date): { date: Date; dayOfWeek: string; dateStr: string }[] => {
  const days = [];
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    days.push({
      date: d,
      dayOfWeek: dayNames[d.getDay()],
      dateStr: formatLocalDate(d),
    });
  }
  return days;
};

// Helper: 週の開始日（月曜日）
const getWeekStart = (date: Date): Date => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

export default function MealCaptureModal() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  
  const [step, setStep] = useState<Step>('capture');
  // 複数枚対応
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  
  // 解析結果
  const [analyzedDishes, setAnalyzedDishes] = useState<DishDetail[]>([]);
  const [totalCalories, setTotalCalories] = useState(0);
  const [nutritionalAdvice, setNutritionalAdvice] = useState('');
  
  // 日付・食事タイプ選択
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
  const [selectedDate, setSelectedDate] = useState(formatLocalDate(new Date()));
  const [selectedMealType, setSelectedMealType] = useState<MealType>(() => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 11) return 'breakfast';
    if (hour >= 11 && hour < 16) return 'lunch';
    return 'dinner';
  });
  
  const [isSaving, setIsSaving] = useState(false);
  
  const weekDates = getWeekDates(weekStart);
  const todayStr = formatLocalDate(new Date());

  // 写真選択（複数枚対応）
  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const newFiles = Array.from(files);
      setPhotoFiles(prev => [...prev, ...newFiles]);
      
      newFiles.forEach(file => {
        const url = URL.createObjectURL(file);
        setPhotoPreviews(prev => [...prev, url]);
      });
    }
  };
  
  // 写真を削除
  const removePhoto = (index: number) => {
    setPhotoFiles(prev => prev.filter((_, i) => i !== index));
    setPhotoPreviews(prev => prev.filter((_, i) => i !== index));
  };

  // AI解析（複数枚対応）
  const analyzePhoto = async () => {
    if (photoFiles.length === 0) return;
    
    setStep('analyzing');
    setIsAnalyzing(true);
    
    try {
      // 複数枚をBase64に変換
      const imageDataArray = await Promise.all(photoFiles.map(async (file) => {
        return new Promise<{ base64: string; mimeType: string }>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const result = reader.result as string;
            resolve({
              base64: result.split(',')[1],
              mimeType: file.type
            });
          };
          reader.readAsDataURL(file);
        });
      }));
      
      const res = await fetch('/api/ai/analyze-meal-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: imageDataArray,
          mealType: selectedMealType,
        }),
      });
      
      if (res.ok) {
        const data = await res.json();
        setAnalyzedDishes(data.dishes || []);
        setTotalCalories(data.totalCalories || 0);
        setNutritionalAdvice(data.nutritionalAdvice || '');
        setStep('result');
      } else {
        alert('解析に失敗しました。もう一度お試しください。');
        setStep('capture');
      }
    } catch (error) {
      console.error('Analysis error:', error);
      alert('エラーが発生しました。');
      setStep('capture');
    } finally {
      setIsAnalyzing(false);
    }
  };

  // 献立表に保存
  const saveToMealPlan = async () => {
    setIsSaving(true);
    
    try {
      // 1. まず写真をアップロード（最初の1枚を使用）
      let imageUrl = null;
      if (photoFiles.length > 0) {
        const formData = new FormData();
        formData.append('file', photoFiles[0]);
        formData.append('folder', 'meals');
        
        const uploadRes = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });
        
        if (uploadRes.ok) {
          const { url } = await uploadRes.json();
          imageUrl = url;
        }
      }
      
      // 2. meal_plan と meal_plan_day を作成/取得し、planned_meal を追加
      const res = await fetch('/api/meal-plans/add-from-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dayDate: selectedDate,
          mealType: selectedMealType,
          dishes: analyzedDishes,
          totalCalories,
          imageUrl,
          nutritionalAdvice,
        }),
      });
      
      if (res.ok) {
        // 成功したら献立表ページへ
        router.push('/menus/weekly');
      } else {
        const err = await res.json();
        alert(`保存に失敗しました: ${err.error || '不明なエラー'}`);
      }
    } catch (error) {
      console.error('Save error:', error);
      alert('保存中にエラーが発生しました。');
    } finally {
      setIsSaving(false);
    }
  };

  // 週を移動
  const goToPreviousWeek = () => {
    const newStart = new Date(weekStart);
    newStart.setDate(newStart.getDate() - 7);
    setWeekStart(newStart);
  };
  
  const goToNextWeek = () => {
    const newStart = new Date(weekStart);
    newStart.setDate(newStart.getDate() + 7);
    setWeekStart(newStart);
  };

  // 閉じる
  const handleClose = () => {
    router.back();
  };

  return (
    <div className="min-h-screen flex flex-col" style={{ background: colors.bg }}>
      {/* ヘッダー */}
      <div className="sticky top-0 z-50 px-4 py-3 flex items-center justify-between" style={{ background: colors.card, borderBottom: `1px solid ${colors.border}` }}>
        <button onClick={handleClose} className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
          <X size={20} color={colors.textLight} />
        </button>
        <div className="flex items-center gap-2">
          <Camera size={20} color={colors.accent} />
          <span style={{ fontSize: 16, fontWeight: 600, color: colors.text }}>
            {step === 'capture' && '食事を撮影'}
            {step === 'analyzing' && 'AI解析中...'}
            {step === 'result' && '解析結果'}
            {step === 'select-date' && '日時を選択'}
          </span>
        </div>
        <div className="w-10" />
      </div>

      <AnimatePresence mode="wait">
        {/* ステップ1: 撮影/選択 */}
        {step === 'capture' && (
          <motion.div
            key="capture"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="flex-1 p-4"
          >
            <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 16, textAlign: 'center' }}>
              食事の写真を撮影またはアップロードすると、<br/>AIが料理を認識して栄養素を推定します。<br/>
              <strong>複数枚の写真をまとめて追加できます。</strong>
            </p>
            
            {/* 選択済み写真のプレビュー */}
            {photoPreviews.length > 0 && (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <span style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>
                    選択した写真 ({photoPreviews.length}枚)
                  </span>
                  <button
                    onClick={() => { setPhotoFiles([]); setPhotoPreviews([]); }}
                    style={{ fontSize: 12, color: colors.accent }}
                  >
                    すべて削除
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {photoPreviews.map((preview, idx) => (
                    <div key={idx} className="relative aspect-square">
                      <img src={preview} alt={`Preview ${idx + 1}`} className="w-full h-full rounded-xl object-cover" />
                      <button
                        onClick={() => removePhoto(idx)}
                        className="absolute top-1 right-1 w-6 h-6 rounded-full flex items-center justify-center"
                        style={{ background: 'rgba(0,0,0,0.6)' }}
                      >
                        <X size={12} color="#fff" />
                      </button>
                    </div>
                  ))}
                  {/* 追加ボタン */}
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="aspect-square rounded-xl flex flex-col items-center justify-center"
                    style={{ background: colors.card, border: `2px dashed ${colors.border}` }}
                  >
                    <Plus size={24} color={colors.textMuted} />
                    <span style={{ fontSize: 10, color: colors.textMuted }}>追加</span>
                  </button>
                </div>
              </div>
            )}
            
            {/* 写真未選択時のボタン */}
            {photoPreviews.length === 0 && (
              <div className="flex gap-4 mb-6">
                <button
                  onClick={() => cameraInputRef.current?.click()}
                  className="flex-1 p-8 rounded-2xl flex flex-col items-center gap-3"
                  style={{ background: colors.card, border: `2px dashed ${colors.border}` }}
                >
                  <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: colors.accentLight }}>
                    <Camera size={32} color={colors.accent} />
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 500, color: colors.text }}>撮影する</span>
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex-1 p-8 rounded-2xl flex flex-col items-center gap-3"
                  style={{ background: colors.card, border: `2px dashed ${colors.border}` }}
                >
                  <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: colors.blueLight }}>
                    <ImageIcon size={32} color={colors.blue} />
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 500, color: colors.text }}>ギャラリーから</span>
                </button>
              </div>
            )}
            
            <input
              type="file"
              ref={cameraInputRef}
              accept="image/*"
              capture="environment"
              onChange={handlePhotoSelect}
              className="hidden"
            />
            <input
              type="file"
              ref={fileInputRef}
              accept="image/*"
              multiple
              onChange={handlePhotoSelect}
              className="hidden"
            />
            
            {photoPreviews.length > 0 && (
              <button
                onClick={analyzePhoto}
                className="w-full py-4 rounded-xl flex items-center justify-center gap-2"
                style={{ background: colors.accent }}
              >
                <Sparkles size={20} color="#fff" />
                <span style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>
                  {photoFiles.length > 1 ? `${photoFiles.length}枚をAIで解析` : 'AIで解析する'}
                </span>
              </button>
            )}
            
            <div className="mt-6 p-4 rounded-xl" style={{ background: colors.blueLight }}>
              <p style={{ fontSize: 12, color: colors.blue, margin: 0 }}>
                💡 ヒント: 複数の料理がある場合は、それぞれ別の写真で撮影するとより正確に解析できます。
              </p>
            </div>
          </motion.div>
        )}

        {/* ステップ2: 解析中 */}
        {step === 'analyzing' && (
          <motion.div
            key="analyzing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 flex flex-col items-center justify-center p-4"
          >
            {photoPreview && (
              <div className="relative mb-6">
                <img 
                  src={photoPreview} 
                  alt="Analyzing" 
                  className="w-64 h-64 rounded-2xl object-cover opacity-80" 
                />
                {/* スキャンライン */}
                <motion.div 
                  initial={{ top: 0 }}
                  animate={{ top: "100%" }}
                  transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                  className="absolute left-0 w-full h-1 rounded-full"
                  style={{ background: `linear-gradient(90deg, transparent, ${colors.accent}, transparent)`, boxShadow: `0 0 20px ${colors.accent}` }}
                />
              </div>
            )}
            <div className="w-12 h-12 border-4 rounded-full animate-spin mb-4" style={{ borderColor: colors.accent, borderTopColor: 'transparent' }} />
            <p style={{ fontSize: 16, fontWeight: 600, color: colors.text }}>AIが解析中...</p>
            <p style={{ fontSize: 13, color: colors.textMuted, marginTop: 8 }}>料理を認識して栄養素を推定しています</p>
          </motion.div>
        )}

        {/* ステップ3: 解析結果 */}
        {step === 'result' && (
          <motion.div
            key="result"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="flex-1 p-4 overflow-auto"
          >
            {photoPreview && (
              <img 
                src={photoPreview} 
                alt="Result" 
                className="w-full h-48 rounded-2xl object-cover mb-4" 
              />
            )}
            
            <div className="flex items-center justify-between mb-4">
              <span style={{ fontSize: 15, fontWeight: 600, color: colors.text }}>検出された料理</span>
              <div className="px-3 py-1.5 rounded-lg" style={{ background: colors.accentLight }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: colors.accent }}>{totalCalories} kcal</span>
              </div>
            </div>
            
            <div className="space-y-2 mb-4">
              {analyzedDishes.map((dish, idx) => (
                <div 
                  key={idx} 
                  className="p-3 rounded-xl flex items-center justify-between"
                  style={{ background: colors.card }}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: colors.successLight }}>
                      <Utensils size={18} color={colors.success} />
                    </div>
                    <div>
                      <p style={{ fontSize: 14, fontWeight: 500, color: colors.text, margin: 0 }}>{dish.name}</p>
                      <p style={{ fontSize: 11, color: colors.textMuted, margin: 0 }}>{dish.role === 'main' ? '主菜' : dish.role === 'side' ? '副菜' : dish.role === 'soup' ? '汁物' : 'おかず'}</p>
                    </div>
                  </div>
                  <span style={{ fontSize: 13, color: colors.textLight }}>{dish.cal} kcal</span>
                </div>
              ))}
            </div>
            
            {nutritionalAdvice && (
              <div className="p-3 rounded-xl mb-4" style={{ background: colors.purpleLight }}>
                <div className="flex items-center gap-1 mb-1">
                  <Sparkles size={12} color={colors.purple} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: colors.purple }}>AIコメント</span>
                </div>
                <p style={{ fontSize: 12, color: colors.text, margin: 0, lineHeight: 1.5 }}>{nutritionalAdvice}</p>
              </div>
            )}
            
            <button
              onClick={() => setStep('select-date')}
              className="w-full py-4 rounded-xl flex items-center justify-center gap-2"
              style={{ background: colors.accent }}
            >
              <Calendar size={18} color="#fff" />
              <span style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>日時を選んで保存</span>
            </button>
            
            <button
              onClick={() => { setStep('capture'); setPhotoFile(null); setPhotoPreview(null); setAnalyzedDishes([]); }}
              className="w-full py-3 mt-2 rounded-xl"
              style={{ background: colors.bg }}
            >
              <span style={{ fontSize: 14, color: colors.textLight }}>撮り直す</span>
            </button>
          </motion.div>
        )}

        {/* ステップ4: 日時選択 */}
        {step === 'select-date' && (
          <motion.div
            key="select-date"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="flex-1 p-4 overflow-auto"
          >
            <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 16 }}>
              この食事をいつの献立として保存しますか？
            </p>
            
            {/* 週選択 */}
            <div className="flex items-center justify-between mb-3">
              <button onClick={goToPreviousWeek} className="p-2 rounded-lg" style={{ background: colors.bg }}>
                <ChevronLeft size={20} color={colors.textLight} />
              </button>
              <span style={{ fontSize: 14, fontWeight: 500, color: colors.text }}>
                {weekDates[0]?.date.getMonth() + 1}/{weekDates[0]?.date.getDate()} - {weekDates[6]?.date.getMonth() + 1}/{weekDates[6]?.date.getDate()}
              </span>
              <button onClick={goToNextWeek} className="p-2 rounded-lg" style={{ background: colors.bg }}>
                <ChevronRight size={20} color={colors.textLight} />
              </button>
            </div>
            
            {/* 日付選択 */}
            <div className="flex gap-1 mb-4">
              {weekDates.map((day) => {
                const isSelected = day.dateStr === selectedDate;
                const isToday = day.dateStr === todayStr;
                const isWeekend = day.date.getDay() === 0 || day.date.getDay() === 6;
                return (
                  <button
                    key={day.dateStr}
                    onClick={() => setSelectedDate(day.dateStr)}
                    className="flex-1 flex flex-col items-center gap-1 py-3 rounded-xl transition-all"
                    style={{
                      background: isSelected ? colors.accent : colors.card,
                      border: isToday && !isSelected ? `2px solid ${colors.accent}` : `1px solid ${colors.border}`,
                    }}
                  >
                    <span style={{ fontSize: 10, color: isSelected ? 'rgba(255,255,255,0.7)' : colors.textMuted }}>{day.date.getDate()}</span>
                    <span style={{ fontSize: 14, fontWeight: 600, color: isSelected ? '#fff' : isWeekend ? colors.accent : colors.text }}>{day.dayOfWeek}</span>
                  </button>
                );
              })}
            </div>
            
            {/* 食事タイプ選択 */}
            <p style={{ fontSize: 13, fontWeight: 500, color: colors.text, marginBottom: 8 }}>食事タイプ</p>
            {/* 基本の3食 */}
            <div className="flex gap-2 mb-2">
              {(['breakfast', 'lunch', 'dinner'] as MealType[]).map((type) => {
                const config = MEAL_CONFIG[type];
                const isSelected = type === selectedMealType;
                const Icon = config.icon;
                return (
                  <button
                    key={type}
                    onClick={() => setSelectedMealType(type)}
                    className="flex-1 p-3 rounded-xl flex flex-col items-center gap-2 transition-all"
                    style={{
                      background: isSelected ? config.bg : colors.card,
                      border: isSelected ? `2px solid ${config.color}` : `1px solid ${colors.border}`,
                    }}
                  >
                    <Icon size={24} color={isSelected ? config.color : colors.textMuted} />
                    <span style={{ fontSize: 13, fontWeight: 500, color: isSelected ? config.color : colors.textLight }}>{config.label}</span>
                  </button>
                );
              })}
            </div>
            {/* おやつ・夜食 */}
            <div className="flex gap-2 mb-6">
              {(['snack', 'midnight_snack'] as MealType[]).map((type) => {
                const config = MEAL_CONFIG[type];
                const isSelected = type === selectedMealType;
                const Icon = config.icon;
                return (
                  <button
                    key={type}
                    onClick={() => setSelectedMealType(type)}
                    className="flex-1 p-3 rounded-xl flex flex-col items-center gap-2 transition-all"
                    style={{
                      background: isSelected ? config.bg : colors.card,
                      border: isSelected ? `2px solid ${config.color}` : `1px solid ${colors.border}`,
                    }}
                  >
                    <Icon size={24} color={isSelected ? config.color : colors.textMuted} />
                    <span style={{ fontSize: 13, fontWeight: 500, color: isSelected ? config.color : colors.textLight }}>{config.label}</span>
                  </button>
                );
              })}
            </div>
            
            {/* 選択内容サマリー */}
            <div className="p-4 rounded-xl mb-4" style={{ background: colors.card }}>
              <p style={{ fontSize: 12, color: colors.textMuted, marginBottom: 8 }}>保存先</p>
              <p style={{ fontSize: 16, fontWeight: 600, color: colors.text, margin: 0 }}>
                {new Date(selectedDate).getMonth() + 1}月{new Date(selectedDate).getDate()}日（{weekDates.find(d => d.dateStr === selectedDate)?.dayOfWeek}）の{MEAL_CONFIG[selectedMealType].label}
              </p>
            </div>
            
            <button
              onClick={saveToMealPlan}
              disabled={isSaving}
              className="w-full py-4 rounded-xl flex items-center justify-center gap-2 disabled:opacity-60"
              style={{ background: colors.success }}
            >
              {isSaving ? (
                <>
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>保存中...</span>
                </>
              ) : (
                <>
                  <Check size={20} color="#fff" />
                  <span style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>献立表に保存</span>
                </>
              )}
            </button>
            
            <button
              onClick={() => setStep('result')}
              className="w-full py-3 mt-2 rounded-xl"
              style={{ background: colors.bg }}
            >
              <span style={{ fontSize: 14, color: colors.textLight }}>戻る</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
