"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  Camera, Image as ImageIcon, X, ChevronLeft, ChevronRight,
  Sparkles, Check, Calendar, Clock, Sun, Coffee, Moon,
  Utensils, Plus, Minus, Refrigerator, FileHeart, Wand2,
  AlertCircle, Save, RefreshCw
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
type DishDetail = { name: string; cal: number; calories_kcal?: number; role: string; ingredient?: string };
type Step = 'mode-select' | 'capture' | 'analyzing' | 'result' | 'select-date' | 'fridge-result' | 'health-result';
type PhotoMode = 'auto' | 'meal' | 'fridge' | 'health_checkup';

// 写真モード設定
const PHOTO_MODES: Record<PhotoMode, { icon: any; label: string; description: string; color: string; bg: string }> = {
  auto: { icon: Wand2, label: 'オート', description: 'AIが写真の種類を自動判別', color: colors.purple, bg: colors.purpleLight },
  meal: { icon: Utensils, label: '食事', description: '食事の写真を記録', color: colors.accent, bg: colors.accentLight },
  fridge: { icon: Refrigerator, label: '冷蔵庫', description: '冷蔵庫の中身を登録', color: colors.blue, bg: colors.blueLight },
  health_checkup: { icon: FileHeart, label: '健診', description: '健康診断結果を読み取り', color: colors.success, bg: colors.successLight },
};

// 冷蔵庫解析結果
interface FridgeIngredient {
  name: string;
  category: string;
  quantity: string;
  freshness: 'fresh' | 'good' | 'expiring_soon' | 'expired';
  daysRemaining: number;
}

// 健康診断解析結果
interface HealthCheckupData {
  checkupDate?: string;
  facilityName?: string;
  height?: number;
  weight?: number;
  bmi?: number;
  bloodPressureSystolic?: number;
  bloodPressureDiastolic?: number;
  hemoglobin?: number;
  hba1c?: number;
  fastingGlucose?: number;
  totalCholesterol?: number;
  ldlCholesterol?: number;
  hdlCholesterol?: number;
  triglycerides?: number;
  ast?: number;
  alt?: number;
  gammaGtp?: number;
  creatinine?: number;
  egfr?: number;
  uricAcid?: number;
}

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

  const [step, setStep] = useState<Step>('mode-select');
  const [photoMode, setPhotoMode] = useState<PhotoMode>('auto');
  // 複数枚対応
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // 冷蔵庫解析結果
  const [fridgeIngredients, setFridgeIngredients] = useState<FridgeIngredient[]>([]);
  const [fridgeSummary, setFridgeSummary] = useState('');
  const [fridgeSuggestions, setFridgeSuggestions] = useState<string[]>([]);
  const [isSavingFridge, setIsSavingFridge] = useState(false);

  // 健康診断解析結果
  const [healthData, setHealthData] = useState<HealthCheckupData>({});
  const [healthConfidence, setHealthConfidence] = useState(0);
  const [healthNotes, setHealthNotes] = useState('');
  const [isSavingHealth, setIsSavingHealth] = useState(false);

  // オートモード判別結果
  const [detectedType, setDetectedType] = useState<string | null>(null);
  const [detectedConfidence, setDetectedConfidence] = useState(0);
  
  // 解析結果
  const [analyzedDishes, setAnalyzedDishes] = useState<DishDetail[]>([]);
  const [totalCalories, setTotalCalories] = useState(0);
  const [totalProtein, setTotalProtein] = useState(0);
  const [totalCarbs, setTotalCarbs] = useState(0);
  const [totalFat, setTotalFat] = useState(0);
  const [overallScore, setOverallScore] = useState(0);
  const [vegScore, setVegScore] = useState(0);
  const [praiseComment, setPraiseComment] = useState('');
  const [nutritionTip, setNutritionTip] = useState('');
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
        setTotalProtein(data.totalProtein || 0);
        setTotalCarbs(data.totalCarbs || 0);
        setTotalFat(data.totalFat || 0);
        setOverallScore(data.overallScore || 75);
        setVegScore(data.vegScore || 50);
        setPraiseComment(data.praiseComment || '');
        setNutritionTip(data.nutritionTip || '');
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

  // 写真タイプを判別（オートモード）
  const classifyPhoto = async (base64: string, mimeType: string): Promise<PhotoMode> => {
    try {
      const res = await fetch('/api/ai/classify-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, mimeType }),
      });

      if (res.ok) {
        const data = await res.json();
        setDetectedType(data.type);
        setDetectedConfidence(data.confidence);
        if (data.type === 'meal' || data.type === 'fridge' || data.type === 'health_checkup') {
          return data.type as PhotoMode;
        }
      }
    } catch (error) {
      console.error('Classification error:', error);
    }
    return 'meal'; // デフォルトは食事モード
  };

  // 冷蔵庫写真解析
  const analyzeFridge = async () => {
    if (photoFiles.length === 0) return;

    setStep('analyzing');
    setIsAnalyzing(true);

    try {
      const file = photoFiles[0];
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(file);
      });

      const res = await fetch('/api/ai/analyze-fridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, mimeType: file.type }),
      });

      if (res.ok) {
        const data = await res.json();
        setFridgeIngredients(data.detailedIngredients || []);
        setFridgeSummary(data.summary || '');
        setFridgeSuggestions(data.suggestions || []);
        setStep('fridge-result');
      } else {
        alert('冷蔵庫の解析に失敗しました。');
        setStep('capture');
      }
    } catch (error) {
      console.error('Fridge analysis error:', error);
      alert('エラーが発生しました。');
      setStep('capture');
    } finally {
      setIsAnalyzing(false);
    }
  };

  // 健康診断写真解析
  const analyzeHealthCheckup = async () => {
    if (photoFiles.length === 0) return;

    setStep('analyzing');
    setIsAnalyzing(true);

    try {
      const file = photoFiles[0];
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(file);
      });

      const res = await fetch('/api/ai/analyze-health-checkup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, mimeType: file.type }),
      });

      if (res.ok) {
        const data = await res.json();
        setHealthData(data.extractedData || {});
        setHealthConfidence(data.confidence || 0);
        setHealthNotes(data.notes || '');
        setStep('health-result');
      } else {
        alert('健康診断結果の解析に失敗しました。');
        setStep('capture');
      }
    } catch (error) {
      console.error('Health checkup analysis error:', error);
      alert('エラーが発生しました。');
      setStep('capture');
    } finally {
      setIsAnalyzing(false);
    }
  };

  // 統合解析（モードに応じて分岐）
  const analyzeByMode = async () => {
    if (photoFiles.length === 0) return;

    let targetMode = photoMode;

    // オートモードの場合は先に判別
    if (photoMode === 'auto') {
      setStep('analyzing');
      setIsAnalyzing(true);

      const file = photoFiles[0];
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(file);
      });

      targetMode = await classifyPhoto(base64, file.type);
      setIsAnalyzing(false);
    }

    // 判別結果に応じて解析
    switch (targetMode) {
      case 'fridge':
        await analyzeFridge();
        break;
      case 'health_checkup':
        await analyzeHealthCheckup();
        break;
      case 'meal':
      default:
        await analyzePhoto();
        break;
    }
  };

  // 冷蔵庫データを保存
  const saveFridgeItems = async (mode: 'append' | 'replace') => {
    setIsSavingFridge(true);

    try {
      const res = await fetch('/api/pantry/from-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ingredients: fridgeIngredients.map(i => ({
            name: i.name,
            amount: i.quantity,
            category: i.category,
            daysRemaining: i.daysRemaining,
          })),
          mode,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        alert(`冷蔵庫に${data.results.created + data.results.updated}件の食材を保存しました。`);
        router.push('/menus/weekly');
      } else {
        alert('保存に失敗しました。');
      }
    } catch (error) {
      console.error('Fridge save error:', error);
      alert('エラーが発生しました。');
    } finally {
      setIsSavingFridge(false);
    }
  };

  // 健康診断データを保存
  const saveHealthCheckup = async () => {
    setIsSavingHealth(true);

    try {
      // 健康診断APIにPOST
      const res = await fetch('/api/health/checkups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          checkup_date: healthData.checkupDate || new Date().toISOString().split('T')[0],
          facility_name: healthData.facilityName,
          height: healthData.height,
          weight: healthData.weight,
          bmi: healthData.bmi,
          blood_pressure_systolic: healthData.bloodPressureSystolic,
          blood_pressure_diastolic: healthData.bloodPressureDiastolic,
          hemoglobin: healthData.hemoglobin,
          hba1c: healthData.hba1c,
          fasting_glucose: healthData.fastingGlucose,
          total_cholesterol: healthData.totalCholesterol,
          ldl_cholesterol: healthData.ldlCholesterol,
          hdl_cholesterol: healthData.hdlCholesterol,
          triglycerides: healthData.triglycerides,
          ast: healthData.ast,
          alt: healthData.alt,
          gamma_gtp: healthData.gammaGtp,
          creatinine: healthData.creatinine,
          egfr: healthData.egfr,
          uric_acid: healthData.uricAcid,
          ocr_extracted_data: healthData,
          ocr_extraction_timestamp: new Date().toISOString(),
          ocr_model_used: 'gpt-4o',
        }),
      });

      if (res.ok) {
        alert('健康診断結果を保存しました。');
        router.push('/health/checkups');
      } else {
        alert('保存に失敗しました。');
      }
    } catch (error) {
      console.error('Health checkup save error:', error);
      alert('エラーが発生しました。');
    } finally {
      setIsSavingHealth(false);
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
            {step === 'mode-select' && 'モード選択'}
            {step === 'capture' && (photoMode === 'meal' ? '食事を撮影' : photoMode === 'fridge' ? '冷蔵庫を撮影' : photoMode === 'health_checkup' ? '健診結果を撮影' : '写真を撮影')}
            {step === 'analyzing' && 'AI解析中...'}
            {step === 'result' && '解析結果'}
            {step === 'select-date' && '日時を選択'}
            {step === 'fridge-result' && '冷蔵庫の中身'}
            {step === 'health-result' && '健康診断結果'}
          </span>
        </div>
        <div className="w-10" />
      </div>

      <AnimatePresence mode="wait">
        {/* ステップ0: モード選択 */}
        {step === 'mode-select' && (
          <motion.div
            key="mode-select"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="flex-1 p-4"
          >
            <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 16, textAlign: 'center' }}>
              撮影するものを選んでください
            </p>

            <div className="grid grid-cols-2 gap-3 mb-6">
              {(Object.entries(PHOTO_MODES) as [PhotoMode, typeof PHOTO_MODES.auto][]).map(([mode, config]) => {
                const isSelected = photoMode === mode;
                const Icon = config.icon;
                return (
                  <button
                    key={mode}
                    onClick={() => setPhotoMode(mode)}
                    className="p-4 rounded-2xl flex flex-col items-center gap-2 transition-all"
                    style={{
                      background: isSelected ? config.bg : colors.card,
                      border: isSelected ? `2px solid ${config.color}` : `1px solid ${colors.border}`,
                    }}
                  >
                    <div
                      className="w-12 h-12 rounded-xl flex items-center justify-center"
                      style={{ background: isSelected ? config.color : colors.bg }}
                    >
                      <Icon size={24} color={isSelected ? '#fff' : config.color} />
                    </div>
                    <span style={{ fontSize: 14, fontWeight: 600, color: isSelected ? config.color : colors.text }}>
                      {config.label}
                    </span>
                    <span style={{ fontSize: 10, color: colors.textMuted, textAlign: 'center' }}>
                      {config.description}
                    </span>
                  </button>
                );
              })}
            </div>

            <button
              onClick={() => setStep('capture')}
              className="w-full py-4 rounded-xl flex items-center justify-center gap-2"
              style={{ background: PHOTO_MODES[photoMode].color }}
            >
              <Camera size={20} color="#fff" />
              <span style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>
                撮影へ進む
              </span>
            </button>
          </motion.div>
        )}

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
              {photoMode === 'auto' && 'AIが写真の種類を自動判別します。'}
              {photoMode === 'meal' && '食事の写真を撮影してください。AIが料理を認識します。'}
              {photoMode === 'fridge' && '冷蔵庫の中を撮影してください。食材を認識します。'}
              {photoMode === 'health_checkup' && '健康診断結果を撮影してください。数値を読み取ります。'}
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
                onClick={analyzeByMode}
                className="w-full py-4 rounded-xl flex items-center justify-center gap-2"
                style={{ background: PHOTO_MODES[photoMode].color }}
              >
                <Sparkles size={20} color="#fff" />
                <span style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>
                  {photoMode === 'auto' ? 'AIが判別して解析' : photoFiles.length > 1 ? `${photoFiles.length}枚をAIで解析` : 'AIで解析する'}
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
            {photoPreviews.length > 0 && (
              <div className="relative mb-6">
                <img 
                  src={photoPreviews[0]} 
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
                {photoPreviews.length > 1 && (
                  <div className="absolute bottom-2 right-2 px-2 py-1 rounded-lg" style={{ background: 'rgba(0,0,0,0.6)' }}>
                    <span style={{ fontSize: 11, color: '#fff' }}>+{photoPreviews.length - 1}枚</span>
                  </div>
                )}
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
            {/* スコアと写真 */}
            <div className="relative mb-4">
              {photoPreviews.length > 0 && (
                <img 
                  src={photoPreviews[0]} 
                  alt="Result" 
                  className="w-full h-40 rounded-2xl object-cover" 
                />
              )}
              {photoPreviews.length > 1 && (
                <div className="absolute bottom-2 right-2 px-2 py-1 rounded-lg" style={{ background: 'rgba(0,0,0,0.6)' }}>
                  <span style={{ fontSize: 11, color: '#fff' }}>{photoPreviews.length}枚から解析</span>
                </div>
              )}
            </div>

            {/* スコア表示 */}
            <div className="flex items-center gap-4 mb-4 p-4 rounded-2xl" style={{ background: colors.successLight }}>
              <div 
                className="w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-bold text-white"
                style={{ background: overallScore >= 85 ? colors.success : overallScore >= 70 ? colors.warning : colors.accent }}
              >
                {overallScore}
              </div>
              <div>
                <p style={{ fontSize: 16, fontWeight: 700, color: overallScore >= 85 ? colors.success : overallScore >= 70 ? '#B8860B' : colors.accent, margin: 0 }}>
                  {overallScore >= 90 ? '素晴らしい！🎉' : overallScore >= 80 ? 'いいね！👍' : overallScore >= 70 ? 'グッド！😊' : '記録しました！'}
                </p>
                <p style={{ fontSize: 13, color: colors.textLight, margin: 0 }}>
                  {analyzedDishes.length > 0 ? analyzedDishes[0].name : '食事'}{analyzedDishes.length > 1 ? ` 他${analyzedDishes.length - 1}品` : ''}
                </p>
              </div>
            </div>

            {/* AIからの褒めコメント */}
            {praiseComment && (
              <div className="p-4 rounded-2xl mb-4" style={{ background: colors.accentLight }}>
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: colors.accent }}>
                    <Sparkles size={16} color="#fff" />
                  </div>
                  <div>
                    <p style={{ fontSize: 12, fontWeight: 600, color: colors.accent, margin: '0 0 4px 0' }}>AIからのコメント</p>
                    <p style={{ fontSize: 13, color: colors.text, margin: 0, lineHeight: 1.6 }}>{praiseComment}</p>
                  </div>
                </div>
              </div>
            )}

            {/* 栄養素グリッド */}
            <div className="grid grid-cols-5 gap-2 mb-4">
              {[
                { label: 'カロリー', value: totalCalories, unit: 'kcal', color: colors.accent },
                { label: 'タンパク質', value: totalProtein, unit: 'g', color: colors.blue },
                { label: '炭水化物', value: totalCarbs, unit: 'g', color: colors.warning },
                { label: '脂質', value: totalFat, unit: 'g', color: colors.purple },
                { label: '野菜', value: vegScore, unit: '点', color: colors.success },
              ].map((n, i) => (
                <div key={i} className="p-2 rounded-xl text-center" style={{ background: colors.bg }}>
                  <p style={{ fontSize: 9, color: colors.textMuted, margin: '0 0 2px 0' }}>{n.label}</p>
                  <p style={{ fontSize: 14, fontWeight: 700, color: n.color, margin: 0 }}>{n.value}</p>
                  <p style={{ fontSize: 9, color: colors.textMuted, margin: 0 }}>{n.unit}</p>
                </div>
              ))}
            </div>

            {/* 豆知識 */}
            {nutritionTip && (
              <div className="p-3 rounded-xl mb-4 flex items-start gap-2" style={{ background: colors.warningLight }}>
                <span style={{ fontSize: 14 }}>💡</span>
                <p style={{ fontSize: 11, color: colors.text, margin: 0, lineHeight: 1.5 }}>
                  <strong style={{ color: colors.warning }}>豆知識:</strong> {nutritionTip}
                </p>
              </div>
            )}
            
            {/* 検出された料理 */}
            <div className="mb-4">
              <p style={{ fontSize: 13, fontWeight: 600, color: colors.textLight, marginBottom: 8 }}>検出された料理</p>
              <div className="space-y-2">
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
                        <p style={{ fontSize: 11, color: colors.textMuted, margin: 0 }}>{dish.role === 'main' ? '主菜' : dish.role === 'side' ? '副菜' : dish.role === 'soup' ? '汁物' : dish.role === 'rice' ? 'ご飯' : dish.role === 'salad' ? 'サラダ' : 'おかず'}</p>
                      </div>
                    </div>
                    <span style={{ fontSize: 13, color: colors.textLight }}>{dish.calories_kcal} kcal</span>
                  </div>
                ))}
              </div>
            </div>
            
            <button
              onClick={() => setStep('select-date')}
              className="w-full py-4 rounded-xl flex items-center justify-center gap-2"
              style={{ background: colors.accent }}
            >
              <Calendar size={18} color="#fff" />
              <span style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>日時を選んで保存</span>
            </button>
            
            <button
              onClick={() => { setStep('capture'); setPhotoFiles([]); setPhotoPreviews([]); setAnalyzedDishes([]); setOverallScore(0); setPraiseComment(''); setNutritionTip(''); }}
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

        {/* 冷蔵庫解析結果 */}
        {step === 'fridge-result' && (
          <motion.div
            key="fridge-result"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="flex-1 p-4 overflow-auto"
          >
            {/* 写真プレビュー */}
            {photoPreviews.length > 0 && (
              <div className="relative mb-4">
                <img src={photoPreviews[0]} alt="Fridge" className="w-full h-32 rounded-2xl object-cover" />
              </div>
            )}

            {/* サマリー */}
            {fridgeSummary && (
              <div className="p-4 rounded-2xl mb-4" style={{ background: colors.blueLight }}>
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: colors.blue }}>
                    <Refrigerator size={16} color="#fff" />
                  </div>
                  <div>
                    <p style={{ fontSize: 12, fontWeight: 600, color: colors.blue, margin: '0 0 4px 0' }}>冷蔵庫の中身</p>
                    <p style={{ fontSize: 13, color: colors.text, margin: 0, lineHeight: 1.6 }}>{fridgeSummary}</p>
                  </div>
                </div>
              </div>
            )}

            {/* 検出された食材 */}
            <div className="mb-4">
              <p style={{ fontSize: 13, fontWeight: 600, color: colors.textLight, marginBottom: 8 }}>
                検出された食材 ({fridgeIngredients.length}件)
              </p>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {fridgeIngredients.map((item, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-xl flex items-center justify-between"
                    style={{ background: colors.card }}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className="w-10 h-10 rounded-lg flex items-center justify-center"
                        style={{
                          background: item.freshness === 'fresh' ? colors.successLight
                            : item.freshness === 'good' ? colors.blueLight
                            : item.freshness === 'expiring_soon' ? colors.warningLight
                            : colors.accentLight
                        }}
                      >
                        <span style={{ fontSize: 18 }}>
                          {item.category === '野菜' ? '🥬' : item.category === '肉類' ? '🥩' : item.category === '魚介類' ? '🐟' : item.category === '乳製品' ? '🧀' : '🍴'}
                        </span>
                      </div>
                      <div>
                        <p style={{ fontSize: 14, fontWeight: 500, color: colors.text, margin: 0 }}>{item.name}</p>
                        <p style={{ fontSize: 11, color: colors.textMuted, margin: 0 }}>
                          {item.quantity} • {item.category}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <span
                        style={{
                          fontSize: 10,
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: item.freshness === 'fresh' ? colors.successLight
                            : item.freshness === 'good' ? colors.blueLight
                            : item.freshness === 'expiring_soon' ? colors.warningLight
                            : colors.accentLight,
                          color: item.freshness === 'fresh' ? colors.success
                            : item.freshness === 'good' ? colors.blue
                            : item.freshness === 'expiring_soon' ? colors.warning
                            : colors.accent,
                        }}
                      >
                        {item.freshness === 'fresh' ? '新鮮' : item.freshness === 'good' ? '良好' : item.freshness === 'expiring_soon' ? '早めに' : '要確認'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 料理提案 */}
            {fridgeSuggestions.length > 0 && (
              <div className="p-4 rounded-xl mb-4" style={{ background: colors.purpleLight }}>
                <p style={{ fontSize: 12, fontWeight: 600, color: colors.purple, marginBottom: 8 }}>💡 この食材で作れる料理</p>
                <div className="flex flex-wrap gap-2">
                  {fridgeSuggestions.map((s, idx) => (
                    <span key={idx} style={{ fontSize: 12, color: colors.text, background: colors.card, padding: '4px 8px', borderRadius: 6 }}>
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 保存ボタン */}
            <div className="flex gap-3 mb-3">
              <button
                onClick={() => saveFridgeItems('append')}
                disabled={isSavingFridge}
                className="flex-1 py-3 rounded-xl flex items-center justify-center gap-2 disabled:opacity-60"
                style={{ background: colors.blue }}
              >
                <Plus size={18} color="#fff" />
                <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>追記する</span>
              </button>
              <button
                onClick={() => saveFridgeItems('replace')}
                disabled={isSavingFridge}
                className="flex-1 py-3 rounded-xl flex items-center justify-center gap-2 disabled:opacity-60"
                style={{ background: colors.accent }}
              >
                <RefreshCw size={18} color="#fff" />
                <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>入れ替える</span>
              </button>
            </div>

            <button
              onClick={() => { setStep('mode-select'); setPhotoFiles([]); setPhotoPreviews([]); }}
              className="w-full py-3 rounded-xl"
              style={{ background: colors.bg }}
            >
              <span style={{ fontSize: 14, color: colors.textLight }}>やり直す</span>
            </button>
          </motion.div>
        )}

        {/* 健康診断解析結果 */}
        {step === 'health-result' && (
          <motion.div
            key="health-result"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="flex-1 p-4 overflow-auto"
          >
            {/* 写真プレビュー */}
            {photoPreviews.length > 0 && (
              <div className="relative mb-4">
                <img src={photoPreviews[0]} alt="Health Checkup" className="w-full h-32 rounded-2xl object-cover" />
                {healthConfidence > 0 && (
                  <div className="absolute bottom-2 right-2 px-2 py-1 rounded-lg" style={{ background: 'rgba(0,0,0,0.6)' }}>
                    <span style={{ fontSize: 10, color: '#fff' }}>読み取り精度: {Math.round(healthConfidence * 100)}%</span>
                  </div>
                )}
              </div>
            )}

            {/* 注意事項 */}
            {healthNotes && (
              <div className="p-3 rounded-xl mb-4 flex items-start gap-2" style={{ background: colors.warningLight }}>
                <AlertCircle size={16} color={colors.warning} className="flex-shrink-0 mt-0.5" />
                <p style={{ fontSize: 11, color: colors.text, margin: 0 }}>{healthNotes}</p>
              </div>
            )}

            {/* 解析結果 */}
            <div className="space-y-3 mb-4">
              {/* 身体測定 */}
              {(healthData.height || healthData.weight || healthData.bmi) && (
                <div className="p-3 rounded-xl" style={{ background: colors.card }}>
                  <p style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, marginBottom: 8 }}>身体測定</p>
                  <div className="grid grid-cols-3 gap-2">
                    {healthData.height && (
                      <div className="text-center">
                        <p style={{ fontSize: 16, fontWeight: 700, color: colors.text, margin: 0 }}>{healthData.height}</p>
                        <p style={{ fontSize: 10, color: colors.textMuted, margin: 0 }}>身長 cm</p>
                      </div>
                    )}
                    {healthData.weight && (
                      <div className="text-center">
                        <p style={{ fontSize: 16, fontWeight: 700, color: colors.text, margin: 0 }}>{healthData.weight}</p>
                        <p style={{ fontSize: 10, color: colors.textMuted, margin: 0 }}>体重 kg</p>
                      </div>
                    )}
                    {healthData.bmi && (
                      <div className="text-center">
                        <p style={{ fontSize: 16, fontWeight: 700, color: colors.text, margin: 0 }}>{healthData.bmi}</p>
                        <p style={{ fontSize: 10, color: colors.textMuted, margin: 0 }}>BMI</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 血圧 */}
              {(healthData.bloodPressureSystolic || healthData.bloodPressureDiastolic) && (
                <div className="p-3 rounded-xl" style={{ background: colors.card }}>
                  <p style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, marginBottom: 8 }}>血圧</p>
                  <p style={{ fontSize: 18, fontWeight: 700, color: colors.text, margin: 0, textAlign: 'center' }}>
                    {healthData.bloodPressureSystolic || '-'} / {healthData.bloodPressureDiastolic || '-'} <span style={{ fontSize: 12, fontWeight: 400 }}>mmHg</span>
                  </p>
                </div>
              )}

              {/* 血糖 */}
              {(healthData.hba1c || healthData.fastingGlucose) && (
                <div className="p-3 rounded-xl" style={{ background: colors.card }}>
                  <p style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, marginBottom: 8 }}>血糖</p>
                  <div className="grid grid-cols-2 gap-2">
                    {healthData.hba1c && (
                      <div className="text-center">
                        <p style={{ fontSize: 16, fontWeight: 700, color: colors.text, margin: 0 }}>{healthData.hba1c}</p>
                        <p style={{ fontSize: 10, color: colors.textMuted, margin: 0 }}>HbA1c %</p>
                      </div>
                    )}
                    {healthData.fastingGlucose && (
                      <div className="text-center">
                        <p style={{ fontSize: 16, fontWeight: 700, color: colors.text, margin: 0 }}>{healthData.fastingGlucose}</p>
                        <p style={{ fontSize: 10, color: colors.textMuted, margin: 0 }}>空腹時血糖</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 脂質 */}
              {(healthData.totalCholesterol || healthData.ldlCholesterol || healthData.hdlCholesterol || healthData.triglycerides) && (
                <div className="p-3 rounded-xl" style={{ background: colors.card }}>
                  <p style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, marginBottom: 8 }}>脂質</p>
                  <div className="grid grid-cols-2 gap-2">
                    {healthData.ldlCholesterol && (
                      <div className="text-center">
                        <p style={{ fontSize: 14, fontWeight: 700, color: colors.text, margin: 0 }}>{healthData.ldlCholesterol}</p>
                        <p style={{ fontSize: 9, color: colors.textMuted, margin: 0 }}>LDL</p>
                      </div>
                    )}
                    {healthData.hdlCholesterol && (
                      <div className="text-center">
                        <p style={{ fontSize: 14, fontWeight: 700, color: colors.text, margin: 0 }}>{healthData.hdlCholesterol}</p>
                        <p style={{ fontSize: 9, color: colors.textMuted, margin: 0 }}>HDL</p>
                      </div>
                    )}
                    {healthData.triglycerides && (
                      <div className="text-center">
                        <p style={{ fontSize: 14, fontWeight: 700, color: colors.text, margin: 0 }}>{healthData.triglycerides}</p>
                        <p style={{ fontSize: 9, color: colors.textMuted, margin: 0 }}>中性脂肪</p>
                      </div>
                    )}
                    {healthData.totalCholesterol && (
                      <div className="text-center">
                        <p style={{ fontSize: 14, fontWeight: 700, color: colors.text, margin: 0 }}>{healthData.totalCholesterol}</p>
                        <p style={{ fontSize: 9, color: colors.textMuted, margin: 0 }}>総コレステロール</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 肝機能 */}
              {(healthData.ast || healthData.alt || healthData.gammaGtp) && (
                <div className="p-3 rounded-xl" style={{ background: colors.card }}>
                  <p style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, marginBottom: 8 }}>肝機能</p>
                  <div className="grid grid-cols-3 gap-2">
                    {healthData.ast && (
                      <div className="text-center">
                        <p style={{ fontSize: 14, fontWeight: 700, color: colors.text, margin: 0 }}>{healthData.ast}</p>
                        <p style={{ fontSize: 9, color: colors.textMuted, margin: 0 }}>AST</p>
                      </div>
                    )}
                    {healthData.alt && (
                      <div className="text-center">
                        <p style={{ fontSize: 14, fontWeight: 700, color: colors.text, margin: 0 }}>{healthData.alt}</p>
                        <p style={{ fontSize: 9, color: colors.textMuted, margin: 0 }}>ALT</p>
                      </div>
                    )}
                    {healthData.gammaGtp && (
                      <div className="text-center">
                        <p style={{ fontSize: 14, fontWeight: 700, color: colors.text, margin: 0 }}>{healthData.gammaGtp}</p>
                        <p style={{ fontSize: 9, color: colors.textMuted, margin: 0 }}>γ-GTP</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 腎機能 */}
              {(healthData.creatinine || healthData.egfr || healthData.uricAcid) && (
                <div className="p-3 rounded-xl" style={{ background: colors.card }}>
                  <p style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted, marginBottom: 8 }}>腎機能</p>
                  <div className="grid grid-cols-3 gap-2">
                    {healthData.creatinine && (
                      <div className="text-center">
                        <p style={{ fontSize: 14, fontWeight: 700, color: colors.text, margin: 0 }}>{healthData.creatinine}</p>
                        <p style={{ fontSize: 9, color: colors.textMuted, margin: 0 }}>クレアチニン</p>
                      </div>
                    )}
                    {healthData.egfr && (
                      <div className="text-center">
                        <p style={{ fontSize: 14, fontWeight: 700, color: colors.text, margin: 0 }}>{healthData.egfr}</p>
                        <p style={{ fontSize: 9, color: colors.textMuted, margin: 0 }}>eGFR</p>
                      </div>
                    )}
                    {healthData.uricAcid && (
                      <div className="text-center">
                        <p style={{ fontSize: 14, fontWeight: 700, color: colors.text, margin: 0 }}>{healthData.uricAcid}</p>
                        <p style={{ fontSize: 9, color: colors.textMuted, margin: 0 }}>尿酸</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 保存ボタン */}
            <button
              onClick={saveHealthCheckup}
              disabled={isSavingHealth}
              className="w-full py-4 rounded-xl flex items-center justify-center gap-2 disabled:opacity-60 mb-3"
              style={{ background: colors.success }}
            >
              {isSavingHealth ? (
                <>
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>保存中...</span>
                </>
              ) : (
                <>
                  <Save size={18} color="#fff" />
                  <span style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>健康診断記録を保存</span>
                </>
              )}
            </button>

            <button
              onClick={() => { setStep('mode-select'); setPhotoFiles([]); setPhotoPreviews([]); }}
              className="w-full py-3 rounded-xl"
              style={{ background: colors.bg }}
            >
              <span style={{ fontSize: 14, color: colors.textLight }}>やり直す</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
