import type { Api } from './api.ts';
import { modeNotice, renderFrame, setTitle } from './chrome.ts';
import { button, h, replaceContent } from './dom.ts';
import { parseRoute, routeHash, routeTitle, type Route } from './routes.ts';
import type { Session } from './types.ts';
import { mountCaseDetail } from './views/case-detail.ts';
import { mountCases } from './views/cases.ts';
import { errorBanner } from './views/common.ts';
import { hasRole, type ViewContext } from './views/context.ts';
import { mountNewCase } from './views/new-case.ts';
import { mountOperator } from './views/operator.ts';

export interface ShellOptions {
  readonly api: Api;
  readonly session: Session;
  readonly accountLabel: string | null;
  /** True for the local/CI test identity provider, which the page says plainly. */
  readonly testSignIn: boolean;
  readonly signOut: () => void;
  /**
   * Whether the first render moves focus to the page heading. It should after a click that removed the focused
   * control, such as signing in, and should not on a plain page load, where the first Tab belongs to the skip link.
   */
  readonly focusFirstRender: boolean;
}

type NavKey = 'cases' | 'new-case' | 'operator';

function navKeyOf(route: Route): NavKey | null {
  switch (route.name) {
    case 'cases':
    case 'case':
      return 'cases';
    case 'new-case':
      return 'new-case';
    case 'operator':
      return 'operator';
    case 'not-found':
      return null;
  }
}

function mountRoute(main: HTMLElement, ctx: ViewContext, route: Route): void {
  switch (route.name) {
    case 'cases':
      mountCases(main, ctx);
      return;
    case 'new-case':
      mountNewCase(main, ctx);
      return;
    case 'case':
      mountCaseDetail(main, ctx, route.caseId);
      return;
    case 'operator':
      mountOperator(main, ctx);
      return;
    case 'not-found':
      replaceContent(
        main,
        h('h1', null, 'Page not found'),
        h('p', null, 'There is nothing at ', h('code', null, route.hash === '' ? '#' : route.hash), '.'),
        h('p', null, h('a', { href: routeHash({ name: 'cases' }) }, 'Go to the cases')),
      );
      return;
  }
}

/**
 * The signed-in console: navigation, who you are, and a hash router. Every navigation aborts the view that was
 * showing, so a slow response from a page you left never lands on the page you are on. Returns a function that
 * stops the router.
 */
export function mountShell(root: HTMLElement, options: ShellOptions): () => void {
  const { api, session } = options;
  const frame = renderFrame(root);
  replaceContent(frame.modeRegion, modeNotice(session.environment));

  const items: readonly { readonly key: NavKey; readonly label: string; readonly route: Route; readonly visible: boolean }[] = [
    { key: 'cases', label: 'Cases', route: { name: 'cases' }, visible: true },
    { key: 'new-case', label: 'New dispute', route: { name: 'new-case' }, visible: hasRole(session, 'Representative') },
    { key: 'operator', label: 'Operator recovery', route: { name: 'operator' }, visible: hasRole(session, 'Operator') },
  ];
  const links = new Map<NavKey, HTMLAnchorElement>();
  replaceContent(
    frame.nav,
    h(
      'ul',
      null,
      items
        .filter((item) => item.visible)
        .map((item) => {
          const link = h('a', { href: routeHash(item.route) }, item.label);
          links.set(item.key, link);
          return h('li', null, link);
        }),
    ),
  );

  const who = options.accountLabel ?? `User ${session.principal.principalId.slice(0, 8)}`;
  replaceContent(
    frame.identity,
    h(
      'p',
      { class: 'who' },
      h('strong', null, who),
      ' ',
      h('span', { class: 'meta' }, `Tenant ${session.principal.tenantId} · ${session.principal.roles.join(', ')}`),
    ),
    options.testSignIn ? h('p', { class: 'meta' }, 'Local test sign-in') : null,
    button('Sign out', options.signOut, { class: 'secondary small' }),
  );

  let controller: AbortController | null = null;

  const navigate = (hash: string): void => {
    window.location.hash = hash;
  };

  function render(moveFocus: boolean): void {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    const route = parseRoute(window.location.hash);
    const ctx: ViewContext = { api, session, signal: mine.signal, navigate, announce: frame.announce, signOut: options.signOut };
    replaceContent(frame.main);
    try {
      mountRoute(frame.main, ctx, route);
    } catch (error) {
      mine.abort();
      replaceContent(frame.main, h('h1', null, 'Something went wrong'), errorBanner(error, { signOut: options.signOut }));
    }
    setTitle(routeTitle(route));
    for (const link of links.values()) link.removeAttribute('aria-current');
    const key = navKeyOf(route);
    if (key !== null) links.get(key)?.setAttribute('aria-current', route.name === 'case' ? 'true' : 'page');
    window.scrollTo(0, 0);
    if (!moveFocus) return;
    // Moving focus to the heading tells keyboard and screen-reader users the page changed.
    const heading = frame.main.querySelector('h1');
    if (heading === null) {
      frame.main.focus({ preventScroll: true });
    } else {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }

  const onHashChange = (): void => {
    render(true);
  };
  window.addEventListener('hashchange', onHashChange);
  render(options.focusFirstRender);

  return () => {
    window.removeEventListener('hashchange', onHashChange);
    controller?.abort();
    controller = null;
  };
}
