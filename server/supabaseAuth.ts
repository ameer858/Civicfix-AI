import type { NextFunction, Request, Response } from 'express';
import {
  getSupabaseAdminClient,
  verifySupabaseAccessToken,
} from '../supabaseClient.ts';
import {
  ALL_WORKER_AVAILABILITY_STATUSES,
  CANONICAL_STARTER_DEPARTMENTS,
  attachVerifiedAiAnalysisSupabase,
  createVerifiedCivicReportSupabase,
  ensureCanonicalDepartmentsExist,
  fetchAccessibleReportsForDuplicatesSupabase,
  fetchAccessibleReportsForUserSupabase,
  fetchPublicActivitiesFromSupabase,
  fetchPublicReportByTrackingCodeFromSupabase,
  fetchPublicReportsFromSupabase,
  fetchSingleReportForUserSupabase,
  isWorkerAvailabilityStatus,
  listDepartmentEmailSettingsForAdminSupabase,
  makeWorkerInviteId,
  mapProfileRow,
  normalizeUserRole,
  processReportAuthorityEmailRoutingSupabase,
  registerWorkerInviteSupabase,
  resolveCanonicalDeptName,
  resolveTargetDepartmentForCategory,
  saveDepartmentEmailSettingAsAdminSupabase,
  updateUserRoleAsAdminSupabase,
  updateWorkerOperationalProfileSupabase,
  verifyReportTransitionAuthorizationSupabase,
  type AuthenticatedUser,
  type ServerAuthorityEmailLog,
  type ServerCivicReportRecord,
  type ServerCreateReportInput,
  type ServerDepartmentEmailSetting,
  type ServerPublicActivitySummary,
  type ServerPublicReportSummary,
  type ServerPublicTimelineEvent,
  type ServerUserProfile,
  type ServerWorkerInvite,
  type UserRole,
  type VerifiedUploadMetadataInput,
  type WorkerAvailabilityStatus,
} from './supabaseDb.ts';

export {
  ALL_WORKER_AVAILABILITY_STATUSES,
  CANONICAL_STARTER_DEPARTMENTS,
  isWorkerAvailabilityStatus,
  makeWorkerInviteId,
  resolveTargetDepartmentForCategory,
  type AuthenticatedUser,
  type ServerAuthorityEmailLog,
  type ServerCivicReportRecord,
  type ServerCreateReportInput,
  type ServerDepartmentEmailSetting,
  type ServerPublicActivitySummary,
  type ServerPublicReportSummary,
  type ServerPublicTimelineEvent,
  type ServerUserProfile,
  type ServerWorkerInvite,
  type UserRole,
  type VerifiedUploadMetadataInput,
  type WorkerAvailabilityStatus,
};

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

const DEFAULT_BOOTSTRAP_ADMIN_EMAIL = 'anshadameer61@gmail.com';
const BOOTSTRAP_ADMIN_ALLOWLIST: Set<string> = new Set(
  (process.env.BOOTSTRAP_ADMIN_EMAIL || DEFAULT_BOOTSTRAP_ADMIN_EMAIL)
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);


export function isAllowlistedBootstrapAdminEmail(email: string, emailVerified: boolean): boolean {
  return Boolean(emailVerified && email && BOOTSTRAP_ADMIN_ALLOWLIST.has(email.trim().toLowerCase()));
}

interface SupabaseProfileRow {
  id: string;
  firebase_uid?: string | null;
  full_name?: string | null;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
  avatar_url?: string | null;
  department_id?: string | null;
  is_active?: boolean | null;
  metadata?: Record<string, any> | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * Loads authoritative user role, departmentId, and active status strictly from
 * the Supabase `profiles` table (never trusting client claims or user_metadata).
 */
export async function fetchUserRoleFromSupabase(
  uid: string
): Promise<{ role: UserRole; departmentId: string; active: boolean; exists: boolean }> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from('profiles')
    .select('id, role, department_id, is_active')
    .eq('id', uid)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load authorization profile from Supabase: ${error.message}`);
  }

  if (!data) {
    return { role: 'citizen', departmentId: '', active: true, exists: false };
  }

  return {
    role: normalizeUserRole(data.role),
    departmentId: typeof data.department_id === 'string' ? data.department_id : '',
    active: data.is_active !== false,
    exists: true,
  };
}


/**
 * Express authentication middleware: verifies Supabase access tokens via
 * server-side Supabase Auth and loads authoritative role/department from `profiles`.
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      res.status(401).json({ error: 'Authentication required. Missing Bearer token.' });
      return;
    }
    const accessToken = match[1].trim();
    const sbUser = await verifySupabaseAccessToken(accessToken);

    const uid = typeof sbUser.id === 'string' ? sbUser.id : '';
    const email = typeof sbUser.email === 'string' ? sbUser.email : '';
    const emailVerified = Boolean(sbUser.email_confirmed_at || sbUser.confirmed_at);
    const userMeta =
      sbUser.user_metadata && typeof sbUser.user_metadata === 'object'
        ? (sbUser.user_metadata as Record<string, unknown>)
        : {};
    const rawName =
      (typeof userMeta.full_name === 'string' && userMeta.full_name) ||
      (typeof userMeta.display_name === 'string' && userMeta.display_name) ||
      (typeof userMeta.name === 'string' && userMeta.name) ||
      (email.includes('@') ? email.split('@')[0] : '') ||
      'Civic User';
    const photoUrl =
      (typeof userMeta.avatar_url === 'string' && userMeta.avatar_url) ||
      (typeof userMeta.picture === 'string' && userMeta.picture) ||
      '';

    if (!uid) {
      res.status(401).json({ error: 'Invalid authentication token subject.' });
      return;
    }

    const { role, departmentId, active } = await fetchUserRoleFromSupabase(uid);
    if (!active) {
      res.status(403).json({
        error: 'This account has been deactivated by an administrator. Contact municipal support for assistance.',
      });
      return;
    }

    req.user = {
      uid,
      email,
      emailVerified,
      name: rawName,
      photoUrl,
      role,
      departmentId,
      idToken: accessToken,
    };

    next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Invalid or expired authentication token.';
    res.status(401).json({ error: `Authentication failed: ${message}` });
  }
}

export function requireRole(allowedRoles: Array<UserRole>) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        error: `Forbidden: Role '${req.user.role}' is not authorized for this operation.`,
      });
      return;
    }
    next();
  };
}

/**
 * Separates authentication from authorization using Supabase Auth + `profiles`:
 * 1. Every new authenticated user receives the 'citizen' role by default.
 * 2. Browser input can never supply or elevate privileged roles.
 * 3. Allowlisted bootstrap admin promotion and pre-authorized worker/officer invite
 *    claiming are enforced strictly server-side using the Supabase secret key.
 */
export async function initializeUserAndBootstrapAdmin(user: AuthenticatedUser): Promise<{
  profile: ServerUserProfile;
  isAdmin: boolean;
  bootstrapApplied: boolean;
  bootstrapPendingServerConfig: boolean;
  bootstrapNotice: string | null;
  authMode: 'service_account' | 'verified_token';
}> {
  const supabase = getSupabaseAdminClient();
  const uid = user.uid;
  const displayName = (user.name || user.email.split('@')[0] || 'Civic User').trim().slice(0, 100);
  const safeEmail = (user.email || '').trim().toLowerCase().slice(0, 200);
  const safePhoto = (user.photoUrl || '').trim().slice(0, 500);
  const nowIso = new Date().toISOString();

  // 1. Fetch or create profile row (always defaulting new users to 'citizen')
  const { data: existingData, error: fetchError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', uid)
    .maybeSingle();

  if (fetchError) {
    throw new Error(`Unable to read user profile from Supabase: ${fetchError.message}`);
  }

  let currentRow = existingData as SupabaseProfileRow | null;

  if (!currentRow) {
    const insertPayload = {
      id: uid,
      full_name: displayName,
      email: safeEmail || null,
      phone: '',
      avatar_url: safePhoto || null,
      role: 'citizen',
      department_id: null,
      is_active: true,
      metadata: { departmentName: '' },
      created_at: nowIso,
      updated_at: nowIso,
    };

    const { data: inserted, error: insertError } = await supabase
      .from('profiles')
      .insert(insertPayload)
      .select('*')
      .single();

    if (insertError) {
      if (insertError.code === '23505') {
        const { data: retryData, error: retryErr } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', uid)
          .single();
        if (retryErr || !retryData) {
          throw new Error(
            `Unable to reload user profile after concurrent creation: ${retryErr?.message || 'Not found'}`
          );
        }
        currentRow = retryData as SupabaseProfileRow;
      } else {
        throw new Error(`Unable to create user profile in Supabase: ${insertError.message}`);
      }
    } else {
      currentRow = inserted as SupabaseProfileRow;
    }
  } else {
    if (currentRow.is_active === false) {
      throw new Error(
        'This account has been deactivated by an administrator. Contact municipal support for assistance.'
      );
    }

    const syncUpdates: Record<string, any> = {};
    if (safeEmail && currentRow.email !== safeEmail) syncUpdates.email = safeEmail;
    if (safePhoto && currentRow.avatar_url !== safePhoto) syncUpdates.avatar_url = safePhoto;
    if (!currentRow.full_name && displayName) syncUpdates.full_name = displayName;
    if (!currentRow.metadata || typeof currentRow.metadata !== 'object') {
      syncUpdates.metadata = { departmentName: '' };
    }

    if (Object.keys(syncUpdates).length > 0) {
      syncUpdates.updated_at = nowIso;
      const { data: synced } = await supabase
        .from('profiles')
        .update(syncUpdates)
        .eq('id', uid)
        .select('*')
        .maybeSingle();
      if (synced) {
        currentRow = synced as SupabaseProfileRow;
      }
    }
  }

  let bootstrapApplied = false;
  let bootstrapNotice: string | null = null;
  const emailIsAllowlisted = Boolean(safeEmail && BOOTSTRAP_ADMIN_ALLOWLIST.has(safeEmail));
  const isVerifiedBootstrapAdmin = isAllowlistedBootstrapAdminEmail(safeEmail, user.emailVerified);

  // 2. Server-side allowlisted admin bootstrap (never client-supplied)
  if (isVerifiedBootstrapAdmin && normalizeUserRole(currentRow.role) !== 'admin') {
    const { data: promoted, error: promoteErr } = await supabase
      .from('profiles')
      .update({ role: 'admin', updated_at: new Date().toISOString() })
      .eq('id', uid)
      .select('*')
      .single();

    if (promoteErr) {
      throw new Error(`Admin bootstrap promotion failed: ${promoteErr.message}`);
    }
    if (promoted) {
      currentRow = promoted as SupabaseProfileRow;
      bootstrapApplied = true;
    }

    // Sync to admins table using verified schema (PK is `id` FK -> profiles.id)
    await supabase
      .from('admins')
      .upsert(
        {
          id: uid,
          full_name: currentRow.full_name || displayName,
          email: safeEmail || null,
          is_active: true,
          metadata: { grantedBy: 'server_bootstrap' },
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' }
      )
      .then(() => {}, () => {});
  } else if (
    emailIsAllowlisted &&
    !user.emailVerified &&
    normalizeUserRole(currentRow.role) !== 'admin'
  ) {
    bootstrapNotice = `Signed in as Citizen (${safeEmail}). Please confirm your email address to activate allowlisted Administrator privileges.`;
  }

  // 3. Claim any pending pre-authorized worker/officer invite for this email
  if (normalizeUserRole(currentRow.role) === 'citizen' && safeEmail) {
    const { data: inviteRows } = await supabase
      .from('worker_invites')
      .select('*')
      .ilike('email', safeEmail)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1);

    const invite = Array.isArray(inviteRows) ? inviteRows[0] : null;
    if (invite) {
      const invitedRole = String(invite.role || '').toLowerCase();
      const notExpired = !invite.expires_at || Date.parse(String(invite.expires_at)) > Date.now();
      if ((invitedRole === 'worker' || invitedRole === 'officer') && notExpired) {
        const existingMeta =
          currentRow.metadata && typeof currentRow.metadata === 'object' ? currentRow.metadata : {};
        const invMeta =
          invite.metadata && typeof invite.metadata === 'object' ? invite.metadata : {};
        const nextDeptId =
          typeof invite.department_id === 'string' && invite.department_id
            ? invite.department_id
            : null;
        const mergedMeta: Record<string, any> = {
          ...existingMeta,
          departmentName:
            (typeof invMeta.departmentName === 'string' && invMeta.departmentName) ||
            resolveCanonicalDeptName(nextDeptId || ''),
          availabilityStatus: isWorkerAvailabilityStatus(String(invMeta.availabilityStatus || ''))
            ? invMeta.availabilityStatus
            : 'available',
          workZone: typeof invMeta.workZone === 'string' ? invMeta.workZone : '',
          claimedInviteId: String(invite.id),
        };
        if (invMeta.employeeId) mergedMeta.employeeId = String(invMeta.employeeId);
        if (invMeta.supervisorId) mergedMeta.supervisorId = String(invMeta.supervisorId);
        if (invMeta.supervisorName) mergedMeta.supervisorName = String(invMeta.supervisorName);

        const { data: claimedProfile, error: claimErr } = await supabase
          .from('profiles')
          .update({
            role: invitedRole,
            department_id: nextDeptId,
            full_name: currentRow.full_name || invite.full_name || displayName,
            metadata: mergedMeta,
            updated_at: new Date().toISOString(),
          })
          .eq('id', uid)
          .select('*')
          .single();

        if (!claimErr && claimedProfile) {
          currentRow = claimedProfile as SupabaseProfileRow;
          await supabase
            .from('worker_invites')
            .update({
              status: 'accepted',
              accepted_at: new Date().toISOString(),
              metadata: {
                ...invMeta,
                claimedByUid: uid,
              },
            })
            .eq('id', invite.id);
        }
      }
    }
  }

  const finalProfile = mapProfileRow(currentRow);

  // Ensure canonical municipal departments exist when an admin signs in
  if (finalProfile.role === 'admin') {
    await ensureCanonicalDepartmentsExist(uid).catch((err) => {
      console.warn('Department seed check skipped:', err instanceof Error ? err.message : err);
    });
  }

  return {
    profile: finalProfile,
    isAdmin: finalProfile.role === 'admin',
    bootstrapApplied,
    bootstrapPendingServerConfig: false,
    bootstrapNotice,
    authMode: 'service_account',
  };
}

// ------------------------------------------------------------------
// Delegated Supabase PostgreSQL Data Operations
// ------------------------------------------------------------------

export {
  fetchPublicReportsFromSupabase,
  fetchPublicReportByTrackingCodeFromSupabase,
  fetchPublicActivitiesFromSupabase,
};
export const fetchAccessibleReportsForDuplicates = fetchAccessibleReportsForDuplicatesSupabase;
export const fetchAccessibleReportsForUser = fetchAccessibleReportsForUserSupabase;
export const fetchSingleReportForUser = fetchSingleReportForUserSupabase;
export const createVerifiedCivicReportServerSide = createVerifiedCivicReportSupabase;
export const attachVerifiedAiAnalysisServerSide = attachVerifiedAiAnalysisSupabase;
export const verifyReportTransitionAuthorization = verifyReportTransitionAuthorizationSupabase;
export const listDepartmentEmailSettingsForAdmin = listDepartmentEmailSettingsForAdminSupabase;
export const saveDepartmentEmailSettingAsAdmin = saveDepartmentEmailSettingAsAdminSupabase;
export const processReportAuthorityEmailRouting = processReportAuthorityEmailRoutingSupabase;
export const registerWorkerInviteAsAdmin = registerWorkerInviteSupabase;
export const updateWorkerOperationalProfile = updateWorkerOperationalProfileSupabase;
export const updateUserRoleAsAdmin = updateUserRoleAsAdminSupabase;
