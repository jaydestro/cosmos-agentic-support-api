/** Public Microsoft Entra authority host; the console never signs in anywhere else. */
export const ENTRA_AUTHORITY_PREFIX = 'https://login.microsoftonline.com/';

/** What `GET /config.json` returns. Every value is public: there are no secrets, keys or tokens. */
export type ConsoleAuthSettings =
  | {
      readonly mode: 'entra';
      readonly clientId: string | null;
      readonly authority: string | null;
      readonly scopes: readonly string[];
    }
  | {
      readonly mode: 'test-idp';
      readonly mintUrl: string | null;
    };

export interface ConsoleSettings {
  readonly auth: ConsoleAuthSettings;
}

export type ParsedSettings =
  | { readonly ok: true; readonly settings: ConsoleSettings }
  | { readonly ok: false; readonly message: string };

const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];

const fail = (message: string): ParsedSettings => ({ ok: false, message });

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const stringOrNull = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === 'string' && value !== '' ? value : undefined;

/** Accepts only what the server sends. The page cannot sign in against anything else, so unexpected values are refused, not repaired. */
export function parseConsoleSettings(value: unknown): ParsedSettings {
  const root = asRecord(value);
  const auth = root === null ? null : asRecord(root['auth']);
  if (auth === null) return fail('The console settings are not in the expected shape.');

  if (auth['mode'] === 'test-idp') {
    const mintUrl = stringOrNull(auth['mintUrl']);
    if (mintUrl === undefined) return fail('The test identity provider address is invalid.');
    if (mintUrl !== null && !isLoopbackHttpUrl(mintUrl)) {
      return fail('The test identity provider must be a loopback address.');
    }
    return { ok: true, settings: { auth: { mode: 'test-idp', mintUrl } } };
  }

  if (auth['mode'] === 'entra') {
    const clientId = stringOrNull(auth['clientId']);
    const authority = stringOrNull(auth['authority']);
    if (clientId === undefined || authority === undefined) return fail('The sign-in settings are invalid.');
    if (authority !== null && !authority.startsWith(ENTRA_AUTHORITY_PREFIX)) {
      return fail('The sign-in authority must be Microsoft Entra ID.');
    }
    const scopes = auth['scopes'];
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string' && scope !== '')) {
      return fail('The sign-in scopes are invalid.');
    }
    return { ok: true, settings: { auth: { mode: 'entra', clientId, authority, scopes: scopes as string[] } } };
  }

  return fail('The console settings name an unknown sign-in mode.');
}

function isLoopbackHttpUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.includes(url.hostname) && url.username === '' && url.password === '';
}
