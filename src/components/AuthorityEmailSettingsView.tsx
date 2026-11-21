import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Loader2,
  Mail,
  RefreshCw,
  Save,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import {
  CANONICAL_STARTER_DEPARTMENTS,
  fetchAdminDepartmentEmailSettingsViaServer,
  formatFriendlyError,
  saveDepartmentEmailSettingViaServer,
  sendTestAuthorityEmailViaServer,
  validateNonDummyEmailClient,
  type EmailTransportStatusClient,
} from '../lib/civicService';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import type { TranslationKey } from '../i18n/types';
import { GmailConfirmModal } from './GmailConfirmModal';
import { formatTimestamp } from './WorkflowTimeline';
import {
  type AuthorityEmailLog,
  type AuthorityEmailStatus,
  type Department,
  type DepartmentEmailSetting,
  type IssueCategory,
} from '../types/civic';

interface AuthorityEmailSettingsViewProps {
  departments: Department[];
  settingsFromStore: DepartmentEmailSetting[];
  logsFromStore: AuthorityEmailLog[];
  getIdToken: () => Promise<string>;
  onSelectReport?: (reportId: string) => void;
}

interface DraftSettingRow {
  departmentId: string;
  departmentName: string;
  departmentContactPerson: string;
  officialAuthorityEmail: string;
  seniorAuthorityEmail: string;
  notificationEnabled: boolean;
  emailVerified: boolean;
  updatedByName?: string;
  updatedAt?: any;
}

const ROUTING_RULES: Array<{
  category: IssueCategory;
  departmentId: string;
  departmentName: string;
}> = [
  {
    category: 'pothole',
    departmentId: 'dept_roads_infrastructure',
    departmentName: 'Public Works Department',
  },
  {
    category: 'garbage',
    departmentId: 'dept_sanitation',
    departmentName: 'Sanitation Department',
  },
  {
    category: 'streetlight',
    departmentId: 'dept_electrical',
    departmentName: 'Electricity Department',
  },
  {
    category: 'water_leakage',
    departmentId: 'dept_water_supply',
    departmentName: 'Water Supply Department',
  },
  {
    category: 'drainage',
    departmentId: 'dept_drainage',
    departmentName: 'Drainage Department',
  },
  {
    category: 'public_park_damage',
    departmentId: 'dept_parks',
    departmentName: 'Parks Department',
  },
];

function getEmailStatusBadge(
  status: AuthorityEmailStatus,
  t: (key: TranslationKey) => string
) {
  switch (status) {
    case 'sent':
      return {
        label: t('emailSettings.statusSent'),
        className: 'bg-emerald-50 text-emerald-800 border-emerald-200',
      };
    case 'not_configured':
      return {
        label: t('emailSettings.notConfiguredBadge'),
        className: 'bg-rose-50 text-rose-800 border-rose-200',
      };
    case 'disabled':
      return {
        label: t('emailSettings.notificationsDisabledShort'),
        className: 'bg-slate-100 text-slate-700 border-slate-200',
      };
    case 'smtp_not_configured':
      return {
        label: t('emailSettings.smtpNotConfiguredShort'),
        className: 'bg-amber-50 text-amber-800 border-amber-200',
      };
    case 'failed':
      return {
        label: t('emailSettings.deliveryFailedShort'),
        className: 'bg-rose-50 text-rose-800 border-rose-200',
      };
    default:
      return {
        label: t('emailSettings.statusPending'),
        className: 'bg-blue-50 text-blue-800 border-blue-200',
      };
  }
}

export function AuthorityEmailSettingsView({
  departments,
  settingsFromStore,
  logsFromStore,
  getIdToken,
  onSelectReport,
}: AuthorityEmailSettingsViewProps) {
  const { t, tCategory, tDepartmentName, tError } = useLanguage();
  const {
    user,
    gmailConnected,
    connectingGmail,
    connectGmail,
    getGmailAccessToken,
    invalidateGmailToken,
  } = useAuth();
  const [transport, setTransport] = useState<EmailTransportStatusClient | null>(null);
  const [serverSettings, setServerSettings] = useState<DepartmentEmailSetting[]>([]);
  const [serverLogs, setServerLogs] = useState<AuthorityEmailLog[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftSettingRow>>({});
  const [loading, setLoading] = useState(true);
  const [savingDeptId, setSavingDeptId] = useState<string | null>(null);
  const [rowFeedback, setRowFeedback] = useState<
    Record<string, { type: 'success' | 'error'; message: string }>
  >({});
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [testEmailTarget, setTestEmailTarget] = useState('');
  const [sendingTestEmail, setSendingTestEmail] = useState(false);
  const [testEmailResult, setTestEmailResult] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [pendingGmailTestTarget, setPendingGmailTestTarget] = useState<string | null>(null);
  const [gmailTestModalError, setGmailTestModalError] = useState<string | null>(null);

  const loadServerConfig = useCallback(async () => {
    setLoading(true);
    setGlobalError(null);
    try {
      const token = await getIdToken();
      const data = await fetchAdminDepartmentEmailSettingsViaServer(token);
      setTransport(data.transport);
      setServerSettings(data.settings);
      setServerLogs(data.logs);
    } catch (err: unknown) {
      setGlobalError(tError(formatFriendlyError(err)));
    } finally {
      setLoading(false);
    }
  }, [getIdToken, tError]);

  useEffect(() => {
    loadServerConfig();
  }, [loadServerConfig]);

  // Merge live workspace store data + server response + canonical starter departments
  const mergedSettings = useMemo<DepartmentEmailSetting[]>(() => {
    const map = new Map<string, DepartmentEmailSetting>();

    for (const d of CANONICAL_STARTER_DEPARTMENTS) {
      map.set(d.id, {
        departmentId: d.id,
        departmentName: d.name,
        officialAuthorityEmail: '',
        seniorAuthorityEmail: '',
        notificationEnabled: true,
        departmentContactPerson: '',
        emailVerified: false,
        updatedById: '',
        updatedByName: '',
        createdAt: null,
        updatedAt: null,
      });
    }

    for (const d of departments) {
      if (!d.active) continue;
      if (!map.has(d.id)) {
        map.set(d.id, {
          departmentId: d.id,
          departmentName: d.name,
          officialAuthorityEmail: '',
          seniorAuthorityEmail: '',
          notificationEnabled: true,
          departmentContactPerson: '',
          emailVerified: false,
          updatedById: '',
          updatedByName: '',
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
        });
      }
    }

    for (const s of serverSettings) {
      map.set(s.departmentId, s);
    }
    for (const s of settingsFromStore) {
      map.set(s.departmentId, s);
    }

    return Array.from(map.values()).sort((a, b) => a.departmentName.localeCompare(b.departmentName));
  }, [departments, serverSettings, settingsFromStore]);

  useEffect(() => {
    setDrafts((prev) => {
      const next: Record<string, DraftSettingRow> = { ...prev };
      for (const s of mergedSettings) {
        if (!next[s.departmentId]) {
          next[s.departmentId] = {
            departmentId: s.departmentId,
            departmentName: s.departmentName,
            departmentContactPerson: s.departmentContactPerson || '',
            officialAuthorityEmail: s.officialAuthorityEmail || '',
            seniorAuthorityEmail: s.seniorAuthorityEmail || '',
            notificationEnabled: s.notificationEnabled,
            emailVerified: s.emailVerified,
            updatedByName: s.updatedByName,
            updatedAt: s.updatedAt,
          };
        } else {
          // Keep server metadata up to date
          next[s.departmentId] = {
            ...next[s.departmentId],
            emailVerified: s.emailVerified,
            updatedByName: s.updatedByName,
            updatedAt: s.updatedAt,
          };
        }
      }
      return next;
    });
  }, [mergedSettings]);

  const combinedLogs = useMemo(() => {
    const byId = new Map<string, AuthorityEmailLog>();
    for (const l of serverLogs) byId.set(l.id, l);
    for (const l of logsFromStore) byId.set(l.id, l);
    return Array.from(byId.values()).slice(0, 40);
  }, [serverLogs, logsFromStore]);

  const unconfiguredDepartments = useMemo(
    () =>
      mergedSettings.filter(
        (s) => !s.officialAuthorityEmail || !validateNonDummyEmailClient(s.officialAuthorityEmail, false).valid
      ),
    [mergedSettings]
  );

  const handleFieldChange = (
    deptId: string,
    field: keyof DraftSettingRow,
    value: string | boolean
  ) => {
    setRowFeedback((prev) => {
      const copy = { ...prev };
      delete copy[deptId];
      return copy;
    });
    setDrafts((prev) => ({
      ...prev,
      [deptId]: {
        ...(prev[deptId] || {
          departmentId: deptId,
          departmentName: deptId,
          departmentContactPerson: '',
          officialAuthorityEmail: '',
          seniorAuthorityEmail: '',
          notificationEnabled: true,
          emailVerified: false,
        }),
        [field]: value,
      },
    }));
  };

  const handleSaveDepartment = async (e: React.FormEvent, deptId: string) => {
    e.preventDefault();
    const draft = drafts[deptId];
    if (!draft) return;

    const officialCheck = validateNonDummyEmailClient(draft.officialAuthorityEmail, true);
    if (!officialCheck.valid) {
      setRowFeedback((prev) => ({
        ...prev,
        [deptId]: {
          type: 'error',
          message: officialCheck.error ? tError(officialCheck.error) : t('emailSettings.invalidOfficialEmail'),
        },
      }));
      return;
    }

    const seniorCheck = validateNonDummyEmailClient(draft.seniorAuthorityEmail, true);
    if (!seniorCheck.valid) {
      setRowFeedback((prev) => ({
        ...prev,
        [deptId]: {
          type: 'error',
          message: seniorCheck.error ? tError(seniorCheck.error) : t('emailSettings.invalidSeniorEmail'),
        },
      }));
      return;
    }

    if (draft.departmentName.trim().length < 2) {
      setRowFeedback((prev) => ({
        ...prev,
        [deptId]: { type: 'error', message: t('emailSettings.deptNameTooShort') },
      }));
      return;
    }

    setSavingDeptId(deptId);
    setRowFeedback((prev) => {
      const copy = { ...prev };
      delete copy[deptId];
      return copy;
    });

    try {
      const token = await getIdToken();
      const saved = await saveDepartmentEmailSettingViaServer(
        deptId,
        {
          departmentName: draft.departmentName.trim(),
          officialAuthorityEmail: officialCheck.email,
          seniorAuthorityEmail: seniorCheck.email,
          notificationEnabled: draft.notificationEnabled,
          departmentContactPerson: draft.departmentContactPerson.trim(),
        },
        token
      );

      setDrafts((prev) => ({
        ...prev,
        [deptId]: {
          departmentId: saved.departmentId,
          departmentName: saved.departmentName,
          departmentContactPerson: saved.departmentContactPerson,
          officialAuthorityEmail: saved.officialAuthorityEmail,
          seniorAuthorityEmail: saved.seniorAuthorityEmail,
          notificationEnabled: saved.notificationEnabled,
          emailVerified: saved.emailVerified,
          updatedByName: saved.updatedByName,
          updatedAt: saved.updatedAt,
        },
      }));

      setServerSettings((prev) => {
        const filtered = prev.filter((item) => item.departmentId !== saved.departmentId);
        return [...filtered, saved];
      });

      setRowFeedback((prev) => ({
        ...prev,
        [deptId]: {
          type: 'success',
          message: saved.officialAuthorityEmail
            ? t('emailSettings.savedVerified', {
                dept: tDepartmentName(saved.departmentId, saved.departmentName),
              })
            : t('emailSettings.savedUnconfigured', {
                dept: tDepartmentName(saved.departmentId, saved.departmentName),
              }),
        },
      }));
    } catch (err: unknown) {
      setRowFeedback((prev) => ({
        ...prev,
        [deptId]: { type: 'error', message: tError(formatFriendlyError(err)) },
      }));
    } finally {
      setSavingDeptId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-b border-slate-200 pb-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            {t('emailSettings.pageTitle')}
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            {t('emailSettings.pageSubtitle')}
          </p>
        </div>
        <button
          type="button"
          onClick={loadServerConfig}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 min-h-[40px]"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          <span>{t('emailSettings.refreshConfig')}</span>
        </button>
      </div>

      {globalError && (
        <div
          role="alert"
          className="p-3.5 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-800 flex items-start gap-2.5"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{globalError}</span>
        </div>
      )}

      {/* Email Transport Status & Live Test Delivery */}
      {transport && (
        <div
          className={`p-4 rounded-xl border space-y-3 ${
            transport.configured || gmailConnected
              ? 'bg-emerald-50 border-emerald-200 text-emerald-950'
              : 'bg-amber-50 border-amber-200 text-amber-950'
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              {transport.configured || gmailConnected ? (
                <ShieldCheck className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" aria-hidden="true" />
              ) : (
                <ShieldAlert className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
              )}
              <div className="space-y-0.5 text-sm">
                <p className="font-semibold">
                  {transport.configured
                    ? t('emailSettings.transportActive', { provider: transport.provider.toUpperCase() })
                    : gmailConnected
                      ? t('emailSettings.gmailConnectedTitle', {
                          email: user?.email || t('gmailModal.defaultSender'),
                        })
                      : t('emailSettings.transportNotConnected')}
                </p>
                <p className="text-xs opacity-90">
                  {transport.configured
                    ? transport.notice
                    : gmailConnected
                      ? t('emailSettings.gmailConnectedDesc')
                      : t('emailSettings.transportDisconnectedDesc')}
                </p>
                {transport.configured && transport.fromAddress && (
                  <p className="text-xs font-mono opacity-80">
                    {t('emailSettings.senderAddress', { address: transport.fromAddress })}
                  </p>
                )}
              </div>
            </div>

            {!transport.configured && (
              <button
                type="button"
                onClick={async () => {
                  setTestEmailResult(null);
                  try {
                    await connectGmail();
                  } catch (err: unknown) {
                    setTestEmailResult({
                      type: 'error',
                      message: tError(formatFriendlyError(err)),
                    });
                  }
                }}
                disabled={connectingGmail}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 shrink-0"
              >
                {connectingGmail ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Mail className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>{gmailConnected ? t('emailSettings.reconnectGmail') : t('workspace.connectGmail')}</span>
              </button>
            )}
          </div>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setTestEmailResult(null);
              setGmailTestModalError(null);
              const check = validateNonDummyEmailClient(testEmailTarget, false);
              if (!check.valid) {
                setTestEmailResult({
                  type: 'error',
                  message: check.error ? tError(check.error) : t('emailSettings.invalidRecipientEmail'),
                });
                return;
              }
              if (!transport.configured) {
                setPendingGmailTestTarget(check.email);
                return;
              }
              setSendingTestEmail(true);
              try {
                const token = await getIdToken();
                const res = await sendTestAuthorityEmailViaServer(
                  { toEmail: check.email, departmentName: 'CivicFix AI Transport Verification' },
                  token
                );
                setTestEmailResult({
                  type: res.sent ? 'success' : 'error',
                  message: res.message,
                });
              } catch (err: unknown) {
                setTestEmailResult({
                  type: 'error',
                  message: tError(formatFriendlyError(err)),
                });
              } finally {
                setSendingTestEmail(false);
              }
            }}
            className="pt-2.5 border-t border-black/10 flex flex-wrap items-center gap-2"
          >
            <label htmlFor="test-authority-email" className="text-xs font-medium shrink-0">
              {t('emailSettings.sendTestLabel')}
            </label>
            <input
              id="test-authority-email"
              type="email"
              value={testEmailTarget}
              onChange={(e) => setTestEmailTarget(e.target.value)}
              placeholder={t('emailSettings.sendTestPlaceholder')}
              className="flex-1 min-w-[220px] min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
            <button
              type="submit"
              disabled={sendingTestEmail || !testEmailTarget.trim()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 disabled:opacity-50 min-h-[38px]"
            >
              {sendingTestEmail ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Mail className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>{sendingTestEmail ? t('emailSettings.sendingTest') : t('emailSettings.sendTestBtn')}</span>
            </button>
          </form>

          {testEmailResult && (
            <div
              role={testEmailResult.type === 'error' ? 'alert' : 'status'}
              className={`p-2.5 rounded-lg text-xs border ${
                testEmailResult.type === 'error'
                  ? 'bg-rose-50 border-rose-200 text-rose-800'
                  : 'bg-white border-emerald-300 text-emerald-900'
              }`}
            >
              {testEmailResult.message}
            </div>
          )}
        </div>
      )}

      {/* Unconfigured Department Alert */}
      {unconfiguredDepartments.length > 0 && (
        <div
          role="status"
          className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-950 flex items-start gap-2.5"
        >
          <AlertTriangle className="w-5 h-5 text-rose-700 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="space-y-1 text-sm">
            <p className="font-semibold">
              {t('emailSettings.unconfiguredAlertTitle', { count: unconfiguredDepartments.length })}
            </p>
            <p className="text-xs text-rose-900">
              {t('emailSettings.unconfiguredBodyPrefix')}{' '}
              <span className="font-semibold">
                {unconfiguredDepartments
                  .map((d) => tDepartmentName(d.departmentId, d.departmentName))
                  .join(', ')}
              </span>
              . {t('emailSettings.unconfiguredBodySuffix')}
            </p>
          </div>
        </div>
      )}

      {/* Automatic Category-to-Department Routing Table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2">
          <Building2 className="w-4 h-4 text-blue-700" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              {t('emailSettings.routingRulesTitle')}
            </h2>
            <p className="text-xs text-slate-500">
              {t('emailSettings.routingRulesDesc')}
            </p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th className="py-2.5 px-5 font-medium">{t('emailSettings.colComplaintCategory')}</th>
                <th className="py-2.5 px-4 font-medium">{t('emailSettings.colTargetDept')}</th>
                <th className="py-2.5 px-4 font-medium">{t('emailSettings.colDeptId')}</th>
                <th className="py-2.5 px-5 font-medium">{t('emailSettings.colAuthorityStatus')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {ROUTING_RULES.map((rule) => {
                const setting = mergedSettings.find((s) => s.departmentId === rule.departmentId);
                const hasEmail = Boolean(
                  setting?.officialAuthorityEmail &&
                    validateNonDummyEmailClient(setting.officialAuthorityEmail, false).valid
                );
                return (
                  <tr key={rule.category} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-5 font-medium text-slate-900">{tCategory(rule.category)}</td>
                    <td className="py-2.5 px-4 text-slate-800">
                      {tDepartmentName(rule.departmentId, setting?.departmentName || rule.departmentName)}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-500">{rule.departmentId}</td>
                    <td className="py-2.5 px-5">
                      {!hasEmail || !setting ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded border border-rose-200 bg-rose-50 text-rose-800 font-medium">
                          {t('emailSettings.notConfiguredBadge')}
                        </span>
                      ) : !setting.notificationEnabled ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded border border-slate-200 bg-slate-100 text-slate-700 font-medium">
                          {t('emailSettings.notificationsDisabledWithEmail', {
                            email: setting.officialAuthorityEmail,
                          })}
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-800 font-medium font-mono">
                          {setting.officialAuthorityEmail}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Department Authority Email Forms */}
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">
            {t('emailSettings.deptSettingsHeading', { count: mergedSettings.length })}
          </h2>
          <span className="text-xs text-slate-500 font-mono">department_email_settings</span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {mergedSettings.map((setting) => {
            const draft = drafts[setting.departmentId] || {
              departmentId: setting.departmentId,
              departmentName: setting.departmentName,
              departmentContactPerson: setting.departmentContactPerson || '',
              officialAuthorityEmail: setting.officialAuthorityEmail || '',
              seniorAuthorityEmail: setting.seniorAuthorityEmail || '',
              notificationEnabled: setting.notificationEnabled,
              emailVerified: setting.emailVerified,
              updatedByName: setting.updatedByName,
              updatedAt: setting.updatedAt,
            };
            const isConfigured = Boolean(
              setting.officialAuthorityEmail &&
                validateNonDummyEmailClient(setting.officialAuthorityEmail, false).valid
            );
            const feedback = rowFeedback[setting.departmentId];
            const isSaving = savingDeptId === setting.departmentId;

            return (
              <form
                key={setting.departmentId}
                onSubmit={(e) => handleSaveDepartment(e, setting.departmentId)}
                className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 pb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Mail className="w-4 h-4 text-blue-700 shrink-0" aria-hidden="true" />
                      <h3 className="text-sm font-semibold text-slate-900">
                        {tDepartmentName(setting.departmentId, setting.departmentName)}
                      </h3>
                    </div>
                    <p className="text-[11px] font-mono text-slate-500 mt-0.5">
                      {t('emailSettings.colDeptId')}: {setting.departmentId}
                    </p>
                  </div>

                  {isConfigured ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-800 text-xs font-medium">
                      <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{t('emailSettings.verifiedBadge')}</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-rose-200 bg-rose-50 text-rose-800 text-xs font-medium">
                      <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{t('emailSettings.notConfiguredBadge')}</span>
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor={`dept-name-${setting.departmentId}`}
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      {t('analytics.deptName')}
                    </label>
                    <input
                      id={`dept-name-${setting.departmentId}`}
                      type="text"
                      required
                      maxLength={120}
                      value={draft.departmentName}
                      onChange={(e) =>
                        handleFieldChange(setting.departmentId, 'departmentName', e.target.value)
                      }
                      className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor={`dept-contact-${setting.departmentId}`}
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      {t('emailSettings.contactPerson')}
                    </label>
                    <input
                      id={`dept-contact-${setting.departmentId}`}
                      type="text"
                      maxLength={120}
                      value={draft.departmentContactPerson}
                      onChange={(e) =>
                        handleFieldChange(
                          setting.departmentId,
                          'departmentContactPerson',
                          e.target.value
                        )
                      }
                      placeholder={t('emailSettings.contactPlaceholder')}
                      className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label
                      htmlFor={`dept-official-email-${setting.departmentId}`}
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      {t('emailSettings.officialEmail')}
                    </label>
                    <input
                      id={`dept-official-email-${setting.departmentId}`}
                      type="email"
                      maxLength={254}
                      value={draft.officialAuthorityEmail}
                      onChange={(e) =>
                        handleFieldChange(
                          setting.departmentId,
                          'officialAuthorityEmail',
                          e.target.value
                        )
                      }
                      placeholder={t('emailSettings.officialEmailPlaceholder')}
                      className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label
                      htmlFor={`dept-senior-email-${setting.departmentId}`}
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      {t('emailSettings.seniorEmailLabel')}
                    </label>
                    <input
                      id={`dept-senior-email-${setting.departmentId}`}
                      type="email"
                      maxLength={254}
                      value={draft.seniorAuthorityEmail}
                      onChange={(e) =>
                        handleFieldChange(
                          setting.departmentId,
                          'seniorAuthorityEmail',
                          e.target.value
                        )
                      }
                      placeholder={t('emailSettings.seniorEmailPlaceholder')}
                      className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>
                </div>

                <label className="flex items-center gap-2.5 text-xs text-slate-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={draft.notificationEnabled}
                    onChange={(e) =>
                      handleFieldChange(
                        setting.departmentId,
                        'notificationEnabled',
                        e.target.checked
                      )
                    }
                    className="w-4 h-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                  />
                  <span className="font-medium text-slate-800">
                    {t('emailSettings.notificationToggleLabel')}
                  </span>
                </label>

                {feedback && (
                  <div
                    role={feedback.type === 'error' ? 'alert' : 'status'}
                    className={`p-2.5 rounded-lg text-xs border ${
                      feedback.type === 'error'
                        ? 'bg-rose-50 border-rose-200 text-rose-800'
                        : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    }`}
                  >
                    {feedback.message}
                  </div>
                )}

                <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-500">
                    {setting.updatedByName
                      ? `${t('emailSettings.lastUpdatedBy', { name: setting.updatedByName })}${setting.updatedAt ? ` · ${formatTimestamp(setting.updatedAt)}` : ''}`
                      : t('emailSettings.notConfiguredYet')}
                  </span>
                  <button
                    type="submit"
                    disabled={isSaving}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-700 text-white text-xs font-medium hover:bg-blue-800 disabled:opacity-60 min-h-[40px]"
                  >
                    {isSaving ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Save className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>{isSaving ? t('common.saving') : t('emailSettings.saveConfigBtn')}</span>
                  </button>
                </div>
              </form>
            );
          })}
        </div>
      </section>

      {/* Authority Email Dispatch Audit Logs */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              {t('emailSettings.auditLogHeading')}
            </h2>
            <p className="text-xs text-slate-500">
              {t('emailSettings.auditLogSubtitle')}
            </p>
          </div>
          <span className="text-xs font-mono text-slate-500">
            {t('emailSettings.recordsCount', { count: combinedLogs.length })}
          </span>
        </div>

        {combinedLogs.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            {t('emailSettings.noRoutingLogs')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <th className="py-2.5 px-5 font-medium">{t('common.trackingId')}</th>
                  <th className="py-2.5 px-4 font-medium">{t('emailSettings.colCategoryDept')}</th>
                  <th className="py-2.5 px-4 font-medium">{t('emailSettings.colAuthorityEmailStatus')}</th>
                  <th className="py-2.5 px-4 font-medium">{t('emailSettings.colCitizenNotif')}</th>
                  <th className="py-2.5 px-4 font-medium">{t('emailSettings.colDetails')}</th>
                  <th className="py-2.5 px-5 font-medium text-right">{t('emailSettings.colRecorded')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {combinedLogs.map((log) => {
                  const badge = getEmailStatusBadge(log.status, t);
                  return (
                    <tr
                      key={log.id}
                      onClick={() => onSelectReport?.(log.reportId)}
                      className={onSelectReport ? 'hover:bg-slate-50 cursor-pointer' : ''}
                    >
                      <td className="py-3 px-5 font-mono font-medium text-blue-700 whitespace-nowrap">
                        {log.trackingCode}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">
                          {tDepartmentName(log.departmentId, log.departmentName)}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {tCategory(log.category)}
                        </div>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded border font-medium ${badge.className}`}
                        >
                          {badge.label}
                        </span>
                        {log.recipientEmail && (
                          <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                            {log.recipientEmail}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded border font-medium ${
                            log.citizenNotificationStatus === 'sent'
                              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                              : 'bg-slate-100 text-slate-700 border-slate-200'
                          }`}
                        >
                          {log.citizenNotificationStatus === 'sent'
                            ? t('emailSettings.statusSent')
                            : log.citizenNotificationStatus || t('emailSettings.statusSent')}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-slate-600 max-w-xs truncate" title={log.statusNote}>
                        {log.statusNote}
                      </td>
                      <td className="py-3 px-5 text-right font-mono tabular-nums text-slate-500 whitespace-nowrap">
                        {formatTimestamp(log.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <GmailConfirmModal
        open={Boolean(pendingGmailTestTarget)}
        title={t('emailSettings.gmailTestModalTitle')}
        description={t('emailSettings.gmailTestModalDesc', {
          email: pendingGmailTestTarget || '',
        })}
        senderEmail={user?.email}
        recipientLabel={pendingGmailTestTarget || undefined}
        gmailConnected={gmailConnected}
        connectingGmail={connectingGmail}
        busy={sendingTestEmail}
        error={gmailTestModalError}
        confirmLabel={t('emailSettings.gmailTestConfirmLabel')}
        onConnectGmail={async () => {
          setGmailTestModalError(null);
          try {
            await connectGmail();
          } catch (err: unknown) {
            setGmailTestModalError(tError(formatFriendlyError(err)));
          }
        }}
        onConfirmSend={async () => {
          if (!pendingGmailTestTarget) return;
          const gmailToken = getGmailAccessToken();
          if (!gmailToken) {
            invalidateGmailToken();
            setGmailTestModalError(t('emailSettings.gmailSessionExpired'));
            return;
          }
          setGmailTestModalError(null);
          setSendingTestEmail(true);
          try {
            const token = await getIdToken();
            const res = await sendTestAuthorityEmailViaServer(
              {
                toEmail: pendingGmailTestTarget,
                departmentName: 'CivicFix AI Transport Verification',
              },
              token,
              gmailToken
            );
            setPendingGmailTestTarget(null);
            setTestEmailResult({
              type: res.sent ? 'success' : 'error',
              message: res.message,
            });
          } catch (err: unknown) {
            const friendly = formatFriendlyError(err);
            if (friendly.toLowerCase().includes('gmail permission') || friendly.includes('401') || friendly.includes('403')) {
              invalidateGmailToken();
            }
            setGmailTestModalError(tError(friendly));
          } finally {
            setSendingTestEmail(false);
          }
        }}
        onCancel={() => {
          setPendingGmailTestTarget(null);
          setGmailTestModalError(null);
        }}
      />
    </div>
  );
}
