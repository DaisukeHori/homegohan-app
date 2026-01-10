"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { createClient } from "@/lib/supabase/client";
import {
  Camera, Upload, X, ChevronDown, ChevronUp, Loader2,
  CheckCircle2, AlertTriangle, Sparkles, ArrowLeft, Activity
} from 'lucide-react';

const colors = {
  bg: '#FAF9F7',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#9A9A9A',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  success: '#4CAF50',
  successLight: '#E8F5E9',
  warning: '#FF9800',
  warningLight: '#FFF3E0',
  error: '#F44336',
  border: '#EEEEEE',
  purple: '#7C4DFF',
  purpleLight: '#EDE7FF',
};

interface FormData {
  checkup_date: string;
  facility_name: string;
  checkup_type: string;
  // 身体測定
  height: string;
  weight: string;
  bmi: string;
  waist_circumference: string;
  // 血圧
  blood_pressure_systolic: string;
  blood_pressure_diastolic: string;
  // 血液検査
  hemoglobin: string;
  hba1c: string;
  fasting_glucose: string;
  // 脂質
  total_cholesterol: string;
  ldl_cholesterol: string;
  hdl_cholesterol: string;
  triglycerides: string;
  // 肝機能
  ast: string;
  alt: string;
  gamma_gtp: string;
  // 腎機能
  creatinine: string;
  egfr: string;
  uric_acid: string;
}

const initialFormData: FormData = {
  checkup_date: new Date().toISOString().split('T')[0],
  facility_name: '',
  checkup_type: '定期健診',
  height: '',
  weight: '',
  bmi: '',
  waist_circumference: '',
  blood_pressure_systolic: '',
  blood_pressure_diastolic: '',
  hemoglobin: '',
  hba1c: '',
  fasting_glucose: '',
  total_cholesterol: '',
  ldl_cholesterol: '',
  hdl_cholesterol: '',
  triglycerides: '',
  ast: '',
  alt: '',
  gamma_gtp: '',
  creatinine: '',
  egfr: '',
  uric_acid: '',
};

type Step = 'upload' | 'confirm' | 'review';

export default function NewHealthCheckupPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('upload');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [formData, setFormData] = useState<FormData>(initialFormData);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    basic: true,
    blood: true,
    lipid: false,
    liver: false,
    kidney: false,
  });
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedCheckup, setSavedCheckup] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const supabase = createClient();

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
    setError(null);
  };

  const handleUploadAndAnalyze = async () => {
    if (!imageFile) {
      // 画像なしで手動入力へ
      setStep('confirm');
      return;
    }

    setUploading(true);
    setError(null);

    try {
      // 1. 画像をアップロード
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        throw new Error('ログインが必要です');
      }

      const fileName = `${user.id}/${Date.now()}-${Math.random().toString(36).substring(7)}.${imageFile.name.split('.').pop()}`;

      const { error: uploadError } = await supabase.storage
        .from('health-checkups')
        .upload(fileName, imageFile, {
          contentType: imageFile.type,
          upsert: false,
        });

      if (uploadError) {
        // バケットが存在しない場合はスキップして手動入力へ
        console.error('Upload failed:', uploadError);
        setStep('confirm');
        return;
      }

      const { data: { publicUrl } } = supabase.storage
        .from('health-checkups')
        .getPublicUrl(fileName);

      setUploading(false);
      setAnalyzing(true);

      // 2. 画像解析（実際のAPI呼び出しはPOST時に行う）
      // ここでは画像URLを保持してconfirmステップへ
      setFormData(prev => ({ ...prev, image_url: publicUrl } as any));
      setStep('confirm');

    } catch (err: any) {
      setError(err.message || '画像のアップロードに失敗しました');
    } finally {
      setUploading(false);
      setAnalyzing(false);
    }
  };

  const handleSkipUpload = () => {
    setStep('confirm');
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    try {
      // フォームデータを数値に変換
      const numericFields = [
        'height', 'weight', 'bmi', 'waist_circumference',
        'blood_pressure_systolic', 'blood_pressure_diastolic',
        'hemoglobin', 'hba1c', 'fasting_glucose',
        'total_cholesterol', 'ldl_cholesterol', 'hdl_cholesterol', 'triglycerides',
        'ast', 'alt', 'gamma_gtp',
        'creatinine', 'egfr', 'uric_acid',
      ];

      const payload: any = {
        checkup_date: formData.checkup_date,
        facility_name: formData.facility_name || null,
        checkup_type: formData.checkup_type || null,
        image_url: (formData as any).image_url || null,
      };

      numericFields.forEach(field => {
        const value = formData[field as keyof FormData];
        if (value && value !== '') {
          payload[field] = parseFloat(value);
        }
      });

      const res = await fetch('/api/health/checkups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '保存に失敗しました');
      }

      const data = await res.json();
      setSavedCheckup(data.checkup);
      setStep('review');

    } catch (err: any) {
      setError(err.message || '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  const updateFormField = (field: keyof FormData, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const renderInput = (
    field: keyof FormData,
    label: string,
    unit?: string,
    placeholder?: string
  ) => (
    <div className="flex items-center gap-2">
      <label className="w-24 text-sm flex-shrink-0" style={{ color: colors.textLight }}>
        {label}
      </label>
      <div className="flex-1 flex items-center gap-1">
        <input
          type="text"
          inputMode="decimal"
          value={formData[field]}
          onChange={(e) => updateFormField(field, e.target.value)}
          placeholder={placeholder}
          className="flex-1 px-3 py-2 rounded-lg text-sm border"
          style={{ borderColor: colors.border, backgroundColor: colors.card }}
        />
        {unit && (
          <span className="text-xs w-12" style={{ color: colors.textMuted }}>
            {unit}
          </span>
        )}
      </div>
    </div>
  );

  const renderSection = (
    key: string,
    title: string,
    icon: React.ReactNode,
    children: React.ReactNode
  ) => (
    <div className="rounded-xl overflow-hidden" style={{ backgroundColor: colors.card }}>
      <button
        onClick={() => toggleSection(key)}
        className="w-full p-4 flex items-center justify-between"
      >
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center"
            style={{ backgroundColor: colors.accentLight }}
          >
            {icon}
          </div>
          <span className="font-bold" style={{ color: colors.text }}>{title}</span>
        </div>
        {expandedSections[key] ? (
          <ChevronUp size={20} style={{ color: colors.textMuted }} />
        ) : (
          <ChevronDown size={20} style={{ color: colors.textMuted }} />
        )}
      </button>
      <AnimatePresence>
        {expandedSections[key] && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="px-4 pb-4 space-y-3"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  return (
    <div className="min-h-screen pb-24" style={{ backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <div className="sticky top-0 z-10 px-4 py-4" style={{ backgroundColor: colors.bg }}>
        <div className="flex items-center gap-3">
          <button onClick={() => router.back()}>
            <ArrowLeft size={24} style={{ color: colors.text }} />
          </button>
          <h1 className="text-xl font-bold" style={{ color: colors.text }}>
            {step === 'upload' && '健康診断を記録'}
            {step === 'confirm' && '検査結果を確認'}
            {step === 'review' && 'AI分析結果'}
          </h1>
        </div>
      </div>

      <div className="px-4">
        {/* Step 1: 画像アップロード */}
        {step === 'upload' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-4"
          >
            <p className="text-sm" style={{ color: colors.textLight }}>
              健康診断の結果票を撮影すると、AIが自動で数値を読み取ります。
            </p>

            {/* 画像プレビュー or アップロードエリア */}
            {imagePreview ? (
              <div className="relative rounded-2xl overflow-hidden">
                <img
                  src={imagePreview}
                  alt="健康診断結果"
                  className="w-full h-auto"
                />
                <button
                  onClick={() => {
                    setImageFile(null);
                    setImagePreview(null);
                  }}
                  className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/50 flex items-center justify-center"
                >
                  <X size={16} color="white" />
                </button>
              </div>
            ) : (
              <motion.div
                whileTap={{ scale: 0.98 }}
                onClick={() => fileInputRef.current?.click()}
                className="aspect-[4/3] rounded-2xl border-2 border-dashed flex flex-col items-center justify-center cursor-pointer"
                style={{ borderColor: colors.accent, backgroundColor: colors.accentLight }}
              >
                <Camera size={48} style={{ color: colors.accent }} />
                <p className="mt-2 font-bold" style={{ color: colors.accent }}>
                  タップして撮影
                </p>
                <p className="text-xs mt-1" style={{ color: colors.textMuted }}>
                  または画像を選択
                </p>
              </motion.div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleFileSelect}
              className="hidden"
            />

            {error && (
              <div className="p-3 rounded-lg" style={{ backgroundColor: colors.warningLight }}>
                <p className="text-sm" style={{ color: colors.warning }}>{error}</p>
              </div>
            )}

            <div className="space-y-3 pt-4">
              <motion.button
                whileTap={{ scale: 0.98 }}
                onClick={handleUploadAndAnalyze}
                disabled={uploading || analyzing}
                className="w-full py-4 rounded-full text-white font-bold flex items-center justify-center gap-2"
                style={{ backgroundColor: colors.accent, opacity: (uploading || analyzing) ? 0.7 : 1 }}
              >
                {uploading ? (
                  <>
                    <Loader2 size={20} className="animate-spin" />
                    アップロード中...
                  </>
                ) : analyzing ? (
                  <>
                    <Sparkles size={20} />
                    AI解析中...
                  </>
                ) : imagePreview ? (
                  <>
                    <Sparkles size={20} />
                    AIで読み取る
                  </>
                ) : (
                  '手動で入力する'
                )}
              </motion.button>

              {imagePreview && (
                <button
                  onClick={handleSkipUpload}
                  className="w-full py-3 text-sm"
                  style={{ color: colors.textMuted }}
                >
                  画像なしで手動入力
                </button>
              )}
            </div>
          </motion.div>
        )}

        {/* Step 2: データ確認・編集 */}
        {step === 'confirm' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-4"
          >
            {/* 基本情報 */}
            <div className="p-4 rounded-xl space-y-3" style={{ backgroundColor: colors.card }}>
              <div className="flex items-center gap-2">
                <label className="w-24 text-sm" style={{ color: colors.textLight }}>
                  検査日
                </label>
                <input
                  type="date"
                  value={formData.checkup_date}
                  onChange={(e) => updateFormField('checkup_date', e.target.value)}
                  className="flex-1 px-3 py-2 rounded-lg text-sm border"
                  style={{ borderColor: colors.border }}
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="w-24 text-sm" style={{ color: colors.textLight }}>
                  医療機関
                </label>
                <input
                  type="text"
                  value={formData.facility_name}
                  onChange={(e) => updateFormField('facility_name', e.target.value)}
                  placeholder="〇〇クリニック"
                  className="flex-1 px-3 py-2 rounded-lg text-sm border"
                  style={{ borderColor: colors.border }}
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="w-24 text-sm" style={{ color: colors.textLight }}>
                  種類
                </label>
                <select
                  value={formData.checkup_type}
                  onChange={(e) => updateFormField('checkup_type', e.target.value)}
                  className="flex-1 px-3 py-2 rounded-lg text-sm border"
                  style={{ borderColor: colors.border }}
                >
                  <option value="定期健診">定期健診</option>
                  <option value="人間ドック">人間ドック</option>
                  <option value="特定健診">特定健診</option>
                  <option value="その他">その他</option>
                </select>
              </div>
            </div>

            {/* 血圧・代謝 */}
            {renderSection('basic', '血圧・代謝', <Activity size={20} style={{ color: colors.accent }} />, (
              <>
                {renderInput('blood_pressure_systolic', '収縮期血圧', 'mmHg', '120')}
                {renderInput('blood_pressure_diastolic', '拡張期血圧', 'mmHg', '80')}
                {renderInput('hba1c', 'HbA1c', '%', '5.6')}
                {renderInput('fasting_glucose', '空腹時血糖', 'mg/dL', '100')}
              </>
            ))}

            {/* 身体測定 */}
            {renderSection('blood', '身体測定', <Camera size={20} style={{ color: colors.accent }} />, (
              <>
                {renderInput('height', '身長', 'cm', '170')}
                {renderInput('weight', '体重', 'kg', '65')}
                {renderInput('bmi', 'BMI', '', '22.5')}
                {renderInput('waist_circumference', '腹囲', 'cm', '85')}
              </>
            ))}

            {/* 脂質 */}
            {renderSection('lipid', '脂質', <Activity size={20} style={{ color: colors.accent }} />, (
              <>
                {renderInput('total_cholesterol', '総コレステロール', 'mg/dL', '200')}
                {renderInput('ldl_cholesterol', 'LDL', 'mg/dL', '120')}
                {renderInput('hdl_cholesterol', 'HDL', 'mg/dL', '60')}
                {renderInput('triglycerides', '中性脂肪', 'mg/dL', '150')}
              </>
            ))}

            {/* 肝機能 */}
            {renderSection('liver', '肝機能', <Activity size={20} style={{ color: colors.accent }} />, (
              <>
                {renderInput('ast', 'AST(GOT)', 'U/L', '25')}
                {renderInput('alt', 'ALT(GPT)', 'U/L', '20')}
                {renderInput('gamma_gtp', 'γ-GTP', 'U/L', '30')}
              </>
            ))}

            {/* 腎機能 */}
            {renderSection('kidney', '腎機能・尿酸', <Activity size={20} style={{ color: colors.accent }} />, (
              <>
                {renderInput('creatinine', 'クレアチニン', 'mg/dL', '0.8')}
                {renderInput('egfr', 'eGFR', '', '90')}
                {renderInput('uric_acid', '尿酸', 'mg/dL', '5.5')}
              </>
            ))}

            {error && (
              <div className="p-3 rounded-lg" style={{ backgroundColor: colors.warningLight }}>
                <p className="text-sm" style={{ color: colors.warning }}>{error}</p>
              </div>
            )}

            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={handleSave}
              disabled={saving}
              className="w-full py-4 rounded-full text-white font-bold flex items-center justify-center gap-2"
              style={{ backgroundColor: colors.accent, opacity: saving ? 0.7 : 1 }}
            >
              {saving ? (
                <>
                  <Loader2 size={20} className="animate-spin" />
                  保存中...
                </>
              ) : (
                <>
                  <Sparkles size={20} />
                  保存してAI分析を実行
                </>
              )}
            </motion.button>
          </motion.div>
        )}

        {/* Step 3: AIレビュー表示 */}
        {step === 'review' && savedCheckup && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-4"
          >
            {savedCheckup.individual_review ? (
              <>
                {/* 総評 */}
                <div className="p-4 rounded-xl" style={{ backgroundColor: colors.card }}>
                  <div className="flex items-center gap-2 mb-3">
                    <Sparkles size={20} style={{ color: colors.purple }} />
                    <span className="font-bold" style={{ color: colors.text }}>AI分析結果</span>
                  </div>
                  <p className="text-sm leading-relaxed" style={{ color: colors.textLight }}>
                    {savedCheckup.individual_review.summary}
                  </p>
                </div>

                {/* 気になる点 */}
                {savedCheckup.individual_review.concerns?.length > 0 && (
                  <div className="p-4 rounded-xl" style={{ backgroundColor: colors.warningLight }}>
                    <div className="flex items-center gap-2 mb-3">
                      <AlertTriangle size={20} style={{ color: colors.warning }} />
                      <span className="font-bold" style={{ color: colors.warning }}>気になる点</span>
                    </div>
                    <ul className="space-y-2">
                      {savedCheckup.individual_review.concerns.map((item: string, i: number) => (
                        <li key={i} className="flex items-start gap-2 text-sm" style={{ color: colors.textLight }}>
                          <span>•</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* 良い点 */}
                {savedCheckup.individual_review.positives?.length > 0 && (
                  <div className="p-4 rounded-xl" style={{ backgroundColor: colors.successLight }}>
                    <div className="flex items-center gap-2 mb-3">
                      <CheckCircle2 size={20} style={{ color: colors.success }} />
                      <span className="font-bold" style={{ color: colors.success }}>良い点</span>
                    </div>
                    <ul className="space-y-2">
                      {savedCheckup.individual_review.positives.map((item: string, i: number) => (
                        <li key={i} className="flex items-start gap-2 text-sm" style={{ color: colors.textLight }}>
                          <span>•</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* アドバイス */}
                {savedCheckup.individual_review.recommendations?.length > 0 && (
                  <div className="p-4 rounded-xl" style={{ backgroundColor: colors.purpleLight }}>
                    <div className="flex items-center gap-2 mb-3">
                      <Sparkles size={20} style={{ color: colors.purple }} />
                      <span className="font-bold" style={{ color: colors.purple }}>改善アドバイス</span>
                    </div>
                    <ul className="space-y-2">
                      {savedCheckup.individual_review.recommendations.map((item: string, i: number) => (
                        <li key={i} className="flex items-start gap-2 text-sm" style={{ color: colors.textLight }}>
                          <span>{i + 1}.</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <div className="p-4 rounded-xl text-center" style={{ backgroundColor: colors.card }}>
                <p className="text-sm" style={{ color: colors.textMuted }}>
                  AI分析を実行できませんでした
                </p>
              </div>
            )}

            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={() => router.push('/health/checkups')}
              className="w-full py-4 rounded-full text-white font-bold"
              style={{ backgroundColor: colors.accent }}
            >
              完了
            </motion.button>
          </motion.div>
        )}
      </div>
    </div>
  );
}
