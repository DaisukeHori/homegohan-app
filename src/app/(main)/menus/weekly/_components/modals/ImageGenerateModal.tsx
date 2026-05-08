"use client";

import React, { useRef } from "react";
import { motion } from "framer-motion";
import { X, Plus, Sparkles, Image as ImageIcon } from "lucide-react";
import Image from "next/image";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  border: '#E8E8E8',
};

interface ImageGenerateMeal {
  dishName?: string;
  imageUrl?: string;
}

interface ImageGenerateModalProps {
  imageGenerateMeal: ImageGenerateMeal;
  imageGenerationPrompt: string;
  imageReferencePreviews: string[];
  isGeneratingMealImage: boolean;
  onClose: () => void;
  onChangePrompt: (value: string) => void;
  onAddReferenceImages: (files: FileList) => void;
  onRemoveReferenceImage: (idx: number) => void;
  onGenerate: () => void;
}

export function ImageGenerateModal({
  imageGenerateMeal,
  imageGenerationPrompt,
  imageReferencePreviews,
  isGeneratingMealImage,
  onClose,
  onChangePrompt,
  onAddReferenceImages,
  onRemoveReferenceImage,
  onGenerate,
}: ImageGenerateModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAddReferenceImages(e.target.files);
    }
  };

  const handleAddMore = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files && files.length > 0) {
        onAddReferenceImages(files);
      }
    };
    input.click();
  };

  return (
    <motion.div
      initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl"
      style={{ background: colors.card, maxHeight: '78vh' }}
    >
      <div className="flex justify-between items-center px-4 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
        <div className="flex items-center gap-2">
          <ImageIcon size={18} color={colors.accent} />
          <span style={{ fontSize: 15, fontWeight: 600 }}>AIで料理画像を生成</span>
          {imageReferencePreviews.length > 0 && (
            <span className="px-2 py-0.5 rounded-full text-xs" style={{ background: colors.accentLight, color: colors.accent }}>
              参照 {imageReferencePreviews.length}枚
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          disabled={isGeneratingMealImage}
          className="w-7 h-7 rounded-full flex items-center justify-center disabled:opacity-50"
          style={{ background: colors.bg }}
        >
          <X size={14} color={colors.textLight} />
        </button>
      </div>
      <div className="flex-1 p-4 overflow-auto">
        {imageGenerateMeal.imageUrl && (
          <div className="mb-4">
            <label style={{ fontSize: 12, color: colors.textMuted, display: 'block', marginBottom: 8 }}>現在の画像</label>
            <div className="relative h-40 rounded-2xl overflow-hidden" style={{ border: `1px solid ${colors.border}` }}>
              <Image
                src={imageGenerateMeal.imageUrl}
                alt={imageGenerateMeal.dishName || 'Meal image'}
                fill
                sizes="(max-width: 1024px) 100vw, 50vw"
                className="object-cover"
              />
            </div>
          </div>
        )}

        <div className="mb-4">
          <label style={{ fontSize: 12, color: colors.textMuted, display: 'block', marginBottom: 8 }}>生成したい画像の説明</label>
          <textarea
            value={imageGenerationPrompt}
            onChange={(e) => onChangePrompt(e.target.value)}
            placeholder="例: 彩りの良い和風ハンバーグ定食、湯気のある自然光、木のテーブル"
            rows={4}
            className="w-full p-3 rounded-2xl text-[13px] outline-none resize-none"
            style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
          />
          <p style={{ fontSize: 11, color: colors.textMuted, marginTop: 8 }}>
            料理名だけでも生成できます。盛り付け、雰囲気、器の指定も追加できます。
          </p>
        </div>

        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label style={{ fontSize: 12, color: colors.textMuted }}>参照画像（任意・複数可）</label>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="text-[12px] flex items-center gap-1"
              style={{ color: colors.accent }}
            >
              <Plus size={12} /> 追加
            </button>
          </div>

          <input
            type="file"
            ref={fileInputRef}
            accept="image/*"
            multiple
            onChange={handleFileChange}
            className="hidden"
          />

          {imageReferencePreviews.length > 0 ? (
            <div className="grid grid-cols-3 gap-2">
              {imageReferencePreviews.map((preview, idx) => (
                <div key={idx} className="relative aspect-square">
                  <Image
                    src={preview}
                    alt={`Reference ${idx + 1}`}
                    fill
                    sizes="(max-width: 768px) 33vw, 120px"
                    unoptimized
                    className="rounded-lg object-cover"
                  />
                  <button
                    onClick={() => onRemoveReferenceImage(idx)}
                    className="absolute top-1 right-1 w-6 h-6 rounded-full flex items-center justify-center"
                    style={{ background: 'rgba(0,0,0,0.6)' }}
                  >
                    <X size={12} color="#fff" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full p-6 rounded-2xl flex flex-col items-center gap-2"
              style={{ background: colors.bg, border: `2px dashed ${colors.border}` }}
            >
              <ImageIcon size={32} color={colors.textMuted} />
              <span style={{ fontSize: 13, color: colors.textMuted }}>参考画像を追加する</span>
            </button>
          )}
        </div>

        <div className="p-3 rounded-xl" style={{ background: colors.accentLight }}>
          <p style={{ fontSize: 11, color: colors.accent, margin: 0 }}>
            AIが料理画像を新規生成します。参照画像を追加すると、盛り付けや色味を寄せやすくなります。
          </p>
        </div>
      </div>
      <div className="px-4 py-4 pb-4 lg:pb-6 flex-shrink-0" style={{ borderTop: `1px solid ${colors.border}`, background: colors.card }}>
        <button
          onClick={onGenerate}
          disabled={!imageGenerationPrompt.trim() || isGeneratingMealImage}
          className="w-full py-3.5 rounded-xl flex items-center justify-center gap-2 disabled:opacity-50"
          style={{ background: colors.accent }}
        >
          {isGeneratingMealImage ? (
            <>
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>画像を生成中...</span>
            </>
          ) : (
            <>
              <Sparkles size={16} color="#fff" />
              <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>料理画像を生成する</span>
            </>
          )}
        </button>
      </div>
    </motion.div>
  );
}
