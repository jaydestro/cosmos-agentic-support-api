import type { Config } from '../config/env.ts';
import type { StaticResponse } from './static.ts';

/** Public Microsoft Entra authority host; sovereign clouds are not supported by this sample. */
export const ENTRA_AUTHORITY_HOST = 'https://login.microsoftonline.com';

/** What the console needs to sign someone in. Every value is public: there are no secrets, keys or tokens. */
export type ConsoleAuthSettings =
  | {
      mode: 'entra';
      /** Null until a single-page-application registration is configured; the console then says it cannot sign in. */
      clientId: string | null;
      authority: string | null;
      scopes: string[];
    }
  | {
      mode: 'test-idp';
      /** Present only for the local/CI test identity provider; the application refuses test-idp mode on Azure. */
      mintUrl: string | null;
    };

export interface ConsoleSettings {
  auth: ConsoleAuthSettings;
}

export function consoleSettings(config: Config): ConsoleSettings {
  if (config.auth.mode === 'entra') {
    const { directoryId } = config.auth;
    return {
      auth: {
        mode: 'entra',
        clientId: config.console.entraClientId ?? null,
        authority: directoryId === undefined ? null : `${ENTRA_AUTHORITY_HOST}/${directoryId}`,
        scopes: [config.console.apiScope],
      },
    };
  }
  return { auth: { mode: 'test-idp', mintUrl: config.console.testIdpMintUrl ?? null } };
}

/**
 * Origins the console page may call besides itself and Entra. Only the test identity provider qualifies,
 * and its address is configured solely in test-idp mode, which Azure hosting refuses.
 */
export function consoleConnectSources(config: Config): string[] {
  const mint = config.auth.mode === 'test-idp' ? config.console.testIdpMintUrl : undefined;
  return mint === undefined ? [] : [new URL(mint).origin];
}

/** The unauthenticated `/config.json` answer. It is never cached because the settings follow the deployment. */
export function consoleConfigResponse(config: Config, method: string): StaticResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(consoleSettings(config)));
  return {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
    ...(method === 'HEAD' ? {} : { body: bytes }),
  };
}
