import type { Api } from '../api.ts';
import type { Role, Session } from '../types.ts';

/** What a view may use. Views never reach for globals such as the current location or the sign-in. */
export interface ViewContext {
  readonly api: Api;
  readonly session: Session;
  /** Aborted when the person navigates away. Every request a view makes carries it. */
  readonly signal: AbortSignal;
  readonly navigate: (hash: string) => void;
  /** Tells screen-reader users something without moving focus. */
  readonly announce: (message: string) => void;
  readonly signOut: () => void;
}

export const hasRole = (session: Session, role: Role): boolean => session.principal.roles.includes(role);
