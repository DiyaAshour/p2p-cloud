const API_KEY = import.meta.env.VITE_P2P_API_KEY || '';
const ENV_API_BASE = (import.meta.env.VITE_P2P_API_BASE_URL || import.meta.env.VITE_API_BASE_URL || '').trim();

let resolvedApiBase: string | null = null;

function normalizeBase(base: string) {
  return base.replace(/\/+$/, '');
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => normalizeBase(value.trim())).filter(Boolean)));
}

function candidateApiBases() {
  const bases: string[] = [];

  if (ENV_API_BASE) bases.push(ENV_API_BASE);

  if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) {
    bases.push(window.location.origin);
  }

  bases.push('http://127.0.0.1:3001');
  bases.push('http://localhost:3001');
  bases.push('http://127.0.0.1:3000');
  bases.push('http://localhost:3000');

  return unique(bases);
}

function withApiHeaders(headers: HeadersInit = {}) {
  return API_KEY ? { ...headers, 'x-p2p-api-key': API_KEY } : headers;
}

function apiUrl(path: string, base: string) {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

async function readResponseMessage(response: Response) {
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const data = await response.json().catch(() => null);
    if (data && typeof data === 'object') {
      const error = 'error' in data ? data.error : undefined;
      const message = 'message' in data ? data.message : undefined;
      if (typeof error === 'string') return error;
      if (typeof message === 'string') return message;
      return JSON.stringify(data);
    }
  }

  return response.text().catch(() => '');
}

async function ensureApiBase() {
  if (resolvedApiBase !== null) return resolvedApiBase;

  for (const base of candidateApiBases()) {
    try {
      const response = await fetch(apiUrl('/api/health', base), {
        cache: 'no-store',
        headers: withApiHeaders(),
      });

      if (response.ok || response.status === 401) {
        resolvedApiBase = base;
        return resolvedApiBase;
      }
    } catch {
      // Try the next known local/API candidate.
    }
  }

  throw new Error(
    'P2P API is not reachable. Start the backend API or set VITE_P2P_API_BASE_URL to the running API URL.'
  );
}

export async function p2pFetch(path: string, options: RequestInit = {}) {
  const base = await ensureApiBase();
  const response = await fetch(apiUrl(path, base), {
    ...options,
    headers: withApiHeaders(options.headers || {}),
  });

  if (!response.ok) {
    const message = await readResponseMessage(response);
    const status = `${response.status} ${response.statusText}`.trim();
    throw new Error(message ? `${status}: ${message}` : `Request failed with ${status}`);
  }

  return response;
}

export async function p2pJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await p2pFetch(path, options);
  return response.json();
}

export function resetP2PApiBase() {
  resolvedApiBase = null;
}
