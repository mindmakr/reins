import { tokenResponse } from 'reins/server';

/**
 * App Router handler that serves the pairing token in development.
 * Add `app/api/reins-token/route.ts` with:
 *   export { GET } from '@reins/next/token-route';
 *   export const dynamic = 'force-dynamic';
 * and connect with `reins.connect({ tokenUrl: '/api/reins-token' })`.
 * In production it always answers 404.
 */
export async function GET(request: Request): Promise<Response> {
  if (process.env.NODE_ENV === 'production') return new Response('Not found', { status: 404 });
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => (headers[k] = v));
  const { status, body } = tokenResponse(process.cwd(), headers);
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
}
