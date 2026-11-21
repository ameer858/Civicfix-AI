import React, { useMemo, useState } from 'react';
import {
  Building2,
  Calendar,
  CheckCircle2,
  HeartHandshake,
  Loader2,
  MapPin,
  PlusCircle,
  ShieldCheck,
  Upload,
  Users,
  XCircle,
} from 'lucide-react';
import {
  formatFriendlyError,
  joinCivicActivity,
  publishCivicActivity,
  registerNgoOrganization,
  reviewCivicActivity,
  reviewNgoOrganization,
  submitCivicActivityCompletion,
  uploadValidatedImage,
  upsertVolunteerProfile,
  withdrawFromCivicActivity,
} from '../lib/civicService';
import { formatTimestamp } from './WorkflowTimeline';
import { useLanguage } from '../context/LanguageContext';
import {
  ACTIVITY_CATEGORY_LABELS,
  type ActivityCategory,
  type CivicActivity,
  type CivicReport,
  type NgoOrganization,
  type UploadedImageMetadata,
  type UserProfile,
  type UserRole,
  type VolunteerProfile,
} from '../types/civic';

interface CommunityNgoViewProps {
  profile: UserProfile;
  effectiveRole: UserRole;
  reports: CivicReport[];
  ngos: NgoOrganization[];
  volunteerProfile: VolunteerProfile | null;
  activities: CivicActivity[];
  joinedActivityIds: Set<string>;
  getIdToken: () => Promise<string>;
  onMembershipChanged: (activityId: string, joined: boolean) => void;
}

type CommunitySubTab = 'activities' | 'volunteer' | 'ngo_portal' | 'admin_review';

export function CommunityNgoView({
  profile,
  effectiveRole,
  reports,
  ngos,
  volunteerProfile,
  activities,
  joinedActivityIds,
  getIdToken,
  onMembershipChanged,
}: CommunityNgoViewProps) {
  const { t, tActivityCategory, tActivityStatus, tError } = useLanguage();
  const isAdmin = profile.role === 'admin' && effectiveRole === 'admin';

  const [subTab, setSubTab] = useState<CommunitySubTab>('activities');
  const [categoryFilter, setCategoryFilter] = useState<ActivityCategory | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'approved' | 'completed'>('all');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  // Volunteer profile form
  const [volSkillsText, setVolSkillsText] = useState(
    volunteerProfile?.skills?.join(', ') || ''
  );
  const [volArea, setVolArea] = useState(volunteerProfile?.serviceArea || '');
  const [volAvail, setVolAvail] = useState(
    volunteerProfile?.availability || 'Weekends & Evenings'
  );
  const [volActive, setVolActive] = useState(volunteerProfile?.active ?? true);

  // NGO Registration form
  const [ngoName, setNgoName] = useState('');
  const [ngoRegNumber, setNgoRegNumber] = useState('');
  const [ngoFocusText, setNgoFocusText] = useState('Neighborhood Cleanup, Urban Greenery');
  const [ngoWard, setNgoWard] = useState('');
  const [ngoDesc, setNgoDesc] = useState('');
  const [ngoEmail, setNgoEmail] = useState('');
  const [ngoPhone, setNgoPhone] = useState('');

  // Publish Activity form
  const [selectedNgoId, setSelectedNgoId] = useState('');
  const [actTitle, setActTitle] = useState('');
  const [actDesc, setActDesc] = useState('');
  const [actCategory, setActCategory] = useState<ActivityCategory>('cleanup_drive');
  const [actLocation, setActLocation] = useState('');
  const [actWard, setActWard] = useState('');
  const [actDate, setActDate] = useState(() => {
    const d = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 16);
  });
  const [actMaxVol, setActMaxVol] = useState(25);
  const [actRelatedReportId, setActRelatedReportId] = useState('');

  // Completion proof drawer state
  const [completingActivityId, setCompletingActivityId] = useState<string | null>(null);
  const [completionSummary, setCompletionSummary] = useState('');
  const [completionPhotos, setCompletionPhotos] = useState<UploadedImageMetadata[]>([]);
  const [uploadingProof, setUploadingProof] = useState(false);

  // Admin review notes
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});

  const myNgos = useMemo(
    () => ngos.filter((n) => n.ownerUid === profile.uid),
    [ngos, profile.uid]
  );
  const myApprovedNgos = useMemo(
    () => myNgos.filter((n) => n.verificationStatus === 'approved'),
    [myNgos]
  );
  const activePublishNgo =
    myApprovedNgos.find((n) => n.id === selectedNgoId) || myApprovedNgos[0] || null;

  const publicVisibleActivities = useMemo(() => {
    return activities.filter((a) => {
      if (a.status !== 'approved' && a.status !== 'completed') return false;
      if (categoryFilter !== 'all' && a.category !== categoryFilter) return false;
      if (statusFilter !== 'all' && a.status !== statusFilter) return false;
      return true;
    });
  }, [activities, categoryFilter, statusFilter]);

  const myPublishedActivities = useMemo(
    () => activities.filter((a) => a.createdByUid === profile.uid),
    [activities, profile.uid]
  );

  const pendingNgos = useMemo(
    () => ngos.filter((n) => n.verificationStatus === 'pending'),
    [ngos]
  );
  const pendingActivities = useMemo(
    () => activities.filter((a) => a.status === 'pending_approval'),
    [activities]
  );

  const handleJoin = async (activity: CivicActivity) => {
    setNotice(null);
    setBusyKey(`join_${activity.id}`);
    try {
      await joinCivicActivity({
        activity,
        user: profile,
        volunteerProfile,
      });
      onMembershipChanged(activity.id, true);
      setNotice({
        kind: 'success',
        text: t('community.msgJoined', { title: activity.title }),
      });
    } catch (err) {
      setNotice({ kind: 'error', text: tError(formatFriendlyError(err)) });
    } finally {
      setBusyKey(null);
    }
  };

  const handleWithdraw = async (activity: CivicActivity) => {
    setNotice(null);
    setBusyKey(`withdraw_${activity.id}`);
    try {
      await withdrawFromCivicActivity({
        activity,
        user: profile,
      });
      onMembershipChanged(activity.id, false);
      setNotice({
        kind: 'success',
        text: t('community.msgWithdrawn', { title: activity.title }),
      });
    } catch (err) {
      setNotice({ kind: 'error', text: tError(formatFriendlyError(err)) });
    } finally {
      setBusyKey(null);
    }
  };

  const handleSaveVolunteer = async (e: React.FormEvent) => {
    e.preventDefault();
    setNotice(null);
    setBusyKey('save_vol');
    try {
      const skills = volSkillsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await upsertVolunteerProfile({
        user: profile,
        existingProfile: volunteerProfile,
        skills,
        serviceArea: volArea,
        availability: volAvail,
        active: volActive,
      });
      setNotice({ kind: 'success', text: t('community.volunteerSaved') });
    } catch (err) {
      setNotice({ kind: 'error', text: tError(formatFriendlyError(err)) });
    } finally {
      setBusyKey(null);
    }
  };

  const handleRegisterNgo = async (e: React.FormEvent) => {
    e.preventDefault();
    setNotice(null);
    setBusyKey('register_ngo');
    try {
      const focusAreas = ngoFocusText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await registerNgoOrganization({
        owner: profile,
        name: ngoName,
        registrationNumber: ngoRegNumber,
        focusAreas,
        operatingCityOrWard: ngoWard,
        description: ngoDesc,
        contactEmail: ngoEmail,
        contactPhone: ngoPhone,
      });
      setNgoName('');
      setNgoRegNumber('');
      setNgoWard('');
      setNgoDesc('');
      setNgoEmail('');
      setNgoPhone('');
      setNotice({
        kind: 'success',
        text: t('community.msgNgoSubmitted'),
      });
    } catch (err) {
      setNotice({ kind: 'error', text: tError(formatFriendlyError(err)) });
    } finally {
      setBusyKey(null);
    }
  };

  const handlePublishActivity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activePublishNgo) return;
    setNotice(null);
    setBusyKey('publish_act');
    try {
      const isoDate = actDate ? new Date(actDate).toISOString() : new Date().toISOString();
      await publishCivicActivity({
        ngo: activePublishNgo,
        actor: profile,
        title: actTitle,
        description: actDesc,
        category: actCategory,
        locationLabel: actLocation,
        wardOrZone: actWard,
        scheduledDateIso: isoDate,
        maxVolunteers: actMaxVol,
        relatedReportId: actRelatedReportId || undefined,
      });
      setActTitle('');
      setActDesc('');
      setActLocation('');
      setActWard('');
      setActRelatedReportId('');
      setNotice({
        kind: 'success',
        text: t('community.msgActivitySubmitted'),
      });
    } catch (err) {
      setNotice({ kind: 'error', text: tError(formatFriendlyError(err)) });
    } finally {
      setBusyKey(null);
    }
  };

  const handleProofFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setNotice(null);
    setUploadingProof(true);
    try {
      const idToken = await getIdToken();
      const uploaded = await uploadValidatedImage(file, idToken, 'evidence', {
        existingCount: completionPhotos.length,
      });
      setCompletionPhotos((prev) => [
        ...prev,
        {
          url: uploaded.url,
          ...(uploaded.publicId ? { publicId: uploaded.publicId } : {}),
          fileName: uploaded.fileName,
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.sizeBytes,
          storageProvider: uploaded.storageProvider,
          storagePath: uploaded.storagePath,
          uploadedBy: uploaded.uploadedBy,
          uploadedAtIso: uploaded.uploadedAtIso,
        },
      ]);
    } catch (err) {
      setNotice({ kind: 'error', text: tError(formatFriendlyError(err)) });
    } finally {
      setUploadingProof(false);
    }
  };

  const handleSubmitCompletion = async (activity: CivicActivity) => {
    setNotice(null);
    setBusyKey(`complete_${activity.id}`);
    try {
      await submitCivicActivityCompletion({
        activity,
        completionSummary,
        completionPhotoMetadata: completionPhotos,
      });
      setCompletingActivityId(null);
      setCompletionSummary('');
      setCompletionPhotos([]);
      setNotice({
        kind: 'success',
        text: t('community.msgCompletionSynced', { title: activity.title }),
      });
    } catch (err) {
      setNotice({ kind: 'error', text: tError(formatFriendlyError(err)) });
    } finally {
      setBusyKey(null);
    }
  };

  const handleReviewNgo = async (ngo: NgoOrganization, decision: 'approved' | 'rejected') => {
    setNotice(null);
    setBusyKey(`rev_ngo_${ngo.id}`);
    try {
      await reviewNgoOrganization({
        ngo,
        admin: profile,
        decision,
        reviewNote: reviewNotes[ngo.id] || '',
      });
      setNotice({
        kind: 'success',
        text: t('community.msgNgoReviewed', {
          name: ngo.name,
          status: tActivityStatus(decision),
        }),
      });
    } catch (err) {
      setNotice({ kind: 'error', text: tError(formatFriendlyError(err)) });
    } finally {
      setBusyKey(null);
    }
  };

  const handleReviewActivity = async (
    activity: CivicActivity,
    decision: 'approved' | 'rejected'
  ) => {
    setNotice(null);
    setBusyKey(`rev_act_${activity.id}`);
    try {
      await reviewCivicActivity({
        activity,
        admin: profile,
        decision,
        reviewNote: reviewNotes[activity.id] || '',
      });
      setNotice({
        kind: 'success',
        text: t('community.msgActivityReviewed', {
          title: activity.title,
          status:
            decision === 'approved'
              ? t('community.approvedPublished')
              : tActivityStatus('rejected'),
        }),
      });
    } catch (err) {
      setNotice({ kind: 'error', text: tError(formatFriendlyError(err)) });
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className="space-y-6">
      <div className="border-b border-slate-200 pb-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            {t('community.pageTitle')}
          </h1>
          <p className="text-sm text-slate-600 mt-0.5">
            {t('community.pageSubtitle')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-slate-700 font-medium">
            {t('community.openDrivesBadge', {
              count: publicVisibleActivities.filter((a) => a.status === 'approved').length,
            })}
          </span>
          <span className="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-slate-700 font-medium">
            {t('community.verifiedNgosBadge', {
              count: ngos.filter((n) => n.verificationStatus === 'approved').length,
            })}
          </span>
        </div>
      </div>

      {notice && (
        <div
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={`p-3.5 rounded-xl border text-sm flex items-center gap-2 ${
            notice.kind === 'error'
              ? 'bg-rose-50 border-rose-200 text-rose-800'
              : 'bg-emerald-50 border-emerald-200 text-emerald-900'
          }`}
        >
          {notice.kind === 'error' ? (
            <XCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          )}
          <span>{notice.text}</span>
        </div>
      )}

      {/* Sub-tab Navigation */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-3">
        <button
          type="button"
          onClick={() => setSubTab('activities')}
          className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors ${
            subTab === 'activities'
              ? 'bg-blue-700 text-white'
              : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
          }`}
        >
          <HeartHandshake className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{t('community.tabCivicDrives', { count: publicVisibleActivities.length })}</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab('volunteer')}
          className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors ${
            subTab === 'volunteer'
              ? 'bg-blue-700 text-white'
              : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
          }`}
        >
          <Users className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{t('community.tabVolunteerShort')}</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab('ngo_portal')}
          className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors ${
            subTab === 'ngo_portal'
              ? 'bg-blue-700 text-white'
              : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
          }`}
        >
          <Building2 className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{t('community.tabNgoPortal', { count: myNgos.length })}</span>
        </button>

        {isAdmin && (
          <button
            type="button"
            onClick={() => setSubTab('admin_review')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors ${
              subTab === 'admin_review'
                ? 'bg-blue-700 text-white'
                : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
            <span>
              {t('community.tabAdminQueue', {
                count: pendingNgos.length + pendingActivities.length,
              })}
            </span>
          </button>
        )}
      </div>

      {/* 1. Civic Drives & Volunteer Participation */}
      {subTab === 'activities' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center gap-3">
            <select
              aria-label={t('workspace.filterByCategory')}
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value as ActivityCategory | 'all')}
              className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs text-slate-800"
            >
              <option value="all">{t('community.allInitiativeCategories')}</option>
              {(Object.keys(ACTIVITY_CATEGORY_LABELS) as ActivityCategory[]).map((cat) => (
                <option key={cat} value={cat}>
                  {tActivityCategory(cat)}
                </option>
              ))}
            </select>

            <select
              aria-label={t('workspace.filterByStatus')}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | 'approved' | 'completed')}
              className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs text-slate-800"
            >
              <option value="all">{t('community.approvedAndCompleted')}</option>
              <option value="approved">{t('community.openForVolunteers')}</option>
              <option value="completed">{t('community.completedDrives')}</option>
            </select>
          </div>

          {publicVisibleActivities.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-2">
              <HeartHandshake className="w-8 h-8 text-slate-300 mx-auto" aria-hidden="true" />
              <p className="text-sm font-medium text-slate-900">
                {t('community.noMatchingDrives')}
              </p>
              <p className="text-xs text-slate-500">
                {t('community.noMatchingDrivesHint')}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {publicVisibleActivities.map((act) => {
                const isJoined = joinedActivityIds.has(act.id);
                const isOwner = act.createdByUid === profile.uid;
                const isFull = (act.participantCount || 0) >= act.maxVolunteers;
                return (
                  <div
                    key={act.id}
                    className="bg-white border border-slate-200 rounded-xl p-5 space-y-3 flex flex-col justify-between"
                  >
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-medium text-blue-700">
                          {tActivityCategory(act.category)}
                        </span>
                        <div className="flex items-center gap-1.5">
                          {isJoined && (
                            <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[11px] font-semibold">
                              {t('community.joinedBadge')}
                            </span>
                          )}
                          <span
                            className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                              act.status === 'completed'
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-blue-100 text-blue-800'
                            }`}
                          >
                            {tActivityStatus(act.status)}
                          </span>
                        </div>
                      </div>

                      <h2 className="text-base font-semibold text-slate-900">{act.title}</h2>
                      <p className="text-xs text-slate-600 leading-relaxed">{act.description}</p>

                      <div className="pt-1 space-y-1 text-xs text-slate-500">
                        <p className="font-medium text-slate-800">
                          {t('community.organizedBy', { name: act.ngoName })}
                        </p>
                        <p className="flex items-center gap-1.5">
                          <MapPin className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                          <span>
                            {act.locationLabel}
                            {act.wardOrZone ? ` (${act.wardOrZone})` : ''}
                          </span>
                        </p>
                        <p className="flex items-center gap-1.5">
                          <Calendar className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                          <span>{formatTimestamp(act.scheduledDateIso)}</span>
                        </p>
                      </div>

                      {act.status === 'completed' && act.completionSummary && (
                        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-950 space-y-2">
                          <p className="font-semibold">{t('community.verifiedCompletionReport')}</p>
                          <p>{act.completionSummary}</p>
                          {act.completionPhotoMetadata && act.completionPhotoMetadata.length > 0 && (
                            <div className="space-y-1.5">
                              <p className="text-[11px] text-emerald-800">
                                {t('community.photosAttachedCount', {
                                  count: act.completionPhotoMetadata.length,
                                })}
                              </p>
                              <div className="flex flex-wrap gap-2">
                                {act.completionPhotoMetadata.map((meta, idx) =>
                                  meta.url?.startsWith('https://') ? (
                                    <a
                                      key={(meta.publicId || meta.storagePath) + idx}
                                      href={meta.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="block w-14 h-14 rounded border border-emerald-300 overflow-hidden bg-white"
                                    >
                                      <img
                                        src={meta.url}
                                        alt={meta.fileName || t('timeline.attachmentAlt', { num: idx + 1 })}
                                        referrerPolicy="no-referrer"
                                        className="w-full h-full object-cover"
                                      />
                                    </a>
                                  ) : null
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="pt-3 border-t border-slate-200 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-mono tabular-nums text-slate-700">
                          {t('community.volunteersRatio', {
                            joined: act.participantCount || 0,
                            max: act.maxVolunteers,
                          })}
                        </span>
                        <div className="flex flex-wrap items-center gap-2">
                          {act.status === 'approved' && !isJoined && (
                            <button
                              type="button"
                              disabled={isFull || busyKey === `join_${act.id}`}
                              onClick={() => handleJoin(act)}
                              className="px-3.5 py-1.5 rounded-lg bg-blue-700 text-white text-xs font-medium hover:bg-blue-800 disabled:opacity-50"
                            >
                              {busyKey === `join_${act.id}`
                                ? t('community.joining')
                                : isFull
                                  ? t('community.full')
                                  : t('community.joinActivity')}
                            </button>
                          )}
                          {act.status === 'approved' && isJoined && (
                            <button
                              type="button"
                              disabled={busyKey === `withdraw_${act.id}`}
                              onClick={() => handleWithdraw(act)}
                              className="px-3.5 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
                            >
                              {busyKey === `withdraw_${act.id}`
                                ? t('community.updating')
                                : t('community.withdrawDrive')}
                            </button>
                          )}
                          {isOwner && act.status === 'approved' && (
                            <button
                              type="button"
                              onClick={() => {
                                setCompletingActivityId(
                                  completingActivityId === act.id ? null : act.id
                                );
                                setCompletionSummary('');
                                setCompletionPhotos([]);
                              }}
                              className="px-3 py-1.5 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 text-xs font-medium hover:bg-emerald-100"
                            >
                              {t('community.submitCompletionProof')}
                            </button>
                          )}
                        </div>
                      </div>

                      {completingActivityId === act.id && (
                        <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-3">
                          <p className="text-xs font-semibold text-slate-900">
                            {t('community.submitNgoEvidence')}
                          </p>
                          <textarea
                            rows={2}
                            value={completionSummary}
                            onChange={(e) => setCompletionSummary(e.target.value)}
                            placeholder={t('community.completionSummaryPlaceholder')}
                            className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs text-slate-900"
                          />
                          <div className="flex flex-wrap items-center gap-2">
                            <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100 cursor-pointer">
                              {uploadingProof ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                              ) : (
                                <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                              )}
                              <span>
                                {uploadingProof
                                  ? t('community.validatingPhoto')
                                  : t('community.attachEvidencePhoto', {
                                      count: completionPhotos.length,
                                    })}
                              </span>
                              <input
                                type="file"
                                accept="image/jpeg,image/png,image/webp"
                                disabled={uploadingProof || completionPhotos.length >= 5}
                                onChange={handleProofFileUpload}
                                className="hidden"
                              />
                            </label>
                            <button
                              type="button"
                              disabled={busyKey === `complete_${act.id}`}
                              onClick={() => handleSubmitCompletion(act)}
                              className="px-3.5 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 disabled:opacity-50"
                            >
                              {busyKey === `complete_${act.id}`
                                ? t('common.submitting')
                                : t('community.markCompletedBtn')}
                            </button>
                          </div>
                          {completionPhotos.length > 0 && (
                            <p className="text-[11px] text-slate-600">
                              {t('community.validatedMetaAttached')}{' '}
                              {completionPhotos.map((p) => p.fileName).join(', ')}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 2. Volunteer Profile */}
      {subTab === 'volunteer' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <form
            onSubmit={handleSaveVolunteer}
            className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-4"
          >
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                {t('community.myVolunteerProfile')}
              </h2>
              <p className="text-xs text-slate-600 mt-0.5">
                {t('community.volunteerProfileDesc')}
              </p>
            </div>

            <div className="space-y-1">
              <label htmlFor="vol-area" className="block text-xs font-medium text-slate-700">
                {t('community.serviceArea')}
              </label>
              <input
                id="vol-area"
                type="text"
                required
                value={volArea}
                onChange={(e) => setVolArea(e.target.value)}
                placeholder={t('community.serviceAreaPlaceholder')}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-900"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="vol-skills" className="block text-xs font-medium text-slate-700">
                {t('community.skills')}
              </label>
              <input
                id="vol-skills"
                type="text"
                value={volSkillsText}
                onChange={(e) => setVolSkillsText(e.target.value)}
                placeholder={t('community.skillsPlaceholder')}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-900"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="vol-avail" className="block text-xs font-medium text-slate-700">
                {t('community.availabilityLabel')}
              </label>
              <input
                id="vol-avail"
                type="text"
                required
                value={volAvail}
                onChange={(e) => setVolAvail(e.target.value)}
                placeholder={t('community.availabilityPlaceholder')}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-900"
              />
            </div>

            {volunteerProfile && (
              <label className="flex items-center gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={volActive}
                  onChange={(e) => setVolActive(e.target.checked)}
                />
                <span>{t('community.activeVolunteerStatus')}</span>
              </label>
            )}

            <button
              type="submit"
              disabled={busyKey === 'save_vol'}
              className="px-4 py-2 rounded-lg bg-blue-700 text-white text-sm font-medium hover:bg-blue-800 disabled:opacity-50"
            >
              {busyKey === 'save_vol' ? t('common.saving') : t('community.saveVolunteerBtn')}
            </button>
          </form>

          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-3 h-fit">
            <h3 className="text-sm font-semibold text-slate-900">
              {t('community.participationSummary')}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                <p className="text-xs text-slate-500">{t('community.currentlyJoined')}</p>
                <p className="text-xl font-bold font-mono tabular-nums text-blue-700 mt-0.5">
                  {joinedActivityIds.size}
                </p>
              </div>
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                <p className="text-xs text-slate-500">{t('community.totalParticipations')}</p>
                <p className="text-xl font-bold font-mono tabular-nums text-emerald-700 mt-0.5">
                  {volunteerProfile?.joinedActivityCount ?? joinedActivityIds.size}
                </p>
              </div>
            </div>
            <p className="text-xs text-slate-500">
              {volunteerProfile
                ? t('community.profileActiveSummary', {
                    area: volunteerProfile.serviceArea,
                    availability: volunteerProfile.availability,
                  })
                : t('community.saveProfileHint')}
            </p>
          </div>
        </div>
      )}

      {/* 3. NGO Partner Portal */}
      {subTab === 'ngo_portal' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-6 space-y-6">
            <form
              onSubmit={handleRegisterNgo}
              className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
            >
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  {t('community.registerNgoHeading')}
                </h2>
                <p className="text-xs text-slate-600 mt-0.5">
                  {t('community.registerNgoDesc')}
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="ngo-name" className="block text-xs font-medium text-slate-700">
                    {t('community.ngoName')}
                  </label>
                  <input
                    id="ngo-name"
                    type="text"
                    required
                    value={ngoName}
                    onChange={(e) => setNgoName(e.target.value)}
                    placeholder="GreenWard Civic Foundation"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-900"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="ngo-reg" className="block text-xs font-medium text-slate-700">
                    {t('community.regNumber')}
                  </label>
                  <input
                    id="ngo-reg"
                    type="text"
                    required
                    value={ngoRegNumber}
                    onChange={(e) => setNgoRegNumber(e.target.value)}
                    placeholder="NGO-2026-4412"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-900"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="ngo-ward" className="block text-xs font-medium text-slate-700">
                    {t('community.operatingArea')}
                  </label>
                  <input
                    id="ngo-ward"
                    type="text"
                    required
                    value={ngoWard}
                    onChange={(e) => setNgoWard(e.target.value)}
                    placeholder={t('community.serviceAreaPlaceholder')}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-900"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="ngo-focus" className="block text-xs font-medium text-slate-700">
                    {t('community.focusAreas')}
                  </label>
                  <input
                    id="ngo-focus"
                    type="text"
                    required
                    value={ngoFocusText}
                    onChange={(e) => setNgoFocusText(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-900"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="ngo-email" className="block text-xs font-medium text-slate-700">
                    {t('community.privateContactEmail')}
                  </label>
                  <input
                    id="ngo-email"
                    type="email"
                    required
                    value={ngoEmail}
                    onChange={(e) => setNgoEmail(e.target.value)}
                    placeholder="coordinator@greenward.org"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-900"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="ngo-phone" className="block text-xs font-medium text-slate-700">
                    {t('community.contactPhoneOpt')}
                  </label>
                  <input
                    id="ngo-phone"
                    type="text"
                    value={ngoPhone}
                    onChange={(e) => setNgoPhone(e.target.value)}
                    placeholder="+1 555 201 8890"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-900"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label htmlFor="ngo-desc" className="block text-xs font-medium text-slate-700">
                  {t('community.missionCapabilities')}
                </label>
                <textarea
                  id="ngo-desc"
                  rows={3}
                  required
                  value={ngoDesc}
                  onChange={(e) => setNgoDesc(e.target.value)}
                  placeholder={t('community.missionPlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-900"
                />
              </div>

              <button
                type="submit"
                disabled={busyKey === 'register_ngo'}
                className="px-4 py-2 rounded-lg bg-blue-700 text-white text-xs font-medium hover:bg-blue-800 disabled:opacity-50"
              >
                {busyKey === 'register_ngo' ? t('common.submitting') : t('community.submitNgoReg')}
              </button>
            </form>

            {myNgos.length > 0 && (
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                <h3 className="text-sm font-semibold text-slate-900">
                  {t('community.myRegisteredNgos')}
                </h3>
                <ul className="space-y-2">
                  {myNgos.map((n) => (
                    <li
                      key={n.id}
                      className="p-3 rounded-lg border border-slate-200 bg-slate-50 space-y-1 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-slate-900">{n.name}</span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                            n.verificationStatus === 'approved'
                              ? 'bg-emerald-100 text-emerald-800'
                              : n.verificationStatus === 'rejected'
                                ? 'bg-rose-100 text-rose-800'
                                : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {tActivityStatus(n.verificationStatus)}
                        </span>
                      </div>
                      <p className="text-slate-600">
                        {t('community.regPrefix', {
                          num: n.registrationNumber,
                          area: n.operatingCityOrWard,
                        })}
                      </p>
                      {n.reviewNote && (
                        <p className="text-slate-500 italic">
                          {t('community.adminNotePrefix', { note: n.reviewNote })}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="lg:col-span-6 space-y-6">
            {myApprovedNgos.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-2">
                <PlusCircle className="w-6 h-6 text-slate-400" aria-hidden="true" />
                <h3 className="text-sm font-semibold text-slate-900">
                  {t('community.publishPendingNgoTitle')}
                </h3>
                <p className="text-xs text-slate-600">
                  {t('community.publishPendingNgoDesc')}
                </p>
              </div>
            ) : (
              <form
                onSubmit={handlePublishActivity}
                className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
              >
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    {t('community.publishActivityTitle')}
                  </h2>
                  <p className="text-xs text-slate-600 mt-0.5">
                    {t('community.publishActivityDesc')}
                  </p>
                </div>

                {myApprovedNgos.length > 1 && (
                  <div className="space-y-1">
                    <label htmlFor="act-ngo" className="block text-xs font-medium text-slate-700">
                      {t('community.verifiedNgoOrg')}
                    </label>
                    <select
                      id="act-ngo"
                      value={activePublishNgo?.id || ''}
                      onChange={(e) => setSelectedNgoId(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs text-slate-900"
                    >
                      {myApprovedNgos.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="space-y-1">
                  <label htmlFor="act-title" className="block text-xs font-medium text-slate-700">
                    {t('community.activityTitle')}
                  </label>
                  <input
                    id="act-title"
                    type="text"
                    required
                    value={actTitle}
                    onChange={(e) => setActTitle(e.target.value)}
                    placeholder={t('community.activityTitle')}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-900"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label htmlFor="act-cat" className="block text-xs font-medium text-slate-700">
                      {t('common.category')}
                    </label>
                    <select
                      id="act-cat"
                      value={actCategory}
                      onChange={(e) => setActCategory(e.target.value as ActivityCategory)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs text-slate-900"
                    >
                      {(Object.keys(ACTIVITY_CATEGORY_LABELS) as ActivityCategory[]).map((cat) => (
                        <option key={cat} value={cat}>
                          {tActivityCategory(cat)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="act-max" className="block text-xs font-medium text-slate-700">
                      {t('community.maxVolunteers')}
                    </label>
                    <input
                      id="act-max"
                      type="number"
                      min={1}
                      max={500}
                      required
                      value={actMaxVol}
                      onChange={(e) => setActMaxVol(Number(e.target.value) || 25)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-900"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label htmlFor="act-loc" className="block text-xs font-medium text-slate-700">
                      {t('community.activityLocation')}
                    </label>
                    <input
                      id="act-loc"
                      type="text"
                      required
                      value={actLocation}
                      onChange={(e) => setActLocation(e.target.value)}
                      placeholder={t('community.activityLocation')}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-900"
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="act-date" className="block text-xs font-medium text-slate-700">
                      {t('community.scheduledDate')}
                    </label>
                    <input
                      id="act-date"
                      type="datetime-local"
                      required
                      value={actDate}
                      onChange={(e) => setActDate(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-900"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label htmlFor="act-ward" className="block text-xs font-medium text-slate-700">
                      {t('community.wardZoneOpt')}
                    </label>
                    <input
                      id="act-ward"
                      type="text"
                      value={actWard}
                      onChange={(e) => setActWard(e.target.value)}
                      placeholder={t('submit.wardPlaceholder')}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-900"
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="act-report" className="block text-xs font-medium text-slate-700">
                      {t('community.linkReportOpt')}
                    </label>
                    <select
                      id="act-report"
                      value={actRelatedReportId}
                      onChange={(e) => setActRelatedReportId(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs text-slate-900"
                    >
                      <option value="">{t('common.none')}</option>
                      {reports.slice(0, 20).map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.trackingCode} — {r.title.slice(0, 40)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="space-y-1">
                  <label htmlFor="act-desc" className="block text-xs font-medium text-slate-700">
                    {t('community.activityPlanLabel')}
                  </label>
                  <textarea
                    id="act-desc"
                    rows={3}
                    required
                    value={actDesc}
                    onChange={(e) => setActDesc(e.target.value)}
                    placeholder={t('community.activityPlanPlaceholder')}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-900"
                  />
                </div>

                <button
                  type="submit"
                  disabled={busyKey === 'publish_act'}
                  className="px-4 py-2 rounded-lg bg-blue-700 text-white text-xs font-medium hover:bg-blue-800 disabled:opacity-50"
                >
                  {busyKey === 'publish_act'
                    ? t('common.submitting')
                    : t('community.submitActivityApproval')}
                </button>
              </form>
            )}

            {myPublishedActivities.length > 0 && (
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                <h3 className="text-sm font-semibold text-slate-900">
                  {t('community.myPublishedActivities')}
                </h3>
                <ul className="space-y-2">
                  {myPublishedActivities.map((a) => (
                    <li
                      key={a.id}
                      className="p-3 rounded-lg border border-slate-200 bg-slate-50 text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-slate-900">{a.title}</span>
                        <span className="px-2 py-0.5 rounded-full bg-slate-200 text-slate-800 text-[10px] font-semibold">
                          {tActivityStatus(a.status)}
                        </span>
                      </div>
                      <p className="text-slate-600">
                        {a.locationLabel} ·{' '}
                        {t('community.volunteersRatio', {
                          joined: a.participantCount,
                          max: a.maxVolunteers,
                        })}
                      </p>
                      {a.reviewNote && (
                        <p className="text-slate-500 italic">
                          {t('community.adminNotePrefix', { note: a.reviewNote })}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 4. Administrator Verification Queue */}
      {subTab === 'admin_review' && isAdmin && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <h2 className="text-base font-semibold text-slate-900">
              {t('community.pendingNgoVerifications', { count: pendingNgos.length })}
            </h2>
            {pendingNgos.length === 0 ? (
              <p className="text-xs text-slate-500">{t('community.noPendingNgos')}</p>
            ) : (
              <div className="space-y-3">
                {pendingNgos.map((ngo) => (
                  <div
                    key={ngo.id}
                    className="p-4 rounded-lg border border-slate-200 bg-slate-50 space-y-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900">{ngo.name}</span>
                      <span className="font-mono text-slate-600">{ngo.registrationNumber}</span>
                    </div>
                    <p className="text-slate-600">{ngo.description}</p>
                    <p className="text-slate-500">
                      {t('community.ngoCoordinatorLine', {
                        owner: ngo.ownerName,
                        area: ngo.operatingCityOrWard,
                        focus: ngo.focusAreas.join(', '),
                      })}
                    </p>
                    <input
                      type="text"
                      value={reviewNotes[ngo.id] || ''}
                      onChange={(e) =>
                        setReviewNotes((prev) => ({ ...prev, [ngo.id]: e.target.value }))
                      }
                      placeholder={t('community.optionalVerifyNote')}
                      className="w-full px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs"
                    />
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        type="button"
                        disabled={busyKey === `rev_ngo_${ngo.id}`}
                        onClick={() => handleReviewNgo(ngo, 'approved')}
                        className="px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 disabled:opacity-50"
                      >
                        {t('community.approveNgo')}
                      </button>
                      <button
                        type="button"
                        disabled={busyKey === `rev_ngo_${ngo.id}`}
                        onClick={() => handleReviewNgo(ngo, 'rejected')}
                        className="px-3 py-1.5 rounded-lg bg-rose-700 text-white text-xs font-medium hover:bg-rose-800 disabled:opacity-50"
                      >
                        {t('common.reject')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <h2 className="text-base font-semibold text-slate-900">
              {t('community.pendingActivitiesHeading', { count: pendingActivities.length })}
            </h2>
            {pendingActivities.length === 0 ? (
              <p className="text-xs text-slate-500">{t('community.noPendingActivities')}</p>
            ) : (
              <div className="space-y-3">
                {pendingActivities.map((act) => (
                  <div
                    key={act.id}
                    className="p-4 rounded-lg border border-slate-200 bg-slate-50 space-y-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900">{act.title}</span>
                      <span className="text-blue-700 font-medium">{act.ngoName}</span>
                    </div>
                    <p className="text-slate-600">{act.description}</p>
                    <p className="text-slate-500">
                      {tActivityCategory(act.category)} · {act.locationLabel} ·{' '}
                      {formatTimestamp(act.scheduledDateIso)} ·{' '}
                      {t('community.maxVolunteersShort', { count: act.maxVolunteers })}
                    </p>
                    <input
                      type="text"
                      value={reviewNotes[act.id] || ''}
                      onChange={(e) =>
                        setReviewNotes((prev) => ({ ...prev, [act.id]: e.target.value }))
                      }
                      placeholder={t('community.optionalApprovalNote')}
                      className="w-full px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs"
                    />
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        type="button"
                        disabled={busyKey === `rev_act_${act.id}`}
                        onClick={() => handleReviewActivity(act, 'approved')}
                        className="px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 disabled:opacity-50"
                      >
                        {t('community.approveAndPublish')}
                      </button>
                      <button
                        type="button"
                        disabled={busyKey === `rev_act_${act.id}`}
                        onClick={() => handleReviewActivity(act, 'rejected')}
                        className="px-3 py-1.5 rounded-lg bg-rose-700 text-white text-xs font-medium hover:bg-rose-800 disabled:opacity-50"
                      >
                        {t('common.reject')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
