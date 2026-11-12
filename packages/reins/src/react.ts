import { createElement, useEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { reins, type Action } from '@mindmakr/reins';

/**
 * Registers an action while the component is mounted.
 * `run` always sees the latest props; re-registers only when `deps` change.
 */
export function useReinsAction<I = any, O = any>(def: Action<I, O>, deps: unknown[] = []): void {
  const latest = useRef(def);
  latest.current = def;
  useEffect(
    () =>
      reins.action<I, O>({
        name: def.name,
        description: def.description,
        input: def.input,
        consequential: def.consequential,
        readOnly: def.readOnly,
        run: (input: I) => latest.current.run(input),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [def.name, def.consequential, def.readOnly, ...deps],
  );
}

/** Exposes a state snapshot while the component is mounted. The getter always sees the latest render. */
export function useReinsState(name: string, get: () => unknown): void {
  const latest = useRef(get);
  latest.current = get;
  useEffect(() => reins.state(name, () => latest.current()), [name]);
}

export interface ReinsPanelProps extends HTMLAttributes<HTMLDivElement> {
  id: string;
  children?: ReactNode;
}

/** A `<div data-reins={id}>` the agent can measure, inspect and snap. Other props go to the div. */
export function ReinsPanel({ id, children, ...rest }: ReinsPanelProps) {
  useEffect(() => {
    reins.markComponent(id);
  });
  return createElement('div', { ...rest, 'data-reins': id }, children);
}
