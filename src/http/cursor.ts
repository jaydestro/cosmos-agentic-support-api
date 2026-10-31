import { badRequest } from './problem.ts';

interface CursorPayload {
  v: 1;
  k: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
export const MAX_CURSOR_CHARS = 512;

/** Opaque keyset cursor. It carries no authority: every request re-applies tenant and scope filters. */
export function encodeCursor(key: string): string {
  const payload: CursorPayload = { v: 1, k: key };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(token: unknown, keyPattern: RegExp): string | null {
  if (token === undefined || token === null) return null;
  const invalid = () => badRequest('invalid_continuation_token', 'The continuation token is not valid');
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_CURSOR_CHARS || !BASE64URL.test(token)) {
    throw invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalid();
  const { v, k } = parsed as Partial<CursorPayload>;
  if (v !== 1 || typeof k !== 'string' || !keyPattern.test(k)) throw invalid();
  return k;
}
