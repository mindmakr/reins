// Node-side helpers shared by the build plugins (@reins/vite, @reins/next, @reins/expo/metro).
// Never imported by app code.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';


export const TOKEN_ROUTE = '/__reins/token';

type Headers = Record<string, string | string[] | undefined>;

/**
 * The dev server's answer to a token request. Reads `.reins/token` fresh each time,
 * because the bridge renews it after every pairing. Cross-site browser requests are refused.
 */
export function tokenResponse(projectDir: string, headers: Headers = {}): { status: number; body: string } {
  const site = headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return { status: 403, body: 'cross-site request refused' };
  try {
    const token = readFileSync(join(projectDir, '.reins', 'token'), 'utf8').trim();
    if (token) return { status: 200, body: token };
  } catch {
    // no bridge yet
  }
  return { status: 404, body: 'no reins bridge running: start `npx reins bridge`' };
}

/** True when REINS_ENABLE=1 asks to keep reins in a non-development build (staging only). */
export function keepInBuild(env: Record<string, string | undefined> = process.env): boolean {
  return ['REINS_ENABLE', 'VITE_REINS_ENABLE', 'NEXT_PUBLIC_REINS_ENABLE', 'EXPO_PUBLIC_REINS_ENABLE'].some((k) => env[k] === '1' || env[k] === 'true');
}
