import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string) => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against sources, so they pass before a build.
    alias: [
      { find: /^reins$/, replacement: src('reins/src/index.ts') },
      { find: /^reins\/next\/token-route$/, replacement: src('reins/src/next-token-route.ts') },
      { find: /^reins\/expo\/metro$/, replacement: src('reins/src/metro.ts') },
      { find: /^reins\/bridge$/, replacement: src('reins/src/bridge/index.ts') },
      { find: /^reins\/(server|stub|adapters|react|expo|metro|vite|next|verify)$/, replacement: src('reins/src/$1.ts') },
      { find: /^@reins\/react$/, replacement: src('react/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
