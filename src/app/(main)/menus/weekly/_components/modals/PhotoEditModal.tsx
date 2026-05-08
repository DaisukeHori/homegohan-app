"use client";

import React, { useRef } from "react";
import { motion } from "framer-motion";
import { X, Plus, Sparkles, Camera, Image as ImageIcon } from "lucide-react";
import Image from "next/image";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  blue: '#5B8BC7',
  blueLight: '#EEF4FB',
  border: '#E8E8E8',
};

interface PhotoEditModalProps {
  photoPreviews: string[];
  photoFilesCount: number;
  isAnalyzingPhoto: boolean;
  onClose: () => void;
  onPhotoSelect: (files: FileList) => void;
  onRemovePhoto: (idx: number) => void;
  onAnalyze: () => void;
}

export function PhotoEditModal({
  photoPreviews,
  photoFilesCount,
  isAnalyzingPhoto,
  onClose,
  onPhotoSelect,
  onRemovePhoto,
  onAnalyze,
}: PhotoEditModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleCaptureChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onPhotoSelect(e.target.files);
    }
  };

  const handleGallerySelect = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files && files.length > 0) {
        onPhotoSelect(files);
      }
    };
    input.click();
  };

  return (
    <motion.div
      initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl"
      style={{ background: colors.card, maxHeight: '75vh' }}
    >
      <div className="flex justify-between items-center px-4 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
        <div className="flex items-center gap-2">
          <Camera size={18} color={colors.blue} />
          <span style={{ fontSize: 15, fontWeight: 600 }}>写真から入力</span>
          {photoPreviews.length > 0 && (
            <span className="px-2 py-0.5 rounded-full text-xs" style={{ background: colors.accentLight, color: colors.accent }}>
              {photoPreviews.length}枚
            </span>
          )}
        </div>
        <button onClick={onClose} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
          <X size={14} color={colors.textLight} />
        </button>
      </div>
      <div className="flex-1 p-4 overflow-auto">
        <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 12 }}>
          食事の写真を撮影またはアップロードすると、AIが料理を認識して栄養素を推定します。<br/>
          <strong>複数枚の写真をまとめて追加できます。</strong>
        </p>

        <input
          type="file"
          ref={fileInputRef}
          accept="image/*"
          capture="environment"
          multiple
          onChange={handleCaptureChange}
          className="hidden"
        />

        {/* 選択済み写真のプレビュー */}
        {photoPreviews.length > 0 && (
          <div className="mb-4">
            <div className="grid grid-cols-3 gap-2">
              {photoPreviews.map((preview, idx) => (
                <div key={idx} className="relative aspect-square">
                  <Image
                    src={preview}
                    alt={`Preview ${idx + 1}`}
                    fill
                    sizes="(max-width: 768px) 33vw, 120px"
                    unoptimized
                    className="rounded-lg object-cover"
                  />
                  <button
                    onClick={() => onRemovePhoto(idx)}
                    className="absolute top-1 right-1 w-6 h-6 rounded-full flex items-center justify-center"
                    style={{ background: 'rgba(0,0,0,0.6)' }}
                  >
                    <X size={12} color="#fff" />
                  </button>
                </div>
              ))}
              {/* 追加ボタン */}
              <button
                onClick={handleGallerySelect}
                className="aspect-square rounded-lg flex flex-col items-center justify-center"
                style={{ background: colors.bg, border: `2px dashed ${colors.border}` }}
              >
                <Plus size={24} color={colors.textMuted} />
                <span style={{ fontSize: 10, color: colors.textMuted }}>追加</span>
              </button>
            </div>
          </div>
        )}

        {/* 写真未選択時のボタン */}
        {photoPreviews.length === 0 && (
          <div className="flex gap-3 mb-4">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex-1 p-6 rounded-xl flex flex-col items-center gap-2"
              style={{ background: colors.bg, border: `2px dashed ${colors.border}` }}
            >
              <Camera size={32} color={colors.textMuted} />
              <span style={{ fontSize: 13, color: colors.textMuted }}>撮影する</span>
            </button>
            <button
              onClick={handleGallerySelect}
              className="flex-1 p-6 rounded-xl flex flex-col items-center gap-2"
              style={{ background: colors.bg, border: `2px dashed ${colors.border}` }}
            >
              <ImageIcon size={32} color={colors.textMuted} />
              <span style={{ fontSize: 13, color: colors.textMuted }}>選択する</span>
            </button>
          </div>
        )}

        <div className="p-3 rounded-xl" style={{ background: colors.blueLight }}>
          <p style={{ fontSize: 11, color: colors.blue, margin: 0 }}>
            💡 AIが写真から料理名、カロリー、栄養素を自動で推定します。複数枚の場合はまとめて解析します。
          </p>
        </div>
      </div>
      <div className="px-4 py-4 pb-4 lg:pb-6 flex-shrink-0" style={{ borderTop: `1px solid ${colors.border}`, background: colors.card }}>
        <button
          onClick={onAnalyze}
          disabled={photoFilesCount === 0 || isAnalyzingPhoto}
          className="w-full py-3.5 rounded-xl flex items-center justify-center gap-2 disabled:opacity-50"
          style={{ background: colors.blue }}
        >
          {isAnalyzingPhoto ? (
            <>
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>AIが解析中...</span>
            </>
          ) : (
            <>
              <Sparkles size={16} color="#fff" />
              <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>
                {photoFilesCount > 1 ? `${photoFilesCount}枚をAIで解析` : 'AIで解析する'}
              </span>
            </>
          )}
        </button>
      </div>
    </motion.div>
  );
}
