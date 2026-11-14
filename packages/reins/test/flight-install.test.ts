// Unit u7 B5: an install that imports only @mindmakr/reins/flight runs without `ws` and the MCP SDK being loaded.
// The built package is copied alone into a fresh node_modules, where neither module exists, and a fresh Node
// process imports the flight entry and runs it: had the entry (or anything it reaches) imported either one, the
// import would fail. The two stay dependencies for `npx reins bridge`; the flight entry never reaches them.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const built = join(pkg, 'dist', 'flight.js');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const run = (cwd: string, script: string) => execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', NODE_PATH: '' } });

describe('@mindmakr/reins/flight without ws and the MCP SDK (u7 B5)', () => {
  it.skipIf(!existsSync(built))('imports and runs the built flight entry where neither module is installed (after npm run build)', () => {
    const app = mkdtempSync(join(tmpdir(), 'reins-flight-install-'));
    dirs.push(app);
    const dest = join(app, 'node_modules', '@mindmakr', 'reins');
    mkdirSync(dest, { recursive: true });
    cpSync(join(pkg, 'package.json'), join(dest, 'package.json'));
    cpSync(join(pkg, 'dist'), join(dest, 'dist'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, type: 'module' }));

    // Neither module can be found from the app, so any import of one would throw.
    const missing = run(
      app,
      `const out = [];
       for (const m of ['ws', '@modelcontextprotocol/sdk/server/index.js']) { try { await import(m); out.push(m + ' found'); } catch (e) { out.push(e.code); } }
       console.log(JSON.stringify(out));`,
    );
    expect(JSON.parse(missing)).toEqual(['ERR_MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND']);

    // The bridge does need them: the same install cannot load it, which shows the copy has no other way to them.
    const bridge = run(app, `try { await import('@mindmakr/reins/bridge'); console.log('loaded'); } catch (e) { console.log(e.code); }`);
    expect(bridge.trim()).toBe('ERR_MODULE_NOT_FOUND');

    const out = run(
      app,
      `import { flight, memoryStore } from '@mindmakr/reins/flight';
       const manifest = { schema: 1, service: 'shop', processes: [{ name: 'order', key: 'the order id', steps: ['placed', 'paid'], ends: ['paid'], promises: [{ id: 'one-pay', kind: 'once', step: 'paid' }] }] };
       const started = flight.start({ store: memoryStore(), manifest, checkEveryMs: 0, flushMs: 60000, notify: { daily: false } });
       flight.step('order', 'o1', 'placed');
       flight.step('order', 'o1', 'paid');
       await flight.flush();
       await flight.checkNow();
       const r = await flight.report();
       flight.stop();
       console.log(JSON.stringify({ started, service: r.service, promise: r.promises.map((p) => p.state) }));`,
    );
    expect(JSON.parse(out)).toEqual({ started: true, service: 'shop', promise: ['held'] });
  });
});
