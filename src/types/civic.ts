export type UserRole = 'citizen' | 'admin' | 'officer' | 'worker';

export type IssueCategory =
  | 'pothole'
  | 'garbage'
  | 'streetlight'
  | 'water_leakage'
  | 'drainage'
  | 'damaged_infrastructure'
  | 'public_park_damage'
  | 'other';

export type IssuePriority = 'low' | 'medium' | 'high' | 'critical';

export type ReportStatus =
  | 'submitted'
  | 'under_review'
  | 'verified'
  | 'assigned'
  | 'in_progress'
  | 'resolved'
  | 'citizen_confirmed'
  | 'rejected'
  | 'reopened';

export type ImageQualityStatus = 'clear' | 'partially_obscured' | 'unclear' | 'insufficient';

export type WorkerAvailabilityStatus =
  | 'available'
  | 'assigned'
  | 'on_duty'
  | 'busy'
  | 'completed_shift'
  | 'unavailable';

export const WORKER_AVAILABILITY_LABELS: Record<WorkerAvailabilityStatus, string> = {
  available: 'Available',
  assigned: 'Assigned',
  on_duty: 'On Duty',
  busy: 'Busy',
  completed_shift: 'Completed Shift',
  unavailable: 'Unavailable',
};

export interface UserProfile {
  uid: string;
  displayName: string;
  role: UserRole;
  departmentId: string;
  departmentName?: string;
  active: boolean;
  availabilityStatus?: WorkerAvailabilityStatus;
  availabilityNote?: string;
  workZone?: string;
  employeeId?: string;
  supervisorId?: string;
  supervisorName?: string;
  maxActiveTasks?: number;
  claimedInviteId?: string;
  createdAt: any;
  updatedAt: any;
}

export interface WorkerInvite {
  id: string;
  email: string;
  displayName: string;
  role: 'worker' | 'officer';
  departmentId: string;
  departmentName: string;
  workZone?: string;
  employeeId?: string;
  supervisorId?: string;
  supervisorName?: string;
  availabilityStatus: WorkerAvailabilityStatus;
  invitedByUid: string;
  claimed: boolean;
  claimedByUid?: string;
  createdAt: any;
  updatedAt: any;
}

export interface UserPrivateContact {
  uid: string;
  email: string;
  phone?: string;
  photoUrl?: string;
  updatedAt: any;
}

export interface Department {
  id: string;
  name: string;
  code: string;
  description?: string;
  categories: IssueCategory[];
  officerIds: string[];
  active: boolean;
  createdAt: any;
  updatedAt: any;
}

export interface UploadedImageMetadata {
  url: string;
  publicId?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageProvider: 'cloudinary' | 'server_validated';
  storagePath: string;
  uploadedBy?: string;
  bucket?: string;
  uploadedAtIso: string;
}

export interface TemporaryUploadResult extends UploadedImageMetadata {
  uploadId: string;
  temporaryOnly: boolean;
  retentionNotice: string;
  expiresAtIso?: string;
}

export interface CivicReport {
  id: string;
  trackingCode: string;
  reporterId: string;
  reporterName: string;
  title: string;
  description: string;
  category: IssueCategory;
  priority: IssuePriority;
  priorityRecommendation?: IssuePriority;
  status: ReportStatus;
  addressText: string;
  wardOrZone?: string;
  latitude: number;
  longitude: number;
  imageUrls: string[];
  imageMetadata?: UploadedImageMetadata[];
  resolutionImageUrls: string[];
  resolutionImageMetadata?: UploadedImageMetadata[];
  departmentId: string;
  departmentName?: string;
  authorizedOfficerIds: string[];
  assignedWorkerId: string;
  assignedWorkerName?: string;
  aiAnalysisId?: string;
  rejectionReason?: string;
  reopenReason?: string;
  resolutionNotes?: string;
  // Milestone 6 field operations & supervisor verification fields
  awaitingSupervisorVerification?: boolean;
  supervisorVerifiedAtIso?: string;
  supervisorVerifiedById?: string;
  supervisorVerifiedByName?: string;
  workStartedAtIso?: string;
  completedAtIso?: string;
  materialsUsed?: string;
  obstaclesEncountered?: string;
  hasActiveObstacle?: boolean;
  acknowledgedAtIso?: string;
  escalatedAtIso?: string;
  escalatedToId?: string;
  workerCheckInLabel?: string;
  workerCheckInLat?: number;
  workerCheckInLng?: number;
  deadlineIso?: string;
  supervisorId?: string;
  supervisorName?: string;
  reassignedAtIso?: string;
  delayExplanation?: string;
  assistanceRequestedAtIso?: string;
  assistanceRequestNote?: string;
  // Department authority & citizen notification tracking fields
  authorityEmailStatus?: AuthorityEmailStatus;
  authorityEmailStatusNote?: string;
  authorityEmailSentAtIso?: string;
  citizenNotificationStatus?: CitizenNotificationStatus;
  citizenNotificationStatusNote?: string;
  citizenNotifiedAtIso?: string;
  createdAt: any;
  updatedAt: any;
}

export interface Assignment {
  id: string;
  reportId: string;
  trackingCode: string;
  reportTitle: string;
  departmentId: string;
  departmentName: string;
  assignedById: string;
  authorizedOfficerIds: string[];
  workerId: string;
  workerName?: string;
  status: 'pending_worker' | 'assigned' | 'in_progress' | 'evidence_submitted' | 'approved' | 'rejected';
  priority?: IssuePriority;
  deadlineIso?: string;
  supervisorId?: string;
  supervisorName?: string;
  instructions?: string;
  reassignedFromWorkerId?: string;
  reassignedFromWorkerName?: string;
  reassignedCount?: number;
  reassignmentReason?: string;
  acknowledgedAtIso?: string;
  workStartedAtIso?: string;
  completedAtIso?: string;
  supervisorVerifiedAtIso?: string;
  supervisorVerifiedById?: string;
  materialsUsed?: string;
  obstaclesEncountered?: string;
  delayExplanation?: string;
  assistanceRequestedAtIso?: string;
  assistanceRequestNote?: string;
  workerLocationSharingActive?: boolean;
  workerLocationLat?: number;
  workerLocationLng?: number;
  workerLocationUpdatedAtIso?: string;
  recommendationScore?: number;
  recommendationReason?: string;
  createdAt: any;
  updatedAt: any;
}

export interface ReportUpdate {
  id: string;
  reportId: string;
  reporterId: string;
  authorizedOfficerIds: string[];
  assignedWorkerId: string;
  actorId: string;
  actorName: string;
  actorRole: UserRole;
  fromStatus: string;
  toStatus: string;
  note: string;
  evidenceUrls: string[];
  createdAt: any;
}

export interface AiAnalysis {
  id: string;
  reportId: string;
  reporterId: string;
  authorizedOfficerIds: string[];
  detectedIssue?: string;
  suggestedCategory: IssueCategory;
  factualDescription: string;
  visibleEvidence?: string[];
  suggestedPriority: IssuePriority;
  priorityExplanation: string;
  suggestedDepartmentId?: string;
  suggestedDepartmentName?: string;
  recommendedAction?: string;
  confidenceScore: number;
  imageQualityStatus: ImageQualityStatus;
  requiresHumanReview: boolean;
  reviewReason?: string;
  advisoryOnly: boolean;
  modelUsed: string;
  createdAt: any;
}

export interface AiPhotoAssessmentResult {
  detectedIssue: string;
  suggestedCategory: IssueCategory;
  factualDescription: string;
  visibleEvidence: string[];
  suggestedPriority: IssuePriority;
  priorityExplanation: string;
  suggestedDepartmentId: string;
  suggestedDepartmentName: string;
  recommendedAction: string;
  confidenceScore: number;
  imageQualityStatus: ImageQualityStatus;
  requiresHumanReview: boolean;
  reviewReason: string;
  category?: IssueCategory;
  imageDescription?: string;
  confidence?: number;
  uncertaintyReason?: string;
  humanReviewRequired?: boolean;
  analysisToken?: string;
  advisoryOnly: true;
  modelUsed: string;
  temporaryDataCleanedUp?: boolean;
}

export interface DuplicateScoreBreakdown {
  geoScore: number;
  categoryMatch: number;
  textSimilarity: number;
  aiImageSimilarity: number;
  timeScore: number;
}

export interface DuplicateCandidate {
  reportId: string;
  trackingCode: string;
  title: string;
  category: IssueCategory;
  status: ReportStatus;
  addressText: string;
  distanceMeters: number;
  textSimilarity: number;
  aiImageSimilarity?: number;
  timeDeltaHours: number;
  overallScore: number;
  matchReason: string;
  createdAtIso: string;
  aiDescription?: string;
  scoreBreakdown?: DuplicateScoreBreakdown;
}

export type DuplicateReviewDecision = 'pending_review' | 'confirmed_related' | 'dismissed_distinct';

export interface CitywideDuplicatePair {
  pairId: string;
  reportAId: string;
  reportATrackingCode: string;
  reportATitle: string;
  reportAStatus: ReportStatus;
  reportBId: string;
  reportBTrackingCode: string;
  reportBTitle: string;
  reportBStatus: ReportStatus;
  category: IssueCategory;
  distanceMeters: number | null;
  textSimilarity: number;
  aiImageSimilarity: number;
  timeDeltaHours: number;
  matchScore: number;
  reasons: string[];
  reportAAiDescription?: string;
  reportBAiDescription?: string;
}

export interface TrendBucket {
  key: string;
  label: string;
  submitted: number;
  resolved: number;
  reopened: number;
}

export interface DashboardIntelligence {
  totalReports: number;
  pendingReports: number;
  verifiedReports: number;
  inProgressReports: number;
  resolvedReports: number;
  reopenedReports: number;
  rejectedReports: number;
  avgResolutionHours: number | null;
  resolutionSampleSize: number;
  categoryDistribution: Array<{
    category: IssueCategory;
    label: string;
    count: number;
    sharePct: number;
  }>;
  departmentWorkload: Array<{
    departmentId: string;
    departmentName: string;
    departmentCode: string;
    total: number;
    open: number;
    resolved: number;
  }>;
  weeklyTrends: TrendBucket[];
  monthlyTrends: TrendBucket[];
}

export interface HotspotCluster {
  clusterId: string;
  centroidLat: number;
  centroidLng: number;
  reportCount: number;
  isRecurringZone: boolean;
  dominantCategory: IssueCategory;
  highestPriority: IssuePriority;
  areaLabel: string;
  reports: CivicReport[];
}

export interface HotspotClusteringResult {
  validLocationReports: CivicReport[];
  missingLocationReports: CivicReport[];
  clusters: HotspotCluster[];
}

export interface DepartmentPerformanceMetric {
  departmentId: string;
  departmentName: string;
  departmentCode: string;
  assignedCount: number;
  ackSampleSize: number;
  avgAcknowledgeHours: number | null;
  resolvedSampleSize: number;
  avgResolutionHours: number | null;
  pendingWorkload: number;
  overdueCount: number;
  confirmationSampleSize: number;
  confirmationRatePct: number | null;
  insufficientSample: boolean;
}

export interface PriorityFactor {
  id: 'public_safety' | 'affected_people' | 'issue_type' | 'recurrence' | 'duration_unresolved';
  label: string;
  points: number;
  maxPoints: number;
  observation: string;
}

export interface PriorityIntelligenceResult {
  reportId: string;
  trackingCode: string;
  currentPriority: IssuePriority;
  recommendedPriority: IssuePriority;
  differsFromCurrent: boolean;
  urgencyScore: number;
  factors: PriorityFactor[];
  rationaleSummary: string;
}

export interface AnonymizedTrendDigest {
  generatedAtIso: string;
  totalReports: number;
  statusBreakdown: Record<string, number>;
  categoryBreakdown: Array<{ category: string; count: number; openCount: number; reopenedCount: number }>;
  zoneBreakdown: Array<{ zone: string; count: number; categories: string[] }>;
  departmentBreakdown: Array<{ department: string; assigned: number; resolved: number; pending: number }>;
  weeklyCounts: Array<{ label: string; submitted: number; resolved: number }>;
  monthlyCounts: Array<{ label: string; submitted: number; resolved: number }>;
  anonymizedSamples: Array<{
    trackingCode: string;
    category: string;
    priority: string;
    status: string;
    zone: string;
    ageHours: number;
    summary: string;
    aiSummary?: string;
  }>;
}

export interface TrendIntelligenceResult {
  observedFacts: {
    totalReports: number;
    topCategories: Array<{ category: string; count: number }>;
    reopenedCount: number;
    lowSampleWarning: boolean;
    summary: string;
  };
  frequentlyReportedIssues: string[];
  emergingPatterns: string[];
  areasWithIncreasingComplaints: string[];
  recurringInfrastructureProblems: string[];
  preventiveMaintenancePriorities: Array<{
    title: string;
    rationale: string;
    urgency: 'low' | 'medium' | 'high';
  }>;
  administratorRecommendations: string[];
  advisoryNotice: string;
  generatedAtIso: string;
  modelUsed: string;
}

export interface CitizenFeedback {
  id: string;
  reportId: string;
  citizenId: string;
  authorizedOfficerIds: string[];
  outcome: 'confirmed' | 'reopened';
  rating: number;
  comment: string;
  createdAt: any;
}

export type AppNotificationType =
  | 'status_change'
  | 'assignment'
  | 'reassignment'
  | 'review_needed'
  | 'feedback'
  | 'deadline_warning'
  | 'deadline_overdue'
  | 'obstacle'
  | 'escalation'
  | 'assistance_request'
  | 'task_progress'
  | 'task_accepted'
  | 'authority_email_alert';

export interface AppNotification {
  id: string;
  recipientId: string;
  reportId: string;
  title: string;
  message: string;
  type: AppNotificationType;
  read: boolean;
  createdAt: any;
}

export interface AuditLog {
  id: string;
  reportId: string;
  trackingCode: string;
  departmentId: string;
  authorizedOfficerIds: string[];
  assignedWorkerId: string;
  actorId: string;
  actorName: string;
  actorRole: UserRole;
  action: string;
  summary: string;
  details?: string;
  createdAt: any;
}

// ------------------------------------------------------------------
// Milestone 6: Real-Time Operations, Workforce, SLA & Alerts
// ------------------------------------------------------------------

export type SlaScopeType = 'global' | 'department' | 'category' | 'department_category';

export interface SlaPolicy {
  id: string;
  scopeType: SlaScopeType;
  departmentId: string;
  departmentName?: string;
  category: IssueCategory | '';
  ackTargetHours: number;
  assignTargetHours: number;
  resolveTargetHours: number;
  escalationRole: 'officer' | 'admin';
  updatedById: string;
  createdAt: any;
  updatedAt: any;
}

export type DeadlineHealth = 'on_track' | 'approaching' | 'overdue' | 'met';

export interface DeadlineEvaluation {
  reportId: string;
  policyLabel: string;
  ackTargetMs: number;
  assignTargetMs: number;
  resolveTargetMs: number;
  ackDeadlineMs: number;
  assignDeadlineMs: number;
  resolveDeadlineMs: number;
  ackRemainingMs: number;
  assignRemainingMs: number;
  resolveRemainingMs: number;
  ackHealth: DeadlineHealth;
  assignHealth: DeadlineHealth;
  resolveHealth: DeadlineHealth;
  activeStage: 'acknowledge' | 'assign' | 'resolve' | 'completed';
  activeRemainingMs: number;
  activeRemainingLabel: string;
  isApproaching: boolean;
  isOverdue: boolean;
  overdueStages: Array<'acknowledge' | 'assign' | 'resolve'>;
}

export type OperationalAlertKind =
  | 'high_priority_report'
  | 'unassigned_task'
  | 'deadline_approaching'
  | 'deadline_overdue'
  | 'worker_obstacle'
  | 'completion_awaiting_verification'
  | 'reopened_report'
  | 'authority_email_missing';

export interface OperationalAlertRecord {
  id: string;
  alertKey: string;
  kind: OperationalAlertKind;
  reportId: string;
  trackingCode: string;
  departmentId: string;
  authorizedOfficerIds: string[];
  recipientIds: string[];
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  acknowledged: boolean;
  createdAt: any;
  updatedAt: any;
}

export interface OperationalAlertCandidate {
  alertKey: string;
  kind: OperationalAlertKind;
  reportId: string;
  trackingCode: string;
  departmentId: string;
  authorizedOfficerIds: string[];
  recipientIds: string[];
  severity: 'info' | 'warning' | 'critical';
  notificationType: AppNotificationType;
  title: string;
  message: string;
}

export interface WorkerWorkloadSummary {
  worker: UserProfile;
  availability: WorkerAvailabilityStatus;
  activeTasks: number;
  inProgressTasks: number;
  awaitingVerificationTasks: number;
  completedTasks: number;
  obstacleTasks: number;
  maxActiveTasks: number;
  assignedReports: CivicReport[];
}

export interface WorkerRecommendation {
  worker: UserProfile;
  score: number;
  eligible: boolean;
  availability: WorkerAvailabilityStatus;
  activeTasks: number;
  completedTasks: number;
  reasons: string[];
  breakdown: {
    departmentScore: number;
    availabilityScore: number;
    workloadScore: number;
    priorityScore: number;
    locationScore: number;
  };
}

export interface DepartmentOperationsWorkload {
  departmentId: string;
  departmentName: string;
  departmentCode: string;
  totalActive: number;
  unassigned: number;
  assigned: number;
  inProgress: number;
  overdue: number;
  awaitingVerification: number;
  completed: number;
}

export interface WorkforceAvailabilitySummary {
  totalWorkers: number;
  available: number;
  assigned: number;
  on_duty: number;
  busy: number;
  completed_shift: number;
  unavailable: number;
}

export interface OperationsBoardBuckets {
  newlySubmitted: CivicReport[];
  awaitingVerification: CivicReport[];
  unassigned: CivicReport[];
  assignedTasks: CivicReport[];
  inProgressTasks: CivicReport[];
  overdueTasks: CivicReport[];
  completedAwaitingVerification: CivicReport[];
  totalActiveCount: number;
  completedCount: number;
  departmentWorkloadBreakdown: DepartmentOperationsWorkload[];
  workforceAvailabilitySummary: WorkforceAvailabilitySummary;
  deadlineByReportId: Record<string, DeadlineEvaluation>;
}

export const CATEGORY_LABELS: Record<IssueCategory, string> = {
  pothole: 'Pothole & Road Surface',
  garbage: 'Garbage & Waste',
  streetlight: 'Broken Streetlight',
  water_leakage: 'Water Leakage',
  drainage: 'Drainage Blockage',
  damaged_infrastructure: 'Damaged Infrastructure',
  public_park_damage: 'Public Park Damage',
  other: 'Other Civic Issue',
};

export const PRIORITY_LABELS: Record<IssuePriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export const STATUS_LABELS: Record<ReportStatus, string> = {
  submitted: 'Submitted',
  under_review: 'Under Review',
  verified: 'Verified',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  citizen_confirmed: 'Citizen Confirmed',
  rejected: 'Rejected',
  reopened: 'Reopened',
};

export const WORKFLOW_STAGES: ReportStatus[] = [
  'submitted',
  'under_review',
  'verified',
  'assigned',
  'in_progress',
  'resolved',
  'citizen_confirmed',
];

export interface PublicTimelineEvent {
  stage: string;
  timestampIso: string;
  summary: string;
}

export interface PublicReportSummary {
  id: string;
  trackingCode: string;
  title: string;
  category: IssueCategory;
  priority: IssuePriority;
  status: ReportStatus;
  wardOrZone?: string;
  areaLabel: string;
  departmentId: string;
  departmentName?: string;
  resolutionSummary?: string;
  workStartedAtIso?: string;
  completedAtIso?: string;
  supervisorVerifiedAtIso?: string;
  timelineEvents?: PublicTimelineEvent[];
  createdAt?: any;
  updatedAt?: any;
  createdAtIso?: string;
  updatedAtIso?: string;
}

export interface PublicDepartmentPerformance {
  departmentId: string;
  departmentName: string;
  departmentCode: string;
  total: number;
  underReview: number;
  inProgress: number;
  resolved: number;
  resolutionRatePct: number | null;
  avgResolutionHours: number | null;
}

export interface PublicMonthlyTrend {
  key: string;
  label: string;
  submitted: number;
  resolved: number;
}

export interface PublicUpdateDigestItem {
  reportId: string;
  trackingCode: string;
  title: string;
  category: IssueCategory;
  departmentName: string;
  areaLabel: string;
  status: ReportStatus;
  stage: string;
  timestampIso: string;
  summary: string;
}

export interface PublicTransparencyOverview {
  totalSubmitted: number;
  underReview: number;
  inProgress: number;
  resolved: number;
  rejected: number;
  overallAvgResolutionHours: number | null;
  monthlyTrends: PublicMonthlyTrend[];
  recentPublicUpdates: PublicUpdateDigestItem[];
  publicActivities: PublicCivicActivity[];
  departmentPerformance: PublicDepartmentPerformance[];
  resolutionHistory: PublicReportSummary[];
  generatedAtIso: string;
}

// ------------------------------------------------------------------
// Department Authority Email Routing & Notification Audit Types
// ------------------------------------------------------------------

export type AuthorityEmailStatus =
  | 'pending'
  | 'sent'
  | 'not_configured'
  | 'disabled'
  | 'smtp_not_configured'
  | 'failed';

export type CitizenNotificationStatus = 'pending' | 'sent' | 'failed';

export interface DepartmentEmailSetting {
  departmentId: string;
  departmentName: string;
  officialAuthorityEmail: string;
  seniorAuthorityEmail: string;
  notificationEnabled: boolean;
  departmentContactPerson: string;
  emailVerified: boolean;
  updatedById: string;
  updatedByName: string;
  createdAt: any;
  updatedAt: any;
}

export interface AuthorityEmailLog {
  id: string;
  reportId: string;
  trackingCode: string;
  category: IssueCategory;
  departmentId: string;
  departmentName: string;
  recipientEmail: string;
  ccEmail?: string;
  status: AuthorityEmailStatus;
  citizenNotificationStatus: CitizenNotificationStatus;
  statusNote: string;
  transportUsed: 'smtp' | 'resend' | 'gmail' | 'none';
  actorId: string;
  createdAt: any;
}

// ------------------------------------------------------------------
// NGO & Volunteer Community Participation Module Types
// ------------------------------------------------------------------

export type ActivityCategory =
  | 'cleanup_drive'
  | 'tree_plantation'
  | 'park_restoration'
  | 'water_conservation'
  | 'drainage_clearing'
  | 'road_safety'
  | 'other';

export const ACTIVITY_CATEGORY_LABELS: Record<ActivityCategory, string> = {
  cleanup_drive: 'Neighborhood Cleanup Drive',
  tree_plantation: 'Urban Tree Plantation',
  park_restoration: 'Public Park Restoration',
  water_conservation: 'Water Conservation & Leak Audit',
  drainage_clearing: 'Storm Drain & Canal Clearing',
  road_safety: 'Road & Pedestrian Safety Drive',
  other: 'Community Civic Initiative',
};

export type NgoVerificationStatus = 'pending' | 'approved' | 'rejected';

export interface NgoOrganization {
  id: string;
  ownerUid: string;
  ownerName: string;
  name: string;
  registrationNumber: string;
  focusAreas: string[];
  operatingCityOrWard: string;
  description: string;
  verificationStatus: NgoVerificationStatus;
  reviewedByUid?: string;
  reviewedByName?: string;
  reviewNote?: string;
  createdAt: any;
  updatedAt: any;
}

export interface NgoPrivateContact {
  ngoId: string;
  ownerUid: string;
  contactEmail: string;
  contactPhone?: string;
  updatedAt: any;
}

export interface VolunteerProfile {
  uid: string;
  displayName: string;
  skills: string[];
  serviceArea: string;
  availability: string;
  active: boolean;
  joinedActivityCount: number;
  createdAt: any;
  updatedAt: any;
}

export type CivicActivityStatus = 'pending_approval' | 'approved' | 'completed' | 'rejected';

export interface CivicActivity {
  id: string;
  ngoId: string;
  ngoName: string;
  createdByUid: string;
  title: string;
  description: string;
  category: ActivityCategory;
  locationLabel: string;
  wardOrZone?: string;
  scheduledDateIso: string;
  maxVolunteers: number;
  participantCount: number;
  relatedReportId?: string;
  status: CivicActivityStatus;
  reviewNote?: string;
  reviewedByUid?: string;
  completionSummary?: string;
  completionPhotoMetadata?: UploadedImageMetadata[];
  completionSubmittedAtIso?: string;
  createdAt: any;
  updatedAt: any;
}

export type ActivityParticipantStatus = 'joined' | 'withdrawn' | 'attended';

export interface ActivityParticipant {
  uid: string;
  activityId: string;
  volunteerName: string;
  note?: string;
  status: ActivityParticipantStatus;
  joinedAt: any;
  updatedAt: any;
}

export interface PublicCivicActivity {
  id: string;
  ngoId: string;
  ngoName: string;
  title: string;
  description: string;
  category: ActivityCategory;
  locationLabel: string;
  wardOrZone?: string;
  scheduledDateIso: string;
  maxVolunteers: number;
  participantCount: number;
  status: 'approved' | 'completed';
  completionSummary?: string;
  completionPhotoCount?: number;
  createdAt?: any;
  updatedAt?: any;
  createdAtIso?: string;
  updatedAtIso?: string;
}




