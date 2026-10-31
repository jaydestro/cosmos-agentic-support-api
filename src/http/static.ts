import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

export interface StaticResponse {
  status: number;
  headers: Record<string, string>;
  body?: Uint8Array;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
});

const CSP_ORIGIN = /^https?:\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i;

/**
 * The console page policy. `extraConnectSources` are bare origins the page may call besides itself and
 * Entra; anything that is not a bare origin is refused so a configuration value cannot inject directives.
 */
export function buildConsoleCsp(extraConnectSources: readonly string[] = []): string {
  for (const source of extraConnectSources) {
    if (!CSP_ORIGIN.test(source)) throw new Error('A connect-src source must be a bare http(s) origin');
  }
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    ["connect-src 'self'", 'https://login.microsoftonline.com', ...extraConnectSources].join(' '),
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// Swagger UI applies inline style attributes, so the reference page alone allows them.
const REFERENCE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MAX_PATH_CHARS = 200;
const MAX_CACHED_FILES = 64;

/**
 * Maps a request path onto a file below `root`, or `null` when the path is unsafe. Dot segments,
 * dotfiles, backslashes, NUL bytes and encoded separators are all rejected.
 */
export function resolveAssetPath(root: string, requested: string | undefined): string | null {
  const raw = requested ?? '';
  if (raw.length > MAX_PATH_CHARS) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  const segments = decoded.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment.startsWith('.'))) return null;
  if (segments.length === 0) segments.push('index.html');
  else if (extname(segments[segments.length - 1] as string) === '') segments.push('index.html');
  const base = resolve(root);
  const full = resolve(base, ...segments);
  return full.startsWith(base + sep) ? full : null;
}

function headersFor(relative: string, type: string, consoleCsp: string): Record<string, string> {
  const isReference = relative.startsWith('reference/');
  const headers: Record<string, string> = {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cache-Control': relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : isReference ? 'public, max-age=3600' : 'no-cache',
  };
  if (type.startsWith('text/html')) headers['Content-Security-Policy'] = isReference ? REFERENCE_CSP : consoleCsp;
  return headers;
}

export interface StaticServer {
  serve(requested: string | undefined, method: string): Promise<StaticResponse>;
}

export interface StaticServerOptions {
  /** Extra bare origins the console page may call; see `buildConsoleCsp`. */
  connectSources?: readonly string[];
}

/** Serves prebuilt files from `root`. The file set is small and fixed per deployment, so reads are cached. */
export function createStaticServer(root: string, options: StaticServerOptions = {}): StaticServer {
  const cache = new Map<string, Uint8Array>();
  const base = resolve(root);
  const consoleCsp = buildConsoleCsp(options.connectSources);

  return {
    async serve(requested, method): Promise<StaticResponse> {
      const full = resolveAssetPath(base, requested);
      const type = full === null ? undefined : CONTENT_TYPES[extname(full).toLowerCase()];
      if (full === null || type === undefined) return { status: 404, headers: { 'Cache-Control': 'no-store' } };
      let bytes = cache.get(full);
      if (bytes === undefined) {
        try {
          bytes = await readFile(full);
        } catch {
          return { status: 404, headers: { 'Cache-Control': 'no-store' } };
        }
        if (cache.size >= MAX_CACHED_FILES) cache.clear();
        cache.set(full, bytes);
      }
      const relative = full.slice(base.length + 1).split(sep).join('/');
      return {
        status: 200,
        headers: { ...headersFor(relative, type, consoleCsp), 'Content-Length': String(bytes.byteLength) },
        ...(method === 'HEAD' ? {} : { body: bytes }),
      };
    },
  };
}
