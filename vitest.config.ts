import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string) => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against sources, so they pass before a build.
    alias: [
      { find: /^@mindmakr\/reins$/, replacement: src('reins/src/index.ts') },
      { find: /^@mindmakr\/reins\/next\/token-route$/, replacement: src('reins/src/next-token-route.ts') },
      { find: /^@mindmakr\/reins\/expo\/metro$/, replacement: src('reins/src/metro.ts') },
      { find: /^@mindmakr\/reins\/bridge$/, replacement: src('reins/src/bridge/index.ts') },
      { find: /^@mindmakr\/reins\/flight$/, replacement: src('reins/src/flight.ts') },
      { find: /^@mindmakr\/reins\/(server|stub|adapters|react|expo|metro|vite|next|verify|report|node|record|record-stub)$/, replacement: src('reins/src/$1.ts') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
