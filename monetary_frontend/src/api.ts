export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch('api' + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.detail;
    throw new Error(typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((d: { msg: string }) => d.msg).join('; ') : `Request failed (${response.status})`);
  }
  return data as T;
}
