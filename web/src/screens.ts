import { TestIdpAuthenticator, type EntraAuthenticator } from './auth.ts';
import { renderFrame, setTitle } from './chrome.ts';
import { button, h, replaceContent } from './dom.ts';
import { PERSONAS, type Persona } from './personas.ts';
import { errorBanner, notice, whileBusy } from './views/common.ts';

export interface SignInOptions {
  readonly authenticator: TestIdpAuthenticator | EntraAuthenticator;
  /** Called after a sign-in that did not leave the page. */
  readonly onSignedIn: () => void;
}

function personaList(authenticator: TestIdpAuthenticator, onSignedIn: () => void, errorRegion: HTMLElement): HTMLElement {
  let signingIn = false;
  const cards = PERSONAS.map((persona: Persona) => {
    const trigger: HTMLButtonElement = h(
      'button',
      {
        type: 'button',
        class: 'primary',
        onclick: () => {
          if (signingIn) return;
          signingIn = true;
          replaceContent(errorRegion);
          void whileBusy(trigger, 'Signing in…', async () => {
            try {
              await authenticator.signInAs(persona);
            } catch (error) {
              replaceContent(errorRegion, errorBanner(error));
              return;
            } finally {
              signingIn = false;
            }
            onSignedIn();
          });
        },
      },
      `Sign in as ${persona.label}`,
    );
    return h(
      'li',
      { class: 'card persona' },
      h('h2', { class: 'card-title' }, persona.label),
      h('p', { class: 'meta' }, `Tenant ${persona.tenantId} · ${persona.roles.join(' and ')}`),
      h('p', null, persona.purpose),
      h('div', { class: 'actions' }, trigger),
    );
  });
  return h('ul', { class: 'cards personas' }, cards);
}

/** The screen shown when nobody is signed in. */
export function showSignIn(root: HTMLElement, options: SignInOptions): void {
  const frame = renderFrame(root);
  setTitle('Sign in');
  const errorRegion = h('div', { class: 'submit-error' });
  const authenticator = options.authenticator;
  if (authenticator instanceof TestIdpAuthenticator) {
    replaceContent(
      frame.main,
      h('h1', null, 'Sign in'),
      notice(
        'info',
        h('p', { class: 'banner-title' }, 'Local test sign-in'),
        h('p', null, 'This stack uses a local test identity provider. It issues a short-lived token for a fictional person, and the API validates that token like any other. It is never offered on Azure.'),
      ),
      h('p', { class: 'lede' }, 'Choose who you are. Each person has fixed roles in one tenant.'),
      errorRegion,
      personaList(authenticator, options.onSignedIn, errorRegion),
    );
    return;
  }
  const trigger: HTMLButtonElement = h(
    'button',
    {
      type: 'button',
      class: 'primary',
      onclick: () => {
        replaceContent(errorRegion);
        void whileBusy(trigger, 'Redirecting…', async () => {
          try {
            await authenticator.signIn();
          } catch (error) {
            replaceContent(errorRegion, errorBanner(error));
          }
        });
      },
    },
    'Sign in with Microsoft',
  );
  replaceContent(
    frame.main,
    h('h1', null, 'Sign in'),
    h('p', { class: 'lede' }, 'Sign in with your Microsoft Entra ID account. Your roles and tenant come from the app roles assigned to you.'),
    errorRegion,
    h('div', { class: 'actions' }, trigger),
  );
}

/** A screen with nothing to offer except what went wrong, and optionally another try. */
export function showFailure(root: HTMLElement, title: string, message: string, retry?: () => void): void {
  const frame = renderFrame(root);
  setTitle(title);
  replaceContent(
    frame.main,
    h('h1', null, title),
    h(
      'div',
      { class: 'banner banner-error', role: 'alert' },
      h('p', null, message),
      retry === undefined ? null : h('div', { class: 'actions' }, button('Try again', retry, { class: 'secondary' })),
    ),
  );
}

/** Signed in, but the session could not be read. The person can always try again or sign out. */
export function showSessionFailure(root: HTMLElement, error: unknown, retry: () => void, signOut: () => void): void {
  const frame = renderFrame(root);
  setTitle('Cannot open the console');
  replaceContent(
    frame.main,
    h('h1', null, 'Cannot open the console'),
    errorBanner(error, { retry }),
    h('div', { class: 'actions' }, button('Sign out', signOut, { class: 'secondary' })),
  );
}
