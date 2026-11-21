import { Check, Clock, RotateCcw, XCircle } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { getActiveLanguage, getLanguageOption, translate } from '../i18n';
import {
  WORKFLOW_STAGES,
  type ReportStatus,
  type ReportUpdate,
} from '../types/civic';

export function formatTimestamp(ts: any, localeOverride?: string): string {
  const activeLang = getActiveLanguage();
  if (!ts) return translate(activeLang, 'common.justNow');
  try {
    const date = typeof ts?.toDate === 'function' ? ts.toDate() : new Date(ts);
    if (Number.isNaN(date.getTime())) return translate(activeLang, 'common.recorded');
    const locale = localeOverride || getLanguageOption(activeLang).locale;
    return date.toLocaleString(locale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return translate(activeLang, 'common.recorded');
  }
}

export function WorkflowStepper({ status }: { status: ReportStatus }) {
  const { t, tStatus } = useLanguage();
  const activeIdx = WORKFLOW_STAGES.indexOf(status);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {WORKFLOW_STAGES.map((stage, idx) => {
          const isCompleted = activeIdx > idx;
          const isCurrent = activeIdx === idx;
          return (
            <div key={stage} className="flex items-center gap-2">
              <div
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs font-medium whitespace-nowrap ${
                  isCurrent
                    ? 'bg-blue-700 text-white border-blue-700'
                    : isCompleted
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                      : 'bg-slate-50 text-slate-500 border-slate-200'
                }`}
              >
                {isCompleted ? (
                  <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                ) : (
                  <span className="font-mono text-[11px] tabular-nums">{idx + 1}.</span>
                )}
                <span>{tStatus(stage)}</span>
              </div>
              {idx < WORKFLOW_STAGES.length - 1 && (
                <span className="text-slate-300 text-xs" aria-hidden="true">
                  /
                </span>
              )}
            </div>
          );
        })}
      </div>

      {status === 'rejected' && (
        <div className="flex items-center gap-2 text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded px-3 py-2">
          <XCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{t('timeline.closedRejected')}</span>
        </div>
      )}

      {status === 'reopened' && (
        <div className="flex items-center gap-2 text-xs font-medium text-orange-800 bg-orange-50 border border-orange-200 rounded px-3 py-2">
          <RotateCcw className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{t('timeline.citizenReopened')}</span>
        </div>
      )}
    </div>
  );
}

export function ActivityTimeline({ updates }: { updates: ReportUpdate[] }) {
  const { t, tStatus, tRole, locale } = useLanguage();

  if (updates.length === 0) {
    return (
      <p className="text-sm text-slate-500 py-4">
        {t('timeline.noTransitions')}
      </p>
    );
  }

  return (
    <ol className="divide-y divide-slate-200">
      {updates.map((upd) => (
        <li key={upd.id} className="py-3.5 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold text-slate-900">
                {tStatus(upd.toStatus as ReportStatus)}
              </span>
              {upd.fromStatus && (
                <span className="text-xs text-slate-500">
                  {t('timeline.fromStatus', { status: tStatus(upd.fromStatus as ReportStatus) })}
                </span>
              )}
              <span className="text-slate-300" aria-hidden="true">
                ·
              </span>
              <span className="text-xs text-slate-600">
                {upd.actorName} ({tRole(upd.actorRole)})
              </span>
            </div>
            <time className="text-xs font-mono tabular-nums text-slate-500 flex items-center gap-1">
              <Clock className="w-3 h-3 text-slate-400" aria-hidden="true" />
              {formatTimestamp(upd.createdAt, locale)}
            </time>
          </div>
          <p className="mt-1 text-sm text-slate-700 leading-relaxed">{upd.note}</p>
          {upd.evidenceUrls && upd.evidenceUrls.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {upd.evidenceUrls.map((url, i) => (
                <a
                  key={url + i}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="block w-16 h-16 rounded border border-slate-200 overflow-hidden bg-slate-100 hover:opacity-90"
                >
                  <img
                    src={url}
                    alt={t('timeline.attachmentAlt', { num: i + 1 })}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                </a>
              ))}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
