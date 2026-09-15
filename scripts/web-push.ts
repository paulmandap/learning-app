/**
 * Web Push, with nothing but Node's own crypto (NOTES §45).
 *
 * Two standards. RFC 8291 encrypts a message so that only the device it is for
 * can read it; RFC 8292 (VAPID) signs the request, so the push service — Apple's
 * or Google's — knows it comes from the key the device subscribed with.
 *
 * `web-push` on npm does both. It would be a dependency (HANDOFF asks for a
 * measured reason) for about a hundred lines, run only by the reminders
 * workflow, so these lines are here instead — and `tests/web-push.test.ts`
 * holds them to the RFC's own worked example, value for value.
 */
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';
import type { SubscriptionKeys } from '../src/core/reminders';

const RECORD_SIZE = 4096;

/**
 * Encrypt one message for one device (RFC 8291 §3–4): a single aes128gcm record.
 *
 * `fixed` pins the sender's key pair and salt, which only the RFC's example
 * does; left out, both are new for every message, as they must be.
 */
export function encryptPayload(
  plaintext: Buffer,
  device: Pick<SubscriptionKeys, 'p256dh' | 'auth'>,
  fixed?: { senderPrivateKey: Buffer; salt: Buffer },
): Buffer {
  const devicePublic = Buffer.from(device.p256dh, 'base64url');
  const authSecret = Buffer.from(device.auth, 'base64url');

  const sender = createECDH('prime256v1');
  if (fixed) sender.setPrivateKey(fixed.senderPrivateKey);
  else sender.generateKeys();
  const senderPublic = sender.getPublicKey();
  const shared = sender.computeSecret(devicePublic);

  // IKM = HKDF(auth secret, shared secret, "WebPush: info" || device key || sender key)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), devicePublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));

  const salt = fixed?.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  // The whole message is the last record, so it ends with the 0x02 delimiter.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  // salt (16) || record size (4) || key length (1) || sender public key (65)
  const header = Buffer.alloc(21 + senderPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublic.length, 20);
  senderPublic.copy(header, 21);
  return Buffer.concat([header, sealed]);
}

export interface VapidKeys {
  /** base64url, the 65-byte public key — VAPID_PUBLIC_KEY. */
  publicKey: string;
  /** base64url, the 32-byte private key — the VAPID_PRIVATE_KEY secret. */
  privateKey: string;
}

/**
 * The Authorization header for one push service (RFC 8292): a JWT for that
 * service's origin, signed with ES256, good for twelve hours — under the
 * twenty-four the standard allows.
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now: number): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: subject,
  })}`;
  const publicKey = Buffer.from(keys.publicKey, 'base64url');
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: publicKey.subarray(1, 33).toString('base64url'),
      y: publicKey.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${keys.publicKey}`;
}

/** Sent; gone — the service has forgotten the device, so stop sending to it; or failed for another reason. */
export type PushOutcome = { outcome: 'sent' | 'gone' | 'failed'; status: number; detail: string };

/** Send one message to one device. Never throws for a refusal; says what came back. */
export async function sendPush(
  device: SubscriptionKeys,
  message: string,
  options: { keys: VapidKeys; subject: string; ttlSeconds: number; topic?: string; now?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<PushOutcome> {
  const response = await fetchImpl(device.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(device.endpoint, options.keys, options.subject, options.now ?? Date.now()),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(options.ttlSeconds),
      Urgency: 'normal',
      // A newer message with the same topic replaces one not yet delivered.
      ...(options.topic ? { Topic: options.topic } : {}),
    },
    // Copied into a plain Uint8Array: fetch's types refuse a Node Buffer as a body.
    body: Uint8Array.from(encryptPayload(Buffer.from(message, 'utf8'), device)),
  });
  const detail = response.ok ? '' : (await response.text().catch(() => '')).slice(0, 200);
  if (response.status === 404 || response.status === 410) return { outcome: 'gone', status: response.status, detail };
  return { outcome: response.ok ? 'sent' : 'failed', status: response.status, detail };
}
