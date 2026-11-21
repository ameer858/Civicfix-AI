import {
  CheckCircle2,
  Clock,
  Eye,
  ShieldCheck,
  UserCheck,
  Wrench,
  XCircle,
  RotateCcw,
  AlertTriangle,
} from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import type { ReportStatus, IssuePriority } from '../types/civic';

export function StatusIndicator({ status }: { status: ReportStatus }) {
  const { tStatus } = useLanguage();
  const config: Record<
    ReportStatus,
    { text: string; bg: string; border: string; Icon: typeof Clock }
  > = {
    submitted: {
      text: 'text-slate-700',
      bg: 'bg-slate-100',
      border: 'border-slate-200',
      Icon: Clock,
    },
    under_review: {
      text: 'text-amber-800',
      bg: 'bg-amber-50',
      border: 'border-amber-200',
      Icon: Eye,
    },
    verified: {
      text: 'text-blue-800',
      bg: 'bg-blue-50',
      border: 'border-blue-200',
      Icon: ShieldCheck,
    },
    assigned: {
      text: 'text-indigo-800',
      bg: 'bg-indigo-50',
      border: 'border-indigo-200',
      Icon: UserCheck,
    },
    in_progress: {
      text: 'text-sky-800',
      bg: 'bg-sky-50',
      border: 'border-sky-200',
      Icon: Wrench,
    },
    resolved: {
      text: 'text-emerald-800',
      bg: 'bg-emerald-50',
      border: 'border-emerald-200',
      Icon: CheckCircle2,
    },
    citizen_confirmed: {
      text: 'text-emerald-900',
      bg: 'bg-emerald-100/80',
      border: 'border-emerald-300',
      Icon: CheckCircle2,
    },
    rejected: {
      text: 'text-rose-800',
      bg: 'bg-rose-50',
      border: 'border-rose-200',
      Icon: XCircle,
    },
    reopened: {
      text: 'text-orange-800',
      bg: 'bg-orange-50',
      border: 'border-orange-200',
      Icon: RotateCcw,
    },
  };

  const c = config[status] || config.submitted;
  const Icon = c.Icon;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium border whitespace-nowrap shrink-0 ${c.bg} ${c.text} ${c.border}`}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span>{tStatus(status)}</span>
    </span>
  );
}

export function PriorityIndicator({ priority }: { priority: IssuePriority }) {
  const { tPriority } = useLanguage();
  const styles: Record<IssuePriority, string> = {
    low: 'text-slate-600 bg-slate-100 border-slate-200',
    medium: 'text-amber-800 bg-amber-50 border-amber-200',
    high: 'text-orange-800 bg-orange-50 border-orange-200',
    critical: 'text-rose-800 bg-rose-50 border-rose-200',
  };

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border whitespace-nowrap shrink-0 ${styles[priority]}`}
    >
      {priority === 'critical' && (
        <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
      )}
      <span>{tPriority(priority)}</span>
    </span>
  );
}
