import { createDecipheriv, createECDH, createPublicKey, generateKeyPairSync, hkdfSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { encryptPayload, sendPush, vapidAuthorization } from '../scripts/web-push';

/**
 * Web Push without the npm package (NOTES §45), held to the standards it
 * implements.
 *
 * The encryption is checked against RFC 8291's own worked example — its keys,
 * its salt and the exact bytes it says come out — so a mistake in any of the
 * derivation steps cannot pass. The signature is verified with the public key,
 * as a push service does.
 */

/** RFC 8291 §5 and Appendix A (https://www.rfc-editor.org/rfc/rfc8291), base64url. */
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  devicePrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  devicePublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};

const bytes = (value: string) => Buffer.from(value, 'base64url');

/** What a device does with a message: RFC 8291 from the receiving side. */
function decrypt(body: Buffer, devicePrivate: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const keyLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + keyLength);
  const device = createECDH('prime256v1');
  device.setPrivateKey(devicePrivate);
  const shared = device.computeSecret(senderPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), device.getPublicKey(), senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const sealed = body.subarray(21 + keyLength);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  expect(padded.at(-1)).toBe(2); // the last-record delimiter
  return padded.subarray(0, padded.length - 1);
}

describe('encryptPayload — RFC 8291', () => {
  it("produces the RFC's own example, byte for byte", () => {
    const body = encryptPayload(
      bytes(RFC.plaintext),
      { p256dh: RFC.devicePublic, auth: RFC.auth },
      { senderPrivateKey: bytes(RFC.senderPrivate), salt: bytes(RFC.salt) },
    );
    expect(body.subarray(0, 86).toString('base64url')).toBe(bytes(RFC.header).toString('base64url'));
    expect(body.subarray(86).toString('base64url')).toBe(RFC.ciphertext);
    expect(decrypt(body, bytes(RFC.devicePrivate), bytes(RFC.auth)).toString()).toBe('When I grow up, I want to be a watermelon');
  });

  it('uses a fresh key and salt for every message, and the device can still read it', () => {
    const device = createECDH('prime256v1');
    device.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const keys = { p256dh: device.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
    const message = JSON.stringify({ title: '8 cards due today', body: 'Keep your 3-day streak going.', url: '/' });

    const first = encryptPayload(Buffer.from(message), keys);
    const second = encryptPayload(Buffer.from(message), keys);
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false);
    expect(decrypt(first, device.getPrivateKey(), auth).toString()).toBe(message);
    expect(decrypt(second, device.getPrivateKey(), auth).toString()).toBe(message);
  });
});

describe('vapidAuthorization — RFC 8292', () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.privateKey.export({ format: 'jwk' });
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  const keys = {
    privateKey: jwk.d!,
    publicKey: Buffer.concat([Buffer.from([4]), bytes(publicJwk.x!), bytes(publicJwk.y!)]).toString('base64url'),
  };
  const now = Date.parse('2026-09-15T12:07:00Z');

  it('signs a token for the push service, which the public key verifies', () => {
    const header = vapidAuthorization('https://web.push.apple.com/QGh5/abc', keys, 'mailto:someone@example.test', now);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(bytes(head!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(bytes(claims!).toString())).toEqual({
      aud: 'https://web.push.apple.com',
      exp: Math.floor(now / 1000) + 12 * 60 * 60,
      sub: 'mailto:someone@example.test',
    });
    const publicKey = createPublicKey({ key: { ...publicJwk }, format: 'jwk' });
    const valid = verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, bytes(signature!));
    expect(valid).toBe(true);
  });
});

describe('sendPush', () => {
  const device = createECDH('prime256v1');
  device.generateKeys();
  const target = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    p256dh: device.getPublicKey().toString('base64url'),
    auth: Buffer.alloc(16, 1).toString('base64url'),
  };
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  const keys = {
    privateKey: pair.privateKey.export({ format: 'jwk' }).d!,
    publicKey: Buffer.concat([Buffer.from([4]), bytes(publicJwk.x!), bytes(publicJwk.y!)]).toString('base64url'),
  };
  const options = { keys, subject: 'mailto:someone@example.test', ttlSeconds: 10800, topic: 'nomi-reminder' };

  it('posts the encrypted message with the headers a push service requires', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    const result = await sendPush(target, '{"title":"hi"}', options, fetchImpl as unknown as typeof fetch);
    expect(result.outcome).toBe('sent');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(target.endpoint);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Encoding': 'aes128gcm',
      TTL: '10800',
      Topic: 'nomi-reminder',
    });
    expect(String((init.headers as Record<string, string>).Authorization)).toMatch(/^vapid t=.+, k=/);
    expect(decrypt(Buffer.from(init.body as Uint8Array), device.getPrivateKey(), Buffer.alloc(16, 1)).toString()).toBe('{"title":"hi"}');
  });

  it('says a device is gone when the service has forgotten it, and failed otherwise', async () => {
    const answer = (status: number) => vi.fn(async () => new Response('nope', { status })) as unknown as typeof fetch;
    expect((await sendPush(target, 'x', options, answer(410))).outcome).toBe('gone');
    expect((await sendPush(target, 'x', options, answer(404))).outcome).toBe('gone');
    expect(await sendPush(target, 'x', options, answer(403))).toEqual({ outcome: 'failed', status: 403, detail: 'nope' });
  });
});
