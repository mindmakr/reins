const on = (v: unknown) => v === '1' || v === 'true';

/**
 * True only in development builds, or when REINS_ENABLE=1 is set at build time (for staging).
 * Any production signal wins: `NODE_ENV=production` or `import.meta.env.DEV === false` turn reins off,
 * unless REINS_ENABLE=1. React Native `__DEV__` turns it on.
 */
export function devEnabled(): boolean {
  let enable: unknown;
  let nodeEnv: string | undefined;
  let viteDev: unknown;
  let rnDev: unknown;
  try {
    if (typeof __DEV__ !== 'undefined') rnDev = __DEV__;
  } catch {
    // not React Native
  }
  try {
    const env = (import.meta as any).env;
    if (env) {
      enable = env.REINS_ENABLE || env.VITE_REINS_ENABLE;
      viteDev = env.DEV;
    }
  } catch {
    // no import.meta.env
  }
  // Written as plain `process.env.X` so bundlers can replace them at build time.
  try {
    enable = enable || process.env.REINS_ENABLE || process.env.NEXT_PUBLIC_REINS_ENABLE || process.env.EXPO_PUBLIC_REINS_ENABLE;
  } catch {
    // no process
  }
  try {
    nodeEnv = process.env.NODE_ENV;
  } catch {
    // no process
  }
  if (on(enable) || rnDev === true) return true;
  if (rnDev === false || nodeEnv === 'production' || viteDev === false) return false;
  return viteDev === true || nodeEnv !== undefined;
}

declare const __DEV__: boolean | undefined;
