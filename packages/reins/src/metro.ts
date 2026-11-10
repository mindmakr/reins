// Metro config helper for reins. Runs in Node, never in the app.
import { keepInBuild, TOKEN_ROUTE, tokenResponse } from 'reins/server';

type MetroConfig = Record<string, any>;

export interface ReinsMetroOptions {
  /** Project folder holding `.reins/`. Default: current folder. */
  projectRoot?: string;
  /** Keep reins in production bundles. Prefer REINS_ENABLE=1, and only for staging. */
  keep?: boolean;
}

/** Whether this Metro run should swap reins for its stub. `expo export` and release builds set NODE_ENV=production. */
export function shouldStub(options: ReinsMetroOptions = {}, env = process.env): boolean {
  return env.NODE_ENV === 'production' && !options.keep && !keepInBuild(env);
}

/**
 * Wraps a Metro config:
 * - dev: serves the pairing token at /__reins/token on the Metro server;
 * - production: resolves `reins` to `reins/stub` and `reins/record` to `reins/record-stub`.
 */
export function withReins(config: MetroConfig, options: ReinsMetroOptions = {}): MetroConfig {
  const root = options.projectRoot || process.cwd();
  const server = config.server || {};
  const resolver = config.resolver || {};
  const prevEnhance = server.enhanceMiddleware;
  const prevResolve = resolver.resolveRequest;
  const stub = shouldStub(options);
  return {
    ...config,
    server: {
      ...server,
      enhanceMiddleware(middleware: any, metroServer: any) {
        const inner = prevEnhance ? prevEnhance(middleware, metroServer) : middleware;
        return (req: any, res: any, next: any) => {
          if (req.url !== TOKEN_ROUTE) return inner(req, res, next);
          const { status, body } = tokenResponse(root, req.headers);
          res.statusCode = status;
          res.setHeader('Content-Type', 'text/plain');
          res.setHeader('Cache-Control', 'no-store');
          res.end(body);
        };
      },
    },
    resolver: {
      ...resolver,
      resolveRequest(context: any, moduleName: string, platform: string | null) {
        const name = stub && moduleName === 'reins' ? 'reins/stub' : stub && moduleName === 'reins/record' ? 'reins/record-stub' : moduleName;
        return prevResolve ? prevResolve(context, name, platform) : context.resolveRequest(context, name, platform);
      },
    },
  };
}

export default withReins;
