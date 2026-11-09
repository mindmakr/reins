const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Whether a WebSocket Origin may connect.
 * Default: any http(s) origin on localhost, 127.0.0.1 or ::1, any port.
 * Extra origins are matched exactly, for example `http://my-app.test:3000`.
 * A missing Origin (React Native, Node) is allowed only when `allowNoOrigin` is true; the token is still required.
 */
export function isOriginAllowed(origin: string | undefined, extra: string[] = [], allowNoOrigin = true): boolean {
  if (!origin) return allowNoOrigin;
  if (extra.includes(origin)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost');
}
