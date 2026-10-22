/**
 * Plugin-shape tests: the loader hands `apply(ctx, config)` a raw config object
 * and expects the module to export `name`. These pin the contract without
 * mounting a real Cordis context.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, name, normalizeConfig } from '../lib/index.js';

test('module exports the Cordis contract', () => {
  assert.equal(name, 'temp-sweep');
  assert.equal(typeof apply, 'function');
});

test('normalizeConfig applies safe defaults', () => {
  const config = normalizeConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.maxIdleHours, 24);
  assert.equal(config.protectMinutes, 10);
  assert.equal(config.intervalMinutes, 60);
  assert.deepEqual(config.patterns, ['dsh-workspace-changes-*']);
  assert.ok(config.roots.length >= 1);
  assert.ok(config.markerDir.endsWith('temp-sweep\\hosts') || config.markerDir.endsWith('temp-sweep/hosts'));
});

test('normalizeConfig clamps hostile numbers and drops unsafe roots', () => {
  const config = normalizeConfig({
    maxIdleHours: -5,
    protectMinutes: 100000,
    intervalMinutes: 0,
    maxDeletePerRun: 0,
    roots: ['C:\\', '/', 'C:\\Temp'],
  });
  assert.equal(config.maxIdleHours, 1);
  assert.equal(config.protectMinutes, 24 * 60);
  assert.equal(config.intervalMinutes, 1);
  assert.equal(config.maxDeletePerRun, 1);
  assert.deepEqual(config.roots, ['C:\\Temp']);
});

test('normalizeConfig honours custom patterns and roots', () => {
  const config = normalizeConfig({ patterns: ['dsh-spill-*'], roots: ['C:\\Temp'], maxIdleHours: 48 });
  assert.deepEqual(config.patterns, ['dsh-spill-*']);
  assert.deepEqual(config.roots, ['C:\\Temp']);
  assert.equal(config.maxIdleHours, 48);
});

test('apply does nothing when disabled', () => {
  let touched = false;
  const ctx = {
    effect: () => { touched = true; return () => {}; },
    logger: { info() {}, warn() {}, error() {} },
  };
  apply(ctx, { enabled: false });
  assert.equal(touched, false);
});

test('apply registers one disposable interval effect', () => {
  let effectRuns = 0;
  let disposed = 0;
  const ctx = {
    effect: (execute) => {
      effectRuns += 1;
      const dispose = execute();
      return () => { disposed += 1; dispose(); };
    },
    logger: { info() {}, warn() {}, error() {} },
  };

  apply(ctx, { sweepOnStart: false, roots: ['C:\\Temp'], intervalMinutes: 30 });
  assert.equal(effectRuns, 1);
  assert.equal(disposed, 0);
});
