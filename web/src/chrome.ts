import { h, replaceContent } from './dom.ts';
import { describeMode, type Tone } from './format.ts';
import type { Session } from './types.ts';
import { badge, notice } from './views/common.ts';

export interface Frame {
  readonly main: HTMLElement;
  readonly nav: HTMLElement;
  readonly identity: HTMLElement;
  readonly modeRegion: HTMLElement;
  /** Tells screen-reader users something without moving focus. */
  readonly announce: (message: string) => void;
}

const MODE_TONES: Readonly<Record<'demo' | 'live' | 'blocked', Tone>> = { demo: 'neutral', live: 'active', blocked: 'alert' };

export const setTitle = (title: string): void => {
  document.title = `${title} – Resolve (simulated credits)`;
};

/**
 * The page every screen shares: a skip link, the banner, the simulated-credits notice, one main landmark and a
 * polite live region. Screens fill in the navigation, identity and mode regions they need.
 */
export function renderFrame(root: HTMLElement): Frame {
  const main = h('main', { id: 'main', tabindex: -1 });
  const nav = h('nav', { 'aria-label': 'Primary', class: 'site-nav' });
  const identity = h('div', { class: 'identity' });
  const modeRegion = h('div', { class: 'mode-region' });
  const status = h('div', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  let timer: number | undefined;
  const announce = (message: string): void => {
    window.clearTimeout(timer);
    // Clearing first lets a repeated message be announced again.
    status.textContent = '';
    timer = window.setTimeout(() => {
      status.textContent = message;
    }, 50);
  };
  replaceContent(
    root,
    h(
      'a',
      {
        class: 'skip-link',
        href: '#main',
        onclick: (event) => {
          // The link must not change the hash: the hash is the router's state.
          event.preventDefault();
          main.focus();
        },
      },
      'Skip to main content',
    ),
    h(
      'header',
      { class: 'site-header' },
      h('p', { class: 'brand' }, h('strong', null, 'Resolve'), ' ', h('span', { class: 'brand-sub' }, 'billing dispute console')),
      nav,
      identity,
    ),
    h('p', { class: 'simulated' }, h('strong', null, 'Simulated credits.'), ' No real money moves, and every account, invoice and policy is fictional.'),
    modeRegion,
    main,
    h(
      'footer',
      { class: 'site-footer' },
      h('p', null, 'A public sample: credits are simulated and all data is fictional. ', h('a', { href: '/reference/' }, 'API reference')),
    ),
    status,
  );
  return { main, nav, identity, modeRegion, announce };
}

/** Demo and live are always labelled, and a blocked live mode is a warning: the demo agent is never substituted. */
export function modeNotice(environment: Session['environment']): HTMLElement {
  const mode = describeMode(environment);
  if (mode.tone === 'blocked') {
    return notice('warning', h('p', { class: 'banner-title' }, mode.label), h('p', null, mode.detail));
  }
  return h('p', { class: `mode mode-${mode.tone}` }, badge(mode.label, MODE_TONES[mode.tone]), ' ', mode.detail);
}
