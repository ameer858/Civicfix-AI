import { AlertCircle, Loader2, Mail, ShieldCheck, X } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

interface GmailConfirmModalProps {
  open: boolean;
  title: string;
  description: string;
  senderEmail?: string | null;
  recipientLabel?: string;
  gmailConnected: boolean;
  connectingGmail: boolean;
  busy?: boolean;
  error?: string | null;
  confirmLabel?: string;
  secondaryActionLabel?: string;
  onConnectGmail: () => Promise<void>;
  onConfirmSend: () => Promise<void> | void;
  onSecondaryAction?: () => Promise<void> | void;
  onCancel: () => void;
}

export function GmailConfirmModal({
  open,
  title,
  description,
  senderEmail,
  recipientLabel,
  gmailConnected,
  connectingGmail,
  busy = false,
  error,
  confirmLabel,
  secondaryActionLabel,
  onConnectGmail,
  onConfirmSend,
  onSecondaryAction,
  onCancel,
}: GmailConfirmModalProps) {
  const { t, tError } = useLanguage();
  if (!open) return null;

  const resolvedConfirmLabel = confirmLabel || t('gmailModal.defaultConfirm');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="gmail-confirm-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
    >
      <div className="w-full max-w-md rounded-xl bg-white border border-slate-200 shadow-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-blue-700 shrink-0" aria-hidden="true" />
            <h3 id="gmail-confirm-title" className="text-sm font-semibold text-slate-900">
              {title}
            </h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy || connectingGmail}
            aria-label={t('gmailModal.cancelAria')}
            className="p-1 rounded text-slate-400 hover:text-slate-700 disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 text-xs text-slate-700 leading-relaxed">
          <p>{description}</p>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-1.5">
            <div>
              <span className="text-slate-500">{t('gmailModal.senderGmail')}</span>{' '}
              <span className="font-mono font-medium text-slate-900">
                {senderEmail || t('gmailModal.defaultSender')}
              </span>
            </div>
            {recipientLabel && (
              <div>
                <span className="text-slate-500">{t('gmailModal.destination')}</span>{' '}
                <span className="font-medium text-slate-900">{recipientLabel}</span>
              </div>
            )}
            <div className="flex items-center gap-1.5 pt-1">
              <ShieldCheck
                className={`w-3.5 h-3.5 shrink-0 ${
                  gmailConnected ? 'text-emerald-700' : 'text-amber-600'
                }`}
                aria-hidden="true"
              />
              <span className={gmailConnected ? 'text-emerald-800 font-medium' : 'text-amber-900 font-medium'}>
                {gmailConnected
                  ? t('gmailModal.permissionActive')
                  : t('gmailModal.permissionNeeded')}
              </span>
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 flex items-start gap-2"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{tError(error)}</span>
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy || connectingGmail}
            className="px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>

          {secondaryActionLabel && onSecondaryAction && (
            <button
              type="button"
              onClick={onSecondaryAction}
              disabled={busy || connectingGmail}
              className="px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50"
            >
              {secondaryActionLabel}
            </button>
          )}

          {!gmailConnected ? (
            <button
              type="button"
              onClick={onConnectGmail}
              disabled={connectingGmail || busy}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-700 text-white text-xs font-medium hover:bg-blue-800 disabled:opacity-60"
            >
              {connectingGmail ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Mail className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>{connectingGmail ? t('workspace.connectingGmail') : t('workspace.connectGmail')}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onConfirmSend}
              disabled={busy || connectingGmail}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-700 text-white text-xs font-medium hover:bg-blue-800 disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Mail className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>{busy ? t('gmailModal.sending') : resolvedConfirmLabel}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
