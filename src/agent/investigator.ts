import type { CaseFacts } from './adjudicate.ts';
import type { Retrieved } from './guard.ts';
import type { ModelCompletion, ModelMessage } from './model.ts';
import type { ToolCall } from './tools.ts';

/**
 * What an investigation is: something that, given the facts of a case and a way to call the allowed
 * tools, ends by getting one proposal accepted. The demo plan and a live model are both investigators.
 * An investigator cannot approve or execute anything and cannot reach any data except through
 * `session.call`.
 */

/** How a run that could not finish is recorded. */
export type StopKind = 'budget_exhausted' | 'failed';

/**
 * Thrown by a session when the run cannot make another call: its budget is spent, or a call kept
 * failing. An investigator lets it pass; the runner records the stop.
 */
export class RunStopped extends Error {
  readonly kind: StopKind;
  /** A short code (for instance `steps_exhausted` or `tool_error`) that becomes the run's stop reason. */
  readonly reason: string;
  constructor(kind: StopKind, reason: string) {
    super(`The run stopped: ${reason}.`);
    this.name = 'RunStopped';
    this.kind = kind;
    this.reason = reason;
  }
}

export interface InvestigationSession {
  /** The case as code understands it. The description a representative wrote is deliberately not here. */
  readonly facts: CaseFacts;
  /**
   * Runs one allowed tool. The allowance for the call is reserved first and settled after it, so the
   * call is accounted for however it ends. Throws `RunStopped` when no further call is allowed. Once a
   * proposal has been accepted, a further call is refused with `already_submitted` and changes nothing.
   */
  call(name: string, args?: unknown): Promise<ToolCall>;
  /**
   * Asks the live model for its next message. The allowance is reserved before the request, for the run
   * and for the tenant's daily live spend, and settled after it, so the call is accounted for however it
   * ends. A transient failure is retried within the run's retry allowance. Throws `RunStopped` when no
   * further call is allowed or the call failed for good, and always when the run is not a live run.
   */
  model(messages: readonly ModelMessage[]): Promise<ModelCompletion>;
  /** What the run has retrieved so far, as a copy. */
  retrieved(): Retrieved;
}

export interface Investigator {
  readonly mode: 'demo' | 'live';
  investigate(session: InvestigationSession): Promise<void>;
}

/**
 * The investigators a deployment has. `live` is null until a live model adapter is configured; a run
 * that asks for live mode is then blocked rather than answered by the demo plan.
 */
export interface Investigators {
  readonly demo: Investigator;
  readonly live: Investigator | null;
}
