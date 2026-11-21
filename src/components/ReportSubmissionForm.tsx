import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Info,
  Loader2,
  MapPin,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { GmailConfirmModal } from './GmailConfirmModal';
import {
  analyzeImageViaServer,
  createCivicReport,
  deleteTemporaryUpload,
  detectDuplicatesViaServer,
  fetchServerEmailTransportStatus,
  formatFriendlyError,
  resolveDepartmentForCategory,
  uploadValidatedImage,
  type ServerEmailTransportInfo,
  type UploadProgressInfo,
} from '../lib/civicService';
import {
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  type AiPhotoAssessmentResult,
  type Department,
  type DuplicateCandidate,
  type IssueCategory,
  type IssuePriority,
  type UploadedImageMetadata,
} from '../types/civic';

export interface SubmissionRoutingInfo {
  departmentId: string;
  departmentName: string;
  authorityEmailStatus: string;
  authorityEmailStatusNote: string;
  citizenNotificationStatus: string;
  citizenEmailSent?: boolean;
  citizenEmailNote?: string;
}

interface ReportSubmissionFormProps {
  departments?: Department[];
  onSubmitted: (reportId: string, trackingCode: string, routingInfo?: SubmissionRoutingInfo) => void;
  onCancel: () => void;
}

interface DraftUploadedPhoto {
  uploadId: string;
  previewUrl: string;
  file: File;
  metadata: UploadedImageMetadata;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const SAMPLE_DISTRICTS = [
  { label: 'Downtown Civic Center', lat: 37.7793, lng: -122.4193, ward: 'Ward 1 · Central' },
  { label: 'Northside Transit Corridor', lat: 37.7897, lng: -122.4014, ward: 'Ward 3 · North' },
  { label: 'Harbor & Waterfront District', lat: 37.7689, lng: -122.3892, ward: 'Ward 5 · Waterfront' },
];

const MAX_PHOTOS = 5;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function ReportSubmissionForm({
  departments,
  onSubmitted,
  onCancel,
}: ReportSubmissionFormProps) {
  const {
    user,
    profile,
    gmailConnected,
    connectingGmail,
    connectGmail,
    getGmailAccessToken,
    invalidateGmailToken,
    getIdToken,
  } = useAuth();
  const { t, tCategory, tPriority, tStatus, tDepartmentName, tError } = useLanguage();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<IssueCategory>('pothole');
  const [priority, setPriority] = useState<IssuePriority>('medium');
  const [addressText, setAddressText] = useState('');
  const [wardOrZone, setWardOrZone] = useState('Ward 1 · Central');
  const [latitude, setLatitude] = useState<number>(37.7793);
  const [longitude, setLongitude] = useState<number>(-122.4193);

  const [uploadedPhotos, setUploadedPhotos] = useState<DraftUploadedPhoto[]>([]);
  const photosRef = useRef<DraftUploadedPhoto[]>([]);
  photosRef.current = uploadedPhotos;
  const submittedRef = useRef(false);

  useEffect(() => {
    return () => {
      for (const item of photosRef.current) {
        URL.revokeObjectURL(item.previewUrl);
      }
      if (!submittedRef.current && photosRef.current.length > 0) {
        void getIdToken()
          .then((token) =>
            Promise.all(photosRef.current.map((item) => deleteTemporaryUpload(item.uploadId, token)))
          )
          .catch(() => {});
      }
    };
  }, [getIdToken]);

  const [uploadProgress, setUploadProgress] = useState<{
    fileName: string;
    info: UploadProgressInfo;
  } | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  const [aiStatus, setAiStatus] = useState<'idle' | 'analyzing' | 'completed' | 'failed'>('idle');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiAssessment, setAiAssessment] = useState<AiPhotoAssessmentResult | null>(null);
  const [aiAppliedNote, setAiAppliedNote] = useState(false);

  const [dupLoading, setDupLoading] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const [dupChecked, setDupChecked] = useState(false);

  const [locating, setLocating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [serverEmailInfo, setServerEmailInfo] = useState<ServerEmailTransportInfo | null>(null);
  const [showGmailConfirmModal, setShowGmailConfirmModal] = useState(false);
  const [gmailModalError, setGmailModalError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchServerEmailTransportStatus().then((info) => {
      if (!cancelled) setServerEmailInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    if (selectedFiles.length === 0) return;

    setError(null);
    setUploadSuccess(null);
    setAiError(null);
    setAiAppliedNote(false);

    const remainingSlots = MAX_PHOTOS - uploadedPhotos.length;
    if (remainingSlots <= 0) {
      setError(t('submit.errMaxPhotos', { max: MAX_PHOTOS }));
      return;
    }

    if (selectedFiles.length > remainingSlots) {
      setError(
        t('submit.errSlotsRemaining', {
          selected: selectedFiles.length,
          remaining: remainingSlots,
          max: MAX_PHOTOS,
        })
      );
      return;
    }

    let currentCount = uploadedPhotos.length;
    let lastUploadedDraft: DraftUploadedPhoto | null = null;
    const newlyAdded: DraftUploadedPhoto[] = [];

    try {
      setUploadingPhoto(true);
      const token = await getIdToken();

      for (const file of selectedFiles) {
        if (!ALLOWED_TYPES.includes(file.type)) {
          throw new Error(
            `"${file.name}" has unsupported format (${file.type || 'unknown'}). Only JPEG, PNG, and WebP images are allowed.`
          );
        }
        if (file.size === 0) {
          throw new Error(`"${file.name}" is empty (0 bytes).`);
        }
        if (file.size > MAX_FILE_BYTES) {
          throw new Error(
            `"${file.name}" is ${formatBytes(file.size)}, which exceeds the 5 MB limit.`
          );
        }

        const uploaded = await uploadValidatedImage(file, token, 'reports', {
          existingCount: currentCount,
          onProgress: (info) => setUploadProgress({ fileName: file.name, info }),
        });

        const previewUrl = URL.createObjectURL(file);
        const draft: DraftUploadedPhoto = {
          uploadId: uploaded.uploadId,
          previewUrl,
          file,
          metadata: {
            url: uploaded.url,
            fileName: uploaded.fileName,
            mimeType: uploaded.mimeType,
            sizeBytes: uploaded.sizeBytes,
            storageProvider: uploaded.storageProvider,
            storagePath: uploaded.storagePath,
            uploadedBy: uploaded.uploadedBy,
            uploadedAtIso: uploaded.uploadedAtIso,
          },
        };

        newlyAdded.push(draft);
        currentCount += 1;
        lastUploadedDraft = draft;
        setUploadedPhotos((prev) => [...prev, draft]);
      }

      setUploadSuccess(t('submit.uploadValidatedSuccess', { count: newlyAdded.length }));

      if (lastUploadedDraft) {
        setAiAssessment(null);
        setAiStatus('analyzing');
        setAiLoading(true);
        try {
          const result = await analyzeImageViaServer(
            lastUploadedDraft.file,
            lastUploadedDraft.uploadId,
            token,
            title || description
          );
          setAiAssessment(result);
          setAiStatus('completed');
        } catch (aiErr: unknown) {
          setAiAssessment(null);
          setAiStatus('failed');
          setAiError(formatFriendlyError(aiErr));
        } finally {
          setAiLoading(false);
        }
      }
    } catch (err: unknown) {
      setError(formatFriendlyError(err));
    } finally {
      setUploadingPhoto(false);
      setUploadProgress(null);
    }
  };

  const handleRemovePhoto = async (index: number) => {
    const target = uploadedPhotos[index];
    if (!target) return;
    URL.revokeObjectURL(target.previewUrl);
    const remaining = uploadedPhotos.filter((_, i) => i !== index);
    setUploadedPhotos(remaining);
    if (remaining.length === 0) {
      setAiAssessment(null);
      setAiError(null);
      setAiStatus('idle');
      setAiAppliedNote(false);
    }
    try {
      const token = await getIdToken();
      await deleteTemporaryUpload(target.uploadId, token);
    } catch {
      // Non-blocking
    }
  };

  const applyAiSuggestions = () => {
    if (!aiAssessment) return;
    setCategory(aiAssessment.suggestedCategory);
    setPriority(aiAssessment.suggestedPriority);
    if (!description.trim()) {
      setDescription(aiAssessment.factualDescription);
    }
    if (!title.trim()) {
      const baseTitle =
        aiAssessment.detectedIssue ||
        `${CATEGORY_LABELS[aiAssessment.suggestedCategory]} — ${addressText || 'Reported Issue'}`;
      setTitle(baseTitle.slice(0, 140));
    }
    setAiAppliedNote(true);
  };

  const handleDetectLocation = () => {
    if (!navigator.geolocation) {
      setError(t('submit.errGeoUnavailable'));
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLatitude(Number(pos.coords.latitude.toFixed(6)));
        setLongitude(Number(pos.coords.longitude.toFixed(6)));
        if (!addressText.trim()) {
          setAddressText(
            `GPS (${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)})`
          );
        }
        setLocating(false);
      },
      () => {
        setLocating(false);
        setError(t('submit.errGeoDenied'));
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  const handleDuplicateCheck = async () => {
    setDupLoading(true);
    setError(null);
    try {
      const token = await getIdToken();
      const result = await detectDuplicatesViaServer(
        {
          title: title || CATEGORY_LABELS[category],
          description,
          category,
          latitude,
          longitude,
        },
        token
      );
      setDuplicates(result.candidates);
      setDupChecked(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Duplicate check failed.');
    } finally {
      setDupLoading(false);
    }
  };

  const executeReportSubmit = async (gmailAccessToken: string | null) => {
    if (!profile) return;
    setError(null);
    setGmailModalError(null);
    try {
      setSubmitting(true);
      const token = await getIdToken();
      const result = await createCivicReport({
        reporter: profile,
        title,
        description,
        category,
        priority,
        addressText,
        wardOrZone,
        latitude,
        longitude,
        imageUrls: [],
        imageMetadata: uploadedPhotos.map((p) => p.metadata),
        uploadIds: uploadedPhotos.map((p) => p.uploadId),
        aiAssessment,
        departments,
        idToken: token,
        gmailAccessToken,
      });
      submittedRef.current = true;
      setShowGmailConfirmModal(false);
      onSubmitted(result.reportId, result.trackingCode, {
        departmentId: result.departmentId,
        departmentName: result.departmentName,
        authorityEmailStatus: result.authorityEmailStatus,
        authorityEmailStatusNote: result.authorityEmailStatusNote,
        citizenNotificationStatus: result.citizenNotificationStatus,
        citizenEmailSent: result.citizenEmailSent,
        citizenEmailNote: result.citizenEmailNote,
      });
    } catch (err: unknown) {
      setShowGmailConfirmModal(false);
      setError(formatFriendlyError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    setError(null);
    setGmailModalError(null);

    if (uploadingPhoto || aiLoading) {
      setError(t('submit.errWaitUploadAi'));
      return;
    }
    if (title.trim().length < 3) {
      setError(t('submit.errTitleShort'));
      return;
    }
    if (description.trim().length < 5) {
      setError(t('submit.errDescShort'));
      return;
    }
    if (addressText.trim().length < 2) {
      setError(t('submit.errAddressShort'));
      return;
    }
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      setError(t('submit.errInvalidLat'));
      return;
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      setError(t('submit.errInvalidLng'));
      return;
    }

    const transportInfo = serverEmailInfo || (await fetchServerEmailTransportStatus());
    setServerEmailInfo(transportInfo);
    if (transportInfo.emailConfigured) {
      await executeReportSubmit(null);
      return;
    }

    // Server SMTP/Resend not configured: require explicit user confirmation before sending via Gmail
    setShowGmailConfirmModal(true);
  };

  const handleManualReanalyze = async () => {
    const latestDraft = uploadedPhotos[uploadedPhotos.length - 1];
    if (!latestDraft?.file) {
      setAiStatus('failed');
      setAiError(t('submit.errNeedPhotoForAi'));
      return;
    }
    setAiError(null);
    setAiAssessment(null);
    setAiAppliedNote(false);
    setAiStatus('analyzing');
    setAiLoading(true);
    try {
      const token = await getIdToken();
      const result = await analyzeImageViaServer(
        latestDraft.file,
        latestDraft.uploadId,
        token,
        title || description
      );
      setAiAssessment(result);
      setAiStatus('completed');
    } catch (aiErr: unknown) {
      setAiAssessment(null);
      setAiStatus('failed');
      setAiError(formatFriendlyError(aiErr));
    } finally {
      setAiLoading(false);
    }
  };

  const routedDept = resolveDepartmentForCategory(category, departments);
  const localizedRoutedDeptName = tDepartmentName(routedDept.departmentId, routedDept.departmentName);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            {t('submit.title')}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {t('submit.subtitle')}
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
        >
          {t('submit.backToReports')}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2.5 p-3.5 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-800"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{tError(error)}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Step 1: Photograph & Server-Side Gemini AI Visual Analysis */}
        <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                {t('submit.step1Title')}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {t('submit.step1Hint')}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {uploadedPhotos.length > 0 && (
                <button
                  type="button"
                  onClick={handleManualReanalyze}
                  disabled={aiLoading || uploadingPhoto}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                >
                  <Sparkles className="w-3.5 h-3.5 text-blue-700" aria-hidden="true" />
                  <span>{aiLoading ? t('submit.analyzing') : t('submit.rerunAi')}</span>
                </button>
              )}
              <label
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-700 text-white text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                  uploadingPhoto || uploadedPhotos.length >= MAX_PHOTOS
                    ? 'opacity-60 cursor-not-allowed'
                    : 'hover:bg-blue-800 cursor-pointer'
                }`}
              >
                {uploadingPhoto ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Upload className="w-4 h-4" aria-hidden="true" />
                )}
                <span>
                  {uploadingPhoto
                    ? t('submit.uploadingPct', { pct: uploadProgress?.info.percent ?? 0 })
                    : t('submit.uploadPhotoCount', { count: uploadedPhotos.length, max: MAX_PHOTOS })}
                </span>
                <input
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handlePhotoUpload}
                  disabled={uploadingPhoto || uploadedPhotos.length >= MAX_PHOTOS}
                  className="sr-only"
                />
              </label>
            </div>
          </div>

          {uploadProgress && (
            <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs text-slate-700">
                <span className="font-medium truncate">{uploadProgress.info.message}</span>
                <span className="font-mono tabular-nums text-slate-600 shrink-0">
                  {uploadProgress.info.percent}%
                </span>
              </div>
              <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-700 transition-all duration-150"
                  style={{ width: `${uploadProgress.info.percent}%` }}
                />
              </div>
            </div>
          )}

          {uploadSuccess && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900">
              <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{uploadSuccess}</span>
            </div>
          )}

          <div className="flex items-start gap-2.5 p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700">
            <Info className="w-4 h-4 text-blue-700 mt-0.5 shrink-0" aria-hidden="true" />
            <span>{t('submit.photoPrivacyNotice')}</span>
          </div>

          {uploadedPhotos.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {uploadedPhotos.map((photo, idx) => (
                <div
                  key={photo.uploadId + idx}
                  className="rounded-lg border border-slate-200 overflow-hidden bg-white"
                >
                  <div className="relative aspect-[4/3] bg-slate-100">
                    <img
                      src={photo.previewUrl}
                      alt={`${photo.metadata.fileName}`}
                      className="w-full h-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemovePhoto(idx)}
                      aria-label={t('common.remove')}
                      className="absolute top-2 right-2 p-1.5 rounded bg-slate-900/80 text-white hover:bg-rose-700 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                  <div className="p-2.5 border-t border-slate-200 text-xs space-y-0.5">
                    <p className="font-medium text-slate-900 truncate" title={photo.metadata.fileName}>
                      {photo.metadata.fileName}
                    </p>
                    <p className="font-mono tabular-nums text-[11px] text-slate-500">
                      {photo.metadata.mimeType.replace('image/', '').toUpperCase()} · {formatBytes(photo.metadata.sizeBytes)} · {t('submit.tempValidation')}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="border border-dashed border-slate-300 rounded-lg p-6 text-center bg-slate-50/70">
              <Camera className="w-6 h-6 text-slate-400 mx-auto mb-2" aria-hidden="true" />
              <p className="text-sm text-slate-600">
                {t('submit.uploadEmptyHint')}
              </p>
            </div>
          )}

          {aiLoading && (
            <div className="flex items-center justify-between gap-3 p-4 rounded-lg bg-slate-50 border border-slate-200 text-sm text-slate-700">
              <div className="flex items-center gap-2.5">
                <Loader2 className="w-4 h-4 animate-spin text-blue-700 shrink-0" aria-hidden="true" />
                <span>{t('submit.aiAnalyzingBanner')}</span>
              </div>
              <span className="text-xs font-mono text-blue-700 shrink-0">
                {t('submit.statusAnalyzing')}
              </span>
            </div>
          )}

          {aiError && !aiLoading && (
            <div
              role="alert"
              className="p-4 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-900 space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-semibold">
                  <AlertTriangle className="w-4 h-4 text-rose-700 shrink-0" aria-hidden="true" />
                  <span>{t('submit.aiFailedTitle')}</span>
                </div>
                <span className="text-xs font-mono text-rose-800">{t('submit.statusFailed')}</span>
              </div>
              <p className="text-xs text-rose-800 leading-relaxed">
                {t('submit.aiFailedHint', { error: tError(aiError) })}
              </p>
              {uploadedPhotos.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={handleManualReanalyze}
                    disabled={aiLoading || uploadingPhoto}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-700 text-white text-xs font-medium hover:bg-rose-800 disabled:opacity-50 transition-colors"
                  >
                    <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{t('submit.retryAnalysis')}</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {aiAssessment && !aiLoading && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Sparkles className="w-4 h-4 text-blue-700 shrink-0" aria-hidden="true" />
                  <h3 className="text-sm font-semibold text-slate-900">
                    {t('submit.aiResultsTitle')}
                  </h3>
                  <span className="text-[11px] font-mono text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
                    {aiStatus === 'completed' ? t('submit.statusCompleted') : t('submit.statusReady')}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={handleManualReanalyze}
                    disabled={aiLoading || uploadingPhoto}
                    className="px-2.5 py-1.5 text-xs font-medium rounded-md bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 transition-colors whitespace-nowrap"
                  >
                    {t('submit.retryAnalysis')}
                  </button>
                  <button
                    type="button"
                    onClick={applyAiSuggestions}
                    className="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-700 text-white hover:bg-blue-800 transition-colors whitespace-nowrap"
                  >
                    {t('submit.applySuggestions')}
                  </button>
                </div>
              </div>

              {aiAppliedNote && (
                <div className="flex items-center gap-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>{t('submit.aiAppliedNotice')}</span>
                </div>
              )}

              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-md bg-white border border-slate-200">
                  <dt className="text-slate-500 font-medium">{t('submit.aiDetectedIssue')}</dt>
                  <dd className="text-slate-900 font-semibold mt-0.5">{aiAssessment.detectedIssue}</dd>
                </div>
                <div className="p-3 rounded-md bg-white border border-slate-200">
                  <dt className="text-slate-500 font-medium">{t('submit.aiIssueCategory')}</dt>
                  <dd className="text-slate-900 font-semibold mt-0.5">
                    {tCategory(aiAssessment.suggestedCategory)}
                  </dd>
                </div>
                <div className="p-3 rounded-md bg-white border border-slate-200">
                  <dt className="text-slate-500 font-medium">{t('submit.aiSuggestedPriority')}</dt>
                  <dd className="text-slate-900 font-semibold mt-0.5">
                    {tPriority(aiAssessment.suggestedPriority)}
                    <span className="block font-normal text-slate-600 mt-0.5">
                      {aiAssessment.priorityExplanation}
                    </span>
                  </dd>
                </div>
                <div className="p-3 rounded-md bg-white border border-slate-200">
                  <dt className="text-slate-500 font-medium">{t('submit.aiResponsibleDept')}</dt>
                  <dd className="text-slate-900 font-semibold mt-0.5">
                    {(() => {
                      const aiDept = resolveDepartmentForCategory(aiAssessment.suggestedCategory, departments);
                      return tDepartmentName(
                        aiAssessment.suggestedDepartmentId || aiDept.departmentId,
                        aiAssessment.suggestedDepartmentName || aiDept.departmentName
                      );
                    })()}
                  </dd>
                </div>
              </dl>

              <div className="p-3 rounded-md bg-white border border-slate-200 space-y-2 text-xs">
                <div>
                  <p className="text-slate-500 font-medium">{t('submit.aiDescription')}</p>
                  <p className="text-sm text-slate-800 leading-relaxed mt-0.5">
                    {aiAssessment.factualDescription}
                  </p>
                </div>
                {Array.isArray(aiAssessment.visibleEvidence) && aiAssessment.visibleEvidence.length > 0 && (
                  <div className="pt-2 border-t border-slate-100">
                    <p className="text-slate-500 font-medium">{t('submit.aiVisibleEvidence')}</p>
                    <ul className="mt-1 list-disc list-inside space-y-0.5 text-slate-800">
                      {aiAssessment.visibleEvidence.map((item, idx) => (
                        <li key={idx}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="pt-2 border-t border-slate-100">
                  <p className="text-slate-500 font-medium">{t('submit.aiRecommendedSolution')}</p>
                  <p className="text-slate-800 leading-relaxed mt-0.5">
                    {aiAssessment.recommendedAction}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-600 font-mono tabular-nums">
                <span>{t('submit.confidence', { pct: Math.round(aiAssessment.confidenceScore * 100) })}</span>
                <span>{t('submit.imageClarity', { clarity: aiAssessment.imageQualityStatus.replace('_', ' ') })}</span>
                <span>{t('submit.model', { model: aiAssessment.modelUsed })}</span>
              </div>

              {aiAssessment.requiresHumanReview && (
                <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 border border-amber-200 text-xs text-amber-900">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                  <div>
                    <span className="font-semibold">{t('submit.humanVerificationFlagged')} </span>
                    <span>{aiAssessment.reviewReason}</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Step 2: Issue Details */}
        <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <h2 className="text-base font-semibold text-slate-900">{t('submit.step2Title')}</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label htmlFor="report-title" className="block text-sm font-medium text-slate-700 mb-1">
                {t('submit.issueTitleLabel')}
              </label>
              <input
                id="report-title"
                type="text"
                required
                maxLength={160}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('submit.issueTitlePlaceholder')}
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
              />
            </div>

            <div>
              <label htmlFor="report-category" className="block text-sm font-medium text-slate-700 mb-1">
                {t('common.category')}
              </label>
              <select
                id="report-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as IssueCategory)}
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                {(Object.keys(CATEGORY_LABELS) as IssueCategory[]).map((k) => (
                  <option key={k} value={k}>
                    {tCategory(k)}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500">
                {t('submit.autoDeptRouting')}{' '}
                <span className="font-medium text-slate-700">{localizedRoutedDeptName}</span>
              </p>
            </div>

            <div>
              <label htmlFor="report-priority" className="block text-sm font-medium text-slate-700 mb-1">
                {t('submit.reporterUrgency')}
              </label>
              <select
                id="report-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as IssuePriority)}
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                {(Object.keys(PRIORITY_LABELS) as IssuePriority[]).map((k) => (
                  <option key={k} value={k}>
                    {tPriority(k)}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500">
                {t('submit.priorityServerNote')}
              </p>
            </div>

            <div className="md:col-span-2">
              <label htmlFor="report-description" className="block text-sm font-medium text-slate-700 mb-1">
                {t('submit.detailedDescription')}
              </label>
              <textarea
                id="report-description"
                rows={4}
                required
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('submit.descriptionPlaceholder')}
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
          </div>
        </section>

        {/* Step 3: Location & Duplicate Check */}
        <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-900">{t('submit.step3Title')}</h2>
            <button
              type="button"
              onClick={handleDetectLocation}
              disabled={locating}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
            >
              {locating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <MapPin className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>{locating ? t('submit.locating') : t('submit.useCurrentGps')}</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-500">{t('submit.quickZones')}</span>
            {SAMPLE_DISTRICTS.map((z) => (
              <button
                key={z.label}
                type="button"
                onClick={() => {
                  setLatitude(z.lat);
                  setLongitude(z.lng);
                  setWardOrZone(z.ward);
                  if (!addressText.trim()) setAddressText(z.label);
                }}
                className="px-2.5 py-1 rounded border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 transition-colors"
              >
                {z.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-6 gap-4">
            <div className="md:col-span-2">
              <label htmlFor="report-address" className="block text-sm font-medium text-slate-700 mb-1">
                {t('submit.streetAddress')}
              </label>
              <input
                id="report-address"
                type="text"
                required
                maxLength={240}
                value={addressText}
                onChange={(e) => setAddressText(e.target.value)}
                placeholder={t('submit.addressPlaceholder')}
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <div className="md:col-span-2">
              <label htmlFor="report-ward" className="block text-sm font-medium text-slate-700 mb-1">
                {t('submit.wardDistrict')}
              </label>
              <input
                id="report-ward"
                type="text"
                maxLength={80}
                value={wardOrZone}
                onChange={(e) => setWardOrZone(e.target.value)}
                placeholder={t('submit.wardPlaceholder')}
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <div>
              <label htmlFor="report-lat" className="block text-sm font-medium text-slate-700 mb-1">
                {t('submit.latitude')}
              </label>
              <input
                id="report-lat"
                type="number"
                step="0.000001"
                required
                value={Number.isFinite(latitude) ? latitude : ''}
                onChange={(e) => setLatitude(e.target.value === '' ? NaN : Number(e.target.value))}
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono tabular-nums text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <div>
              <label htmlFor="report-lng" className="block text-sm font-medium text-slate-700 mb-1">
                {t('submit.longitude')}
              </label>
              <input
                id="report-lng"
                type="number"
                step="0.000001"
                required
                value={Number.isFinite(longitude) ? longitude : ''}
                onChange={(e) => setLongitude(e.target.value === '' ? NaN : Number(e.target.value))}
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 text-sm font-mono tabular-nums text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
          </div>

          <div className="pt-2 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              {t('submit.duplicateHint')}
            </p>
            <button
              type="button"
              onClick={handleDuplicateCheck}
              disabled={dupLoading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
            >
              {dupLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Search className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>{dupLoading ? t('submit.checking') : t('submit.checkNearby')}</span>
            </button>
          </div>

          {dupChecked && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-2">
              {duplicates.length === 0 ? (
                <div className="flex items-center gap-2 text-xs text-emerald-800">
                  <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>{t('submit.noNearbyMatches')}</span>
                </div>
              ) : (
                <>
                  <p className="text-xs font-semibold text-amber-900">
                    {t('submit.possibleDuplicates')}
                  </p>
                  <ul className="divide-y divide-slate-200">
                    {duplicates.map((dup) => (
                      <li key={dup.reportId} className="py-2 text-xs text-slate-700">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium text-slate-900">
                            {dup.trackingCode} · {dup.title}
                          </span>
                          <span className="font-mono tabular-nums text-slate-500">
                            {t('submit.distanceAway', { meters: dup.distanceMeters })} · {tStatus(dup.status)}
                          </span>
                        </div>
                        <p className="text-slate-500 mt-0.5">{dup.matchReason}</p>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </section>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={submitting || uploadingPhoto || aiLoading}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-700 text-white text-sm font-medium hover:bg-blue-800 disabled:opacity-60 transition-colors"
          >
            {(submitting || aiLoading) && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            <span>
              {submitting
                ? t('submit.submittingReport')
                : aiLoading
                  ? t('submit.waitingAi')
                  : t('submit.submitReportBtn')}
            </span>
          </button>
        </div>
      </form>

      <GmailConfirmModal
        open={showGmailConfirmModal}
        title={t('submit.gmailModalTitle')}
        description={t('submit.gmailModalDesc', { dept: localizedRoutedDeptName })}
        senderEmail={user?.email}
        recipientLabel={t('submit.gmailRecipientLabel', { dept: localizedRoutedDeptName })}
        gmailConnected={gmailConnected}
        connectingGmail={connectingGmail}
        busy={submitting}
        error={gmailModalError}
        confirmLabel={t('submit.confirmSubmitSend')}
        secondaryActionLabel={t('submit.submitWithoutEmail')}
        onConnectGmail={async () => {
          setGmailModalError(null);
          try {
            await connectGmail();
          } catch (err: unknown) {
            setGmailModalError(formatFriendlyError(err));
          }
        }}
        onConfirmSend={async () => {
          const token = getGmailAccessToken();
          if (!token) {
            invalidateGmailToken();
            setGmailModalError(t('auth.sessionExpired'));
            return;
          }
          await executeReportSubmit(token);
        }}
        onSecondaryAction={async () => {
          await executeReportSubmit(null);
        }}
        onCancel={() => {
          setShowGmailConfirmModal(false);
          setGmailModalError(null);
        }}
      />
    </div>
  );
}
