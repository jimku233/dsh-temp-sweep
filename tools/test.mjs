#!/usr/bin/env node
/**
 * 可移植的测试入口 —— 本地、CI、受限沙箱三种环境行为一致。
 *
 * 为什么不用 `node --test tests/`：不同 Node 版本对「目录参数」的处理不一致，
 * 在 Node 22/24 上实测会把 `tests` 当成模块去加载，报 MODULE_NOT_FOUND ——
 * 2026-10-22 那次推送因此四个 CI job 全红。
 *
 * 为什么默认进程内：`node --test` 会为每个测试文件 fork 子进程，而受限沙箱禁止
 * 子进程管道（EPERM）。直接 import 每个测试文件，node:test 仍会注册并执行它们，
 * 失败通过 process.exitCode 反映。需要逐文件隔离时用 `--fork`。
 *
 * @module dsh-temp-sweep/tools/test
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const useFork = process.argv.includes('--fork');

const names = readdirSync(join(ROOT, 'tests'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

if (names.length === 0) {
  console.error('tools/test: tests/ 下没有 *.test.mjs');
  process.exit(1);
}

const files = names.map((name) => join('tests', name));

if (useFork) {
  console.log(`node --test ${files.join(' ')}`);
  const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`tools/test: 无法启动测试运行器（${result.error.code ?? result.error.message}）`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

console.log(`加载 ${files.length} 个测试文件（进程内）`);
for (const file of files) {
  await import(pathToFileURL(join(ROOT, file)).href);
}
// node:test 在事件循环末尾跑完所有用例，并把结果写进 process.exitCode；
// 这里不能 process.exit()，否则会截断尚未执行的用例。
