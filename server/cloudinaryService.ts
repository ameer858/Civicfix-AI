import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';

const CLOUDINARY_UPLOAD_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;

let lastConfigSignature = '';

function getCloudinaryCredentials(): {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
} | null {
  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const apiKey = String(process.env.CLOUDINARY_API_KEY || '').trim();
  const apiSecret = String(process.env.CLOUDINARY_API_SECRET || '').trim();
  if (!cloudName || !apiKey || !apiSecret) {
    return null;
  }
  return { cloudName, apiKey, apiSecret };
}

export function isCloudinaryConfigured(): boolean {
  return Boolean(getCloudinaryCredentials());
}

function ensureCloudinaryConfigured(): {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
} {
  const creds = getCloudinaryCredentials();
  if (!creds) {
    throw new Error(
      'Cloudinary credentials are not configured on the server (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET).'
    );
  }
  const sig = `${creds.cloudName}:${creds.apiKey}:${creds.apiSecret.length}`;
  if (sig !== lastConfigSignature) {
    cloudinary.config({
      cloud_name: creds.cloudName,
      api_key: creds.apiKey,
      api_secret: creds.apiSecret,
      secure: true,
    });
    lastConfigSignature = sig;
  }
  return creds;
}

export interface CloudinaryUploadResult {
  secureUrl: string;
  publicId: string;
  bytes: number;
  format: string;
  width?: number;
  height?: number;
}

export async function uploadImageBufferToCloudinary(
  buffer: Buffer,
  options: {
    folder: 'reports' | 'evidence';
    uid: string;
    fileName: string;
    mimeType: string;
  }
): Promise<CloudinaryUploadResult> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Cannot upload an empty image buffer to Cloudinary.');
  }

  ensureCloudinaryConfigured();

  const safeUid = options.uid.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'user';
  const safeBaseName =
    options.fileName
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 48) || 'civic_photo';
  const folderPath = `civicfix/${options.folder}/${safeUid}`;

  const result = await new Promise<UploadApiResponse>((resolve, reject) => {
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Cloudinary upload timed out. Please retry.'));
      }
    }, CLOUDINARY_UPLOAD_TIMEOUT_MS);

    const stream = cloudinary.uploader.upload_stream(
      {
        folder: folderPath,
        public_id_prefix: safeBaseName,
        resource_type: 'image',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
        unique_filename: true,
        overwrite: false,
        timeout: CLOUDINARY_UPLOAD_TIMEOUT_MS,
        context: {
          app: 'civicfix-ai',
          folder: options.folder,
          uploaded_by: safeUid,
        },
      },
      (err, uploadResult) => {
        clearTimeout(timeoutHandle);
        if (settled) return;
        settled = true;
        if (err) {
          const httpCode = (err as { http_code?: number }).http_code;
          const rawMsg = err.message || 'Cloudinary image upload failed.';
          if (httpCode === 403 || rawMsg.includes('403') || rawMsg.includes('missing permissions')) {
            reject(
              new Error(
                'Cloudinary rejected the image upload (HTTP 403: missing create/upload permissions on the configured CLOUDINARY_API_KEY). Enable upload/create permissions for this API key in Cloudinary Console > Settings > Access Keys.'
              )
            );
            return;
          }
          reject(new Error(rawMsg));
          return;
        }
        if (!uploadResult || !uploadResult.secure_url || !uploadResult.public_id) {
          reject(new Error('Cloudinary did not return a valid secure_url and public_id.'));
          return;
        }
        resolve(uploadResult);
      }
    );

    stream.on('error', (streamErr) => {
      clearTimeout(timeoutHandle);
      if (!settled) {
        settled = true;
        reject(streamErr instanceof Error ? streamErr : new Error('Cloudinary upload stream failed.'));
      }
    });

    stream.end(buffer);
  });

  if (!result.secure_url.startsWith('https://')) {
    throw new Error('Cloudinary returned a non-HTTPS URL.');
  }

  return {
    secureUrl: result.secure_url,
    publicId: result.public_id,
    bytes: Number(result.bytes) || buffer.length,
    format: String(result.format || ''),
    width: typeof result.width === 'number' ? result.width : undefined,
    height: typeof result.height === 'number' ? result.height : undefined,
  };
}

export async function deleteCloudinaryAsset(publicId: string): Promise<boolean> {
  const cleanId = String(publicId || '').trim();
  if (!cleanId || !isCloudinaryConfigured()) {
    return false;
  }
  ensureCloudinaryConfigured();
  try {
    const res = await cloudinary.uploader.destroy(cleanId, {
      resource_type: 'image',
      invalidate: true,
    });
    return res?.result === 'ok' || res?.result === 'not found';
  } catch {
    return false;
  }
}

export function isTrustedCloudinaryUrl(urlString: string): boolean {
  const creds = getCloudinaryCredentials();
  if (!creds) return false;
  try {
    const parsed = new URL(urlString);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'res.cloudinary.com' &&
      parsed.pathname.startsWith(`/${creds.cloudName}/`)
    );
  } catch {
    return false;
  }
}

export async function fetchCloudinaryImageBuffer(secureUrl: string): Promise<{
  buffer: Buffer;
  mimeType: string;
}> {
  if (!isTrustedCloudinaryUrl(secureUrl)) {
    throw new Error('Refusing to fetch image from an untrusted or non-Cloudinary URL.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(secureUrl, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Failed to retrieve uploaded image from Cloudinary (HTTP ${res.status}).`);
    }
    const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength === 0 || arrayBuf.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error('Retrieved Cloudinary image exceeds allowed size bounds.');
    }
    return {
      buffer: Buffer.from(arrayBuf),
      mimeType: contentType || 'image/jpeg',
    };
  } finally {
    clearTimeout(timer);
  }
}
