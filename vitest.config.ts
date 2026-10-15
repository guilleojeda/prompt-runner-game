import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Ignored working copies are evidence, not the current product's test suite.
    exclude: [...configDefaults.exclude, '**/.work/**'],
  },
});
