export function devEnabled(): boolean {
  const d = (import.meta as any).env,
    r = (globalThis as any).__DEV__,
    p: any = typeof process < 'u' && process.env;
  return (
    ['', 'VITE_', 'NEXT_PUBLIC_', 'EXPO_PUBLIC_'].some((k) => /^(1|true)$/.test(d?.[k + 'REINS_ENABLE'] || p?.[k + 'REINS_ENABLE'])) ||
    r === true ||
    (r !== false && p?.NODE_ENV != 'production' && d?.DEV !== false && !!(d?.DEV || p?.NODE_ENV))
  );
}
