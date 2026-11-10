import { createElement, useEffect, useRef, type ReactNode } from 'react';
import { NativeModules, PixelRatio, Platform, View } from 'react-native';
import { reins, type Box, type ConnectOptions } from 'reins';

export const TOKEN_ROUTE = '/__reins/token';

/** `http://host:port` of the Metro dev server that served this bundle, if known. */
export function devServerOrigin(scriptURL: string | undefined = NativeModules.SourceCode && NativeModules.SourceCode.scriptURL): string | null {
  if (!scriptURL) return null;
  const m = /^(https?:\/\/[^/]+)/.exec(scriptURL);
  return m ? m[1] : null;
}

/**
 * Pairs the app with the bridge. Fetches the token from the Metro dev server (see `withReins` in `reins/metro`)
 * and connects to the bridge on localhost. Android emulators and USB devices need `adb reverse tcp:7357 tcp:7357`.
 * Does nothing in production builds.
 */
export function connectExpo(opts: ConnectOptions = {}): Promise<boolean> {
  const origin = devServerOrigin();
  return reins.connect({
    tokenUrl: origin ? origin + TOKEN_ROUTE : undefined,
    url: 'ws://localhost:7357',
    ...opts,
    meta: { platform: Platform.OS, ...(opts.meta || {}) },
  });
}

/** Measures a native view in window coordinates (dp) with the pixel ratio. */
export function measureView(id: string, view: any): Promise<Box | null> {
  return new Promise((resolve) => {
    if (!view || typeof view.measureInWindow !== 'function') return resolve(null);
    view.measureInWindow((x: number, y: number, width: number, height: number) =>
      resolve({ id, x, y, width, height, scrollX: 0, scrollY: 0, devicePixelRatio: PixelRatio.get() }),
    );
  });
}

/** Returns a ref to put on a View; the agent can then measure and snap it as panel `id`. */
export function useReinsPanel(id: string) {
  const ref = useRef<any>(null);
  useEffect(() => reins.registerPanel(id, () => measureView(id, ref.current)), [id]);
  return ref;
}

export interface ReinsPanelProps {
  id: string;
  children?: ReactNode;
  [prop: string]: unknown;
}

/** A View with `testID={id}` that the agent can measure and snap. */
export function ReinsPanel({ id, children, ...rest }: ReinsPanelProps) {
  useEffect(() => {
    reins.markComponent(id);
  });
  const ref = useReinsPanel(id);
  return createElement(View, { testID: id, collapsable: false, ...rest, ref }, children);
}

export { useReinsAction, useReinsState } from 'reins/react';
