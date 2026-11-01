import {
  CacheLookupPolicy,
  InteractionRequiredAuthError,
  createStandardPublicClientApplication,
  type AccountInfo,
  type IPublicClientApplication,
} from '@azure/msal-browser';
import { AuthError } from './errors.ts';
import { findPersona, roleClaims, type Persona } from './personas.ts';

/** What the rest of the console needs from a sign-in, whichever provider is behind it. */
export interface Authenticator {
  readonly mode: 'entra' | 'test-idp';
  /** Completes a pending redirect or restores a saved sign-in. Resolves true when someone is signed in. */
  start(): Promise<boolean>;
  getAccessToken(): Promise<string>;
  accountLabel(): string | null;
  signOut(): Promise<void>;
}

const PERSONA_KEY = 'resolve.persona';
const TOKEN_LIFETIME_SECONDS = 900;
const REFRESH_MARGIN_MS = 60_000;
const MINT_TIMEOUT_MS = 10_000;

/** Storage can be disabled by the browser; the persona is then simply not remembered. */
function readStoredPersona(): string | null {
  try {
    return window.sessionStorage.getItem(PERSONA_KEY);
  } catch {
    return null;
  }
}

function storePersona(id: string | null): void {
  try {
    if (id === null) window.sessionStorage.removeItem(PERSONA_KEY);
    else window.sessionStorage.setItem(PERSONA_KEY, id);
  } catch {
    // Not remembering the persona is harmless.
  }
}

function tokenFrom(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const token = (body as Record<string, unknown>)['token'];
  return typeof token === 'string' && token !== '' ? token : null;
}

interface CachedToken {
  readonly personaId: string;
  readonly value: string;
  readonly refreshAt: number;
}

/**
 * Local and CI only. The local test identity provider mints a short-lived token for a fictional persona, and
 * the host validates that token like any other. The server never offers this mode on Azure.
 */
export class TestIdpAuthenticator implements Authenticator {
  readonly mode = 'test-idp' as const;
  readonly #mintUrl: string;
  #persona: Persona | null = null;
  #cached: CachedToken | null = null;
  #inflight: { readonly personaId: string; readonly promise: Promise<string> } | null = null;

  constructor(mintUrl: string) {
    this.#mintUrl = mintUrl;
  }

  start(): Promise<boolean> {
    this.#persona = findPersona(readStoredPersona()) ?? null;
    return Promise.resolve(this.#persona !== null);
  }

  persona(): Persona | null {
    return this.#persona;
  }

  accountLabel(): string | null {
    return this.#persona?.label ?? null;
  }

  async signInAs(persona: Persona): Promise<void> {
    this.#persona = persona;
    this.#cached = null;
    this.#inflight = null;
    try {
      await this.getAccessToken();
    } catch (error) {
      this.#persona = null;
      throw error;
    }
    storePersona(persona.id);
  }

  getAccessToken(): Promise<string> {
    const persona = this.#persona;
    if (persona === null) return Promise.reject(new AuthError('signed_out', 'Choose a person to sign in as.'));
    const cached = this.#cached;
    if (cached !== null && cached.personaId === persona.id && cached.refreshAt > Date.now()) return Promise.resolve(cached.value);
    // Several requests start together; they share one mint.
    if (this.#inflight?.personaId === persona.id) return this.#inflight.promise;
    const promise = this.#mint(persona).finally(() => {
      if (this.#inflight?.promise === promise) this.#inflight = null;
    });
    this.#inflight = { personaId: persona.id, promise };
    return promise;
  }

  signOut(): Promise<void> {
    this.#persona = null;
    this.#cached = null;
    this.#inflight = null;
    storePersona(null);
    return Promise.resolve();
  }

  async #mint(persona: Persona): Promise<string> {
    let response: Response;
    try {
      response = await fetch(this.#mintUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oid: persona.oid, roles: roleClaims(persona), expiresInSeconds: TOKEN_LIFETIME_SECONDS }),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      });
    } catch {
      throw new AuthError('unavailable', 'The test identity provider could not be reached. Is the local stack running?');
    }
    if (!response.ok) {
      throw new AuthError('unavailable', `The test identity provider refused the request (HTTP ${String(response.status)}).`);
    }
    const body: unknown = await response.json().catch(() => null);
    const token = tokenFrom(body);
    if (token === null) throw new AuthError('unavailable', 'The test identity provider answered without a token.');
    if (this.#persona === persona) {
      this.#cached = { personaId: persona.id, value: token, refreshAt: Date.now() + TOKEN_LIFETIME_SECONDS * 1000 - REFRESH_MARGIN_MS };
    }
    return token;
  }
}

export interface EntraSettings {
  readonly clientId: string;
  readonly authority: string | null;
  readonly scopes: readonly string[];
}

/**
 * Microsoft Entra ID through the MSAL redirect flow. The page policy has no frame source, so the hidden-frame
 * silent fallback cannot run: refresh tokens are redeemed directly, and a person who must interact is redirected.
 * This path is type-checked and built here, but it needs a real app registration and has not been exercised.
 */
export class EntraAuthenticator implements Authenticator {
  readonly mode = 'entra' as const;
  readonly #settings: EntraSettings;
  #app: IPublicClientApplication | null = null;
  #account: AccountInfo | null = null;

  constructor(settings: EntraSettings) {
    this.#settings = settings;
  }

  async start(): Promise<boolean> {
    const home = `${window.location.origin}/`;
    const { clientId, authority } = this.#settings;
    const app = await createStandardPublicClientApplication({
      auth: { clientId, ...(authority === null ? {} : { authority }), redirectUri: home, postLogoutRedirectUri: home },
      cache: { cacheLocation: 'sessionStorage' },
    });
    this.#app = app;
    // A sign-in redirect lands here with its response in the URL; it must be handled before the router reads the hash.
    const result = await app.handleRedirectPromise();
    const account = result?.account ?? app.getActiveAccount() ?? app.getAllAccounts()[0] ?? null;
    if (account !== null) app.setActiveAccount(account);
    this.#account = account;
    return account !== null;
  }

  async signIn(): Promise<void> {
    const app = this.#app;
    if (app === null) throw new AuthError('unavailable', 'Sign-in has not started.');
    await app.loginRedirect({ scopes: [...this.#settings.scopes] });
  }

  async getAccessToken(): Promise<string> {
    const app = this.#app;
    const account = this.#account;
    if (app === null || account === null) throw new AuthError('signed_out', 'Sign in to continue.');
    const scopes = [...this.#settings.scopes];
    try {
      const result = await app.acquireTokenSilent({ scopes, account, cacheLookupPolicy: CacheLookupPolicy.AccessTokenAndRefreshToken });
      return result.accessToken;
    } catch (error) {
      if (!(error instanceof InteractionRequiredAuthError)) {
        throw new AuthError('unavailable', 'A sign-in token could not be obtained. Sign out and sign in again.');
      }
    }
    await app.acquireTokenRedirect({ scopes, account });
    // The page is navigating to the identity provider; this call never completes.
    return new Promise<string>(() => undefined);
  }

  accountLabel(): string | null {
    const name = this.#account?.name;
    return name !== undefined && name !== '' ? name : (this.#account?.username ?? null);
  }

  async signOut(): Promise<void> {
    const app = this.#app;
    if (app === null) return;
    await app.logoutRedirect({ ...(this.#account === null ? {} : { account: this.#account }), postLogoutRedirectUri: `${window.location.origin}/` });
  }
}
