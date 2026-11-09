import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string) => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against sources, so they pass before a build.
    alias: [
      { find: /^reins$/, replacement: src('reins/src/index.ts') },
      { find: /^reins\/(server|stub|adapters)$/, replacement: src('reins/src/$1.ts') },
      { find: /^@reins\/react$/, replacement: src('react/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
