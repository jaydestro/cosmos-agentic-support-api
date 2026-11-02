export class CliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

export interface ConnectionOptions {
  readonly baseUrl: string;
  readonly scope: string;
  readonly timeoutMs: number;
}

export interface CommonOptions extends ConnectionOptions {
  readonly mode: 'live' | 'demo';
  readonly waitMs: number;
  readonly pollMs: number;
}

export type Command =
  | (CommonOptions & { readonly command: 'start'; readonly idempotencyKey: string })
  | (CommonOptions & { readonly command: 'inspect'; readonly caseId: string })
  | (CommonOptions & { readonly command: 'approve'; readonly caseId: string; readonly version: number; readonly comment?: string })
  | (CommonOptions & { readonly command: 'reject'; readonly caseId: string; readonly version: number; readonly reason: string });

export const HELP = `Resolve fictional billing journey (Node 24)
node tools/demo/cli.ts <start|inspect|approve|reject> [options]

Required for every command:
  --base-url https://<trusted-resolve-host>/api
  --scope api://<Resolve-app-id>/.default

start:   --idempotency-key <stable-16-to-64-character-key>
inspect: --case-id <case_32-lowercase-hex>
approve: --case-id <id> --version <1..4> [--comment <fictional-text>]
reject:  --case-id <id> --version <1..4> --reason <fictional-text>

Optional: --mode live|demo (default live), --timeout-ms 100..60000 (default 15000),
--wait-ms 0..300000 (default 60000 for start/approve; otherwise 0),
--poll-ms 100..10000 (default 1000).

Use a trusted HTTPS API URL. Auth uses the current Azure CLI delegated login;
the CLI never logs in, changes identities, or saves bearer tokens. The signed-in
Azure CLI user must already have consent for this API's delegated access_as_user
permission; AzureCliCredential uses the resource's /.default scope. The application
tenant must have seeded aurora or borealis fictional invoices for start.
Mode selects a requirement, not an adapter: the deployed API must match it.
start stops at durable approval/finding; it NEVER approves. An authorized human
(not the case creator) must separately inspect and explicitly approve/reject a
version. All credits are simulated, even in live mode. Poll expiry is reported as
incomplete (exit 2); retry inspect, not a fresh start key. Mutations are not retried.
Output omits actor IDs, API free text, provider identifiers and auth diagnostics.
`;

function invalid(message: string): never {
  throw new CliError('invalid_arguments', message);
}

export function validateBaseUrl(value: string): string {
  if (!/^https:\/\/[^/?#\\\s]+\/api\/?$/.test(value)) {
    invalid('--base-url must be an HTTPS origin followed by /api (no query, fragment or credentials).');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    invalid('--base-url is not a valid URL.');
  }
  if (url.username || url.password || !url.hostname || url.pathname !== '/api' && url.pathname !== '/api/') {
    invalid('--base-url must not contain credentials or a different API path.');
  }
  return `${url.origin}/api`;
}

export function validateScope(value: string): string {
  if (!/^(api|https):\/\/[A-Za-z0-9._:/-]+\/\.default$/.test(value)) {
    invalid('--scope must explicitly name the Resolve resource /.default scope for AzureCliCredential.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    invalid('--scope is not a valid delegated scope URI.');
  }
  if (!url.hostname || url.username || url.password || url.pathname.includes('//') ||
      value.split('/').some((part) => part === '.' || part === '..')) {
    invalid('--scope is not a valid delegated scope URI.');
  }
  return value;
}

function integer(value: string, name: string, min: number, max: number): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) invalid(`${name} must be a decimal integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) invalid(`${name} is out of range.`);
  return number;
}

function text(value: string, name: string): string {
  if (!value.trim() || [...value].length > 500 ||
      [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    invalid(`${name} must contain 1–500 characters of fictional text without control characters.`);
  }
  return value;
}

export function parseArgs(args: readonly string[]): Command | { readonly command: 'help' } {
  if (args.length === 1 && args[0] === '--help') return { command: 'help' };
  const command = args[0];
  if (command !== 'start' && command !== 'inspect' && command !== 'approve' && command !== 'reject') {
    invalid('Choose start, inspect, approve or reject; use --help for syntax.');
  }
  const allowed = new Set(['--base-url', '--scope', '--mode', '--timeout-ms', '--wait-ms', '--poll-ms']);
  if (command === 'start') allowed.add('--idempotency-key');
  else allowed.add('--case-id');
  if (command === 'approve' || command === 'reject') allowed.add('--version');
  if (command === 'approve') allowed.add('--comment');
  if (command === 'reject') allowed.add('--reason');
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === undefined || !allowed.has(flag) || flags.has(flag)) invalid('Unknown, misplaced or duplicate option.');
    if (value === undefined || value.startsWith('--') || !value) invalid('Each option requires a value.');
    flags.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = flags.get(flag);
    if (value === undefined) invalid(`${flag} is required.`);
    return value;
  };
  const mode = flags.get('--mode') ?? 'live';
  if (mode !== 'live' && mode !== 'demo') invalid('--mode must be live or demo.');
  const common: CommonOptions = {
    baseUrl: validateBaseUrl(required('--base-url')),
    scope: validateScope(required('--scope')),
    mode,
    timeoutMs: integer(flags.get('--timeout-ms') ?? '15000', '--timeout-ms', 100, 60_000),
    waitMs: integer(flags.get('--wait-ms') ?? (command === 'start' || command === 'approve' ? '60000' : '0'), '--wait-ms', 0, 300_000),
    pollMs: integer(flags.get('--poll-ms') ?? '1000', '--poll-ms', 100, 10_000),
  };
  if (command === 'start') {
    const idempotencyKey = required('--idempotency-key');
    if (!/^[A-Za-z0-9._~-]{16,64}$/.test(idempotencyKey)) invalid('--idempotency-key must be 16–64 key-safe characters.');
    return { ...common, command, idempotencyKey };
  }
  const caseId = required('--case-id');
  if (!/^case_[0-9a-f]{32}$/.test(caseId)) invalid('--case-id does not match the public contract.');
  if (command === 'inspect') return { ...common, command, caseId };
  const version = integer(required('--version'), '--version', 1, 4);
  if (command === 'reject') return { ...common, command, caseId, version, reason: text(required('--reason'), '--reason') };
  const comment = flags.get('--comment');
  return { ...common, command, caseId, version, ...(comment === undefined ? {} : { comment: text(comment, '--comment') }) };
}
