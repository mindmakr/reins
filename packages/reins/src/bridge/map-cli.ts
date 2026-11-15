import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { redactDeep } from '@mindmakr/reins';
import { callBridge, parseFlags } from './oneshot-cli.js';

export const MAP_USAGE = `usage:
  reins map [--out <file>] [--static <file>] [--offline] [--stdout] [--port <n>] [--dir <path>] [--timeout <ms>]

Exports live reins_list_actions JSON schemas, registered state store keys, and mounted <ReinsPanel> IDs into feature-map.json, optionally merged with a static route/screen map.`;

export interface FeatureMapAction {
  name: string;
  description?: string;
  input?: unknown;
  consequential: boolean;
  readOnly: boolean;
  target: 'app' | 'server';
  server?: string;
}

export interface FeatureMapRoute {
  method?: string;
  path: string;
  file?: string;
  line?: number;
  id?: string;
}

export interface FeatureMapScreen {
  path: string;
  file?: string;
  line?: number;
  id?: string;
}

export interface FeatureMapServer {
  client?: number;
  title?: string;
  meta?: unknown;
  actions: FeatureMapAction[];
}

export interface FeatureMap {
  schemaVersion: '1.0.0';
  generatedAt: string;
  source: 'live' | 'static' | 'merged';
  app?: { url?: string; title?: string; meta?: unknown };
  actions: FeatureMapAction[];
  states: string[];
  panels: string[];
  routes: FeatureMapRoute[];
  screens: FeatureMapScreen[];
  servers?: FeatureMapServer[];
}

type Printer = (line: string) => void;

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));

function normalizeAction(raw: unknown, target: 'app' | 'server', server?: string): FeatureMapAction | null {
  if (!isObj(raw) || typeof raw.name !== 'string' || !raw.name) return null;
  const action: FeatureMapAction = {
    name: raw.name,
    consequential: Boolean(raw.consequential),
    readOnly: Boolean(raw.readOnly),
    target,
  };
  if (typeof raw.description === 'string' && raw.description) action.description = raw.description;
  // Preserve action input JSON schema property keys verbatim (including e.g. `password` or `token`).
  if (raw.input !== undefined) action.input = raw.input;
  if (server) action.server = server;
  return action;
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

function normalizeRoute(raw: unknown): FeatureMapRoute | null {
  if (typeof raw === 'string' && raw) return { path: raw };
  if (!isObj(raw) || typeof raw.path !== 'string' || !raw.path) return null;
  const route: FeatureMapRoute = { path: raw.path };
  if (typeof raw.method === 'string' && raw.method) route.method = raw.method.toUpperCase();
  if (typeof raw.file === 'string' && raw.file) route.file = raw.file;
  if (typeof raw.line === 'number' && Number.isFinite(raw.line)) route.line = raw.line;
  if (typeof raw.id === 'string' && raw.id) route.id = raw.id;
  return route;
}

function normalizeScreen(raw: unknown): FeatureMapScreen | null {
  if (typeof raw === 'string' && raw) return { path: raw };
  if (!isObj(raw) || typeof raw.path !== 'string' || !raw.path) return null;
  const screen: FeatureMapScreen = { path: raw.path };
  if (typeof raw.file === 'string' && raw.file) screen.file = raw.file;
  if (typeof raw.line === 'number' && Number.isFinite(raw.line)) screen.line = raw.line;
  if (typeof raw.id === 'string' && raw.id) screen.id = raw.id;
  return screen;
}

function extractStatic(raw: unknown): {
  actions: FeatureMapAction[];
  states: string[];
  panels: string[];
  routes: FeatureMapRoute[];
  screens: FeatureMapScreen[];
} {
  if (!isObj(raw)) return { actions: [], states: [], panels: [], routes: [], screens: [] };
  const routes: FeatureMapRoute[] = [];
  const screens: FeatureMapScreen[] = [];

  if (Array.isArray(raw.routes)) {
    for (const item of raw.routes) {
      const r = normalizeRoute(item);
      if (r) routes.push(r);
    }
  }
  if (Array.isArray(raw.screens)) {
    for (const item of raw.screens) {
      const s = normalizeScreen(item);
      if (s) screens.push(s);
    }
  }
  if (Array.isArray(raw.surfaces)) {
    for (const item of raw.surfaces) {
      if (!isObj(item)) continue;
      if (item.kind === 'route') {
        const r = normalizeRoute(item);
        if (r) routes.push(r);
      } else if (item.kind === 'screen') {
        const s = normalizeScreen(item);
        if (s) screens.push(s);
      }
    }
  }
  const actions: FeatureMapAction[] = [];
  if (Array.isArray(raw.actions)) {
    for (const item of raw.actions) {
      const target = isObj(item) && item.target === 'server' ? 'server' : 'app';
      const srv = isObj(item) && typeof item.server === 'string' ? item.server : undefined;
      const a = normalizeAction(item, target, srv);
      if (a) actions.push(a);
    }
  }

  return {
    actions,
    states: stringList(raw.states),
    panels: stringList(raw.panels),
    routes,
    screens,
  };
}

/** Combines a live `reins_list_actions` response and/or static project map into one canonical feature map. */
export function buildFeatureMap(live: unknown | null, staticInput: unknown | null = null): FeatureMap {
  const staticPart = extractStatic(staticInput);
  const hasStatic = staticInput !== null && staticInput !== undefined;
  const hasLive = live !== null && live !== undefined;
  const source: FeatureMap['source'] = hasLive && hasStatic ? 'merged' : hasLive ? 'live' : 'static';

  const liveObj = isObj(live) ? live : {};
  const actionMap = new Map<string, FeatureMapAction>();
  const addAction = (a: FeatureMapAction | null) => {
    if (!a) return;
    actionMap.set(`${a.target}:${a.server ?? ''}:${a.name}`, a);
  };

  // Seed static actions first so live bridge contracts (schemas, consequential, descriptions) always win on collision.
  for (const a of staticPart.actions) addAction(a);

  if (Array.isArray(liveObj.actions)) {
    for (const raw of liveObj.actions) addAction(normalizeAction(raw, 'app'));
  }

  const servers: FeatureMapServer[] = [];
  if (Array.isArray(liveObj.servers)) {
    for (const srv of liveObj.servers) {
      if (!isObj(srv)) continue;
      const redactedMeta = srv.meta !== undefined ? redactDeep(srv.meta) : undefined;
      const metaName = isObj(srv.meta) && typeof srv.meta.name === 'string' && srv.meta.name ? srv.meta.name : undefined;
      const srvName = metaName ?? (typeof srv.title === 'string' && srv.title ? srv.title : undefined);
      const srvActions: FeatureMapAction[] = [];
      if (Array.isArray(srv.actions)) {
        for (const raw of srv.actions) {
          const normalized = normalizeAction(raw, 'server', srvName);
          if (normalized) {
            srvActions.push(normalized);
            addAction(normalized);
          }
        }
      }
      servers.push({
        ...(typeof srv.client === 'number' ? { client: srv.client } : {}),
        ...(typeof srv.title === 'string' ? { title: srv.title } : {}),
        ...(redactedMeta !== undefined ? { meta: redactedMeta } : {}),
        actions: srvActions.sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
  }

  const states = [...new Set([...stringList(liveObj.states), ...staticPart.states])].sort();
  const panels = [...new Set([...stringList(liveObj.panels), ...staticPart.panels])].sort();

  const routeMap = new Map<string, FeatureMapRoute>();
  for (const r of staticPart.routes) {
    routeMap.set(`${r.method ?? ''} ${r.path}`, r);
  }
  const routes = [...routeMap.values()].sort((a, b) => a.path.localeCompare(b.path) || (a.method ?? '').localeCompare(b.method ?? ''));

  const screenMap = new Map<string, FeatureMapScreen>();
  for (const s of staticPart.screens) {
    screenMap.set(`${s.path}\0${s.file ?? ''}`, s);
  }
  const screens = [...screenMap.values()].sort((a, b) => a.path.localeCompare(b.path) || (a.file ?? '').localeCompare(b.file ?? ''));

  let app: FeatureMap['app'];
  if (isObj(liveObj.app)) {
    app = {
      ...(typeof liveObj.app.url === 'string' ? { url: liveObj.app.url } : {}),
      ...(typeof liveObj.app.title === 'string' ? { title: liveObj.app.title } : {}),
      ...(liveObj.app.meta !== undefined ? { meta: redactDeep(liveObj.app.meta) } : {}),
    };
  }

  return {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    source,
    ...(app ? { app } : {}),
    actions: [...actionMap.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.target.localeCompare(b.target) || (a.server ?? '').localeCompare(b.server ?? ''),
    ),
    states,
    panels,
    routes,
    screens,
    ...(servers.length ? { servers } : {}),
  };
}

function writeJsonAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

/** Runs `reins map` to export live/static feature contracts to `feature-map.json` (or `--stdout`). */
export async function mapMain(
  argv: string[],
  cwd = process.cwd(),
  print: Printer = (s) => process.stdout.write(s + '\n'),
  err: Printer = (s) => process.stderr.write(s + '\n'),
): Promise<number> {
  try {
    const { common, values, bools } = parseFlags(argv, cwd, new Set(['--out', '--static']), new Set(['--stdout', '--offline']));
    if (common.help) {
      print(MAP_USAGE);
      return 0;
    }
    if (common.positional.length) {
      err(`reins map: unexpected argument ${common.positional[0]}\n\n${MAP_USAGE}`);
      return 2;
    }
    const offline = bools.has('--offline');
    const stdout = bools.has('--stdout');
    const staticFlag = values['--static'];
    if (offline && !staticFlag) {
      throw new Error('--offline requires --static <file>');
    }

    let staticData: unknown = null;
    if (staticFlag !== undefined) {
      const staticFile = resolve(cwd, staticFlag);
      let rawText: string;
      try {
        rawText = readFileSync(staticFile, 'utf8');
      } catch {
        throw new Error(`cannot read static map at ${staticFile}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new Error(`static map at ${staticFile} is not valid JSON`);
      }
      if (!isObj(parsed)) {
        throw new Error(`static map at ${staticFile} must be a JSON object`);
      }
      staticData = parsed;
    }

    const live = offline
      ? null
      : await callBridge({
          port: common.port,
          dir: common.dir,
          timeoutMs: common.timeoutMs,
          name: 'reins_list_actions',
          args: {},
        });

    const map = buildFeatureMap(live, staticData);
    const json = JSON.stringify(map, null, 2);
    const writeFile = !stdout || values['--out'] !== undefined;
    const outPath = values['--out'] !== undefined ? resolve(cwd, values['--out']) : join(common.dir, 'feature-map.json');

    if (writeFile) {
      writeJsonAtomic(outPath, json + '\n');
    }
    if (stdout) {
      print(json);
    } else {
      print(JSON.stringify({
        ok: true,
        out: outPath,
        source: map.source,
        actions: map.actions.length,
        states: map.states.length,
        panels: map.panels.length,
        routes: map.routes.length,
        screens: map.screens.length,
      }));
    }
    return 0;
  } catch (e: any) {
    err(`reins map: ${e?.message ? String(e.message) : String(e)}`);
    return 2;
  }
}
