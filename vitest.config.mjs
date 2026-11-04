import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 30_000,
    reporters: ['default'],
  },
})
