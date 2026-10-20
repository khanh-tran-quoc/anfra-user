// Email and password sign-in, with sessions kept in the users database.
// Demo-grade: no rate limiting, lockout or password reset (see README).
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { attributesOf, findUser, normalizeEmail, type Db } from './db.ts';
import type { Attributes } from './scopes.ts';

export const SESSION_COOKIE = 'au_session';

// Compared against when the email is unknown, so a wrong email and a wrong password take as long.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export type User = { email: string; displayName: string | null; attrs: Attributes };

export class AuthError extends Error {
  name = 'AuthError';
}

export const hashPassword = (password: string) => bcrypt.hash(password, 10);

export async function login(db: Db, email: string, password: string, ttlSeconds: number): Promise<string> {
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    throw new AuthError('Enter your email and password');
  }
  const user = await findUser(db, email);
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw new AuthError('Wrong email or password');
  const id = randomBytes(32).toString('hex');
  await db.query(`insert into sessions (id, email, expires_at) values ($1, $2, now() + make_interval(secs => $3))`, [id, user.email, ttlSeconds]);
  await db.query('delete from sessions where expires_at < now()');
  return id;
}

export async function logout(db: Db, sessionId: string | undefined) {
  if (sessionId) await db.query('delete from sessions where id = $1', [sessionId]);
}

// Attributes are read on every request, so a change takes effect at once, not at next sign-in.
export async function userForSession(db: Db, sessionId: string | undefined): Promise<User | null> {
  if (!sessionId || !/^[0-9a-f]{64}$/.test(sessionId)) return null;
  const { rows } = await db.query(
    `select u.email, u.display_name from sessions s join users u on u.email = s.email
     where s.id = $1 and s.expires_at > now()`,
    [sessionId],
  );
  if (!rows[0]) return null;
  return { email: rows[0].email, displayName: rows[0].display_name, attrs: await attributesOf(db, rows[0].email) };
}

export function userFromAttributes(email: string, attrs: Attributes): User {
  return { email: normalizeEmail(email), displayName: null, attrs };
}
