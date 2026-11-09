import { keepInBuild, TOKEN_ROUTE, tokenResponse } from 'reins/server';

/** The parts of the Vite plugin API this plugin uses, so it needs no Vite types. */
interface ResolvedConfig {
  root: string;
  command: 'build' | 'serve';
  mode: string;
}
interface Server {
  config: { root: string };
  middlewares: { use(fn: (req: any, res: any, next: () => void) => void): void };
}

export interface ReinsViteOptions {
  /** Keep reins in production builds. Prefer the REINS_ENABLE=1 env var, and only for staging. */
  keep?: boolean;
}

/**
 * Dev: serves the pairing token at /__reins/token from `.reins/token`.
 * Build (not development mode): resolves `reins` to `reins/stub`, so no reins code ships.
 */
export function reinsPlugin(options: ReinsViteOptions = {}) {
  let stub = false;
  return {
    name: 'reins',
    enforce: 'pre' as const,
    configResolved(config: ResolvedConfig) {
      stub = config.command === 'build' && config.mode !== 'development' && !options.keep && !keepInBuild();
    },
    async resolveId(this: any, id: string, importer?: string) {
      if (!stub || id !== 'reins') return null;
      return this.resolve('reins/stub', importer, { skipSelf: true });
    },
    configureServer(server: Server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== TOKEN_ROUTE) return next();
        const { status, body } = tokenResponse(server.config.root, req.headers);
        res.statusCode = status;
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
      });
    },
  };
}

export default reinsPlugin;
