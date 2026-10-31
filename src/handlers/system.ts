import { principalOf } from '../http/pipeline.ts';
import type { Config } from '../config/env.ts';
import type { Handler } from './types.ts';

export interface LiveStatus {
  available: boolean;
  blockedReason: string | null;
}

/**
 * Live mode needs explicit approval and a configured adapter. When either is missing it is
 * reported as blocked; the service never substitutes the deterministic demo investigator.
 */
export function liveStatus(agent: Config['agent'], configured: boolean): LiveStatus {
  if (!agent.liveApproved) return { available: false, blockedReason: 'live_not_approved' };
  if (!configured) return { available: false, blockedReason: 'live_not_configured' };
  return { available: true, blockedReason: null };
}

export const getHealth: Handler = () => Promise.resolve({ status: 200, body: { status: 'ok' } });

export const getReadiness: Handler = async (ctx) => {
  const ready = await ctx.services.readiness.isReady();
  return { status: ready ? 200 : 503, body: { status: ready ? 'ok' : 'unavailable' } };
};

export const getSession: Handler = (ctx) => {
  const principal = principalOf(ctx);
  const { services } = ctx;
  const live = liveStatus(services.config.agent, services.model !== null && services.investigators.live !== null);
  return Promise.resolve({
    status: 200,
    body: {
      principal: { principalId: principal.principalId, tenantId: principal.tenantId, roles: [...principal.roles] },
      environment: {
        agentMode: ctx.services.config.agent.mode,
        liveAvailable: live.available,
        liveBlockedReason: live.blockedReason,
        simulatedCredits: true,
        apiVersion: ctx.services.contract.info.version,
      },
    },
  });
};
