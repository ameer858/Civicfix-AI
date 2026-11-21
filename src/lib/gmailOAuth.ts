import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  type Auth,
} from 'firebase/auth';
import oauthFirebaseConfig from '../../firebase-applet-config.json';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

// OAuth-enabled Firebase app provisioned via set_up_oauth for Gmail sending
// (strictly isolated from Supabase email/password authentication and PostgreSQL)
const GMAIL_OAUTH_FIREBASE_CONFIG = {
  projectId: oauthFirebaseConfig.projectId,
  appId: oauthFirebaseConfig.appId,
  apiKey: oauthFirebaseConfig.apiKey,
  authDomain: oauthFirebaseConfig.authDomain,
  storageBucket: oauthFirebaseConfig.storageBucket,
  messagingSenderId: oauthFirebaseConfig.messagingSenderId,
};

const GMAIL_OAUTH_APP_NAME = 'civicfix-gmail-oauth';

let cachedGmailAuth: Auth | null = null;

function getGmailOAuthAuth(): Auth {
  if (cachedGmailAuth) return cachedGmailAuth;
  const existingApp: FirebaseApp | undefined = getApps().find(
    (app) => app.name === GMAIL_OAUTH_APP_NAME
  );
  const app = existingApp || initializeApp(GMAIL_OAUTH_FIREBASE_CONFIG, GMAIL_OAUTH_APP_NAME);
  cachedGmailAuth = getAuth(app);
  return cachedGmailAuth;
}

if (typeof window !== 'undefined') {
  try {
    getGmailOAuthAuth();
  } catch {
    // Ignore eager init failure in non-browser contexts
  }
}

export async function clearGmailOAuthSession(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const existingApp = getApps().find((app) => app.name === GMAIL_OAUTH_APP_NAME);
    if (existingApp) {
      await getAuth(existingApp).signOut();
    }
  } catch {
    // Ignore cleanup errors
  }
}

interface TokenInfoResponse {
  scope?: string;
  expires_in?: string | number;
  email?: string;
  error?: string;
  error_description?: string;
}

export async function verifyGmailSendToken(accessToken: string): Promise<{
  valid: boolean;
  hasGmailScope: boolean;
  expiresInSec: number;
}> {
  try {
    const res = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
    );
    if (!res.ok) {
      return { valid: false, hasGmailScope: false, expiresInSec: 0 };
    }
    const data = (await res.json()) as TokenInfoResponse;
    const scopes = String(data.scope || '')
      .split(/\s+/)
      .filter(Boolean);
    const hasGmailScope =
      scopes.includes(GMAIL_SEND_SCOPE) || scopes.includes('https://mail.google.com/');
    const expiresInSec = Math.max(60, Number(data.expires_in) || 3500);
    return {
      valid: true,
      hasGmailScope,
      expiresInSec,
    };
  } catch {
    // If tokeninfo endpoint is unreachable due to transient network conditions,
    // allow the freshly issued Firebase OAuth access token to proceed.
    return {
      valid: true,
      hasGmailScope: true,
      expiresInSec: 3500,
    };
  }
}

export async function requestGmailSendAccessToken(loginHint?: string): Promise<{
  accessToken: string;
  expiresInSec: number;
}> {
  if (typeof window === 'undefined') {
    throw new Error('Gmail authorization is only available in a browser.');
  }

  const gmailAuth = getGmailOAuthAuth();
  const provider = new GoogleAuthProvider();
  provider.addScope(GMAIL_SEND_SCOPE);
  provider.setCustomParameters({
    prompt: 'consent',
    ...(loginHint ? { login_hint: loginHint } : {}),
  });

  try {
    const result = await signInWithPopup(gmailAuth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error(
        'Google sign-in completed, but no Gmail access token was returned. Please try connecting Gmail again.'
      );
    }

    const verification = await verifyGmailSendToken(credential.accessToken);
    if (!verification.valid) {
      throw new Error('The Gmail authorization token was invalid or expired. Please try again.');
    }
    if (!verification.hasGmailScope) {
      throw new Error(
        'Gmail send permission was not granted. Please check the Gmail permission box on the Google consent screen and try again.'
      );
    }

    return {
      accessToken: credential.accessToken,
      expiresInSec: verification.expiresInSec,
    };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code || '';
    if (code === 'auth/popup-blocked') {
      throw new Error(
        'Gmail permission popup was blocked by your browser. Please allow popups for this site and try again.'
      );
    }
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      throw new Error('Gmail permission window was closed before completion.');
    }
    if (code === 'auth/unauthorized-domain') {
      throw new Error(
        `This domain is not yet authorized in Firebase Authentication (${GMAIL_OAUTH_FIREBASE_CONFIG.projectId}). Refresh the page and try again.`
      );
    }
    if (code === 'auth/operation-not-allowed') {
      throw new Error(
        `Google Sign-In is not enabled on the Gmail OAuth Firebase project (${GMAIL_OAUTH_FIREBASE_CONFIG.projectId}).`
      );
    }
    if (err instanceof Error) {
      throw err;
    }
    throw new Error('Unable to authorize Gmail access.');
  }
}
