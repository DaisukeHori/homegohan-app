import { BackButton } from "./BackButton";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  className?: string;
  /** 指定時は router.back() ではなく、この URL へ戻る (#1058: common/PageHeader との重複統合) */
  backUrl?: string;
}

export function PageHeader({ title, subtitle, className = "", backUrl }: PageHeaderProps) {
  return (
    <div className={`bg-white p-6 sticky top-0 z-20 border-b border-gray-100 ${className}`}>
      <div className="mb-2">
        <BackButton href={backUrl} />
      </div>
      <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
      {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
    </div>
  );
}

