import { BackButton } from "./BackButton";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  className?: string;
}

export function PageHeader({ title, subtitle, className = "" }: PageHeaderProps) {
  return (
    <div className={`bg-white p-6 sticky top-0 z-20 border-b border-gray-100 ${className}`}>
      <div className="mb-2">
        <BackButton />
      </div>
      <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
      {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
    </div>
  );
}

