#!/usr/bin/env node
/**
 * Build Chrome Extension with esbuild.
 * Usage: node scripts/build.mjs [--watch]
 */

import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  sourcemap: true,
  outdir: 'dist',
};

const entries = [
  { entryPoints: ['src/background.ts'], ...shared },
  { entryPoints: ['src/content.ts'], ...shared, format: 'iife' }, // content scripts must be IIFE
  { entryPoints: ['src/popup.ts'], ...shared, format: 'iife' },   // popup must be IIFE
];

if (watch) {
  for (const entry of entries) {
    const ctx = await esbuild.context(entry);
    await ctx.watch();
  }
  console.log('Watching for changes...');
} else {
  for (const entry of entries) {
    await esbuild.build(entry);
  }
  console.log('Build complete → dist/');
}
