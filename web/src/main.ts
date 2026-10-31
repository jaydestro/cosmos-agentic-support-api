import { Api } from './api.ts';
import { EntraAuthenticator, TestIdpAuthenticator } from './auth.ts';
import { renderFrame } from './chrome.ts';
import { parseConsoleSettings, type ConsoleSettings, type ParsedSettings } from './config.ts';
import { replaceContent } from './dom.ts';
import { showFailure, showSessionFailure, showSignIn } from './screens.ts';
import { mountShell } from './shell.ts';
import type { Session } from './types.ts';
import { loadingNote } from './views/common.ts';

const SETTINGS_TIMEOUT_MS = 10_000;

type Authenticator = TestIdpAuthenticator | EntraAuthenticator;

/** The page's own public settings. They hold no secret, so nothing is sent with the request. */
async function fetchSettings(): Promise<ParsedSettings> {
  let response: Response;
  try {
    response = await fetch('/config.json', {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(SETTINGS_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, message: 'The console settings could not be loaded. Check the connection and try again.' };
  }
  if (!response.ok) {
    return { ok: false, message: `The console settings could not be loaded (HTTP ${String(response.status)}).` };
  }
  const body: unknown = await response.json().catch(() => null);
  return parseConsoleSettings(body);
}

function createAuthenticator(settings: ConsoleSettings): Authenticator | string {
  const auth = settings.auth;
  if (auth.mode === 'test-idp') {
    return auth.mintUrl === null
      ? 'This stack has no test identity provider configured, so nobody can sign in.'
      : new TestIdpAuthenticator(auth.mintUrl);
  }
  return auth.clientId === null
    ? 'This deployment has no Microsoft Entra app registration configured for the console, so nobody can sign in.'
    : new EntraAuthenticator({ clientId: auth.clientId, authority: auth.authority, scopes: auth.scopes });
}

/** Removes a sign-in response that was left in the address bar, so the router never reads it as a page. */
function dropAuthFragment(): void {
  if (/^#(code|error|state|id_token|access_token)=/.test(window.location.hash)) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }
}

async function boot(root: HTMLElement): Promise<void> {
  const loading = renderFrame(root);
  replaceContent(loading.main, loadingNote('Loading the console…'));

  const parsed = await fetchSettings();
  if (!parsed.ok) {
    showFailure(root, 'The console cannot start', parsed.message, () => {
      void boot(root);
    });
    return;
  }
  const auth = createAuthenticator(parsed.settings);
  if (typeof auth === 'string') {
    showFailure(root, 'Sign-in is not configured', auth);
    return;
  }

  const authenticator: Authenticator = auth;

  let signedIn: boolean;
  try {
    // A pending sign-in redirect is completed here, before the router reads the address.
    signedIn = await auth.start();
  } catch (error) {
    console.error('Sign-in could not start:', error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error');
    showFailure(root, 'Sign-in could not start', 'The sign-in library failed to start. Reload the page to try again; if it keeps failing, the sign-in settings of this deployment may be wrong.', () => {
      void boot(root);
    });
    return;
  } finally {
    dropAuthFragment();
  }

  const api = new Api({ baseUrl: `${window.location.origin}/api`, getAccessToken: () => auth.getAccessToken() });
  let stopShell: (() => void) | null = null;

  const signInScreen = (): void => {
    showSignIn(root, {
      authenticator: auth,
      onSignedIn: () => {
        void open(true);
      },
    });
  };

  async function open(focusFirstRender: boolean): Promise<void> {
    const opening = renderFrame(root);
    replaceContent(opening.main, loadingNote('Opening the console…'));
    let session: Session;
    try {
      session = await api.getSession();
    } catch (error) {
      showSessionFailure(
        root,
        error,
        () => {
          void open(true);
        },
        () => {
          void leave();
        },
      );
      return;
    }
    stopShell = mountShell(root, {
      api,
      session,
      accountLabel: authenticator.accountLabel(),
      testSignIn: authenticator.mode === 'test-idp',
      signOut: () => {
        void leave();
      },
      focusFirstRender,
    });
  }

  async function leave(): Promise<void> {
    stopShell?.();
    stopShell = null;
    try {
      await authenticator.signOut();
    } catch {
      // Fall through to the sign-in screen: the local session is gone either way.
    }
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    signInScreen();
  }

  if (signedIn) {
    await open(false);
  } else {
    signInScreen();
  }
}

const root = document.getElementById('app');
if (root !== null) {
  boot(root).catch((error: unknown) => {
    console.error('The console failed to start:', error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error');
    showFailure(root, 'The console cannot start', 'An unexpected error stopped the console from starting. Reload the page to try again.');
  });
}
