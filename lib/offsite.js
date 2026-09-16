/**
 * Off-box backup copies: PUT the nightly SQLite snapshot into any S3-compatible
 * bucket (AWS S3, Cloudflare R2, Backblaze B2, Railway buckets) with a plain
 * SigV4 request, no SDK. Dormant until BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY
 * and BACKUP_S3_SECRET_KEY are set. Optional: BACKUP_S3_ENDPOINT (default AWS),
 * BACKUP_S3_REGION (default auto / us-east-1), BACKUP_S3_PREFIX (default dmsetter/).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function offsiteReady() {
  return !!(process.env.BACKUP_S3_BUCKET && process.env.BACKUP_S3_ACCESS_KEY && process.env.BACKUP_S3_SECRET_KEY);
}

const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Upload one file. Returns the object key. Throws on a non-2xx response. */
export async function uploadBackup(file) {
  const bucket = process.env.BACKUP_S3_BUCKET;
  const region = process.env.BACKUP_S3_REGION || 'us-east-1';
  const endpoint = (process.env.BACKUP_S3_ENDPOINT || `https://s3.${region}.amazonaws.com`).replace(/\/+$/, '');
  const prefix = (process.env.BACKUP_S3_PREFIX || 'dmsetter/').replace(/^\/+/, '');
  const key = prefix + path.basename(file);
  const body = fs.readFileSync(file);
  const url = new URL(`${endpoint}/${bucket}/${key}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = hex(body);
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, 'content-type': 'application/octet-stream' };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonical = ['PUT', url.pathname.split('/').map(encodeURIComponent).join('/'), '', ...Object.keys(headers).sort().map((h) => `${h}:${headers[h]}`), '', signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + process.env.BACKUP_S3_SECRET_KEY, date), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  const auth = `AWS4-HMAC-SHA256 Credential=${process.env.BACKUP_S3_ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const res = await fetch(url, { method: 'PUT', headers: { ...headers, Authorization: auth, 'content-length': String(body.length) }, body });
  if (!res.ok) throw new Error(`S3 PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return key;
}
