export type Route =
  | { readonly name: 'cases' }
  | { readonly name: 'new-case' }
  | { readonly name: 'case'; readonly caseId: string }
  | { readonly name: 'operator' }
  | { readonly name: 'not-found'; readonly hash: string };

export const CASE_ID_PATTERN = /^case_[0-9a-f]{32}$/;

/** Parses `location.hash`. Anything that is not a known route, including a malformed case id, is `not-found`. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  if (path === '' || path === 'cases') return { name: 'cases' };
  if (path === 'cases/new') return { name: 'new-case' };
  if (path === 'operator') return { name: 'operator' };
  const match = /^cases\/([^/]+)$/.exec(path);
  const caseId = match?.[1];
  if (caseId !== undefined && CASE_ID_PATTERN.test(caseId)) return { name: 'case', caseId };
  return { name: 'not-found', hash };
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case 'cases':
      return '#/cases';
    case 'new-case':
      return '#/cases/new';
    case 'case':
      return `#/cases/${route.caseId}`;
    case 'operator':
      return '#/operator';
    case 'not-found':
      return route.hash;
  }
}

export const caseHash = (caseId: string): string => routeHash({ name: 'case', caseId });

export function routeTitle(route: Route): string {
  switch (route.name) {
    case 'cases':
      return 'Cases';
    case 'new-case':
      return 'New dispute';
    case 'case':
      return 'Case';
    case 'operator':
      return 'Operator recovery';
    case 'not-found':
      return 'Page not found';
  }
}
