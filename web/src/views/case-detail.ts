import {
  caseSignature,
  decisionAccess,
  evidenceTarget,
  latestProposal,
  nextPollDelay,
  pollPlan,
  revisionAccess,
  snapshotConsistent,
  type PollPlan,
} from '../case-state.ts';
import { h, pause, replaceContent, type Child } from '../dom.ts';
import { ApiError, isAbort } from '../errors.ts';
import { statusInfo } from '../format.ts';
import type { CaseDetail, Proposal, Run } from '../types.ts';
import { decisionSection, revisionSection, type CaseActions } from './case-actions.ts';
import { mountEvidence } from './case-evidence.ts';
import { attentionNotice, creditPanel, proposalPanel, runPanel, summaryPanel } from './case-parts.ts';
import { mountTimeline } from './case-timeline.ts';
import { mountUsageEvents } from './case-usage.ts';
import { backToCases, errorBanner, loadingNote, notice, shortCaseId } from './common.ts';
import { hasRole, type ViewContext } from './context.ts';

// The case, its proposals and its runs are three reads, so a write can land between them. A snapshot whose parts
// disagree is read again a few times before it is shown as it is.
const SNAPSHOT_ATTEMPTS = 3;
const SNAPSHOT_RETRY_MS = 250;

interface Snapshot {
  readonly detail: CaseDetail;
  readonly proposals: readonly Proposal[];
  readonly runs: readonly Run[];
}

const key = (...parts: readonly unknown[]): string => JSON.stringify(parts);

/** Redraws a region only when what it shows changed, and keeps every section the person opened open. */
function liveRegion(parent: HTMLElement): (regionKey: string, render: () => Child) => void {
  let last: string | null = null;
  return (regionKey, render) => {
    if (regionKey === last) return;
    last = regionKey;
    const open = [...parent.querySelectorAll('details')].map((section) => section.open);
    replaceContent(parent, render());
    parent.querySelectorAll('details').forEach((section, index) => {
      section.open = open[index] ?? false;
    });
  };
}

const region = (name: string): HTMLDivElement => h('div', { class: `region region-${name}` });

/**
 * One case: where it stands, the proposal and what the person may do about it, the credit, the run, the evidence and
 * the timeline. It follows the case while it changes and never trusts its own picture: after every action it reads the
 * case again and shows what the service says.
 */
export function mountCaseDetail(host: HTMLElement, ctx: ViewContext, caseId: string): void {
  const principalId = ctx.session.principal.principalId;
  const isOperator = hasRole(ctx.session, 'Operator');

  // Notices about what the person just did. They survive reloads, and focus moves here when an action finishes.
  const messageRegion = h('div', { class: 'messages', tabindex: -1 });
  const pollRegion = h('div', { class: 'poll-status' });
  const loadRegion = h('div', { class: 'load-status' });

  const regions = {
    summary: region('summary'),
    attention: region('attention'),
    proposal: region('proposal'),
    actions: region('actions'),
    credit: region('credit'),
    run: region('run'),
  };
  const draw = {
    summary: liveRegion(regions.summary),
    attention: liveRegion(regions.attention),
    proposal: liveRegion(regions.proposal),
    actions: liveRegion(regions.actions),
    credit: liveRegion(regions.credit),
    run: liveRegion(regions.run),
  };

  // These three keep their own state, so they sit outside the regions that are redrawn.
  const evidence = mountEvidence(ctx);
  const usage = mountUsageEvents(ctx, caseId);
  const timeline = mountTimeline(ctx, caseId);

  const layout = h(
    'div',
    { class: 'case-layout', hidden: true },
    h('div', { class: 'case-main' }, regions.summary, regions.attention, regions.proposal, regions.actions, regions.credit, evidence.element),
    h('div', { class: 'case-side' }, regions.run, usage.element, timeline.element),
  );

  replaceContent(host, h('h1', null, `Case ${shortCaseId(caseId)}`), backToCases(), messageRegion, pollRegion, loadRegion, layout);

  let snapshot: Snapshot | null = null;
  let shownSignature = '';
  let loadGeneration = 0;
  let pollGeneration = 0;
  let acting = false;

  const actions: CaseActions = {
    approve: (version, body) => act(() => ctx.api.approveProposal(caseId, version, body, ctx.signal), 'Approved. The simulated credit is being issued.'),
    reject: (version, body) =>
      act(() => ctx.api.rejectProposal(caseId, version, body, ctx.signal), 'Rejected. The reason is recorded. You can request a revision if the dispute still needs a credit.'),
    revise: (body) =>
      act(() => ctx.api.requestRevision(caseId, body, ctx.signal), 'Revision requested. A new investigation is starting, and its proposal will need a fresh approval.'),
  };

  function render(next: Snapshot): void {
    const previous = snapshot;
    snapshot = next;
    const { detail, proposals, runs } = next;
    shownSignature = caseSignature(detail);

    const newest = latestProposal(proposals);
    const earlierProposals = proposals.filter((proposal) => proposal.version !== newest?.version).sort((a, b) => b.version - a.version);
    const run = detail.latestRun;
    const earlierRuns = runs.filter((candidate) => candidate.runId !== run?.runId).sort((a, b) => b.revision - a.revision);

    draw.summary(key({ ...detail, latestRun: null }), () => summaryPanel(detail, principalId));
    draw.attention(key(detail.status, detail.latestRun?.state ?? null, detail.latestRun?.stopReason ?? null), () => attentionNotice(detail, isOperator));
    draw.proposal(key(newest, earlierProposals), () => proposalPanel(newest, earlierProposals, principalId));

    // Keyed by what decides which controls exist, so words typed into a form survive the refreshes that change nothing.
    const decide = decisionAccess(ctx.session, detail, newest);
    const revise = revisionAccess(ctx.session, detail);
    draw.actions(
      key(decide.kind, newest?.version ?? null, newest?.digest ?? null, newest?.status ?? null, detail.status, revise.kind, revise.kind === 'allowed' ? revise.remaining : null),
      () => [decisionSection(decide, newest, actions, ctx.announce), revisionSection(revise, actions, ctx.announce)],
    );

    draw.credit(key(detail.creditResult), () => (detail.creditResult === null ? null : creditPanel(detail.creditResult)));
    draw.run(key(run, earlierRuns), () => runPanel(run, earlierRuns));

    usage.update(run);
    evidence.update(evidenceTarget(detail, newest));
    void timeline.refresh();

    replaceContent(loadRegion);
    layout.hidden = false;
    if (previous !== null && previous.detail.status !== detail.status) ctx.announce(`Status: ${statusInfo(detail.status).label}.`);
  }

  async function readSnapshot(): Promise<Snapshot> {
    const [detail, proposals, runs] = await Promise.all([
      ctx.api.getCase(caseId, ctx.signal),
      ctx.api.listProposals(caseId, ctx.signal),
      ctx.api.listInvestigationRuns(caseId, ctx.signal),
    ]);
    return { detail, proposals: proposals.items, runs: runs.items };
  }

  async function readConsistentSnapshot(): Promise<Snapshot> {
    let read = await readSnapshot();
    for (let attempt = 1; attempt < SNAPSHOT_ATTEMPTS && !snapshotConsistent(read.detail, read.proposals, read.runs); attempt += 1) {
      await pause(SNAPSHOT_RETRY_MS, ctx.signal);
      read = await readSnapshot();
    }
    return read;
  }

  /** Reads the whole case and draws it. A read that a newer one overtook is dropped. */
  async function reload(): Promise<void> {
    loadGeneration += 1;
    const mine = loadGeneration;
    const next = await readConsistentSnapshot();
    if (mine !== loadGeneration || ctx.signal.aborted) return;
    render(next);
  }

  function currentPlan(): PollPlan | null {
    return snapshot === null ? null : pollPlan(snapshot.detail.status);
  }

  function showPollError(error: unknown): void {
    replaceContent(
      pollRegion,
      notice('warning', 'Automatic updates are paused because the last refresh failed. What is shown may be out of date.'),
      errorBanner(error, {
        signOut: ctx.signOut,
        retry: () => {
          void reloadAndWatch();
        },
      }),
    );
  }

  /**
   * Looks for a change on a schedule that slows down while nothing happens. A case waiting on a person is read rarely,
   * and a hidden tab is not read at all. A case that cannot change any more is not read.
   */
  async function pollLoop(mine: number, immediate: boolean): Promise<void> {
    let plan = currentPlan();
    let delay = immediate ? 0 : (plan?.firstMs ?? 0);
    while (plan !== null) {
      try {
        await pause(delay, ctx.signal);
      } catch {
        return;
      }
      if (mine !== pollGeneration) return;
      let changed = false;
      if (!document.hidden) {
        try {
          const fresh = await ctx.api.getCase(caseId, ctx.signal);
          if (mine !== pollGeneration) return;
          replaceContent(pollRegion);
          if (caseSignature(fresh) !== shownSignature) {
            changed = true;
            await reload();
            if (mine !== pollGeneration) return;
          }
        } catch (error) {
          if (isAbort(error) || ctx.signal.aborted || mine !== pollGeneration) return;
          showPollError(error);
          return;
        }
      }
      plan = currentPlan();
      if (plan !== null) delay = nextPollDelay(plan, delay, changed);
    }
  }

  function startPolling(immediate: boolean): void {
    pollGeneration += 1;
    void pollLoop(pollGeneration, immediate);
  }

  async function reloadAndWatch(): Promise<void> {
    try {
      await reload();
      replaceContent(pollRegion);
      startPolling(false);
    } catch (error) {
      if (isAbort(error) || ctx.signal.aborted) return;
      showPollError(error);
    }
  }

  /** Sends one change and then shows what the service says, whether it worked or not. */
  async function act(task: () => Promise<unknown>, success: string): Promise<void> {
    if (acting) {
      ctx.announce('Another action is still being processed. Wait for it to finish.');
      return;
    }
    acting = true;
    replaceContent(messageRegion);
    try {
      await task();
      replaceContent(messageRegion, notice('success', success));
    } catch (error) {
      if (isAbort(error) || ctx.signal.aborted) return;
      replaceContent(messageRegion, errorBanner(error, { signOut: ctx.signOut }));
    } finally {
      acting = false;
    }
    await reloadAndWatch();
    messageRegion.focus();
  }

  async function loadFirst(): Promise<void> {
    replaceContent(loadRegion, loadingNote('Loading the case…'));
    try {
      await reload();
      startPolling(false);
    } catch (error) {
      if (isAbort(error) || ctx.signal.aborted) return;
      if (error instanceof ApiError && error.status === 404) {
        replaceContent(loadRegion, notice('warning', 'This case does not exist, or it belongs to another tenant.'));
        return;
      }
      replaceContent(
        loadRegion,
        errorBanner(error, {
          signOut: ctx.signOut,
          retry: () => {
            void loadFirst();
          },
        }),
      );
    }
  }

  // Coming back to a tab that was hidden reads the case straight away instead of at the next slow tick.
  const onVisible = (): void => {
    if (!document.hidden && snapshot !== null) startPolling(true);
  };
  document.addEventListener('visibilitychange', onVisible);
  ctx.signal.addEventListener('abort', () => document.removeEventListener('visibilitychange', onVisible), { once: true });

  void loadFirst();
}
