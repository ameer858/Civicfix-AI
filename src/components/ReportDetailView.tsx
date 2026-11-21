import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  CheckCircle2,
  Clock,
  CopyCheck,
  FileText,
  HelpCircle,
  Info,
  Loader2,
  MapPin,
  MessageSquare,
  Navigation,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Star,
  User,
  UserCheck,
  Wrench,
  XCircle,
} from 'lucide-react';
import {
  adminRequestMoreInformation,
  adminTransitionToUnderReview,
  adminVerifyAndAssignDepartment,
  adminVerifyReport,
  analyzeImageViaServer,
  attachAiAnalysisToReport,
  citizenConfirmOrReopenReport,
  citizenProvideAdditionalInfo,
  detectDuplicatesViaServer,
  escalateOverdueReport,
  fetchCitizenContactForAdmin,
  fetchReportDetailViaApi,
  fetchServerEmailTransportStatus,
  formatFriendlyError,
  officerAssignWorker,
  retryAuthorityEmailViaServer,
  staffRejectReport,
  staffReviewResolutionEvidence,
  submitCitizenFeedback,
  subscribeToCivicRealtime,
  toTimestampMs,
  uploadValidatedImage,
  workerAcknowledgeTask,
  workerRequestSupervisorAssistance,
  workerSubmitFieldUpdate,
  workerUpdateLocationSharing,
  type UploadProgressInfo,
} from '../lib/civicService';
import { GmailConfirmModal } from './GmailConfirmModal';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { StatusIndicator, PriorityIndicator } from './StatusBadge';
import { ActivityTimeline, WorkflowStepper, formatTimestamp } from './WorkflowTimeline';
import { computePriorityRecommendation } from '../lib/intelligenceEngine';
import {
  evaluateReportDeadlines,
  isReportAwaitingSupervisorVerification,
  recommendWorkersForReport,
} from '../lib/operationsEngine';
import {
  CATEGORY_LABELS,
  type AiAnalysis,
  type Assignment,
  type AuditLog,
  type CitizenFeedback,
  type CivicReport,
  type Department,
  type DuplicateCandidate,
  type IssueCategory,
  type IssuePriority,
  type ReportUpdate,
  type SlaPolicy,
  type UploadedImageMetadata,
  type UserPrivateContact,
  type UserProfile,
} from '../types/civic';

interface ReportDetailViewProps {
  report: CivicReport;
  allReports?: CivicReport[];
  assignments?: Assignment[];
  slaPolicies?: SlaPolicy[];
  departments: Department[];
  staffUsers: UserProfile[];
  onBack: () => void;
  onSelectReport?: (reportId: string) => void;
}

function MetadataOnlyCard({ meta }: { meta: UploadedImageMetadata }) {
  const { t } = useLanguage();
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs space-y-1">
      <div className="flex items-center gap-1.5 text-slate-700 font-medium">
        <Camera className="w-3.5 h-3.5 text-slate-500 shrink-0" aria-hidden="true" />
        <span className="truncate" title={meta.fileName}>
          {meta.fileName}
        </span>
      </div>
      <p className="font-mono tabular-nums text-[11px] text-slate-500">
        {meta.mimeType.replace('image/', '').toUpperCase()} ·{' '}
        {meta.sizeBytes >= 1024 * 1024
          ? `${(meta.sizeBytes / (1024 * 1024)).toFixed(2)} MB`
          : `${Math.max(1, Math.round(meta.sizeBytes / 1024))} KB`}
      </p>
      <p className="text-[11px] text-slate-500">
        {t('detail.tempValidatedMeta')}
      </p>
    </div>
  );
}

function SafeImageThumb({
  url,
  alt,
  meta,
}: {
  url: string;
  alt: string;
  meta?: UploadedImageMetadata;
}) {
  const { t } = useLanguage();
  const [failed, setFailed] = useState(false);

  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden bg-white">
      {failed ? (
        <div className="aspect-[4/3] bg-slate-100 flex flex-col items-center justify-center p-3 text-center">
          <Camera className="w-5 h-5 text-slate-400 mb-1" aria-hidden="true" />
          <span className="text-[11px] text-slate-500">{t('detail.imageUnavailable')}</span>
        </div>
      ) : (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="block aspect-[4/3] bg-slate-100 hover:opacity-95"
        >
          <img
            src={url}
            alt={alt}
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            className="w-full h-full object-cover"
          />
        </a>
      )}
      {meta && (
        <div className="px-2.5 py-2 border-t border-slate-200 text-[11px] space-y-0.5">
          <p className="font-medium text-slate-900 truncate" title={meta.fileName}>
            {meta.fileName}
          </p>
          <p className="font-mono tabular-nums text-slate-500">
            {meta.mimeType.replace('image/', '').toUpperCase()} ·{' '}
            {meta.sizeBytes >= 1024 * 1024
              ? `${(meta.sizeBytes / (1024 * 1024)).toFixed(2)} MB`
              : `${Math.max(1, Math.round(meta.sizeBytes / 1024))} KB`}{' '}
            · {t('detail.serverValidated')}
          </p>
        </div>
      )}
    </div>
  );
}

export function ReportDetailView({
  report: initialReport,
  allReports,
  assignments = [],
  slaPolicies = [],
  departments,
  staffUsers,
  onBack,
  onSelectReport,
}: ReportDetailViewProps) {
  const {
    user,
    profile,
    effectiveRole,
    gmailConnected,
    connectingGmail,
    connectGmail,
    getGmailAccessToken,
    invalidateGmailToken,
    getIdToken,
  } = useAuth();
  const {
    t,
    tStatus,
    tPriority,
    tCategory,
    tRole,
    tAvailability,
    tDepartmentName,
    tError,
  } = useLanguage();

  const [report, setReport] = useState<CivicReport>(initialReport);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [updates, setUpdates] = useState<ReportUpdate[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [aiAnalysis, setAiAnalysis] = useState<AiAnalysis | null>(null);
  const [feedbacks, setFeedbacks] = useState<CitizenFeedback[]>([]);
  const [latestAssignment, setLatestAssignment] = useState<Assignment | null>(null);
  const [citizenContact, setCitizenContact] = useState<UserPrivateContact | null>(null);

  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const activeDepartments = departments.filter((d) => d.active);
  const selectableDepartments = activeDepartments.length > 0 ? activeDepartments : departments;

  // Admin verification & department dispatch state
  const [selectedDeptId, setSelectedDeptId] = useState(
    initialReport.departmentId || selectableDepartments[0]?.id || ''
  );
  const [selectedOfficerId, setSelectedOfficerId] = useState('');
  const [categoryOverride, setCategoryOverride] = useState<IssueCategory>(initialReport.category);
  const [priorityOverride, setPriorityOverride] = useState<IssuePriority>(initialReport.priority);
  const [deptInstructions, setDeptInstructions] = useState('');
  const [infoRequestReason, setInfoRequestReason] = useState('');

  // Officer assign / reassign worker state (with priority, custom deadline, supervisor & recommendation metadata)
  const [selectedWorkerId, setSelectedWorkerId] = useState(initialReport.assignedWorkerId || '');
  const [dispatchPriorityOverride, setDispatchPriorityOverride] = useState<IssuePriority>(
    initialReport.priority
  );
  const [dispatchDeadlineInput, setDispatchDeadlineInput] = useState(
    initialReport.deadlineIso ? initialReport.deadlineIso.slice(0, 16) : ''
  );
  const [dispatchSupervisorId, setDispatchSupervisorId] = useState(initialReport.supervisorId || '');
  const [reassignmentReasonInput, setReassignmentReasonInput] = useState('');
  const [workerInstructions, setWorkerInstructions] = useState('');
  const [selectedRecMeta, setSelectedRecMeta] = useState<{
    workerId: string;
    score: number;
    reason: string;
  } | null>(null);

  // Escalation controls
  const [escalationSupervisorId, setEscalationSupervisorId] = useState('');
  const [escalationReasonInput, setEscalationReasonInput] = useState('');

  // Worker field execution, delay explanation, assistance request & completion state
  const [workNote, setWorkNote] = useState('');
  const [materialsUsedInput, setMaterialsUsedInput] = useState(initialReport.materialsUsed || '');
  const [obstacleInput, setObstacleInput] = useState(initialReport.obstaclesEncountered || '');
  const [delayExplanationInput, setDelayExplanationInput] = useState(
    initialReport.delayExplanation || ''
  );
  const [assistanceNoteInput, setAssistanceNoteInput] = useState('');
  const [workStartedAtInput, setWorkStartedAtInput] = useState(
    initialReport.workStartedAtIso ? initialReport.workStartedAtIso.slice(0, 16) : ''
  );
  const [includeSiteCheckIn, setIncludeSiteCheckIn] = useState(false);
  const [siteCheckInLabel, setSiteCheckInLabel] = useState(initialReport.addressText || '');
  const [newResolutionPhotos, setNewResolutionPhotos] = useState<
    Array<UploadedImageMetadata & { previewUrl?: string }>
  >([]);
  const [uploadingEvidence, setUploadingEvidence] = useState(false);
  const [evidenceProgress, setEvidenceProgress] = useState<UploadProgressInfo | null>(null);

  // Voluntary opt-in browser geolocation sharing state (stored ONLY on assignments while active)
  const [locationSharingActive, setLocationSharingActive] = useState(false);
  const [locationSharingBusy, setLocationSharingBusy] = useState(false);
  const [locationSharingError, setLocationSharingError] = useState<string | null>(null);
  const [locationCoords, setLocationCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locationUpdatedAtIso, setLocationUpdatedAtIso] = useState<string | null>(null);
  const geoWatchIdRef = useRef<number | null>(null);
  const activeLocationAssignmentIdRef = useRef<string | null>(null);
  const lastLocationPushMsRef = useRef<number>(0);

  // Rejection / Clarification / Confirmation / Reopen / Feedback state
  const [rejectReason, setRejectReason] = useState('');
  const [citizenClarification, setCitizenClarification] = useState('');
  const [evidenceReviewNote, setEvidenceReviewNote] = useState('');
  const [confirmNoteInput, setConfirmNoteInput] = useState('');
  const [reopenReasonInput, setReopenReasonInput] = useState('');
  const [citizenRating, setCitizenRating] = useState(5);
  const [citizenComment, setCitizenComment] = useState('');

  // Staff duplicate check & AI re-run
  const [dupLoading, setDupLoading] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);
  const [advisoryResult, setAdvisoryResult] = useState<AiAnalysis | null>(null);
  const [aiRunning, setAiRunning] = useState(false);
  const [retryingEmail, setRetryingEmail] = useState(false);
  const [showGmailRetryModal, setShowGmailRetryModal] = useState(false);
  const [gmailRetryError, setGmailRetryError] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  // Live load & subscribe to report, updates, audit logs, assignments, AI analysis, and feedback via Supabase
  useEffect(() => {
    let active = true;

    const loadDetail = async () => {
      try {
        const token = await getIdToken().catch(() => null);
        if (!active) return;
        const bundle = await fetchReportDetailViaApi(initialReport.id, token || undefined);
        if (!active || !bundle) return;

        const data = bundle.report;
        setReport(data);
        setCategoryOverride(data.category);
        setPriorityOverride(data.priority);
        setDispatchPriorityOverride(data.priority);
        if (data.deadlineIso) setDispatchDeadlineInput(data.deadlineIso.slice(0, 16));
        if (data.supervisorId) setDispatchSupervisorId(data.supervisorId);
        if (data.delayExplanation) setDelayExplanationInput(data.delayExplanation);
        if (data.departmentId) setSelectedDeptId(data.departmentId);
        if (data.assignedWorkerId) setSelectedWorkerId(data.assignedWorkerId);

        const sortedUpdates = [...bundle.updates].sort(
          (a, b) => toTimestampMs(b.createdAt) - toTimestampMs(a.createdAt)
        );
        const sortedAudits = [...bundle.auditLogs].sort(
          (a, b) => toTimestampMs(b.createdAt) - toTimestampMs(a.createdAt)
        );

        setUpdates(sortedUpdates);
        setAuditLogs(sortedAudits);
        setLatestAssignment(bundle.latestAssignment);
        setAiAnalysis(bundle.aiAnalysis);
        setFeedbacks(bundle.feedbacks);
      } catch {
        // Non-blocking refresh failure; keeps current loaded state intact
      }
    };

    void loadDetail();

    const unsubscribeRealtime = subscribeToCivicRealtime(
      `report_detail_${initialReport.id}`,
      ['reports', 'report_updates', 'assignments', 'audit_logs', 'ai_analyses', 'citizen_feedback'],
      () => {
        if (active) void loadDetail();
      },
      250
    );

    return () => {
      active = false;
      unsubscribeRealtime();
    };
  }, [initialReport.id, initialReport.aiAnalysisId, effectiveRole, profile?.uid, profile?.role, getIdToken]);

  // Fetch citizen private contact only for real Admin accounts
  useEffect(() => {
    let cancelled = false;
    if (profile?.role === 'admin' && (effectiveRole === 'admin' || effectiveRole === 'officer')) {
      fetchCitizenContactForAdmin(initialReport.reporterId).then((contact) => {
        if (!cancelled) setCitizenContact(contact);
      });
    } else {
      setCitizenContact(null);
    }
    return () => {
      cancelled = true;
    };
  }, [initialReport.reporterId, profile?.role, effectiveRole]);

  useEffect(() => {
    if (!selectedDeptId && selectableDepartments.length > 0) {
      const matching = selectableDepartments.find((d) => d.categories.includes(report.category));
      setSelectedDeptId(matching?.id || selectableDepartments[0].id);
    }
  }, [selectableDepartments, selectedDeptId, report.category]);

  const officersList = staffUsers.filter(
    (u) => u.active && (u.role === 'officer' || u.role === 'admin')
  );

  useEffect(() => {
    if (!selectedDeptId || officersList.length === 0) return;
    const dept = departments.find((d) => d.id === selectedDeptId);
    const matchingOfficer =
      officersList.find((u) => u.role === 'officer' && u.departmentId === selectedDeptId) ||
      officersList.find((u) => dept?.officerIds.includes(u.uid) && u.role === 'officer') ||
      officersList.find((u) => dept?.officerIds.includes(u.uid)) ||
      officersList[0];
    if (matchingOfficer && (!selectedOfficerId || !officersList.some((o) => o.uid === selectedOfficerId))) {
      setSelectedOfficerId(matchingOfficer.uid);
    }
  }, [selectedDeptId, departments, officersList, selectedOfficerId]);

  const stopWorkerLocationSharing = async (assignmentIdOverride?: string) => {
    if (geoWatchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(geoWatchIdRef.current);
      geoWatchIdRef.current = null;
    }
    const targetAsgId = assignmentIdOverride || activeLocationAssignmentIdRef.current;
    activeLocationAssignmentIdRef.current = null;
    setLocationSharingActive(false);
    setLocationCoords(null);
    setLocationUpdatedAtIso(null);
    if (targetAsgId) {
      setLocationSharingBusy(true);
      try {
        await workerUpdateLocationSharing({ assignmentId: targetAsgId, active: false });
      } catch {
        // Non-blocking cleanup
      } finally {
        setLocationSharingBusy(false);
      }
    }
  };

  const startWorkerLocationSharing = () => {
    if (!latestAssignment?.id) {
      setLocationSharingError(t('detail.errLocNeedAssignment'));
      return;
    }
    if (report.status !== 'assigned' && report.status !== 'in_progress') {
      setLocationSharingError(t('detail.errLocActiveOnly'));
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationSharingError(t('detail.errLocUnavailable'));
      return;
    }

    if (geoWatchIdRef.current !== null) {
      navigator.geolocation.clearWatch(geoWatchIdRef.current);
      geoWatchIdRef.current = null;
    }

    setLocationSharingError(null);
    setLocationSharingBusy(true);
    activeLocationAssignmentIdRef.current = latestAssignment.id;
    lastLocationPushMsRef.current = 0;

    const watchId = navigator.geolocation.watchPosition(
      async (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(6));
        const lng = Number(pos.coords.longitude.toFixed(6));
        const now = Date.now();
        setLocationCoords({ lat, lng });
        setLocationSharingActive(true);
        setLocationSharingBusy(false);
        setLocationSharingError(null);

        if (now - lastLocationPushMsRef.current < 15_000) {
          return;
        }
        lastLocationPushMsRef.current = now;
        try {
          await workerUpdateLocationSharing({
            assignmentId: latestAssignment.id,
            active: true,
            lat,
            lng,
          });
          setLocationUpdatedAtIso(new Date().toISOString());
        } catch (err: unknown) {
          setLocationSharingError(tError(formatFriendlyError(err)));
        }
      },
      (geoErr) => {
        setLocationSharingBusy(false);
        setLocationSharingActive(false);
        activeLocationAssignmentIdRef.current = null;
        if (geoWatchIdRef.current !== null) {
          navigator.geolocation.clearWatch(geoWatchIdRef.current);
          geoWatchIdRef.current = null;
        }
        if (geoErr.code === geoErr.PERMISSION_DENIED) {
          setLocationSharingError(t('detail.errLocDenied'));
        } else {
          setLocationSharingError(
            geoErr.message || t('detail.errGeoAcquire')
          );
        }
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 }
    );
    geoWatchIdRef.current = watchId;
  };

  // Automatically stop location sharing when task completes or user navigates away
  useEffect(() => {
    if (
      activeLocationAssignmentIdRef.current &&
      report.status !== 'assigned' &&
      report.status !== 'in_progress'
    ) {
      void stopWorkerLocationSharing(activeLocationAssignmentIdRef.current);
    }
  }, [report.status]);

  useEffect(() => {
    return () => {
      if (geoWatchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.clearWatch(geoWatchIdRef.current);
        geoWatchIdRef.current = null;
      }
      if (activeLocationAssignmentIdRef.current) {
        const cleanupId = activeLocationAssignmentIdRef.current;
        activeLocationAssignmentIdRef.current = null;
        void workerUpdateLocationSharing({ assignmentId: cleanupId, active: false }).catch(
          () => {}
        );
      }
    };
  }, []);

  const workersList = staffUsers.filter(
    (u) => u.active && (u.role === 'worker' || (profile?.role === 'admin' && u.uid === profile.uid))
  );

  const runAction = async (fn: () => Promise<void>, successMsg: string) => {
    setActionError(null);
    setActionSuccess(null);
    try {
      setActionLoading(true);
      await fn();
      setActionSuccess(successMsg);
    } catch (err: unknown) {
      setActionError(tError(formatFriendlyError(err)));
    } finally {
      setActionLoading(false);
    }
  };

  const handleUploadEvidence = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setActionError(null);
    setActionSuccess(null);

    const existingTotal =
      Math.max(report.resolutionImageUrls?.length || 0, report.resolutionImageMetadata?.length || 0) +
      newResolutionPhotos.length;
    if (existingTotal >= 5) {
      setActionError(t('detail.errMax5Photos'));
      return;
    }

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setActionError(t('detail.errUnsupportedImg', { name: file.name }));
      return;
    }
    if (file.size <= 0 || file.size > 5 * 1024 * 1024) {
      setActionError(t('detail.errImgSize', { name: file.name }));
      return;
    }

    try {
      setUploadingEvidence(true);
      const token = await getIdToken();
      const uploaded = await uploadValidatedImage(file, token, 'evidence', {
        existingCount: existingTotal,
        onProgress: (info) => setEvidenceProgress(info),
      });
      const previewUrl = URL.createObjectURL(file);
      setNewResolutionPhotos((prev) =>
        [
          ...prev,
          {
            url: uploaded.url,
            fileName: uploaded.fileName,
            mimeType: uploaded.mimeType,
            sizeBytes: uploaded.sizeBytes,
            storageProvider: uploaded.storageProvider,
            storagePath: uploaded.storagePath,
            uploadedBy: uploaded.uploadedBy,
            uploadedAtIso: uploaded.uploadedAtIso,
            previewUrl,
          },
        ].slice(0, 5)
      );
      setActionSuccess(t('detail.msgPhotoValidated', { name: uploaded.fileName }));
    } catch (err: unknown) {
      setActionError(err instanceof Error ? tError(err.message) : t('detail.errEvidenceUploadFailed'));
    } finally {
      setUploadingEvidence(false);
      setEvidenceProgress(null);
    }
  };

  const handleStaffDuplicateCheck = async () => {
    setDupLoading(true);
    setActionError(null);
    try {
      const token = await getIdToken();
      const res = await detectDuplicatesViaServer(
        {
          reportId: report.id,
          title: report.title,
          description: report.description,
          aiDescription: (aiAnalysis || advisoryResult)?.factualDescription,
          category: report.category,
          latitude: report.latitude,
          longitude: report.longitude,
        },
        token
      );
      setDuplicates(res.candidates);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? tError(err.message) : t('detail.errDuplicateScanFailed'));
    } finally {
      setDupLoading(false);
    }
  };

  const handleRunLiveAiForFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setActionError(t('detail.errAiFormat'));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setActionError(t('detail.errAiSize'));
      return;
    }
    setAiRunning(true);
    setActionError(null);
    try {
      const token = await getIdToken();
      const result = await analyzeImageViaServer(file, null, token, report.title);
      if (!report.aiAnalysisId && (profile?.role === 'admin' || report.reporterId === profile?.uid)) {
        await attachAiAnalysisToReport(report, result, token);
      }
      setAdvisoryResult({
        id: 'live_preview',
        reportId: report.id,
        reporterId: report.reporterId,
        authorizedOfficerIds: report.authorizedOfficerIds,
        ...result,
        createdAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      setActionError(err instanceof Error ? tError(err.message) : t('detail.errAiFailed'));
    } finally {
      setAiRunning(false);
    }
  };

  const displayedAi = aiAnalysis || advisoryResult;
  const isStaff = effectiveRole === 'admin' || effectiveRole === 'officer';
  const priorityIntelligence = useMemo(
    () =>
      computePriorityRecommendation(
        report,
        allReports && allReports.length > 0 ? allReports : [report],
        displayedAi,
        updates
      ),
    [report, allReports, displayedAi, updates]
  );
  const deadlineEvaluation = useMemo(
    () => evaluateReportDeadlines(report, latestAssignment, slaPolicies, nowMs),
    [report, latestAssignment, slaPolicies, nowMs]
  );
  const awaitingSupervisorSignOff = useMemo(
    () => isReportAwaitingSupervisorVerification(report, latestAssignment),
    [report, latestAssignment]
  );
  const workerRecommendations = useMemo(
    () =>
      recommendWorkersForReport(
        report,
        staffUsers,
        allReports && allReports.length > 0 ? allReports : [report],
        assignments,
        departments
      ),
    [report, staffUsers, allReports, assignments, departments]
  );
  const isTerminal = report.status === 'citizen_confirmed' || report.status === 'rejected';
  const latestResolvedUpdate = updates.find((u) => u.toStatus === 'resolved');
  const confirmedFeedback = feedbacks.find((f) => f.outcome === 'confirmed') || null;
  const latestInfoRequest =
    report.status === 'under_review'
      ? updates.find((u) => u.note.startsWith('More information requested:'))
      : undefined;
  const assignedOfficerNames = report.authorizedOfficerIds
    .map((id) => staffUsers.find((u) => u.uid === id))
    .filter((u): u is UserProfile => Boolean(u))
    .map((u) => `${u.displayName} (${tRole(u.role)})`);

  useEffect(() => {
    if (!isStaff) return;
    if (!['submitted', 'under_review', 'reopened'].includes(initialReport.status)) return;
    let cancelled = false;
    (async () => {
      try {
        setDupLoading(true);
        const token = await getIdToken();
        const res = await detectDuplicatesViaServer(
          {
            reportId: initialReport.id,
            title: initialReport.title,
            description: initialReport.description,
            aiDescription: aiAnalysis?.factualDescription,
            category: initialReport.category,
            latitude: initialReport.latitude,
            longitude: initialReport.longitude,
          },
          token
        );
        if (!cancelled) setDuplicates(res.candidates);
      } catch {
        // Non-blocking background scan; manual button remains available
      } finally {
        if (!cancelled) setDupLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialReport.id, isStaff]);

  return (
    <div className="space-y-6">
      {/* Contextual Breadcrumb & Return */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors shrink-0"
          >
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('common.back')}</span>
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>{t('detail.reportsBreadcrumb')}</span>
              <span aria-hidden="true">/</span>
              <span className="font-mono tabular-nums font-medium text-slate-700">
                {report.trackingCode}
              </span>
            </div>
            <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 truncate mt-0.5">
              {report.title}
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <PriorityIndicator priority={report.priority} />
          <StatusIndicator status={report.status} />
        </div>
      </div>

      {actionError && (
        <div role="alert" className="p-3.5 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-800 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{actionError}</span>
        </div>
      )}

      {actionSuccess && (
        <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-900 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{actionSuccess}</span>
        </div>
      )}

      {/* Workflow Stepper */}
      <section className="bg-white border border-slate-200 rounded-xl p-5">
        <h2 className="text-xs font-semibold text-slate-500 mb-3">{t('detail.workflowProgression')}</h2>
        <WorkflowStepper status={report.status} />
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Report Facts, Citizen Details (Staff Only), Imagery, AI Triage, Timeline */}
        <div className="lg:col-span-7 space-y-6">
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
              <span className="font-medium text-slate-800">{tCategory(report.category)}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{t('common.trackingId')}: {report.trackingCode}</span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                <Clock className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
                {t('common.submitted')} {formatTimestamp(report.createdAt)}
              </span>
            </div>

            <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
              {report.description}
            </p>

            {/* Authorized Staff Citizen Details Block */}
            {isStaff ? (
              <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-1">
                <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                  <User className="w-3.5 h-3.5 text-blue-700" aria-hidden="true" />
                  <span>{t('detail.citizenDetailsStaff')}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-slate-600 pt-1">
                  <p>
                    {t('detail.nameLabel')} <span className="font-medium text-slate-900">{report.reporterName}</span>
                  </p>
                  <p className="font-mono text-[11px] truncate" title={report.reporterId}>
                    {t('detail.reporterIdLabel')} {report.reporterId}
                  </p>
                  <p className="sm:col-span-2">
                    {t('detail.contactEmailLabel')}{' '}
                    <span className="font-medium text-slate-900">
                      {citizenContact?.email
                        ? citizenContact.email
                        : profile?.role === 'admin'
                          ? t('detail.unavailable')
                          : t('detail.piiRestricted')}
                    </span>
                    {citizenContact?.phone ? ` · ${citizenContact.phone}` : ''}
                  </p>
                </div>
              </div>
            ) : effectiveRole === 'citizen' ? (
              <p className="text-xs text-slate-500">
                {t('detail.submittedBy')} <span className="font-medium text-slate-800">{report.reporterName}</span>
              </p>
            ) : (
              <p className="text-xs text-slate-500">
                {t('detail.contactRestrictedNote')}
              </p>
            )}

            <div className="pt-3 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-slate-600">
              <div className="flex items-start gap-2">
                <MapPin className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" aria-hidden="true" />
                <div>
                  <p className="font-medium text-slate-900">{report.addressText}</p>
                  <p className="font-mono tabular-nums text-slate-500 mt-0.5">
                    {report.latitude.toFixed(5)}, {report.longitude.toFixed(5)}
                    {report.wardOrZone ? ` · ${report.wardOrZone}` : ''}
                  </p>
                </div>
              </div>
              <div className="space-y-0.5">
                <p className="text-slate-500">
                  {t('common.department')}:{' '}
                  <span className="font-medium text-slate-900">
                    {report.departmentName
                      ? tDepartmentName(report.departmentId, report.departmentName)
                      : t('common.unassigned')}
                  </span>
                </p>
                <p className="text-slate-500">
                  {t('detail.authorizedOfficer')}{' '}
                  <span className="font-medium text-slate-900">
                    {assignedOfficerNames.length > 0
                      ? assignedOfficerNames.join(', ')
                      : report.departmentId
                        ? t('detail.deptOfficerPool')
                        : t('detail.pending')}
                  </span>
                </p>
                <p className="text-slate-500">
                  {t('detail.fieldWorker')}{' '}
                  <span className="font-medium text-slate-900">
                    {report.assignedWorkerName || t('common.unassigned')}
                  </span>
                </p>
                {report.supervisorName && (
                  <p className="text-slate-500">
                    {t('detail.supervisingOfficer')}{' '}
                    <span className="font-medium text-slate-900">{report.supervisorName}</span>
                  </p>
                )}
                {report.deadlineIso && (
                  <p className="text-slate-500 font-mono tabular-nums">
                    {t('detail.taskDeadline')}{' '}
                    <span className="font-medium text-slate-900">
                      {formatTimestamp(report.deadlineIso)}
                    </span>
                  </p>
                )}
                {report.authorityEmailStatus && (
                  <div className="space-y-1">
                    <p className="text-slate-500">
                      {t('detail.authorityEmailLabel')}{' '}
                      <span
                        className={`font-medium ${
                          report.authorityEmailStatus === 'sent'
                            ? 'text-emerald-700'
                            : report.authorityEmailStatus === 'not_configured' ||
                                report.authorityEmailStatus === 'failed'
                              ? 'text-rose-700'
                              : 'text-slate-900'
                        }`}
                      >
                        {report.authorityEmailStatus === 'not_configured'
                          ? t('emailSettings.notConfiguredBadge')
                          : report.authorityEmailStatus === 'sent'
                            ? t('detail.authEmailDispatched')
                            : report.authorityEmailStatus === 'disabled'
                              ? t('emailSettings.notificationsDisabledShort')
                              : report.authorityEmailStatus === 'smtp_not_configured'
                                ? t('detail.authEmailPendingTransport')
                                : report.authorityEmailStatus === 'failed'
                                  ? t('detail.authEmailFailedAdmin')
                                  : t('detail.authEmailPendingRouting')}
                      </span>
                    </p>
                    {report.authorityEmailStatusNote && (
                      <p className="text-[11px] text-slate-600">{report.authorityEmailStatusNote}</p>
                    )}
                    {(profile?.role === 'admin' || report.reporterId === profile?.uid) &&
                      report.authorityEmailStatus !== 'sent' &&
                      report.authorityEmailStatus !== 'disabled' && (
                        <button
                          type="button"
                          disabled={retryingEmail}
                          onClick={async () => {
                            setActionError(null);
                            setActionSuccess(null);
                            setGmailRetryError(null);
                            setRetryingEmail(true);
                            try {
                              const transportInfo = await fetchServerEmailTransportStatus();
                              if (!transportInfo.emailConfigured) {
                                setRetryingEmail(false);
                                setShowGmailRetryModal(true);
                                return;
                              }
                              const token = await getIdToken();
                              const outcome = await retryAuthorityEmailViaServer(report.id, token);
                              setReport((prev) => ({
                                ...prev,
                                authorityEmailStatus: outcome.authorityEmailStatus,
                                authorityEmailStatusNote: outcome.authorityEmailStatusNote,
                                authorityEmailSentAtIso: outcome.authorityEmailSentAtIso,
                              }));
                              if (outcome.authorityEmailStatus === 'sent') {
                                setActionSuccess(outcome.authorityEmailStatusNote);
                              } else {
                                setActionError(outcome.authorityEmailStatusNote);
                              }
                            } catch (err: unknown) {
                              setActionError(tError(formatFriendlyError(err)));
                            } finally {
                              setRetryingEmail(false);
                            }
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 bg-white text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {retryingEmail ? (
                            <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                          ) : (
                            <RotateCcw className="w-3 h-3" aria-hidden="true" />
                          )}
                          <span>{retryingEmail ? t('detail.sending') : t('detail.retryAuthorityEmail')}</span>
                        </button>
                      )}
                  </div>
                )}
                {report.citizenNotificationStatus && (
                  <p className="text-slate-500">
                    {t('detail.citizenInAppNotif')}{' '}
                    <span className="font-medium text-slate-900 capitalize">
                      {report.citizenNotificationStatus}
                    </span>
                  </p>
                )}
              </div>
            </div>

            <div className="pt-2 border-t border-slate-100 flex flex-wrap gap-x-5 gap-y-1 text-[11px] font-mono tabular-nums text-slate-500">
              <span>{t('detail.tsCreated', { time: formatTimestamp(report.createdAt) })}</span>
              <span>{t('detail.tsLastUpdated', { time: formatTimestamp(report.updatedAt) })}</span>
              {report.acknowledgedAtIso && (
                <span>{t('detail.tsAcknowledged', { time: formatTimestamp(report.acknowledgedAtIso) })}</span>
              )}
              {report.reassignedAtIso && (
                <span>{t('detail.tsReassigned', { time: formatTimestamp(report.reassignedAtIso) })}</span>
              )}
              {report.workStartedAtIso && (
                <span>{t('detail.tsWorkStarted', { time: formatTimestamp(report.workStartedAtIso) })}</span>
              )}
              {report.completedAtIso && (
                <span>{t('detail.tsWorkCompleted', { time: formatTimestamp(report.completedAtIso) })}</span>
              )}
              {report.supervisorVerifiedAtIso && (
                <span className="text-emerald-700 font-medium">
                  {t('detail.tsSupVerified', { time: formatTimestamp(report.supervisorVerifiedAtIso) })}
                  {report.supervisorVerifiedByName ? ` (${report.supervisorVerifiedByName})` : ''}
                </span>
              )}
              {(report.status === 'resolved' || report.status === 'citizen_confirmed') &&
                !report.supervisorVerifiedAtIso &&
                latestResolvedUpdate && (
                  <span className="text-emerald-700 font-medium">
                    {t('detail.tsCompleted', { time: formatTimestamp(latestResolvedUpdate.createdAt) })}
                  </span>
                )}
            </div>

            {latestAssignment?.reassignedFromWorkerName && latestAssignment.reassignmentReason && isStaff && (
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700">
                <span className="font-semibold text-slate-900">{t('detail.taskReassignment')} </span>
                <span>
                  {t('detail.reassignmentDetail', {
                    from: latestAssignment.reassignedFromWorkerName,
                    to: latestAssignment.workerName || t('detail.newFieldWorker'),
                    reason: latestAssignment.reassignmentReason,
                  })}
                </span>
              </div>
            )}

            {report.assistanceRequestNote && (
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-950 flex items-start gap-2">
                <HelpCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <span className="font-semibold">{t('detail.supAssistanceRequested')} </span>
                  <span>{report.assistanceRequestNote}</span>
                  {report.assistanceRequestedAtIso && (
                    <span className="block text-[11px] font-mono tabular-nums text-amber-800 mt-0.5">
                      {formatTimestamp(report.assistanceRequestedAtIso)}
                    </span>
                  )}
                </div>
              </div>
            )}

            {report.delayExplanation && (
              <div className="p-3 rounded-lg bg-amber-50/70 border border-amber-200 text-xs text-amber-950">
                <span className="font-semibold">{t('detail.fieldDelayExplanation')} </span>
                <span>{report.delayExplanation}</span>
              </div>
            )}

            {awaitingSupervisorSignOff && (
              <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-950 flex items-start gap-2">
                <UserCheck className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" aria-hidden="true" />
                <span>
                  <strong>{t('detail.completionAwaitingTitle')}</strong> {t('detail.completionAwaitingBody')}
                </span>
              </div>
            )}

            {report.hasActiveObstacle && report.obstaclesEncountered && (
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-950 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <span className="font-semibold">{t('detail.activeObstacleTitle')} </span>
                  <span>{report.obstaclesEncountered}</span>
                </div>
              </div>
            )}

            {report.escalatedAtIso && (
              <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-900 flex items-start gap-2">
                <ShieldAlert className="w-4 h-4 text-rose-700 shrink-0 mt-0.5" aria-hidden="true" />
                <span>
                  <strong>{t('detail.escalatedBannerTitle')}</strong>{' '}
                  {t('detail.escalatedBannerBody', { time: formatTimestamp(report.escalatedAtIso) })}
                </span>
              </div>
            )}

            {latestAssignment?.instructions && (
              <div className="p-3 rounded-lg bg-blue-50/70 border border-blue-200 text-xs text-blue-950">
                <span className="font-semibold">{t('detail.dispatchInstructionsLabel')} </span>
                <span>{latestAssignment.instructions}</span>
              </div>
            )}

            {latestInfoRequest && (
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-950">
                <span className="font-semibold">{t('detail.moreInfoRequestedLabel')} </span>
                <span>{latestInfoRequest.note.replace(/^More information requested:\s*/i, '')}</span>
              </div>
            )}

            {report.rejectionReason && (
              <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-900">
                <span className="font-semibold">{t('detail.rejectionReworkLabel')} </span>
                <span>{report.rejectionReason}</span>
              </div>
            )}

            {report.reopenReason && (
              <div className="p-3 rounded-lg bg-orange-50 border border-orange-200 text-xs text-orange-900">
                <span className="font-semibold">{t('detail.citizenReopenLabel')} </span>
                <span>{report.reopenReason}</span>
              </div>
            )}
          </section>

          {/* Photographs & Completion Evidence */}
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700 flex items-start gap-2">
              <Info className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{t('detail.photoMemoryNotice')}</span>
            </div>

            <div>
              <h2 className="text-sm font-semibold text-slate-900 mb-3">
                {t('detail.citizenPhotosCount', {
                  count: Math.max(report.imageUrls.length, report.imageMetadata?.length || 0),
                })}
              </h2>
              {report.imageUrls.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {report.imageUrls.map((url, idx) => (
                    <SafeImageThumb
                      key={url + idx}
                      url={url}
                      alt={t('detail.citizenEvidenceAlt', { num: idx + 1 })}
                      meta={report.imageMetadata?.find((m) => m.url === url) || report.imageMetadata?.[idx]}
                    />
                  ))}
                </div>
              ) : report.imageMetadata && report.imageMetadata.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {report.imageMetadata.map((meta, idx) => (
                    <MetadataOnlyCard key={meta.storagePath + idx} meta={meta} />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-500">
                  {t('detail.noPhotoMeta')}
                </p>
              )}
            </div>

            <div className="pt-4 border-t border-slate-200">
              <h2 className="text-sm font-semibold text-slate-900 mb-2">
                {t('detail.fieldEvidenceCount', {
                  count: Math.max(
                    report.resolutionImageUrls.length,
                    report.resolutionImageMetadata?.length || 0
                  ),
                })}
              </h2>
              {(report.resolutionNotes ||
                report.materialsUsed ||
                report.obstaclesEncountered ||
                report.workerCheckInLabel) && (
                <div className="text-xs text-slate-700 mb-3 bg-slate-50 border border-slate-200 rounded-lg p-3.5 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 font-semibold text-slate-800">
                    <span>{t('detail.fieldProgressRecord')}</span>
                    {report.completedAtIso && (
                      <span className="font-mono tabular-nums text-emerald-700">
                        {t('detail.tsCompleted', { time: formatTimestamp(report.completedAtIso) })}
                      </span>
                    )}
                  </div>
                  {report.resolutionNotes && (
                    <p className="text-sm text-slate-800">{report.resolutionNotes}</p>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11px] text-slate-600 pt-1">
                    {report.workStartedAtIso && (
                      <p className="font-mono tabular-nums">
                        {t('detail.startedLabel', { time: formatTimestamp(report.workStartedAtIso) })}
                      </p>
                    )}
                    {report.materialsUsed && (
                      <p>
                        {t('detail.materialsLabel')}{' '}
                        <span className="font-medium text-slate-900">{report.materialsUsed}</span>
                      </p>
                    )}
                    {report.obstaclesEncountered && (
                      <p className="sm:col-span-2 text-amber-900">
                        {t('detail.obstaclesShort')} <span className="font-medium">{report.obstaclesEncountered}</span>
                      </p>
                    )}
                    {report.workerCheckInLabel && (
                      <p className="sm:col-span-2">
                        {t('detail.explicitCheckIn')}{' '}
                        <span className="font-medium text-slate-900">{report.workerCheckInLabel}</span>
                      </p>
                    )}
                  </div>
                </div>
              )}
              {report.resolutionImageUrls.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {report.resolutionImageUrls.map((url, idx) => (
                    <SafeImageThumb
                      key={url + idx}
                      url={url}
                      alt={t('detail.resolutionProofAlt', { num: idx + 1 })}
                      meta={
                        report.resolutionImageMetadata?.find((m) => m.url === url) ||
                        report.resolutionImageMetadata?.[idx]
                      }
                    />
                  ))}
                </div>
              ) : report.resolutionImageMetadata && report.resolutionImageMetadata.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {report.resolutionImageMetadata.map((meta, idx) => (
                    <MetadataOnlyCard key={meta.storagePath + idx} meta={meta} />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-500">
                  {t('detail.noFieldPhotos')}
                </p>
              )}
            </div>
          </section>

          {/* Advisory Gemini AI Assessment */}
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-blue-700" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-slate-900">
                  {t('detail.geminiAdvisoryHeading')}
                </h2>
              </div>
              {isStaff && (
                <label
                  className={`px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 transition-colors ${
                    aiRunning ? 'opacity-50 cursor-not-allowed' : 'hover:bg-slate-50 cursor-pointer'
                  }`}
                >
                  <span>{aiRunning ? t('detail.analyzing') : t('detail.analyzeFieldPhoto')}</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    disabled={aiRunning}
                    onChange={handleRunLiveAiForFile}
                    className="sr-only"
                  />
                </label>
              )}
            </div>

            {displayedAi ? (
              <div className="space-y-3 text-sm">
                {displayedAi.detectedIssue && (
                  <p className="text-xs text-slate-600">
                    {t('submit.aiDetectedIssue')}:{' '}
                    <strong className="text-slate-900">{displayedAi.detectedIssue}</strong>
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                  <span>
                    {t('detail.suggestedLabel')}{' '}
                    <strong className="text-slate-900">{tCategory(displayedAi.suggestedCategory)}</strong>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {t('detail.priorityLabel')}{' '}
                    <strong className="text-slate-900">{tPriority(displayedAi.suggestedPriority)}</strong>
                  </span>
                  {displayedAi.suggestedDepartmentName && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>
                        {t('detail.responsibleDeptShort')}{' '}
                        <strong className="text-slate-900">
                          {tDepartmentName(
                            displayedAi.suggestedDepartmentId,
                            displayedAi.suggestedDepartmentName
                          )}
                        </strong>
                      </span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {t('submit.confidence', { pct: Math.round(displayedAi.confidenceScore * 100) })}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {t('detail.clarityLabel', {
                      clarity: displayedAi.imageQualityStatus.replace('_', ' '),
                    })}
                  </span>
                </div>
                <p className="text-slate-800">{displayedAi.factualDescription}</p>
                {Array.isArray(displayedAi.visibleEvidence) && displayedAi.visibleEvidence.length > 0 && (
                  <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-700">
                    <p className="font-semibold text-slate-900 mb-1">{t('submit.aiVisibleEvidence')}:</p>
                    <ul className="list-disc list-inside space-y-0.5">
                      {displayedAi.visibleEvidence.map((item, idx) => (
                        <li key={idx}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="text-xs text-slate-600">
                  {t('detail.priorityRationale', { reason: displayedAi.priorityExplanation })}
                </p>
                {displayedAi.recommendedAction && (
                  <p className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                    <strong className="text-slate-900">{t('detail.recommendedSolution')}</strong>{' '}
                    {displayedAi.recommendedAction}
                  </p>
                )}
                {(report.category !== displayedAi.suggestedCategory ||
                  report.priority !== displayedAi.suggestedPriority) && (
                  <p className="text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                    {t('detail.confirmedHumanAssessment')}{' '}
                    <strong>{tCategory(report.category)}</strong> · {t('common.priority')}{' '}
                    <strong>{tPriority(report.priority)}</strong>
                  </p>
                )}
                {displayedAi.requiresHumanReview && (
                  <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                    <span>
                      <strong>{t('detail.humanReviewFlagged')}</strong> {displayedAi.reviewReason}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                {t('detail.noAiAttached')}
              </p>
            )}
          </section>

          {/* Activity History */}
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <h2 className="text-sm font-semibold text-slate-900">
              {t('detail.timestampedHistory')}
            </h2>
            <ActivityTimeline updates={updates} />
          </section>

          {/* Staff-Only Immutable Audit Logs */}
          {isStaff && (
            <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-slate-600" aria-hidden="true" />
                  <h2 className="text-sm font-semibold text-slate-900">
                    {t('detail.immutableAuditTrail')}
                  </h2>
                </div>
                <span className="text-[11px] font-mono tabular-nums text-slate-500">
                  {t('detail.auditEntriesCount', { count: auditLogs.length })}
                </span>
              </div>
              {auditLogs.length === 0 ? (
                <p className="text-xs text-slate-500">
                  {t('detail.noAuditLogs')}
                </p>
              ) : (
                <ul className="divide-y divide-slate-200">
                  {auditLogs.map((log) => (
                    <li key={log.id} className="py-2.5 first:pt-0 last:pb-0 text-xs space-y-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-900">{log.actorName}</span>
                          <span className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-[10px] font-mono uppercase text-slate-600">
                            {tRole(log.actorRole)}
                          </span>
                          <span className="font-mono text-[11px] text-blue-800">{log.action}</span>
                        </div>
                        <span className="font-mono tabular-nums text-slate-500">
                          {formatTimestamp(log.createdAt)}
                        </span>
                      </div>
                      <p className="text-slate-700">{log.summary}</p>
                      {log.details && (
                        <p className="text-[11px] text-slate-500">{log.details}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        {/* Right Column: Deadlines, Role Actions & Staff Duplicate Detection */}
        <div className="lg:col-span-5 space-y-6">
          {/* Module 4: Administrative Response Deadlines & Escalation */}
          {(isStaff || effectiveRole === 'worker') && (
            <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-blue-700" aria-hidden="true" />
                  <h2 className="text-sm font-semibold text-slate-900">
                    {t('detail.adminResponseTargets')}
                  </h2>
                </div>
                <span
                  className={`px-2 py-0.5 rounded border text-[11px] font-mono tabular-nums font-medium ${
                    deadlineEvaluation.isOverdue
                      ? 'bg-rose-50 text-rose-800 border-rose-200'
                      : deadlineEvaluation.isApproaching
                        ? 'bg-amber-50 text-amber-900 border-amber-200'
                        : 'bg-emerald-50 text-emerald-800 border-emerald-200'
                  }`}
                >
                  {deadlineEvaluation.activeRemainingLabel}
                </span>
              </div>

              <p className="text-[11px] text-slate-500">
                {t('detail.policyBenchmarkNote', { label: deadlineEvaluation.policyLabel })}
              </p>

              <div className="grid grid-cols-3 gap-2 text-xs">
                {(
                  [
                    { key: 'ack', label: t('detail.stageAcknowledge'), health: deadlineEvaluation.ackHealth, ms: deadlineEvaluation.ackRemainingMs },
                    { key: 'assign', label: t('detail.stageAssign'), health: deadlineEvaluation.assignHealth, ms: deadlineEvaluation.assignRemainingMs },
                    { key: 'resolve', label: t('detail.stageResolve'), health: deadlineEvaluation.resolveHealth, ms: deadlineEvaluation.resolveRemainingMs },
                  ] as const
                ).map((stage) => (
                  <div
                    key={stage.key}
                    className={`p-2.5 rounded-lg border text-center ${
                      stage.health === 'met'
                        ? 'bg-emerald-50/70 border-emerald-200 text-emerald-900'
                        : stage.health === 'overdue'
                          ? 'bg-rose-50 border-rose-200 text-rose-900'
                          : stage.health === 'approaching'
                            ? 'bg-amber-50 border-amber-200 text-amber-900'
                            : 'bg-slate-50 border-slate-200 text-slate-800'
                    }`}
                  >
                    <p className="font-semibold text-[11px]">{stage.label}</p>
                    <p className="font-mono tabular-nums text-[11px] mt-0.5">
                      {stage.health === 'met'
                        ? t('detail.stageMet')
                        : stage.health === 'overdue'
                          ? t('detail.stageOverdue')
                          : t('detail.hoursLeft', {
                              hours: Math.max(1, Math.round(stage.ms / 3600_000)),
                            })}
                    </p>
                  </div>
                ))}
              </div>

              {isStaff && !isTerminal && profile && (
                <div className="pt-3 border-t border-slate-200 space-y-2">
                  <label className="block text-xs font-medium text-slate-700">
                    {t('detail.escalateToSupervisor')}
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <select
                      aria-label={t('detail.selectEscalationSupervisorAria')}
                      value={escalationSupervisorId}
                      onChange={(e) => setEscalationSupervisorId(e.target.value)}
                      className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                    >
                      <option value="">{t('detail.defaultDeptSupervisor')}</option>
                      {officersList.map((o) => (
                        <option key={o.uid} value={o.uid}>
                          {o.displayName} ({tRole(o.role)})
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={escalationReasonInput}
                      onChange={(e) => setEscalationReasonInput(e.target.value)}
                      placeholder={t('detail.escalationNotePlaceholder')}
                      className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={actionLoading}
                    onClick={async () => {
                      const sup = officersList.find((o) => o.uid === escalationSupervisorId) || null;
                      const token = await getIdToken();
                      await runAction(
                        () =>
                          escalateOverdueReport({
                            report,
                            actor: profile,
                            supervisor: sup,
                            reason:
                              escalationReasonInput.trim() ||
                              `Escalated (${deadlineEvaluation.activeStage}: ${deadlineEvaluation.activeRemainingLabel}).`,
                            idToken: token,
                          }),
                        t('detail.msgEscalated', { code: report.trackingCode })
                      );
                      setEscalationReasonInput('');
                    }}
                    className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg border border-rose-300 bg-rose-50 text-rose-900 text-xs font-medium hover:bg-rose-100 disabled:opacity-50"
                  >
                    <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{t('detail.escalateBlockedBtn')}</span>
                  </button>
                </div>
              )}
            </section>
          )}

          {/* Staff Duplicate Detection */}
          {isStaff && (
            <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <CopyCheck className="w-4 h-4 text-blue-700" aria-hidden="true" />
                  <h2 className="text-sm font-semibold text-slate-900">
                    {t('detail.duplicateDetection')}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={handleStaffDuplicateCheck}
                  disabled={dupLoading}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                >
                  {dupLoading ? t('detail.scanning') : t('detail.scanMatches')}
                </button>
              </div>
              <p className="text-xs text-slate-500">
                {t('detail.duplicateDesc')}
              </p>

              {duplicates !== null && (
                <div className="pt-2">
                  {duplicates.length === 0 ? (
                    <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                      {t('detail.noDuplicatesInRange')}
                    </p>
                  ) : (
                    <ul className="divide-y divide-slate-200 border border-slate-200 rounded-lg bg-slate-50 px-3">
                      {duplicates.map((d) => (
                        <li key={d.reportId} className="py-2.5 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            {onSelectReport ? (
                              <button
                                type="button"
                                onClick={() => onSelectReport(d.reportId)}
                                className="font-semibold text-blue-700 hover:underline truncate text-left"
                              >
                                {d.trackingCode} · {d.title}
                              </button>
                            ) : (
                              <span className="font-semibold text-slate-900 truncate">
                                {d.trackingCode} · {d.title}
                              </span>
                            )}
                            <span className="font-mono tabular-nums text-blue-800 shrink-0">
                              {t('detail.matchPct', { pct: Math.round(d.overallScore * 100) })}
                            </span>
                          </div>
                          <p className="text-slate-600 mt-0.5">
                            {t('submit.distanceAway', { meters: d.distanceMeters })} · {tStatus(d.status)} · {d.matchReason}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          )}

          {/* ADMIN CONTROLS */}
          {effectiveRole === 'admin' && !isTerminal && profile && (
            <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-blue-700" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-slate-900">
                  {t('detail.adminVerifyDispatch')}
                </h2>
              </div>

              {(report.status === 'submitted' || report.status === 'reopened') && (
                <button
                  type="button"
                  disabled={actionLoading}
                  onClick={async () => {
                    const token = await getIdToken();
                    await runAction(
                      () => adminTransitionToUnderReview(report, profile, token),
                      t('detail.msgMovedUnderReview')
                    );
                  }}
                  className="w-full py-2 px-4 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-800 hover:bg-slate-50 transition-colors"
                >
                  {t('detail.startReview')}
                </button>
              )}

              {(report.status === 'submitted' ||
                report.status === 'under_review' ||
                report.status === 'reopened' ||
                report.status === 'verified') && (
                <div className="space-y-3 pt-3 border-t border-slate-200">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        {t('detail.confirmedCategory')}
                      </label>
                      <select
                        value={categoryOverride}
                        onChange={(e) => setCategoryOverride(e.target.value as IssueCategory)}
                        className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs bg-white"
                      >
                        {(Object.keys(CATEGORY_LABELS) as IssueCategory[]).map((cat) => (
                          <option key={cat} value={cat}>
                            {tCategory(cat)}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        {t('detail.confirmedPriorityFinal')}
                      </label>
                      <select
                        value={priorityOverride}
                        onChange={(e) => setPriorityOverride(e.target.value as IssuePriority)}
                        className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs bg-white"
                      >
                        <option value="low">{tPriority('low')}</option>
                        <option value="medium">{tPriority('medium')}</option>
                        <option value="high">{tPriority('high')}</option>
                        <option value="critical">{tPriority('critical')}</option>
                      </select>
                    </div>
                  </div>

                  {/* Priority Intelligence Advisory Breakdown */}
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-slate-800">
                        {t('detail.priorityIntelSuggested', {
                          priority: tPriority(priorityIntelligence.recommendedPriority),
                        })}{' '}
                        <span className="font-mono tabular-nums text-slate-500">
                          ({priorityIntelligence.urgencyScore}/100)
                        </span>
                      </span>
                      {priorityIntelligence.recommendedPriority !== priorityOverride && (
                        <button
                          type="button"
                          onClick={() => setPriorityOverride(priorityIntelligence.recommendedPriority)}
                          className="px-2 py-1 rounded border border-blue-200 bg-white text-blue-700 font-medium hover:bg-blue-50 whitespace-nowrap"
                        >
                          {t('detail.useSuggestedPriority')}
                        </button>
                      )}
                    </div>
                    <ul className="space-y-1 text-[11px] text-slate-600">
                      {priorityIntelligence.factors.map((f) => (
                        <li key={f.id} className="flex items-start justify-between gap-2">
                          <span>{f.label}: {f.observation}</span>
                          <span className="font-mono tabular-nums text-slate-500 shrink-0">
                            {f.points}/{f.maxPoints}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      {t('detail.assignDepartment')}
                    </label>
                    <select
                      value={selectedDeptId}
                      onChange={(e) => setSelectedDeptId(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                    >
                      {selectableDepartments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {tDepartmentName(d.id, d.name)} ({d.code})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      {t('detail.authorizedDeptOfficer')}
                    </label>
                    <select
                      value={selectedOfficerId}
                      onChange={(e) => setSelectedOfficerId(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                    >
                      <option value="">{t('detail.deptOfficerPoolDefault')}</option>
                      {officersList.map((u) => (
                        <option key={u.uid} value={u.uid}>
                          {u.displayName} ({tRole(u.role)}
                          {u.departmentName
                            ? ` · ${tDepartmentName(u.departmentId, u.departmentName)}`
                            : ''})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      {t('detail.verifyDispatchNote')}
                    </label>
                    <textarea
                      rows={2}
                      value={deptInstructions}
                      onChange={(e) => setDeptInstructions(e.target.value)}
                      placeholder={t('detail.verifyDispatchPlaceholder')}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                    />
                  </div>

                  <div className="flex flex-col sm:flex-row gap-2">
                    {report.status !== 'verified' && (
                      <button
                        type="button"
                        disabled={actionLoading}
                        onClick={async () => {
                          const token = await getIdToken();
                          await runAction(
                            () =>
                              adminVerifyReport({
                                report,
                                actor: profile,
                                categoryOverride,
                                priorityOverride,
                                verificationNote: deptInstructions,
                                idToken: token,
                              }),
                            t('detail.msgVerifiedConfirmed')
                          );
                        }}
                        className="sm:w-1/3 py-2.5 px-3 rounded-lg border border-blue-300 bg-blue-50 text-blue-900 text-xs font-medium hover:bg-blue-100 disabled:opacity-60 transition-colors whitespace-nowrap"
                      >
                        {t('detail.verifyOnly')}
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={actionLoading || !selectedDeptId}
                      onClick={async () => {
                        const dept = selectableDepartments.find((d) => d.id === selectedDeptId);
                        if (!dept) return;
                        const officer = officersList.find((o) => o.uid === selectedOfficerId) || null;
                        const token = await getIdToken();
                        const localizedDept = tDepartmentName(dept.id, dept.name);
                        await runAction(
                          () =>
                            adminVerifyAndAssignDepartment({
                              report,
                              department: dept,
                              assignedOfficer: officer,
                              actor: profile,
                              categoryOverride,
                              priorityOverride,
                              instructions: deptInstructions,
                              idToken: token,
                            }),
                          report.status === 'verified'
                            ? t('detail.msgUpdatedDept', { dept: localizedDept })
                            : t('detail.msgVerifiedAssignedDept', { dept: localizedDept })
                        );
                      }}
                      className="flex-1 py-2.5 px-4 rounded-lg bg-blue-700 text-white text-sm font-medium hover:bg-blue-800 disabled:opacity-60 transition-colors"
                    >
                      {report.status === 'verified'
                        ? t('detail.assignUpdateDept')
                        : t('detail.verifyAssignDept')}
                    </button>
                  </div>
                </div>
              )}

              {(report.status === 'submitted' ||
                report.status === 'under_review' ||
                report.status === 'reopened' ||
                report.status === 'verified') && (
                <div className="pt-3 border-t border-slate-200 space-y-2">
                  <label className="block text-xs font-medium text-slate-700">
                    {t('detail.requestMoreInfoLabel')}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={infoRequestReason}
                      onChange={(e) => setInfoRequestReason(e.target.value)}
                      placeholder={t('detail.requestInfoPlaceholder')}
                      className="flex-1 px-3 py-2 rounded-lg border border-slate-300 text-xs"
                    />
                    <button
                      type="button"
                      disabled={actionLoading || infoRequestReason.trim().length < 3}
                      onClick={async () => {
                        const token = await getIdToken();
                        await runAction(
                          () =>
                            adminRequestMoreInformation({
                              report,
                              actor: profile,
                              reason: infoRequestReason,
                              idToken: token,
                            }),
                          t('detail.msgInfoRequested')
                        );
                        setInfoRequestReason('');
                      }}
                      className="px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs font-medium hover:bg-amber-100 disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      {t('detail.requestInfoBtn')}
                    </button>
                  </div>
                </div>
              )}

              <div className="pt-3 border-t border-slate-200 space-y-2">
                <label className="block text-xs font-medium text-slate-700">
                  {t('detail.rejectSubmissionLabel')}
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder={t('detail.rejectPlaceholder')}
                    className="flex-1 px-3 py-2 rounded-lg border border-slate-300 text-xs"
                  />
                  <button
                    type="button"
                    disabled={actionLoading || rejectReason.trim().length < 3}
                    onClick={async () => {
                      const token = await getIdToken();
                      await runAction(
                        () =>
                          staffRejectReport({
                            report,
                            actor: profile,
                            reason: rejectReason,
                            idToken: token,
                          }),
                        t('detail.msgClosedRejected')
                      );
                    }}
                    className="px-3 py-2 rounded-lg border border-rose-300 bg-rose-50 text-rose-800 text-xs font-medium hover:bg-rose-100 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    {t('common.reject')}
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* OFFICER CONTROLS */}
          {(effectiveRole === 'officer' || effectiveRole === 'admin') && !isTerminal && profile && (
            <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <div className="flex items-center gap-2">
                <UserCheck className="w-4 h-4 text-blue-700" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-slate-900">
                  {t('detail.officerDispatchReview')}
                </h2>
              </div>

              {(report.status === 'verified' ||
                report.status === 'reopened' ||
                report.status === 'assigned' ||
                report.status === 'in_progress') && (
                <div className="space-y-3">
                  {/* Staff-Only Active Task Location Sharing Display (Never shown to citizens) */}
                  {latestAssignment && (
                    <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-slate-800 flex items-center gap-1.5">
                          <Navigation className="w-3.5 h-3.5 text-blue-700" aria-hidden="true" />
                          <span>{t('detail.workerActiveLocation')}</span>
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${
                            latestAssignment.workerLocationSharingActive
                              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                              : 'bg-white text-slate-600 border-slate-200'
                          }`}
                        >
                          {latestAssignment.workerLocationSharingActive
                            ? t('detail.optInActive')
                            : t('detail.notShared')}
                        </span>
                      </div>
                      {latestAssignment.workerLocationSharingActive &&
                      typeof latestAssignment.workerLocationLat === 'number' &&
                      typeof latestAssignment.workerLocationLng === 'number' ? (
                        <p className="font-mono tabular-nums text-[11px] text-slate-700">
                          {latestAssignment.workerLocationLat.toFixed(6)},{' '}
                          {latestAssignment.workerLocationLng.toFixed(6)}
                          {latestAssignment.workerLocationUpdatedAtIso
                            ? ` · ${t('detail.updatedTime', {
                                time: formatTimestamp(latestAssignment.workerLocationUpdatedAtIso),
                              })}`
                            : ''}
                        </p>
                      ) : (
                        <p className="text-[11px] text-slate-500">
                          {t('detail.workerLocationPrivacy')}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Module 3: Smart Worker Recommendations */}
                  <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-900">
                        {t('detail.smartWorkerRecs')}
                      </span>
                      <span className="text-[11px] text-slate-500">{t('detail.fiveFactorScore')}</span>
                    </div>

                    {workerRecommendations.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        {t('detail.noWorkersToRank')}
                      </p>
                    ) : (
                      <ul className="space-y-2">
                        {workerRecommendations.slice(0, 4).map((rec) => {
                          const isSelected = selectedWorkerId === rec.worker.uid;
                          return (
                            <li
                              key={rec.worker.uid}
                              className={`p-2.5 rounded-lg border text-xs bg-white space-y-1 ${
                                isSelected ? 'border-blue-400 ring-1 ring-blue-300' : 'border-slate-200'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="font-semibold text-slate-900 truncate">
                                    {rec.worker.displayName}
                                  </span>
                                  <span
                                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                                      rec.availability === 'available'
                                        ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                        : rec.availability === 'on_duty' || rec.availability === 'assigned'
                                          ? 'bg-blue-50 text-blue-800 border-blue-200'
                                          : rec.availability === 'busy'
                                            ? 'bg-amber-50 text-amber-900 border-amber-200'
                                            : 'bg-rose-50 text-rose-800 border-rose-200'
                                    }`}
                                  >
                                    {tAvailability(rec.availability)}
                                  </span>
                                </div>

                                <div className="flex items-center gap-2 shrink-0">
                                  <span className="font-mono tabular-nums font-semibold text-blue-800">
                                    {rec.score}/100
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSelectedWorkerId(rec.worker.uid);
                                      setSelectedRecMeta({
                                        workerId: rec.worker.uid,
                                        score: rec.score,
                                        reason: rec.reasons.join('; '),
                                      });
                                    }}
                                    className={`px-2 py-1 rounded text-[11px] font-medium border ${
                                      isSelected
                                        ? 'bg-blue-700 text-white border-blue-700'
                                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                                    }`}
                                  >
                                    {isSelected ? t('detail.selected') : t('detail.select')}
                                  </button>
                                </div>
                              </div>
                              <p className="text-[11px] text-slate-600 leading-snug">
                                {rec.reasons.join(' · ')}
                              </p>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      {report.assignedWorkerId
                        ? t('detail.assignedReassignWorker')
                        : t('detail.assignWorker')}
                    </label>
                    <select
                      value={selectedWorkerId}
                      onChange={(e) => {
                        const uid = e.target.value;
                        setSelectedWorkerId(uid);
                        const rec = workerRecommendations.find((r) => r.worker.uid === uid);
                        setSelectedRecMeta(
                          rec
                            ? { workerId: uid, score: rec.score, reason: rec.reasons.join('; ') }
                            : null
                        );
                      }}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                    >
                      <option value="">{t('detail.selectFieldWorkerPlaceholder')}</option>
                      {workersList.map((w) => (
                        <option key={w.uid} value={w.uid}>
                          {w.displayName} (
                          {w.departmentName
                            ? tDepartmentName(w.departmentId, w.departmentName)
                            : tRole(w.role)}
                          {w.availabilityStatus
                            ? ` · ${tAvailability(w.availabilityStatus)}`
                            : ''})
                        </option>
                      ))}
                    </select>
                    {selectedWorkerId &&
                      ['unavailable', 'completed_shift'].includes(
                        workersList.find((w) => w.uid === selectedWorkerId)?.availabilityStatus || ''
                      ) && (
                        <p className="text-xs text-rose-700 mt-1">
                          {t('detail.workerUnavailableWarn', {
                            status: tAvailability(
                              workersList.find((w) => w.uid === selectedWorkerId)!.availabilityStatus!
                            ),
                          })}
                        </p>
                      )}
                    {workersList.length === 0 && (
                      <p className="text-xs text-amber-800 mt-1">
                        {t('detail.noWorkersRegisteredHint')}
                      </p>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        {t('detail.taskPriority')}
                      </label>
                      <select
                        value={dispatchPriorityOverride}
                        onChange={(e) => setDispatchPriorityOverride(e.target.value as IssuePriority)}
                        className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs bg-white"
                      >
                        <option value="low">{tPriority('low')}</option>
                        <option value="medium">{tPriority('medium')}</option>
                        <option value="high">{tPriority('high')}</option>
                        <option value="critical">{tPriority('critical')}</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        {t('detail.customDeadlineOpt')}
                      </label>
                      <input
                        type="datetime-local"
                        value={dispatchDeadlineInput}
                        onChange={(e) => setDispatchDeadlineInput(e.target.value)}
                        className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-mono"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      {t('detail.supervisingOfficer').replace(/:$/, '')}
                    </label>
                    <select
                      value={dispatchSupervisorId}
                      onChange={(e) => setDispatchSupervisorId(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs bg-white"
                    >
                      <option value="">
                        {t('detail.assigningOfficerSelf', { name: profile.displayName })}
                      </option>
                      {officersList.map((o) => (
                        <option key={o.uid} value={o.uid}>
                          {o.displayName} ({tRole(o.role)})
                        </option>
                      ))}
                    </select>
                  </div>

                  {Boolean(
                    report.assignedWorkerId &&
                      selectedWorkerId &&
                      selectedWorkerId !== report.assignedWorkerId
                  ) && (
                    <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 space-y-1.5">
                      <label className="block text-xs font-semibold text-amber-950">
                        {t('detail.reassignReasonLabel')}
                      </label>
                      <input
                        type="text"
                        value={reassignmentReasonInput}
                        onChange={(e) => setReassignmentReasonInput(e.target.value)}
                        placeholder={t('detail.reassignReasonPlaceholder', {
                          name: report.assignedWorkerName || t('detail.currentWorkerFallback'),
                        })}
                        className="w-full px-3 py-2 rounded-lg border border-amber-300 bg-white text-xs"
                      />
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      {t('detail.dispatchInstructionsLabel').replace(/:$/, '')}
                    </label>
                    <textarea
                      rows={2}
                      value={workerInstructions}
                      onChange={(e) => setWorkerInstructions(e.target.value)}
                      placeholder={t('detail.dispatchInstructionsPlaceholder')}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                    />
                  </div>

                  {(() => {
                    const isReassigning = Boolean(
                      report.assignedWorkerId &&
                        selectedWorkerId &&
                        selectedWorkerId !== report.assignedWorkerId
                    );
                    const reassignmentBlocked =
                      isReassigning && reassignmentReasonInput.trim().length < 3;
                    return (
                      <button
                        type="button"
                        disabled={actionLoading || !selectedWorkerId || reassignmentBlocked}
                        onClick={async () => {
                          const worker = workersList.find((w) => w.uid === selectedWorkerId);
                          if (!worker) return;
                          const supervisorObj =
                            officersList.find((o) => o.uid === dispatchSupervisorId) || null;
                          const deadlineIso = dispatchDeadlineInput
                            ? new Date(dispatchDeadlineInput).toISOString()
                            : undefined;
                          const token = await getIdToken();
                          const recMatch =
                            selectedRecMeta?.workerId === worker.uid ? selectedRecMeta : null;
                          await runAction(
                            () =>
                              officerAssignWorker({
                                report,
                                worker,
                                actor: profile,
                                instructions: workerInstructions,
                                priorityOverride: dispatchPriorityOverride,
                                deadlineIso,
                                supervisor: supervisorObj,
                                reassignmentReason: isReassigning
                                  ? reassignmentReasonInput
                                  : undefined,
                                expectedWorkerId: report.assignedWorkerId || '',
                                recommendationScore: recMatch?.score,
                                recommendationReason: recMatch?.reason,
                                idToken: token,
                              }),
                            isReassigning
                              ? t('detail.msgReassignedWorker', { name: worker.displayName })
                              : t('detail.msgAssignedWorker', { name: worker.displayName })
                          );
                          setReassignmentReasonInput('');
                        }}
                        className="w-full py-2.5 px-4 rounded-lg bg-blue-700 text-white text-sm font-medium hover:bg-blue-800 disabled:opacity-60 transition-colors"
                      >
                        {isReassigning
                          ? t('detail.confirmReassignment')
                          : t('detail.approveAssignWorker')}
                      </button>
                    );
                  })()}
                </div>
              )}

              {effectiveRole === 'officer' &&
                (report.status === 'under_review' ||
                  report.status === 'verified' ||
                  report.status === 'assigned' ||
                  report.status === 'in_progress' ||
                  report.status === 'reopened') && (
                  <div className="pt-3 border-t border-slate-200 space-y-2">
                    <label className="block text-xs font-medium text-slate-700">
                      {t('detail.rejectReportLabel')}
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder={t('detail.rejectReportPlaceholder')}
                        className="flex-1 px-3 py-2 rounded-lg border border-slate-300 text-xs"
                      />
                      <button
                        type="button"
                        disabled={actionLoading || rejectReason.trim().length < 3}
                        onClick={async () => {
                          const token = await getIdToken();
                          await runAction(
                            () =>
                              staffRejectReport({
                                report,
                                actor: profile,
                                reason: rejectReason,
                                idToken: token,
                              }),
                            t('detail.msgClosedRejected')
                          );
                        }}
                        className="px-3 py-2 rounded-lg border border-rose-300 bg-rose-50 text-rose-800 text-xs font-medium hover:bg-rose-100 disabled:opacity-50 whitespace-nowrap shrink-0"
                      >
                        {t('common.reject')}
                      </button>
                    </div>
                  </div>
                )}

              {/* Module 6: Supervisor Completion Verification Gate */}
              {awaitingSupervisorSignOff && (
                <div className="space-y-3 pt-3 border-t border-emerald-200 bg-emerald-50/40 rounded-lg p-3.5">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-950">
                    <ShieldCheck className="w-4 h-4 text-emerald-700" aria-hidden="true" />
                    <span>{t('detail.supVerifyRequired')}</span>
                  </div>
                  <p className="text-xs text-slate-700">
                    {t('detail.supVerifyDesc')}
                  </p>
                  <textarea
                    rows={2}
                    value={evidenceReviewNote}
                    onChange={(e) => setEvidenceReviewNote(e.target.value)}
                    placeholder={t('detail.evidenceReviewPlaceholder')}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm"
                  />
                  <div className="space-y-2">
                    <button
                      type="button"
                      disabled={actionLoading}
                      onClick={async () => {
                        const token = await getIdToken();
                        await runAction(
                          () =>
                            staffReviewResolutionEvidence({
                              report,
                              actor: profile,
                              decision: 'approve',
                              reason: evidenceReviewNote || 'Supervisor verified completed work.',
                              idToken: token,
                            }),
                          t('detail.msgWorkVerifiedResolved')
                        );
                        setEvidenceReviewNote('');
                      }}
                      className="w-full py-2 px-3 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 transition-colors"
                    >
                      {t('detail.verifyMarkResolved')}
                    </button>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={actionLoading || evidenceReviewNote.trim().length < 3}
                        onClick={async () => {
                          const token = await getIdToken();
                          await runAction(
                            () =>
                              staffReviewResolutionEvidence({
                                report,
                                actor: profile,
                                decision: 'return_in_progress',
                                reason: evidenceReviewNote,
                                idToken: token,
                              }),
                            t('detail.msgReturnedInProgress')
                          );
                          setEvidenceReviewNote('');
                        }}
                        className="py-2 px-2.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs font-medium hover:bg-amber-100 disabled:opacity-50"
                      >
                        {t('detail.returnInProgress')}
                      </button>
                      <button
                        type="button"
                        disabled={actionLoading || evidenceReviewNote.trim().length < 3}
                        onClick={async () => {
                          const token = await getIdToken();
                          await runAction(
                            () =>
                              staffReviewResolutionEvidence({
                                report,
                                actor: profile,
                                decision: 'reject_evidence',
                                reason: evidenceReviewNote,
                                idToken: token,
                              }),
                            t('detail.msgRejectedIncomplete')
                          );
                          setEvidenceReviewNote('');
                        }}
                        className="py-2 px-2.5 rounded-lg border border-rose-300 bg-rose-50 text-rose-800 text-xs font-medium hover:bg-rose-100 disabled:opacity-50"
                      >
                        {t('detail.rejectIncomplete')}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* FIELD WORKER CONTROLS (Modules 2, 5, 6) */}
          {(effectiveRole === 'worker' || effectiveRole === 'admin') &&
            (report.status === 'assigned' || report.status === 'in_progress') &&
            profile &&
            (report.assignedWorkerId === profile.uid ? (
              <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Wrench className="w-4 h-4 text-blue-700" aria-hidden="true" />
                    <h2 className="text-sm font-semibold text-slate-900">
                      {t('detail.fieldExecHeading')}
                    </h2>
                  </div>
                  {report.acknowledgedAtIso ? (
                    <span className="text-[11px] font-mono text-emerald-700">
                      {t('detail.taskAccepted')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={actionLoading}
                      onClick={async () => {
                        const token = await getIdToken();
                        await runAction(
                          () => workerAcknowledgeTask({ report, actor: profile, idToken: token }),
                          t('detail.msgTaskAccepted')
                        );
                      }}
                      className="px-2.5 py-1 rounded border border-blue-300 bg-blue-50 text-blue-900 text-xs font-medium hover:bg-blue-100 whitespace-nowrap"
                    >
                      {t('detail.acceptTask')}
                    </button>
                  )}
                </div>

                {/* 6-Stage Field Task Lifecycle Indicator */}
                {(() => {
                  const accepted = Boolean(report.acknowledgedAtIso || latestAssignment?.acknowledgedAtIso);
                  const inProg = report.status === 'in_progress' || Boolean(report.workStartedAtIso);
                  const completed = Boolean(
                    report.completedAtIso || latestAssignment?.completedAtIso || awaitingSupervisorSignOff
                  );
                  const supVerified = Boolean(report.supervisorVerifiedAtIso);
                  const lifecycleSteps = [
                    { key: 'assigned', label: tStatus('assigned'), done: true, active: report.status === 'assigned' && !accepted },
                    { key: 'accepted', label: t('detail.lifecycleAccepted'), done: accepted, active: report.status === 'assigned' && accepted },
                    {
                      key: 'in_progress',
                      label: tStatus('in_progress'),
                      done: inProg && completed,
                      active: report.status === 'in_progress' && !awaitingSupervisorSignOff,
                    },
                    { key: 'work_completed', label: t('detail.lifecycleWorkCompleted'), done: completed, active: false },
                    {
                      key: 'sup_verify',
                      label: t('detail.lifecycleSupervisorVerification'),
                      done: supVerified,
                      active: awaitingSupervisorSignOff && !supVerified,
                    },
                    { key: 'resolved', label: tStatus('resolved'), done: false, active: false },
                  ];
                  return (
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      {lifecycleSteps.map((st, idx) => (
                        <React.Fragment key={st.key}>
                          <span
                            className={`px-2 py-0.5 rounded border whitespace-nowrap ${
                              st.active
                                ? 'bg-blue-700 text-white border-blue-700 font-medium'
                                : st.done
                                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                  : 'bg-slate-50 text-slate-500 border-slate-200'
                            }`}
                          >
                            {st.label}
                          </span>
                          {idx < lifecycleSteps.length - 1 && (
                            <span aria-hidden="true" className="text-slate-300">
                              →
                            </span>
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                  );
                })()}

                {awaitingSupervisorSignOff && (
                  <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-950">
                    {t('detail.workerMarkedReadyNote')}
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t('detail.progressDescLabel')}
                  </label>
                  <textarea
                    rows={3}
                    value={workNote}
                    onChange={(e) => setWorkNote(e.target.value)}
                    placeholder={t('detail.progressDescPlaceholder')}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      {t('detail.workStartTimeOpt')}
                    </label>
                    <input
                      type="datetime-local"
                      value={workStartedAtInput}
                      onChange={(e) => setWorkStartedAtInput(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      {t('detail.materialsUsedLabel')}
                    </label>
                    <input
                      type="text"
                      value={materialsUsedInput}
                      onChange={(e) => setMaterialsUsedInput(e.target.value)}
                      placeholder={t('detail.materialsPlaceholder')}
                      className="w-full px-3 py-1.5 rounded-lg border border-slate-300 text-xs"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      {t('detail.obstaclesOpt')}
                    </label>
                    <input
                      type="text"
                      value={obstacleInput}
                      onChange={(e) => setObstacleInput(e.target.value)}
                      placeholder={t('detail.obstaclesPlaceholder')}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      {t('detail.delayExplanationOpt')}
                    </label>
                    <input
                      type="text"
                      value={delayExplanationInput}
                      onChange={(e) => setDelayExplanationInput(e.target.value)}
                      placeholder={t('detail.delayPlaceholder')}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs"
                    />
                  </div>
                </div>

                {/* Optional Text Task Site Note */}
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-2 text-xs">
                  <label className="flex items-center gap-2 font-medium text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeSiteCheckIn}
                      onChange={(e) => setIncludeSiteCheckIn(e.target.checked)}
                      className="rounded border-slate-300"
                    />
                    <span>{t('detail.includeSiteNote')}</span>
                  </label>
                  {includeSiteCheckIn && (
                    <input
                      type="text"
                      value={siteCheckInLabel}
                      onChange={(e) => setSiteCheckInLabel(e.target.value)}
                      placeholder={t('detail.siteLandmarkPlaceholder')}
                      className="w-full px-2.5 py-1.5 rounded border border-slate-300 bg-white text-xs"
                    />
                  )}
                </div>

                {/* Voluntary Opt-In Live Location Sharing (Active Task Only; Stored on Assignment Only) */}
                {latestAssignment && (
                  <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-2.5 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900 flex items-center gap-1.5">
                        <Navigation className="w-3.5 h-3.5 text-blue-700" aria-hidden="true" />
                        <span>{t('detail.activeLocationSharingTitle')}</span>
                      </span>
                      {locationSharingActive && (
                        <span className="px-2 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 text-[11px] font-medium">
                          {t('detail.sharingActive')}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-600 leading-relaxed">
                      {t('detail.locationSharingPolicy')}
                    </p>
                    {locationSharingError && (
                      <p className="text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2.5 py-1.5">
                        {locationSharingError}
                      </p>
                    )}
                    {locationSharingActive && locationCoords && (
                      <p className="font-mono tabular-nums text-[11px] text-slate-800 bg-white border border-slate-200 rounded px-2.5 py-1.5">
                        {t('detail.currentCoords', {
                          lat: locationCoords.lat.toFixed(6),
                          lng: locationCoords.lng.toFixed(6),
                        })}
                        {locationUpdatedAtIso
                          ? ` · ${t('detail.syncedAt', { time: formatTimestamp(locationUpdatedAtIso) })}`
                          : ''}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      {!locationSharingActive ? (
                        <button
                          type="button"
                          disabled={locationSharingBusy}
                          onClick={startWorkerLocationSharing}
                          className="px-3 py-1.5 rounded-lg border border-blue-300 bg-white text-blue-800 font-medium hover:bg-blue-50 disabled:opacity-50 whitespace-nowrap"
                        >
                          {locationSharingBusy
                            ? t('detail.acquiringLocation')
                            : t('detail.shareDuringTask')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={locationSharingBusy}
                          onClick={() => void stopWorkerLocationSharing()}
                          className="px-3 py-1.5 rounded-lg border border-rose-300 bg-rose-50 text-rose-800 font-medium hover:bg-rose-100 disabled:opacity-50 whitespace-nowrap"
                        >
                          {t('detail.stopLocationSharing')}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-700">
                      {t('detail.completionPhotosLabel', { count: newResolutionPhotos.length })}
                    </span>
                    <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer">
                      {uploadingEvidence ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <Camera className="w-3.5 h-3.5" aria-hidden="true" />
                      )}
                      <span>
                        {uploadingEvidence
                          ? t('detail.uploadingPercent', { percent: evidenceProgress?.percent ?? 0 })
                          : t('detail.addPhoto')}
                      </span>
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        onChange={handleUploadEvidence}
                        disabled={uploadingEvidence}
                        className="sr-only"
                      />
                    </label>
                  </div>

                  {evidenceProgress && (
                    <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
                      <div className="flex items-center justify-between text-[11px] text-slate-700">
                        <span className="truncate">{evidenceProgress.message}</span>
                        <span className="font-mono tabular-nums shrink-0">
                          {evidenceProgress.percent}%
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-700 transition-all duration-150"
                          style={{ width: `${evidenceProgress.percent}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {newResolutionPhotos.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {newResolutionPhotos.map((photo, idx) => (
                        <div key={photo.storagePath + idx} className="relative group">
                          <img
                            src={photo.previewUrl || photo.url}
                            alt={t('detail.newCompletionPhotoAlt', { num: idx + 1 })}
                            className="w-16 h-16 rounded border border-slate-200 object-cover"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              if (photo.previewUrl) URL.revokeObjectURL(photo.previewUrl);
                              setNewResolutionPhotos((prev) => prev.filter((_, i) => i !== idx));
                            }}
                            aria-label={t('detail.removeCompletionPhotoAria', { num: idx + 1 })}
                            className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-slate-900 text-white text-[10px] flex items-center justify-center hover:bg-rose-700"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={actionLoading || uploadingEvidence || workNote.trim().length < 5}
                      onClick={async () => {
                        const token = await getIdToken();
                        const cleanMeta = newResolutionPhotos.map(({ previewUrl: _p, ...m }) => m);
                        const startIso = workStartedAtInput
                          ? new Date(workStartedAtInput).toISOString()
                          : undefined;
                        await runAction(
                          () =>
                            workerSubmitFieldUpdate({
                              report,
                              actor: profile,
                              mode: 'progress',
                              workNote,
                              workStartedAtIso: startIso,
                              materialsUsed: materialsUsedInput,
                              obstaclesEncountered: obstacleInput,
                              delayExplanation: delayExplanationInput,
                              clearActiveObstacle: Boolean(report.hasActiveObstacle && !obstacleInput.trim()),
                              workerCheckInLabel: includeSiteCheckIn ? siteCheckInLabel : undefined,
                              resolutionImageUrls: [],
                              resolutionImageMetadata: cleanMeta,
                              idToken: token,
                            }),
                          report.status === 'assigned'
                            ? t('detail.msgTaskStarted')
                            : t('detail.msgProgressRecorded')
                        );
                        setWorkNote('');
                        for (const p of newResolutionPhotos) {
                          if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
                        }
                        setNewResolutionPhotos([]);
                      }}
                      className="py-2.5 px-3 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {report.status === 'assigned'
                        ? t('detail.startWorkInProgress')
                        : t('detail.logProgressUpdate')}
                    </button>

                    <button
                      type="button"
                      disabled={
                        actionLoading ||
                        uploadingEvidence ||
                        (obstacleInput.trim().length < 3 && workNote.trim().length < 3)
                      }
                      onClick={async () => {
                        const token = await getIdToken();
                        const startIso = workStartedAtInput
                          ? new Date(workStartedAtInput).toISOString()
                          : undefined;
                        await runAction(
                          () =>
                            workerSubmitFieldUpdate({
                              report,
                              actor: profile,
                              mode: 'obstacle',
                              workNote: workNote.trim() || obstacleInput.trim(),
                              workStartedAtIso: startIso,
                              materialsUsed: materialsUsedInput,
                              obstaclesEncountered: obstacleInput.trim() || workNote.trim(),
                              delayExplanation: delayExplanationInput,
                              workerCheckInLabel: includeSiteCheckIn ? siteCheckInLabel : undefined,
                              idToken: token,
                            }),
                          t('detail.msgObstacleFlagged')
                        );
                      }}
                      className="py-2.5 px-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs font-medium hover:bg-amber-100 disabled:opacity-50"
                    >
                      {t('detail.flagObstacle')}
                    </button>
                  </div>

                  <button
                    type="button"
                    disabled={actionLoading || uploadingEvidence || workNote.trim().length < 5}
                    onClick={async () => {
                      const token = await getIdToken();
                      const cleanMeta = newResolutionPhotos.map(({ previewUrl: _p, ...m }) => m);
                      const startIso = workStartedAtInput
                        ? new Date(workStartedAtInput).toISOString()
                        : undefined;
                      await runAction(
                        () =>
                          workerSubmitFieldUpdate({
                            report,
                            actor: profile,
                            mode: 'ready_for_verification',
                            workNote,
                            workStartedAtIso: startIso,
                            completedAtIso: new Date().toISOString(),
                            materialsUsed: materialsUsedInput,
                            obstaclesEncountered: obstacleInput,
                            delayExplanation: delayExplanationInput,
                            workerCheckInLabel: includeSiteCheckIn ? siteCheckInLabel : undefined,
                            resolutionImageUrls: [],
                            resolutionImageMetadata: cleanMeta,
                            idToken: token,
                          }),
                        t('detail.msgCompletionSubmitted')
                      );
                      setWorkNote('');
                      for (const p of newResolutionPhotos) {
                        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
                      }
                      setNewResolutionPhotos([]);
                    }}
                    className="w-full py-2.5 px-4 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 disabled:opacity-50"
                  >
                    {t('detail.markReadyForSup')}
                  </button>
                </div>

                {/* Request Supervisor Assistance */}
                <div className="pt-3 border-t border-slate-200 space-y-2">
                  <label className="block text-xs font-medium text-slate-700">
                    {t('detail.requestAssistance')}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={assistanceNoteInput}
                      onChange={(e) => setAssistanceNoteInput(e.target.value)}
                      placeholder={t('detail.requestHelpPlaceholder')}
                      className="flex-1 px-3 py-2 rounded-lg border border-slate-300 text-xs"
                    />
                    <button
                      type="button"
                      disabled={actionLoading || assistanceNoteInput.trim().length < 3}
                      onClick={async () => {
                        const token = await getIdToken();
                        await runAction(
                          () =>
                            workerRequestSupervisorAssistance({
                              report,
                              actor: profile,
                              note: assistanceNoteInput,
                              idToken: token,
                            }),
                          t('detail.msgAssistanceSent')
                        );
                        setAssistanceNoteInput('');
                      }}
                      className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 text-xs font-medium hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      {t('detail.requestHelpBtn')}
                    </button>
                  </div>
                </div>
              </section>
            ) : effectiveRole === 'worker' ? (
              <section className="bg-slate-50 border border-slate-200 rounded-xl p-5 text-xs text-slate-600">
                {t('detail.assignedToOtherWorker', {
                  name: report.assignedWorkerName || t('detail.anotherFieldWorker'),
                })}
              </section>
            ) : null)}

          {/* CITIZEN CLARIFICATION RESPONSE WHEN INFO REQUESTED */}
          {report.status === 'under_review' &&
            profile &&
            report.reporterId === profile.uid &&
            latestInfoRequest && (
              <section className="bg-white border border-amber-200 rounded-xl p-6 space-y-3">
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-amber-700" aria-hidden="true" />
                  <h2 className="text-sm font-semibold text-slate-900">
                    {t('detail.provideRequestedInfo')}
                  </h2>
                </div>
                <p className="text-xs text-slate-600">
                  {t('detail.staffRequestedQuote', {
                    note: latestInfoRequest.note.replace(/^More information requested:\s*/i, ''),
                  })}
                </p>
                <textarea
                  rows={2}
                  value={citizenClarification}
                  onChange={(e) => setCitizenClarification(e.target.value)}
                  placeholder={t('detail.clarificationPlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                />
                <button
                  type="button"
                  disabled={actionLoading || citizenClarification.trim().length < 3}
                  onClick={async () => {
                    const token = await getIdToken();
                    await runAction(
                      () =>
                        citizenProvideAdditionalInfo({
                          report,
                          citizen: profile,
                          clarification: citizenClarification,
                          idToken: token,
                        }),
                      t('detail.msgClarificationAdded')
                    );
                    setCitizenClarification('');
                  }}
                  className="w-full py-2 px-4 rounded-lg bg-amber-700 text-white text-xs font-medium hover:bg-amber-800 disabled:opacity-50"
                >
                  {t('detail.submitClarification')}
                </button>
              </section>
            )}

          {/* CITIZEN RESOLUTION CONFIRMATION OR REOPEN CONTROLS */}
          {report.status === 'resolved' &&
            profile &&
            report.reporterId === profile.uid && (
              <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-700" aria-hidden="true" />
                  <h2 className="text-sm font-semibold text-slate-900">
                    {t('detail.resolutionConfirmation')}
                  </h2>
                </div>

                <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-1.5">
                  <p className="font-semibold text-slate-800">
                    {t('detail.workerResolutionDesc')}
                    {latestResolvedUpdate
                      ? ` · ${formatTimestamp(latestResolvedUpdate.createdAt)}`
                      : ''}
                  </p>
                  <p className="text-slate-700 leading-relaxed">
                    {report.resolutionNotes ||
                      latestResolvedUpdate?.note ||
                      t('detail.fieldCrewResolvedDefault')}
                  </p>
                </div>

                <p className="text-xs text-slate-600">
                  {t('detail.confirmOrReopenHint')}
                </p>

                <div className="space-y-2.5 pt-1">
                  <label className="block text-xs font-medium text-slate-700">
                    {t('detail.optionalConfirmNote')}
                  </label>
                  <input
                    type="text"
                    value={confirmNoteInput}
                    onChange={(e) => setConfirmNoteInput(e.target.value)}
                    placeholder={t('detail.confirmNotePlaceholder')}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs"
                  />
                  <button
                    type="button"
                    disabled={actionLoading}
                    onClick={async () => {
                      const token = await getIdToken();
                      await runAction(
                        () =>
                          citizenConfirmOrReopenReport({
                            report,
                            citizen: profile,
                            outcome: 'confirmed',
                            comment: confirmNoteInput,
                            idToken: token,
                          }),
                        t('detail.msgResolutionConfirmed')
                      );
                      setConfirmNoteInput('');
                    }}
                    className="w-full py-2.5 px-4 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 disabled:opacity-50 transition-colors"
                  >
                    {t('detail.confirmResolutionBtn')}
                  </button>
                </div>

                <div className="pt-3 border-t border-slate-200 space-y-2.5">
                  <label className="block text-xs font-medium text-slate-700">
                    {t('detail.reopenMandatoryLabel')}
                  </label>
                  <textarea
                    rows={2}
                    value={reopenReasonInput}
                    onChange={(e) => setReopenReasonInput(e.target.value)}
                    placeholder={t('detail.reopenPlaceholder')}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs"
                  />
                  <button
                    type="button"
                    disabled={actionLoading || reopenReasonInput.trim().length < 3}
                    onClick={async () => {
                      const token = await getIdToken();
                      await runAction(
                        () =>
                          citizenConfirmOrReopenReport({
                            report,
                            citizen: profile,
                            outcome: 'reopened',
                            comment: reopenReasonInput,
                            idToken: token,
                          }),
                        t('detail.msgReopenedNotified')
                      );
                      setReopenReasonInput('');
                    }}
                    className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-lg border border-orange-300 bg-orange-50 text-orange-900 text-xs font-medium hover:bg-orange-100 disabled:opacity-50 transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{t('detail.reopenBtn')}</span>
                  </button>
                </div>
              </section>
            )}

          {/* POST-CONFIRMATION CITIZEN FEEDBACK (1-5 RATING + OPTIONAL WRITTEN FEEDBACK) */}
          {report.status === 'citizen_confirmed' &&
            profile &&
            report.reporterId === profile.uid && (
              <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Star className="w-4 h-4 text-amber-500" aria-hidden="true" />
                    <h2 className="text-sm font-semibold text-slate-900">
                      {t('detail.citizenServiceFeedback')}
                    </h2>
                  </div>
                  {confirmedFeedback && (
                    <span className="text-[11px] font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
                      {t('common.submitted')}
                    </span>
                  )}
                </div>

                {!confirmedFeedback ? (
                  <div className="space-y-4">
                    <p className="text-xs text-slate-600">
                      {t('detail.ratingInstructions')}
                    </p>

                    <div>
                      <span className="block text-xs font-medium text-slate-700 mb-2">
                        {t('detail.rating1to5')}
                      </span>
                      <div className="grid grid-cols-5 gap-2">
                        {[1, 2, 3, 4, 5].map((starValue) => {
                          const selected = citizenRating === starValue;
                          return (
                            <button
                              key={starValue}
                              type="button"
                              onClick={() => setCitizenRating(starValue)}
                              aria-label={t('detail.rateOutOf5Aria', { star: starValue })}
                              className={`py-2 px-2 rounded-lg border text-xs font-mono font-semibold flex items-center justify-center gap-1 transition-colors ${
                                selected
                                  ? 'bg-blue-700 text-white border-blue-700'
                                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                              }`}
                            >
                              <span>{starValue}</span>
                              <Star
                                className={`w-3.5 h-3.5 ${selected ? 'fill-current' : 'text-amber-500'}`}
                                aria-hidden="true"
                              />
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        {t('detail.writtenFeedbackOpt')}
                      </label>
                      <textarea
                        rows={3}
                        value={citizenComment}
                        onChange={(e) => setCitizenComment(e.target.value)}
                        placeholder={t('detail.writtenFeedbackPlaceholder')}
                        className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                      />
                    </div>

                    <button
                      type="button"
                      disabled={actionLoading}
                      onClick={async () => {
                        const token = await getIdToken();
                        await runAction(
                          () =>
                            submitCitizenFeedback({
                              report,
                              citizen: profile,
                              rating: citizenRating,
                              comment: citizenComment,
                              idToken: token,
                            }),
                          t('detail.msgFeedbackSaved', { rating: citizenRating })
                        );
                        setCitizenComment('');
                      }}
                      className="w-full py-2.5 px-4 rounded-lg bg-blue-700 text-white text-xs font-medium hover:bg-blue-800 disabled:opacity-50 transition-colors"
                    >
                      {t('detail.submitFeedbackBtn', { rating: citizenRating })}
                    </button>
                  </div>
                ) : (
                  <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900 font-mono tabular-nums">
                        {t('detail.ratingSubmitted', { rating: confirmedFeedback.rating })}
                      </span>
                      <span className="font-mono tabular-nums text-slate-500">
                        {formatTimestamp(confirmedFeedback.createdAt)}
                      </span>
                    </div>
                    <p className="text-slate-700">{confirmedFeedback.comment}</p>
                    <p className="text-[11px] text-slate-500 pt-1">
                      {t('detail.feedbackLockedNote')}
                    </p>
                  </div>
                )}
              </section>
            )}

          {/* Citizen Feedback & Disagreement Audit Record */}
          {feedbacks.length > 0 && (
            <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
              <h2 className="text-sm font-semibold text-slate-900">
                {t('detail.citizenFeedbackRecord')}
              </h2>
              <ul className="divide-y divide-slate-200">
                {feedbacks.map((fb) => (
                  <li key={fb.id} className="py-2.5 first:pt-0 last:pb-0 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900">
                        {fb.outcome === 'confirmed'
                          ? t('detail.confirmedFeedbackScore', { rating: fb.rating })
                          : t('detail.reopenedDisagreement')}
                      </span>
                      <span className="font-mono tabular-nums text-slate-500">
                        {formatTimestamp(fb.createdAt)}
                      </span>
                    </div>
                    <p className="text-slate-700">{fb.comment}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {isTerminal && (
            <section className="bg-slate-50 border border-slate-200 rounded-xl p-5 text-xs text-slate-600 flex items-center gap-2">
              {report.status === 'citizen_confirmed' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
              ) : (
                <XCircle className="w-4 h-4 text-rose-700 shrink-0" aria-hidden="true" />
              )}
              <span>
                {t('detail.closedTerminalNotice', { status: tStatus(report.status) })}
              </span>
            </section>
          )}
        </div>
      </div>

      <GmailConfirmModal
        open={showGmailRetryModal}
        title={t('detail.gmailRetryTitle')}
        description={t('detail.gmailRetryDesc', {
          code: report.trackingCode,
          title: report.title,
          dept: report.departmentName
            ? tDepartmentName(report.departmentId, report.departmentName)
            : t('detail.assignedMunicipalDept'),
        })}
        senderEmail={user?.email}
        recipientLabel={t('submit.gmailRecipientLabel', {
          dept: report.departmentName
            ? tDepartmentName(report.departmentId, report.departmentName)
            : t('detail.assignedDept'),
        })}
        gmailConnected={gmailConnected}
        connectingGmail={connectingGmail}
        busy={retryingEmail}
        error={gmailRetryError}
        confirmLabel={t('detail.confirmSendEmail')}
        onConnectGmail={async () => {
          setGmailRetryError(null);
          try {
            await connectGmail();
          } catch (err: unknown) {
            setGmailRetryError(tError(formatFriendlyError(err)));
          }
        }}
        onConfirmSend={async () => {
          const gmailToken = getGmailAccessToken();
          if (!gmailToken) {
            invalidateGmailToken();
            setGmailRetryError(t('emailSettings.gmailSessionExpired'));
            return;
          }
          setGmailRetryError(null);
          setRetryingEmail(true);
          try {
            const token = await getIdToken();
            const outcome = await retryAuthorityEmailViaServer(report.id, token, gmailToken);
            setReport((prev) => ({
              ...prev,
              authorityEmailStatus: outcome.authorityEmailStatus,
              authorityEmailStatusNote: outcome.authorityEmailStatusNote,
              authorityEmailSentAtIso: outcome.authorityEmailSentAtIso,
            }));
            if (outcome.authorityEmailStatus === 'sent') {
              setShowGmailRetryModal(false);
              setActionSuccess(outcome.authorityEmailStatusNote);
            } else if (
              outcome.authorityEmailStatusNote.toLowerCase().includes('gmail permission') ||
              outcome.authorityEmailStatusNote.includes('401') ||
              outcome.authorityEmailStatusNote.includes('403')
            ) {
              invalidateGmailToken();
              setGmailRetryError(outcome.authorityEmailStatusNote);
            } else {
              setShowGmailRetryModal(false);
              setActionError(outcome.authorityEmailStatusNote);
            }
          } catch (err: unknown) {
            const friendly = formatFriendlyError(err);
            if (friendly.toLowerCase().includes('gmail permission') || friendly.includes('401') || friendly.includes('403')) {
              invalidateGmailToken();
            }
            setGmailRetryError(tError(friendly));
          } finally {
            setRetryingEmail(false);
          }
        }}
        onCancel={() => {
          setShowGmailRetryModal(false);
          setGmailRetryError(null);
        }}
      />
    </div>
  );
}
