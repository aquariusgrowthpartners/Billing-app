import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(bytes = 20) {
  const buf = crypto.randomBytes(bytes);
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

export function base32Decode(secret) {
  const clean = String(secret).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = '';
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpCode(secret, time = Date.now()) {
  const counter = Math.floor(time / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const value =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(value % 1_000_000).padStart(6, '0');
}

export function verifyTotp(secret, token, window = 1) {
  if (!secret || !/^\d{6}$/.test(String(token ?? '').trim())) return false;
  const now = Date.now();
  for (let i = -window; i <= window; i += 1) {
    if (totpCode(secret, now + i * 30_000) === String(token).trim()) return true;
  }
  return false;
}

export function otpauthUrl(secret, email) {
  const label = encodeURIComponent(`Dundas Billing:${email || 'user'}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Dundas Billing')}&algorithm=SHA1&digits=6&period=30`;
}
