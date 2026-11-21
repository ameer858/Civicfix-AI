import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Info,
  MapPin,
  ShieldCheck,
  UserPlus,
  Users,
  Wrench,
} from 'lucide-react';
import {
  adminRegisterWorkerInvite,
  adminUpdateUserRole,
  formatFriendlyError,
  updateWorkerAvailability,
  workerAcknowledgeTask,
} from '../lib/civicService';
import {
  computeWorkerWorkloads,
  evaluateReportDeadlines,
  isReportAwaitingSupervisorVerification,
} from '../lib/operationsEngine';
import { PriorityIndicator, StatusIndicator } from './StatusBadge';
import { formatTimestamp } from './WorkflowTimeline';
import { useLanguage } from '../context/LanguageContext';
import {
  type Assignment,
  type CivicReport,
  type Department,
  type SlaPolicy,
  type UserProfile,
  type UserRole,
  type WorkerAvailabilityStatus,
  type WorkerInvite,
} from '../types/civic';

interface WorkforceManagementViewProps {
  profile: UserProfile;
  effectiveRole: UserRole;
  reports: CivicReport[];
  assignments: Assignment[];
  departments: Department[];
  staffUsers: UserProfile[];
  workerInvites: WorkerInvite[];
  slaPolicies: SlaPolicy[];
  getIdToken: () => Promise<string>;
  onSelectReport: (reportId: string) => void;
}

const ALL_AVAILABILITY_STATUSES: WorkerAvailabilityStatus[] = [
  'available',
  'assigned',
  'on_duty',
  'busy',
  'completed_shift',
  'unavailable',
];

function AvailabilityBadge({ status }: { status: WorkerAvailabilityStatus }) {
  const { tAvailability } = useLanguage();
  const styles: Record<WorkerAvailabilityStatus, string> = {
    available: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    assigned: 'bg-indigo-50 text-indigo-800 border-indigo-200',
    on_duty: 'bg-blue-50 text-blue-800 border-blue-200',
    busy: 'bg-amber-50 text-amber-900 border-amber-200',
    completed_shift: 'bg-slate-100 text-slate-700 border-slate-200',
    unavailable: 'bg-rose-50 text-rose-800 border-rose-200',
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium whitespace-nowrap ${
        styles[status] || styles.available
      }`}
    >
      {tAvailability(status)}
    </span>
  );
}

function WorkerTaskLifecycleBar({
  report,
  assignment,
  awaitingSup,
}: {
  report: CivicReport;
  assignment?: Assignment;
  awaitingSup: boolean;
}) {
  const { t } = useLanguage();
  const isResolved = report.status === 'resolved' || report.status === 'citizen_confirmed';
  const accepted = Boolean(report.acknowledgedAtIso || assignment?.acknowledgedAtIso);
  const inProgress =
    report.status === 'in_progress' || Boolean(report.workStartedAtIso) || isResolved;
  const completed = Boolean(
    report.completedAtIso || assignment?.completedAtIso || awaitingSup || isResolved
  );
  const verified = Boolean(report.supervisorVerifiedAtIso || isResolved);

  const steps = [
    { key: 'assigned', label: t('workforce.lifecycleAssigned'), done: true, active: report.status === 'assigned' && !accepted },
    { key: 'accepted', label: t('workforce.lifecycleAccepted'), done: accepted, active: report.status === 'assigned' && accepted },
    {
      key: 'in_progress',
      label: t('workforce.lifecycleInProgress'),
      done: inProgress && completed,
      active: report.status === 'in_progress' && !awaitingSup,
    },
    { key: 'completed', label: t('workforce.lifecycleCompleted'), done: completed, active: false },
    { key: 'sup_verify', label: t('workforce.lifecycleSupVerify'), done: verified, active: awaitingSup && !verified },
    { key: 'resolved', label: t('workforce.lifecycleResolved'), done: isResolved, active: isResolved },
  ];

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      {steps.map((step, idx) => (
        <React.Fragment key={step.key}>
          <span
            className={`px-2 py-0.5 rounded border whitespace-nowrap ${
              step.active
                ? 'bg-blue-700 text-white border-blue-700 font-medium'
                : step.done
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200 font-medium'
                  : 'bg-slate-50 text-slate-500 border-slate-200'
            }`}
          >
            {step.label}
          </span>
          {idx < steps.length - 1 && (
            <span className="text-slate-300" aria-hidden="true">
              →
            </span>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

export function WorkforceManagementView({
  profile,
  effectiveRole,
  reports,
  assignments,
  departments,
  staffUsers,
  workerInvites,
  slaPolicies,
  getIdToken,
  onSelectReport,
}: WorkforceManagementViewProps) {
  const { t, tCategory, tAvailability, tDepartmentName, tRole, tError } = useLanguage();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Admin / Department Officer register worker invite form
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'worker' | 'officer'>('worker');
  const [inviteDeptId, setInviteDeptId] = useState(
    effectiveRole === 'officer' && profile.departmentId
      ? profile.departmentId
      : departments[0]?.id || ''
  );
  const [inviteZone, setInviteZone] = useState('');
  const [inviteEmployeeId, setInviteEmployeeId] = useState('');
  const [inviteSupervisorId, setInviteSupervisorId] = useState(
    effectiveRole === 'officer' ? profile.uid : ''
  );
  const [inviteAvailability, setInviteAvailability] =
    useState<WorkerAvailabilityStatus>('available');
  const [inviting, setInviting] = useState(false);

  // Promote existing signed-in citizen to worker (Admin only)
  const [promoteUid, setPromoteUid] = useState('');
  const [promoteDeptId, setPromoteDeptId] = useState(departments[0]?.id || '');
  const [promoting, setPromoting] = useState(false);

  // Directory filters
  const [deptFilter, setDeptFilter] = useState<string>('all');
  const [availFilter, setAvailFilter] = useState<WorkerAvailabilityStatus | 'all'>('all');
  const [expandedWorkerUid, setExpandedWorkerUid] = useState<string | null>(null);
  const [updatingWorkerUid, setUpdatingWorkerUid] = useState<string | null>(null);

  // Worker inline edit drafts (for Admin & Department Supervisor edits)
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [zoneDrafts, setZoneDrafts] = useState<Record<string, string>>({});
  const [empIdDrafts, setEmpIdDrafts] = useState<Record<string, string>>({});
  const [supIdDrafts, setSupIdDrafts] = useState<Record<string, string>>({});

  // Worker self-service state
  const [selfAvailability, setSelfAvailability] = useState<WorkerAvailabilityStatus>(
    profile.availabilityStatus || 'available'
  );
  const [selfNote, setSelfNote] = useState(profile.availabilityNote || '');
  const [selfZone, setSelfZone] = useState(profile.workZone || '');
  const [savingSelf, setSavingSelf] = useState(false);
  const [ackingReportId, setAckingReportId] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (effectiveRole === 'officer' && profile.departmentId) {
      setInviteDeptId(profile.departmentId);
      setInviteRole('worker');
    } else if (!inviteDeptId && departments.length > 0) {
      setInviteDeptId(departments[0].id);
    }
    if (!promoteDeptId && departments.length > 0) setPromoteDeptId(departments[0].id);
  }, [departments, inviteDeptId, promoteDeptId, effectiveRole, profile.departmentId]);

  useEffect(() => {
    setSelfAvailability(profile.availabilityStatus || 'available');
    setSelfNote(profile.availabilityNote || '');
    setSelfZone(profile.workZone || '');
  }, [profile.availabilityStatus, profile.availabilityNote, profile.workZone]);

  const supervisorsList = useMemo(
    () => staffUsers.filter((u) => u.active && (u.role === 'officer' || u.role === 'admin')),
    [staffUsers]
  );

  const activeDepartments = departments.filter((d) => d.active);
  const deptOptions = activeDepartments.length > 0 ? activeDepartments : departments;

  const workloads = useMemo(
    () => computeWorkerWorkloads(staffUsers, reports, assignments),
    [staffUsers, reports, assignments]
  );

  const filteredWorkloads = useMemo(() => {
    return workloads.filter((w) => {
      if (deptFilter !== 'all' && w.worker.departmentId !== deptFilter) return false;
      if (availFilter !== 'all' && w.availability !== availFilter) return false;
      return true;
    });
  }, [workloads, deptFilter, availFilter]);

  const citizenCandidates = useMemo(
    () => staffUsers.filter((u) => u.active && u.role === 'citizen'),
    [staffUsers]
  );

  const latestAssignmentByReportId = useMemo(() => {
    const map = new Map<string, Assignment>();
    for (const a of assignments) {
      if (!map.has(a.reportId)) map.set(a.reportId, a);
    }
    return map;
  }, [assignments]);

  // ------------------------------------------------------------------
  // FIELD WORKER SELF-SERVICE VIEW
  // ------------------------------------------------------------------
  if (effectiveRole === 'worker') {
    const myTasks = reports.filter((r) =>
      profile.role === 'worker'
        ? r.assignedWorkerId === profile.uid
        : r.assignedWorkerId === profile.uid || r.status === 'assigned' || r.status === 'in_progress'
    );
    const activeTasks = myTasks.filter(
      (r) => r.status === 'assigned' || r.status === 'in_progress'
    );
    const completedTasks = myTasks.filter(
      (r) => r.status === 'resolved' || r.status === 'citizen_confirmed'
    );

    const handleSaveSelfStatus = async (e: React.FormEvent) => {
      e.preventDefault();
      setBanner(null);
      setSavingSelf(true);
      try {
        const token = await getIdToken();
        await updateWorkerAvailability({
          targetUid: profile.uid,
          availabilityStatus: selfAvailability,
          availabilityNote: selfNote,
          workZone: selfZone,
          idToken: token,
        });
        setBanner({
          type: 'success',
          text: t('workforce.availUpdatedMsg', { status: tAvailability(selfAvailability) }),
        });
      } catch (err) {
        setBanner({ type: 'error', text: tError(formatFriendlyError(err)) });
      } finally {
        setSavingSelf(false);
      }
    };

    const handleAcknowledge = async (report: CivicReport) => {
      setBanner(null);
      setAckingReportId(report.id);
      try {
        const token = await getIdToken();
        await workerAcknowledgeTask({
          report,
          actor: profile,
          idToken: token,
        });
        setBanner({
          type: 'success',
          text: t('workforce.taskAckedMsg', { code: report.trackingCode }),
        });
      } catch (err) {
        setBanner({ type: 'error', text: tError(formatFriendlyError(err)) });
      } finally {
        setAckingReportId(null);
      }
    };

    return (
      <div className="space-y-6">
        <div className="border-b border-slate-200 pb-4">
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            {t('workforce.workerHeading')}
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            {t('workforce.workerDesc')}
          </p>
        </div>

        <div className="p-3.5 rounded-xl bg-slate-100 border border-slate-200 text-xs text-slate-700 flex items-start gap-2.5">
          <Info className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" aria-hidden="true" />
          <p>
            <strong>{t('workforce.privacyTitle')}</strong> {t('workforce.privacyBody')}
          </p>
        </div>

        {banner && (
          <div
            role={banner.type === 'error' ? 'alert' : 'status'}
            className={`p-3.5 rounded-lg border text-sm flex items-center gap-2 ${
              banner.type === 'error'
                ? 'bg-rose-50 border-rose-200 text-rose-800'
                : 'bg-emerald-50 border-emerald-200 text-emerald-900'
            }`}
          >
            {banner.type === 'error' ? (
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
            )}
            <span>{banner.text}</span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <p className="text-xs text-slate-500">{t('workforce.activeAssignedTasks')}</p>
            <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-blue-700">
              {activeTasks.length}
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <p className="text-xs text-slate-500">{t('workforce.awaitingVerification')}</p>
            <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-amber-700">
              {
                activeTasks.filter((r) =>
                  isReportAwaitingSupervisorVerification(r, latestAssignmentByReportId.get(r.id))
                ).length
              }
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <p className="text-xs text-slate-500">{t('workforce.supervisorVerifiedClosed')}</p>
            <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-emerald-700">
              {completedTasks.length}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Self Availability Card */}
          <section className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-4 h-fit">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Wrench className="w-4 h-4 text-blue-700" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-slate-900">{t('workforce.myAvailabilityStatus')}</h2>
              </div>
              <AvailabilityBadge status={selfAvailability} />
            </div>

            <form onSubmit={handleSaveSelfStatus} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('workforce.dutyAvailability')}
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  {ALL_AVAILABILITY_STATUSES.map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => setSelfAvailability(st)}
                      className={`py-2 px-2 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap ${
                        selfAvailability === st
                          ? 'bg-blue-700 text-white border-blue-700'
                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      {tAvailability(st)}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('workforce.declaredWorkZone')}
                </label>
                <input
                  type="text"
                  value={selfZone}
                  onChange={(e) => setSelfZone(e.target.value)}
                  placeholder={t('workforce.workZonePlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('workforce.availabilityNoteOpt')}
                </label>
                <input
                  type="text"
                  value={selfNote}
                  onChange={(e) => setSelfNote(e.target.value)}
                  placeholder={t('workforce.availabilityNotePlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs"
                />
              </div>

              <button
                type="submit"
                disabled={savingSelf}
                className="w-full py-2 px-4 rounded-lg bg-blue-700 text-white text-xs font-medium hover:bg-blue-800 disabled:opacity-50"
              >
                {savingSelf ? t('workforce.savingStatus') : t('workforce.saveAvailabilityBtn')}
              </button>
            </form>
          </section>

          {/* My Assigned Tasks List */}
          <section className="lg:col-span-8 space-y-3">
            <h2 className="text-sm font-semibold text-slate-900">
              {t('workforce.assignedFieldTasks', { count: myTasks.length })}
            </h2>

            {myTasks.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-2">
                <Wrench className="w-8 h-8 text-slate-300 mx-auto" aria-hidden="true" />
                <p className="text-sm font-medium text-slate-900">{t('workforce.noTasksAssigned')}</p>
                <p className="text-xs text-slate-500">
                  {t('workforce.noTasksAssignedDesc')}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {myTasks.map((r) => {
                  const asg = latestAssignmentByReportId.get(r.id);
                  const dl = evaluateReportDeadlines(r, asg, slaPolicies, nowMs);
                  const awaitingSup = isReportAwaitingSupervisorVerification(r, asg);
                  return (
                    <div
                      key={r.id}
                      className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            <span className="font-mono tabular-nums font-semibold text-slate-800">
                              {r.trackingCode}
                            </span>
                            <span>·</span>
                            <span>{tCategory(r.category)}</span>
                            {r.departmentName && (
                              <>
                                <span>·</span>
                                <span className="text-slate-700 font-medium">
                                  {tDepartmentName(r.departmentId, r.departmentName)}
                                </span>
                              </>
                            )}
                          </div>
                          <h3 className="text-base font-semibold text-slate-900">{r.title}</h3>
                          <p className="text-xs text-slate-600 flex items-center gap-1">
                            <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
                            <span>{r.addressText}</span>
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                          <PriorityIndicator priority={r.priority} />
                          <StatusIndicator status={r.status} />
                        </div>
                      </div>

                      <WorkerTaskLifecycleBar report={r} assignment={asg} awaitingSup={awaitingSup} />

                      {(asg?.instructions || r.deadlineIso || r.supervisorName) && (
                        <div className="p-2.5 rounded-lg bg-blue-50/70 border border-blue-200 text-xs text-blue-950 space-y-1">
                          {asg?.instructions && (
                            <p>
                              <span className="font-semibold">{t('workforce.instructions')} </span>
                              <span>{asg.instructions}</span>
                            </p>
                          )}
                          {(r.deadlineIso || r.supervisorName) && (
                            <p className="text-[11px] text-blue-900 font-mono tabular-nums">
                              {r.deadlineIso ? t('workforce.dueLabel', { time: formatTimestamp(r.deadlineIso) }) : ''}
                              {r.deadlineIso && r.supervisorName ? ' · ' : ''}
                              {r.supervisorName ? t('workforce.supervisorLabel', { name: r.supervisorName }) : ''}
                            </p>
                          )}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border font-mono tabular-nums text-[11px] ${
                              dl.isOverdue
                                ? 'bg-rose-50 text-rose-800 border-rose-200 font-semibold'
                                : dl.isApproaching
                                  ? 'bg-amber-50 text-amber-900 border-amber-200'
                                  : 'bg-emerald-50 text-emerald-800 border-emerald-200'
                            }`}
                          >
                            <Clock className="w-3 h-3" aria-hidden="true" />
                            {dl.activeRemainingLabel} {t('workforce.targetSuffix')}
                          </span>

                          {r.acknowledgedAtIso ? (
                            <span className="text-[11px] text-emerald-800 font-medium">
                              {t('workforce.acknowledgedAt', { time: formatTimestamp(r.acknowledgedAtIso) })}
                            </span>
                          ) : (
                            <span className="text-[11px] text-amber-800 font-medium">
                              {t('workforce.awaitingAck')}
                            </span>
                          )}

                          {awaitingSup && (
                            <span className="px-2 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-900 text-[11px] font-medium">
                              {t('workforce.awaitingSupVerify')}
                            </span>
                          )}
                          {r.hasActiveObstacle && (
                            <span className="px-2 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-900 text-[11px] font-medium">
                              {t('workforce.obstacleReported')}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          {!r.acknowledgedAtIso &&
                            (r.status === 'assigned' || r.status === 'in_progress') && (
                              <button
                                type="button"
                                disabled={ackingReportId === r.id}
                                onClick={() => handleAcknowledge(r)}
                                className="px-3 py-1.5 rounded-lg border border-blue-300 bg-blue-50 text-blue-900 text-xs font-medium hover:bg-blue-100 disabled:opacity-50"
                              >
                                {ackingReportId === r.id ? t('workforce.acknowledging') : t('workforce.acknowledgeTask')}
                              </button>
                            )}
                          <button
                            type="button"
                            onClick={() => onSelectReport(r.id)}
                            className="px-3 py-1.5 rounded-lg bg-blue-700 text-white text-xs font-medium hover:bg-blue-800"
                          >
                            {t('workforce.openFieldTask')}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // ADMIN & OFFICER WORKFORCE CONSOLE
  // ------------------------------------------------------------------
  const handleRegisterInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanner(null);
    setInviting(true);
    try {
      const token = await getIdToken();
      const supObj = supervisorsList.find((u) => u.uid === inviteSupervisorId);
      const effectiveDeptId =
        effectiveRole === 'officer' && profile.departmentId
          ? profile.departmentId
          : inviteDeptId;
      const effectiveRoleToGrant = effectiveRole === 'officer' ? 'worker' : inviteRole;
      const created = await adminRegisterWorkerInvite({
        email: inviteEmail.trim(),
        displayName: inviteName.trim(),
        role: effectiveRoleToGrant,
        departmentId: effectiveDeptId,
        workZone: inviteZone.trim(),
        employeeId: inviteEmployeeId.trim(),
        supervisorId: supObj?.uid || '',
        supervisorName: supObj?.displayName || '',
        availabilityStatus: inviteAvailability,
        idToken: token,
      });
      setInviteName('');
      setInviteEmail('');
      setInviteZone('');
      setInviteEmployeeId('');
      setBanner({
        type: 'success',
        text: t('workforce.inviteSuccess', {
          name: created.displayName,
          email: created.email,
          role: tRole(created.role),
          dept: tDepartmentName(created.departmentId, created.departmentName),
        }),
      });
    } catch (err) {
      setBanner({ type: 'error', text: tError(formatFriendlyError(err)) });
    } finally {
      setInviting(false);
    }
  };

  const handlePromoteExisting = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = citizenCandidates.find((u) => u.uid === promoteUid);
    if (!target) return;
    setBanner(null);
    setPromoting(true);
    try {
      const token = await getIdToken();
      await adminUpdateUserRole({
        targetUser: target,
        role: 'worker',
        departmentId: promoteDeptId,
        active: true,
        idToken: token,
      });
      setPromoteUid('');
      setBanner({
        type: 'success',
        text: t('workforce.assignedAsWorkerSuccess', { name: target.displayName }),
      });
    } catch (err) {
      setBanner({ type: 'error', text: tError(formatFriendlyError(err)) });
    } finally {
      setPromoting(false);
    }
  };

  const handleAdminUpdateWorker = async (
    worker: UserProfile,
    patch: {
      availabilityStatus?: WorkerAvailabilityStatus;
      availabilityNote?: string;
      workZone?: string;
      employeeId?: string;
      supervisorId?: string;
      supervisorName?: string;
      departmentId?: string;
    }
  ) => {
    setBanner(null);
    setUpdatingWorkerUid(worker.uid);
    try {
      const token = await getIdToken();
      await updateWorkerAvailability({
        targetUid: worker.uid,
        ...patch,
        idToken: token,
      });
      setBanner({
        type: 'success',
        text: t('workforce.updatedWorkerSuccess', { name: worker.displayName }),
      });
    } catch (err) {
      setBanner({ type: 'error', text: tError(formatFriendlyError(err)) });
    } finally {
      setUpdatingWorkerUid(null);
    }
  };

  const canManageWorkforce =
    effectiveRole === 'admin' || (effectiveRole === 'officer' && Boolean(profile.departmentId));
  const availableCount = workloads.filter((w) => w.availability === 'available').length;
  const activeFieldDutyCount = workloads.filter(
    (w) => w.availability === 'assigned' || w.availability === 'on_duty'
  ).length;
  const busyCount = workloads.filter((w) => w.availability === 'busy').length;
  const offShiftCount = workloads.filter(
    (w) => w.availability === 'completed_shift' || w.availability === 'unavailable'
  ).length;
  const totalActiveAssignments = workloads.reduce((acc, w) => acc + w.activeTasks, 0);

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-200 pb-4">
        <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
          {t('workforce.consoleHeading')}
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          {t('workforce.consoleDesc')}
        </p>
      </div>

      {banner && (
        <div
          role={banner.type === 'error' ? 'alert' : 'status'}
          className={`p-3.5 rounded-lg border text-sm flex items-center gap-2 ${
            banner.type === 'error'
              ? 'bg-rose-50 border-rose-200 text-rose-800'
              : 'bg-emerald-50 border-emerald-200 text-emerald-900'
          }`}
        >
          {banner.type === 'error' ? (
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          )}
          <span>{banner.text}</span>
        </div>
      )}

      {/* KPI Row */}
      <section className="grid grid-cols-2 sm:grid-cols-6 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs text-slate-500">{t('workforce.kpiRegistered')}</p>
          <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-slate-900">
            {workloads.length}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs text-slate-500">{t('workforce.kpiAvailable')}</p>
          <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-emerald-700">
            {availableCount}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs text-slate-500">{t('workforce.kpiAssignedOnDuty')}</p>
          <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-indigo-700">
            {activeFieldDutyCount}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs text-slate-500">{t('workforce.kpiBusy')}</p>
          <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-amber-700">
            {busyCount}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs text-slate-500">{t('workforce.kpiOffShift')}</p>
          <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-rose-700">
            {offShiftCount}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs text-slate-500">{t('workforce.kpiActiveDispatched')}</p>
          <p className="mt-1 text-2xl font-semibold font-mono tabular-nums text-blue-700">
            {totalActiveAssignments}
          </p>
        </div>
      </section>

      {/* Admin & Department Supervisor Worker Registration & Pre-Authorization */}
      {canManageWorkforce && (
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <form
            onSubmit={handleRegisterInvite}
            className={`${
              effectiveRole === 'admin' ? 'lg:col-span-7' : 'lg:col-span-12'
            } bg-white border border-slate-200 rounded-xl p-5 space-y-4`}
          >
            <div className="flex items-center gap-2">
              <UserPlus className="w-4 h-4 text-blue-700" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-slate-900">
                {t('workforce.registerInviteTitle')}
              </h2>
            </div>
            <p className="text-xs text-slate-600">
              {effectiveRole === 'officer'
                ? t('workforce.registerInviteOfficerDesc', {
                    dept: profile.departmentName
                      ? tDepartmentName(profile.departmentId, profile.departmentName)
                      : t('workforce.yourDepartment'),
                  })
                : t('workforce.registerInviteAdminDesc')}
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('landing.fullName')}
                </label>
                <input
                  type="text"
                  required
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  placeholder="e.g., Arjun Nair"
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('workforce.accountEmail')}
                </label>
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="worker@municipality.gov"
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('workforce.employeeBadgeOpt')}
                </label>
                <input
                  type="text"
                  value={inviteEmployeeId}
                  onChange={(e) => setInviteEmployeeId(e.target.value)}
                  placeholder="e.g., EMP-1042"
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('workforce.authorizedRole')}
                </label>
                <select
                  disabled={effectiveRole === 'officer'}
                  value={effectiveRole === 'officer' ? 'worker' : inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as 'worker' | 'officer')}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white disabled:bg-slate-50"
                >
                  <option value="worker">{tRole('worker')}</option>
                  {effectiveRole === 'admin' && <option value="officer">{tRole('officer')}</option>}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('workforce.deptAssignment')}
                </label>
                <select
                  disabled={effectiveRole === 'officer'}
                  value={
                    effectiveRole === 'officer' && profile.departmentId
                      ? profile.departmentId
                      : inviteDeptId
                  }
                  onChange={(e) => setInviteDeptId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white disabled:bg-slate-50"
                >
                  {deptOptions.map((d) => (
                    <option key={d.id} value={d.id}>
                      {tDepartmentName(d.id, d.name)} ({d.code})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('workforce.reportingSupervisorOpt')}
                </label>
                <select
                  value={inviteSupervisorId}
                  onChange={(e) => setInviteSupervisorId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                >
                  <option value="">{t('workforce.deptSupervisorPool')}</option>
                  {supervisorsList.map((s) => (
                    <option key={s.uid} value={s.uid}>
                      {s.displayName} ({tRole(s.role)}
                      {s.departmentName ? ` · ${tDepartmentName(s.departmentId, s.departmentName)}` : ''})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('workforce.assignedWorkZoneOpt')}
                </label>
                <input
                  type="text"
                  value={inviteZone}
                  onChange={(e) => setInviteZone(e.target.value)}
                  placeholder={t('workforce.workZonePlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t('workforce.initialAvailability')}
                </label>
                <select
                  value={inviteAvailability}
                  onChange={(e) =>
                    setInviteAvailability(e.target.value as WorkerAvailabilityStatus)
                  }
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                >
                  {ALL_AVAILABILITY_STATUSES.map((st) => (
                    <option key={st} value={st}>
                      {tAvailability(st)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <button
              type="submit"
              disabled={inviting || !(effectiveRole === 'officer' ? profile.departmentId : inviteDeptId)}
              className="px-4 py-2 rounded-lg bg-blue-700 text-white text-xs font-medium hover:bg-blue-800 disabled:opacity-50"
            >
              {inviting ? t('workforce.registeringAuth') : t('workforce.authorizeSaveInvite')}
            </button>
          </form>

          {effectiveRole === 'admin' && (
            <div className="lg:col-span-5 space-y-4">
              {/* Promote existing signed-in user */}
              <form
                onSubmit={handlePromoteExisting}
                className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
              >
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-blue-700" aria-hidden="true" />
                  <h2 className="text-sm font-semibold text-slate-900">
                    {t('workforce.assignExistingTitle')}
                  </h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <select
                    aria-label={t('workforce.selectCitizenPlaceholder')}
                    value={promoteUid}
                    onChange={(e) => setPromoteUid(e.target.value)}
                    className="px-3 py-2 rounded-lg border border-slate-300 text-xs bg-white"
                  >
                    <option value="">{t('workforce.selectCitizenPlaceholder')}</option>
                    {citizenCandidates.map((u) => (
                      <option key={u.uid} value={u.uid}>
                        {u.displayName}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={t('workforce.deptAssignment')}
                    value={promoteDeptId}
                    onChange={(e) => setPromoteDeptId(e.target.value)}
                    className="px-3 py-2 rounded-lg border border-slate-300 text-xs bg-white"
                  >
                    {deptOptions.map((d) => (
                      <option key={d.id} value={d.id}>
                        {tDepartmentName(d.id, d.name)}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="submit"
                  disabled={promoting || !promoteUid || !promoteDeptId}
                  className="w-full py-2 px-3 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                >
                  {promoting ? t('workforce.assigningRole') : t('workforce.assignWorkerRole')}
                </button>
              </form>

              {/* Pending / Claimed Worker Invites */}
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2.5">
                <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
                  {t('workforce.authorizedInvites', { count: workerInvites.length })}
                </h3>
                {workerInvites.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    {t('workforce.noInvitesYet')}
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-200 border border-slate-200 rounded-lg max-h-48 overflow-y-auto">
                    {workerInvites.map((inv) => (
                      <li key={inv.id} className="p-2.5 text-xs flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium text-slate-900 truncate">
                            {inv.displayName} ({tRole(inv.role)})
                          </p>
                          <p className="text-[11px] text-slate-500 truncate">
                            {inv.email} · {tDepartmentName(inv.departmentId, inv.departmentName)}
                          </p>
                        </div>
                        <span
                          className={`px-2 py-0.5 rounded text-[11px] font-medium shrink-0 border ${
                            inv.claimed
                              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                              : 'bg-amber-50 text-amber-900 border-amber-200'
                          }`}
                        >
                          {inv.claimed ? t('workforce.claimed') : t('workforce.pendingSignIn')}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Workforce Directory */}
      <section className="space-y-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-blue-700" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-900">
              {t('workforce.activeFieldWorkers', { count: filteredWorkloads.length })}
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t('common.allDepartments')}
              value={deptFilter}
              onChange={(e) => setDeptFilter(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
            >
              <option value="all">{t('common.allDepartments')}</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {tDepartmentName(d.id, d.name)}
                </option>
              ))}
            </select>

            <select
              aria-label={t('workforce.allAvailability')}
              value={availFilter}
              onChange={(e) =>
                setAvailFilter(e.target.value as WorkerAvailabilityStatus | 'all')
              }
              className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
            >
              <option value="all">{t('workforce.allAvailability')}</option>
              {ALL_AVAILABILITY_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {tAvailability(st)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {filteredWorkloads.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-2">
            <Users className="w-8 h-8 text-slate-300 mx-auto" aria-hidden="true" />
            <p className="text-sm font-medium text-slate-900">{t('workforce.noMatchingWorkers')}</p>
            <p className="text-xs text-slate-500">
              {effectiveRole === 'admin'
                ? t('workforce.noWorkersAdminHint')
                : t('workforce.noWorkersOfficerHint')}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredWorkloads.map((summary) => {
              const {
                worker,
                availability,
                activeTasks,
                inProgressTasks,
                awaitingVerificationTasks,
                completedTasks,
                obstacleTasks,
                maxActiveTasks,
                assignedReports,
              } = summary;
              const isExpanded = expandedWorkerUid === worker.uid;
              const openAssignments = assignedReports.filter(
                (r) => r.status === 'assigned' || r.status === 'in_progress'
              );
              const noteVal = noteDrafts[worker.uid] ?? worker.availabilityNote ?? '';
              const zoneVal = zoneDrafts[worker.uid] ?? worker.workZone ?? '';
              const empIdVal = empIdDrafts[worker.uid] ?? worker.employeeId ?? '';
              const supIdVal = supIdDrafts[worker.uid] ?? worker.supervisorId ?? '';
              const canEditThisWorker =
                effectiveRole === 'admin' ||
                (effectiveRole === 'officer' &&
                  Boolean(profile.departmentId) &&
                  worker.departmentId === profile.departmentId &&
                  worker.role === 'worker');

              return (
                <div
                  key={worker.uid}
                  className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold text-slate-900">
                          {worker.displayName}
                        </h3>
                        {worker.employeeId && (
                          <span className="font-mono text-xs text-slate-500">
                            {worker.employeeId}
                          </span>
                        )}
                        <AvailabilityBadge status={availability} />
                        {obstacleTasks > 0 && (
                          <span className="px-2 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-900 text-[11px] font-medium">
                            {t('workforce.obstaclesCount', { count: obstacleTasks })}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-600">
                        {t('common.department')}:{' '}
                        <strong className="text-slate-900">
                          {worker.departmentName
                            ? tDepartmentName(worker.departmentId, worker.departmentName)
                            : t('common.unassigned')}
                        </strong>{' '}
                        · {t('workforce.workZone')}:{' '}
                        <strong className="text-slate-900">
                          {worker.workZone || t('workforce.citywideFlexible')}
                        </strong>
                        {worker.supervisorName ? (
                          <>
                            {' · '}
                            {t('workforce.supervisor')}:{' '}
                            <strong className="text-slate-900">{worker.supervisorName}</strong>
                          </>
                        ) : null}
                      </p>
                      {worker.availabilityNote && (
                        <p className="text-xs text-slate-500">
                          {t('workforce.notePrefix')} {worker.availabilityNote}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-4 text-xs font-mono tabular-nums shrink-0">
                      <div className="text-right">
                        <p className="text-slate-500 text-[11px]">{t('workforce.activeLoad')}</p>
                        <p className="text-sm font-semibold text-slate-900">
                          {activeTasks} / {maxActiveTasks}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-slate-500 text-[11px]">{t('ops.kpiInProgress')}</p>
                        <p className="text-sm font-semibold text-blue-700">{inProgressTasks}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-slate-500 text-[11px]">{t('workforce.awaitingVerifyShort')}</p>
                        <p className="text-sm font-semibold text-amber-700">
                          {awaitingVerificationTasks}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-slate-500 text-[11px]">{t('workforce.completedTasks')}</p>
                        <p className="text-sm font-semibold text-emerald-700">{completedTasks}</p>
                      </div>
                    </div>
                  </div>

                  {/* Admin & Department Supervisor operational profile & availability controls */}
                  {canEditThisWorker && (
                    <div className="pt-3 border-t border-slate-100 grid grid-cols-1 md:grid-cols-12 gap-2.5 items-end">
                      <div className="md:col-span-2">
                        <label className="block text-[11px] font-medium text-slate-600 mb-1">
                          {t('workforce.availability')}
                        </label>
                        <select
                          disabled={updatingWorkerUid === worker.uid}
                          value={availability}
                          onChange={(e) =>
                            handleAdminUpdateWorker(worker, {
                              availabilityStatus: e.target.value as WorkerAvailabilityStatus,
                            })
                          }
                          className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                        >
                          {ALL_AVAILABILITY_STATUSES.map((st) => (
                            <option key={st} value={st}>
                              {tAvailability(st)}
                            </option>
                          ))}
                        </select>
                      </div>

                      {effectiveRole === 'admin' && (
                        <div className="md:col-span-2">
                          <label className="block text-[11px] font-medium text-slate-600 mb-1">
                            {t('common.department')}
                          </label>
                          <select
                            disabled={updatingWorkerUid === worker.uid}
                            value={worker.departmentId}
                            onChange={(e) =>
                              handleAdminUpdateWorker(worker, {
                                departmentId: e.target.value,
                              })
                            }
                            className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                          >
                            <option value="">{t('common.unassigned')}</option>
                            {deptOptions.map((d) => (
                              <option key={d.id} value={d.id}>
                                {tDepartmentName(d.id, d.name)}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      <div className={effectiveRole === 'admin' ? 'md:col-span-2' : 'md:col-span-3'}>
                        <label className="block text-[11px] font-medium text-slate-600 mb-1">
                          {t('workforce.supervisor')}
                        </label>
                        <select
                          value={supIdVal}
                          onChange={(e) =>
                            setSupIdDrafts((prev) => ({ ...prev, [worker.uid]: e.target.value }))
                          }
                          className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                        >
                          <option value="">{t('workforce.nonePool')}</option>
                          {supervisorsList.map((s) => (
                            <option key={s.uid} value={s.uid}>
                              {s.displayName}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="md:col-span-2">
                        <label className="block text-[11px] font-medium text-slate-600 mb-1">
                          {t('workforce.employeeId')}
                        </label>
                        <input
                          type="text"
                          value={empIdVal}
                          onChange={(e) =>
                            setEmpIdDrafts((prev) => ({ ...prev, [worker.uid]: e.target.value }))
                          }
                          placeholder="EMP-..."
                          className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-mono"
                        />
                      </div>

                      <div className="md:col-span-2">
                        <label className="block text-[11px] font-medium text-slate-600 mb-1">
                          {t('workforce.workZone')}
                        </label>
                        <input
                          type="text"
                          value={zoneVal}
                          onChange={(e) =>
                            setZoneDrafts((prev) => ({ ...prev, [worker.uid]: e.target.value }))
                          }
                          placeholder={t('workforce.wardZonePlaceholder')}
                          className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs"
                        />
                      </div>

                      <div className={effectiveRole === 'admin' ? 'md:col-span-1' : 'md:col-span-2'}>
                        <label className="block text-[11px] font-medium text-slate-600 mb-1">
                          {t('common.notes')}
                        </label>
                        <input
                          type="text"
                          value={noteVal}
                          onChange={(e) =>
                            setNoteDrafts((prev) => ({ ...prev, [worker.uid]: e.target.value }))
                          }
                          placeholder={t('workforce.shiftNotePlaceholder')}
                          className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs"
                        />
                      </div>

                      <div className="md:col-span-1">
                        <button
                          type="button"
                          disabled={updatingWorkerUid === worker.uid}
                          onClick={() => {
                            const supObj = supervisorsList.find((s) => s.uid === supIdVal);
                            handleAdminUpdateWorker(worker, {
                              workZone: zoneVal,
                              availabilityNote: noteVal,
                              employeeId: empIdVal,
                              supervisorId: supIdVal,
                              supervisorName: supObj?.displayName || '',
                            });
                          }}
                          className="w-full py-1.5 px-2.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {t('common.save')}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Expandable Current Task Assignments */}
                  <div className="pt-2 border-t border-slate-100">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedWorkerUid(isExpanded ? null : worker.uid)
                      }
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:text-blue-900"
                    >
                      {isExpanded ? (
                        <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                      )}
                      <span>
                        {t('workforce.currentAssignmentsLabel', {
                          action: isExpanded ? t('workforce.hideAssignments') : t('workforce.viewAssignments'),
                          open: openAssignments.length,
                          total: assignedReports.length,
                        })}
                      </span>
                    </button>

                    {isExpanded && (
                      <div className="mt-3 border border-slate-200 rounded-lg divide-y divide-slate-200 bg-slate-50">
                        {assignedReports.length === 0 ? (
                          <p className="p-3 text-xs text-slate-500">
                            {t('workforce.noAssignedToWorker', { name: worker.displayName })}
                          </p>
                        ) : (
                          assignedReports.map((r) => {
                            const dl = evaluateReportDeadlines(
                              r,
                              latestAssignmentByReportId.get(r.id),
                              slaPolicies,
                              nowMs
                            );
                            return (
                              <button
                                key={r.id}
                                type="button"
                                onClick={() => onSelectReport(r.id)}
                                className="w-full p-3 text-left hover:bg-white transition-colors flex flex-wrap items-center justify-between gap-2"
                              >
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 text-xs">
                                    <span className="font-mono tabular-nums font-semibold text-slate-800">
                                      {r.trackingCode}
                                    </span>
                                    <span className="font-medium text-slate-900 truncate">
                                      {r.title}
                                    </span>
                                  </div>
                                  <p className="text-[11px] text-slate-500 truncate">
                                    {r.addressText} · {tCategory(r.category)}
                                  </p>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <span
                                    className={`text-[11px] font-mono tabular-nums ${
                                      dl.isOverdue
                                        ? 'text-rose-700 font-semibold'
                                        : dl.isApproaching
                                          ? 'text-amber-800'
                                          : 'text-slate-600'
                                    }`}
                                  >
                                    {dl.activeRemainingLabel}
                                  </span>
                                  <PriorityIndicator priority={r.priority} />
                                  <StatusIndicator status={r.status} />
                                </div>
                              </button>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
