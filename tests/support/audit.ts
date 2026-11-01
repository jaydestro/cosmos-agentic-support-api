// Dependency audit gate. The audit is never silenced: production dependencies must be
// clean, and every development-only advisory must be listed below with a reason and an
// expiry date. An unlisted advisory, or an expired exception, fails the gate.
import { spawnSync } from 'node:child_process';

interface Exception {
  readonly advisory: string;
  readonly reason: string;
  readonly expires: string;
}

const EXCEPTIONS: readonly Exception[] = [
  {
    advisory: 'GHSA-g3hv-75wg-m249',
    reason:
      'minimatch <11.0.1 glob DoS. Dev-only (eslint, typescript-eslint, @redocly/openapi-core via openapi-typescript); ' +
      'it never ships in the Functions package. The advisory requires 11.0.1, but npm publishes 10.2.6 as the newest ' +
      'minimatch, so no compatible fix exists. Checked 2026-11-01. Our globs are fixed repository patterns, not user input.',
    expires: '2026-12-15',
  },
];

interface AuditVia {
  readonly url?: string;
}

interface AuditReport {
  readonly vulnerabilities?: Record<string, { readonly severity: string; readonly via: readonly (string | AuditVia)[] }>;
}

function runAudit(omitDev: boolean): AuditReport {
  const args = ['audit', '--json', ...(omitDev ? ['--omit=dev'] : [])];
  const result = spawnSync('npm', args, { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 32 * 1024 * 1024 });
  if (!result.stdout) {
    throw new Error(`npm audit produced no output: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as AuditReport;
}

function advisories(report: AuditReport): Set<string> {
  const ids = new Set<string>();
  for (const entry of Object.values(report.vulnerabilities ?? {})) {
    for (const via of entry.via) {
      if (typeof via === 'object' && via.url) {
        ids.add(via.url.split('/').pop() ?? via.url);
      }
    }
  }
  return ids;
}

const production = advisories(runAudit(true));
if (production.size > 0) {
  console.error(`FAIL production dependencies have advisories: ${[...production].join(', ')}`);
  process.exit(1);
}
console.log('production dependencies: 0 advisories');

const all = advisories(runAudit(false));
const today = new Date().toISOString().slice(0, 10);
let failed = false;
for (const id of all) {
  const exception = EXCEPTIONS.find((candidate) => candidate.advisory === id);
  if (!exception) {
    console.error(`FAIL unlisted advisory ${id}`);
    failed = true;
  } else if (exception.expires < today) {
    console.error(`FAIL exception for ${id} expired ${exception.expires}`);
    failed = true;
  } else {
    console.warn(`ACCEPTED (dev-only, expires ${exception.expires}) ${id}: ${exception.reason}`);
  }
}
for (const exception of EXCEPTIONS) {
  if (!all.has(exception.advisory)) {
    console.warn(`NOTE exception ${exception.advisory} no longer reported; remove it from tests/support/audit.ts`);
  }
}
process.exit(failed ? 1 : 0);
