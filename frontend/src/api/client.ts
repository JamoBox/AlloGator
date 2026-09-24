// Thin fetch wrapper. In production the auth proxy identifies the user via cookies, so no
// credentials are handled here; in dev mode the chosen user is sent as a header.

const DEV_USER_KEY = 'allogator.devUser';
export const DEV_USER_HEADER = 'X-AlloGator-Dev-User';

export function getDevUser(): string | null {
  try {
    return localStorage.getItem(DEV_USER_KEY);
  } catch {
    return null;
  }
}

export function setDevUser(email: string | null) {
  try {
    if (email) localStorage.setItem(DEV_USER_KEY, email);
    else localStorage.removeItem(DEV_USER_KEY);
  } catch {
    /* storage unavailable */
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function headers(extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  const dev = getDevUser();
  if (dev) h.set(DEV_USER_HEADER, dev);
  return h;
}

async function raise(res: Response): Promise<never> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    if (typeof body.detail === 'string') message = body.detail;
    else if (Array.isArray(body.detail))
      message = body.detail.map((d: { msg?: string }) => d.msg ?? String(d)).join('; ');
  } catch {
    /* not JSON */
  }
  throw new ApiError(message, res.status);
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; form?: FormData } = {},
): Promise<T> {
  const init: RequestInit = { method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET') };
  if (opts.form) {
    init.body = opts.form;
    init.headers = headers();
  } else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = headers({ 'Content-Type': 'application/json' });
  } else {
    init.headers = headers();
  }
  const res = await fetch(path, init);
  if (!res.ok) await raise(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Download a file from the API (fetch + blob so dev-mode headers are sent too). */
export async function download(path: string, fallbackName: string) {
  const res = await fetch(path, { headers: headers() });
  if (!res.ok) await raise(res);
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = /filename="?([^";]+)"?/.exec(disposition);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = match?.[1] ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
