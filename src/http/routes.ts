const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PARAMETER = /^\{[A-Za-z][A-Za-z0-9]*\}$/;

/**
 * Compiles route templates such as `api/cases/{caseId}` into a lookup from a concrete path to the
 * HTTP methods that exist for it, so unknown API paths and wrong methods get distinct answers.
 */
export function compileRouteMatcher(
  operations: readonly { readonly route: string; readonly method: string }[],
): (path: string) => string[] {
  const compiled = operations.map((operation) => ({
    method: operation.method,
    regex: new RegExp(
      `^${operation.route
        .split('/')
        .map((segment) => (PARAMETER.test(segment) ? '[^/]+' : escapeRegExp(segment)))
        .join('/')}$`,
    ),
  }));
  return (path) => [...new Set(compiled.filter((entry) => entry.regex.test(path)).map((entry) => entry.method))].sort();
}
