import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The library ships to browsers, but its tests run against pinned
    // fixtures on disk, so Node is the cheaper and more honest environment.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
