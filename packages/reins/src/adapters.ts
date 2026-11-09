import { redactUrl } from './redact.js';

/** State source for any store with `getState()`: Zustand, Redux, Redux Toolkit. */
export const fromStore = (store: { getState(): unknown }) => () => store.getState();
export const zustand = fromStore;
export const redux = fromStore;

/** State source for a TanStack (React) Query client: one entry per cached query. */
export const reactQuery = (client: { getQueryCache(): { getAll(): any[] } }) => () =>
  client
    .getQueryCache()
    .getAll()
    .map((q) => ({
      key: q.queryKey,
      status: q.state.status,
      fetchStatus: q.state.fetchStatus,
      updatedAt: q.state.dataUpdatedAt,
      error: q.state.error ? String(q.state.error) : undefined,
      data: q.state.data,
    }));

/** State source for the current route. Pass a getter for routers that keep their own location. */
export const routerLocation = (get?: () => unknown) => () => {
  if (get) return get();
  const l = (globalThis as any).location;
  return l ? { pathname: l.pathname, search: redactUrl(l.search), hash: l.hash } : null;
};
