import { Globe } from 'lucide-react';
import { LANGUAGE_OPTIONS, type LanguageCode } from '../i18n/types';
import { useLanguage } from '../context/LanguageContext';

interface LanguageSelectorProps {
  compact?: boolean;
  className?: string;
}

export function LanguageSelector({ compact = false, className = '' }: LanguageSelectorProps) {
  const { language, setLanguage, t } = useLanguage();

  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400 focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-600/20 shrink-0 ${className}`}
    >
      <Globe className="w-3.5 h-3.5 text-slate-500 shrink-0" aria-hidden="true" />
      <label className="sr-only" htmlFor={compact ? 'civicfix-lang-compact' : 'civicfix-lang-header'}>
        {t('lang.label')}
      </label>
      <select
        id={compact ? 'civicfix-lang-compact' : 'civicfix-lang-header'}
        aria-label={t('lang.selectAria')}
        value={language}
        onChange={(e) => setLanguage(e.target.value as LanguageCode)}
        className="bg-transparent text-xs font-medium text-slate-800 focus:outline-none cursor-pointer pr-1 min-w-[68px] sm:min-w-[82px]"
      >
        {LANGUAGE_OPTIONS.map((opt) => (
          <option key={opt.code} value={opt.code}>
            {opt.nativeLabel}
          </option>
        ))}
      </select>
    </div>
  );
}
