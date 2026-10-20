// The users database: users, their attributes, sessions (db/init.sql).
import pg from 'pg';
import type { Attributes } from './scopes.ts';

export type Db = pg.Pool;

export function connect(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 5 });
}

export const normalizeEmail = (email: string) => String(email).trim().toLowerCase();

export async function findUser(db: Db, email: string) {
  const { rows } = await db.query('select email, display_name, password_hash from users where email = $1', [normalizeEmail(email)]);
  return rows[0] as { email: string; display_name: string | null; password_hash: string } | undefined;
}

export async function attributesOf(db: Db, email: string): Promise<Attributes> {
  const { rows } = await db.query('select attribute, value from user_attributes where email = $1 order by attribute, value', [email]);
  const attrs: Attributes = new Map();
  for (const { attribute, value } of rows) {
    if (!attrs.has(attribute)) attrs.set(attribute, []);
    attrs.get(attribute)!.push(value);
  }
  return attrs;
}

export async function listUsers(db: Db) {
  const { rows } = await db.query('select email, display_name from users order by email');
  return Promise.all(rows.map(async (u) => ({ ...u, attrs: await attributesOf(db, u.email) })));
}

export async function upsertUser(db: Db, email: string, displayName: string | null, passwordHash: string) {
  await db.query(
    `insert into users (email, display_name, password_hash) values ($1, $2, $3)
     on conflict (email) do update set display_name = excluded.display_name, password_hash = excluded.password_hash`,
    [normalizeEmail(email), displayName, passwordHash],
  );
}

// Replaces the user's values for each attribute given. An attribute given with no values
// is set to an empty list, which is not the same as unset: see README "Scopes".
export async function setAttributes(db: Db, email: string, attrs: Attributes) {
  const client = await db.connect();
  try {
    await client.query('begin');
    for (const [attribute, values] of attrs) {
      await client.query('delete from user_attributes where email = $1 and attribute = $2', [normalizeEmail(email), attribute]);
      for (const value of new Set(values)) {
        await client.query('insert into user_attributes (email, attribute, value) values ($1, $2, $3)', [normalizeEmail(email), attribute, value]);
      }
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function removeUser(db: Db, email: string) {
  const { rowCount } = await db.query('delete from users where email = $1', [normalizeEmail(email)]);
  return rowCount ?? 0;
}
