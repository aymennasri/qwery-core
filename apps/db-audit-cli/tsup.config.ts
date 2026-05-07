import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  target: 'node22',
  splitting: false,
  sourcemap: true,
  minify: false,
  clean: true,
  platform: 'node',
  dts: false,
  noExternal: [
    /^@qwery\//,
    /^@ai-sdk\//,
    'ai',
    'pg',
    'zod',
    'uuid',
    'nanoid',
    'mustache',
    'turndown',
    'class-transformer',
    'reflect-metadata',
  ],
  banner: {
    js: '#!/usr/bin/env node',
  },
  outExtension: () => ({ js: '.cjs' }),
});
