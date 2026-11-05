import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { db } from './db.js';
import { HttpError } from './util.js';

const SESSION_MS = 12 * 60 * 60 * 1000; // 12 jam

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

const DUMMY = hashPassword('dummy-password-for-timing');

export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export function checkPasswordPolicy(pw) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 128) {
    throw new HttpError(400, 'Kata sandi harus 8–128 karakter');
  }
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

export function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
    .run(sha(token), userId, Date.now() + SESSION_MS);
  return token;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

export function destroyUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function userFromToken(token) {
  if (!token) return null;
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return db.prepare(`SELECT u.id, u.username, u.name, u.role, u.is_sample
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).get(sha(token), Date.now()) || null;
}

// Pembatasan percobaan login (in-memory): 5 gagal / 15 menit per IP+username
const fails = new Map();
const WINDOW = 15 * 60 * 1000;
export function loginGuard(key) {
  const rec = fails.get(key);
  if (rec && rec.until > Date.now() && rec.n >= 5) {
    throw new HttpError(429, 'Terlalu banyak percobaan login. Coba lagi beberapa menit lagi.');
  }
}
export function loginFailed(key) {
  const rec = fails.get(key);
  if (!rec || rec.until < Date.now()) fails.set(key, { n: 1, until: Date.now() + WINDOW });
  else rec.n += 1;
}
export function loginOk(key) { fails.delete(key); }

export function login(username, password) {
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || ''));
  const ok = verifyPassword(String(password || ''), u ? u.password_hash : DUMMY);
  return u && ok ? u : null;
}
