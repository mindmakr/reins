import { keepInBuild } from 'reins/server';

type NextConfig = Record<string, any>;

export interface ReinsNextOptions {
  /** Keep reins in production builds. Prefer REINS_ENABLE=1, and only for staging. */
  keep?: boolean;
}

/** Whether a build should swap reins for its stub. */
export function shouldStub(dev: boolean, options: ReinsNextOptions = {}, env = process.env): boolean {
  return !dev && !options.keep && !keepInBuild(env);
}

/**
 * Wraps a Next.js config. Production builds resolve `reins` to `reins/stub`,
 * with webpack and with Turbopack.
 */
export function withReins(nextConfig: NextConfig = {}, options: ReinsNextOptions = {}): NextConfig {
  const prodBuild = process.env.NODE_ENV === 'production';
  const out: NextConfig = {
    ...nextConfig,
    webpack(config: any, ctx: { dev: boolean }) {
      if (shouldStub(ctx.dev, options)) {
        config.resolve = config.resolve || {};
        config.resolve.alias = { ...(config.resolve.alias || {}), reins$: 'reins/stub' };
      }
      return typeof nextConfig.webpack === 'function' ? nextConfig.webpack(config, ctx) : config;
    },
  };
  if (shouldStub(!prodBuild, options)) {
    out.turbopack = { ...(nextConfig.turbopack || {}), resolveAlias: { ...((nextConfig.turbopack || {}).resolveAlias || {}), reins: 'reins/stub' } };
  }
  return out;
}

export default withReins;
