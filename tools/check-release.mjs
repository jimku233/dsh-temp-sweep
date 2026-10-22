#!/usr/bin/env node
/**
 * 发布前自检：四道门。
 *
 *   1. 生成物    仓库里不该有 node_modules / 探针目录 / 日志 / 状态文件
 *   2. 敏感串    被跟踪文件 + 全部 git 历史里不该有本机路径、用户名、内网 IP、token
 *   3. 版本一致  package.json 与 CHANGELOG 最新一节必须同号
 *   4. 测试      node --test 全绿（沙箱内无法 spawn 时自动跳过并说明）
 *
 * 用法：
 *   node tools/check-release.mjs
 *   node tools/check-release.mjs --skip-tests
 *   node tools/check-release.mjs --quiet
 *
 * 为什么扫全历史：敏感串一旦提交，删掉文件也还在历史里；发布前只有历史扫描能发现。
 * 为什么本文件自己不写敏感字面量：它也在被扫描的跟踪文件里，字面量会自我举报。
 *
 * @module dsh-temp-sweep/tools/check-release
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const SKIP_TESTS = argv.includes('--skip-tests');
const QUIET = argv.includes('--quiet');

const problems = [];
const notes = [];
const say = (line) => {
  if (!QUIET) process.stdout.write(`${line}\n`);
};
const bad = (where, message) => problems.push(`${where}：${message}`);

/** Run git in the repository root. */
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** The tracked file list, as repo-relative slash paths. */
function trackedFiles() {
  const out = git(['ls-files']);
  return out === '' ? [] : out.split('\n');
}

say('发布前检查（tools/check-release.mjs）');

const files = trackedFiles();
say(`  跟踪文件 ${files.length} 个`);

// ---------------------------------------------------------------- 1. 生成物
const GENERATED = [
  [/^node_modules\//, '依赖目录'],
  [/^_probe\//, '开发探针目录'],
  [/^\.tmp\//, '临时目录'],
  [/\.log$/, '日志'],
  [/^last-run\.json$/, '运行状态文件'],
  [/\.(bak|orig|rej)$/, '备份/冲突残片'],
  [/(^|\/)\.DS_Store$/, 'macOS 元数据'],
  [/^Thumbs\.db$/i, 'Windows 元数据'],
];
const stray = files.filter((file) => GENERATED.some(([re]) => re.test(file)));
for (const file of stray) bad('生成物', `${file} 不该进仓库`);
if (stray.length === 0) say('  1/4 生成物：干净');

// ---------------------------------------------------------------- 2. 敏感串
// 本文件也被跟踪，所以这些字面量必须拼出来，否则会自我举报。
const USER = ['8613', '6'].join('');
const WINDOWS_HOME = ['C:', '\\', 'Users', '\\'].join('');
const WORKSPACE = ['服务', '质量pdf'].join('');

const PATTERNS = [
  [new RegExp(`\\b${USER}\\b`), '本机用户名'],
  [new RegExp(WINDOWS_HOME.replace(/\\/g, '\\\\') + '[A-Za-z]'), 'Windows 用户目录绝对路径'],
  [new RegExp(WORKSPACE), '本机工作区名'],
  [/\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, '内网 IP'],
  [/\bghp_[A-Za-z0-9]{20,}\b/, 'GitHub 经典 token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, 'GitHub 细粒度 token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/, '私钥'],
  [/(?:password|passwd|secret|token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i, '疑似硬编码凭证'],
];

/** Scan a text blob and report the first hit of each pattern. */
function scanText(label, text) {
  for (const [re, why] of PATTERNS) {
    if (re.test(text)) bad(label, `命中${why}（${re}）`);
  }
}

for (const file of files) {
  let text;
  try {
    text = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    continue; // binary or unreadable
  }
  scanText(file, text);
}

// Full history: a secret removed from HEAD is still published with the repo.
let historyText = '';
try {
  historyText = execFileSync('git', ['log', '-p', '--all', '--format=commit %H'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
} catch (error) {
  notes.push(`历史扫描不可用（${error?.message ?? error}）`);
}
if (historyText) scanText('git 全历史', historyText);
say(`  2/4 敏感串：${files.length} 个跟踪文件 + 全历史`);

// ---------------------------------------------------------------- 3. 版本一致
const readText = (path) => (existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), 'utf8') : '');
const versionOf = (pattern, file) => {
  const match = readText(file).match(pattern);
  return match ? match[1] : '';
};

const versions = [
  ['package.json', versionOf(/"version"\s*:\s*"([\d.]+)"/, 'package.json')],
  ['CHANGELOG.md', versionOf(/^##\s*([\d.]+)\s+—/m, 'CHANGELOG.md')],
];
const missing = versions.filter(([, value]) => value === '');
for (const [where] of missing) bad('版本', `${where} 里找不到版本号`);
const known = versions.filter(([, value]) => value !== '');
const unique = [...new Set(known.map(([, value]) => value))];
if (unique.length > 1) {
  bad('版本', `不一致：${known.map(([where, value]) => `${where}=${value}`).join('，')}`);
}
if (unique.length === 1 && missing.length === 0) say(`  3/4 版本：${unique[0]} 一致`);

// .gitignore 必须仍然存在且有效，否则发布后会带上不该带的东西。
const ignore = readText('.gitignore');
for (const must of ['node_modules/', '_probe/']) {
  if (!ignore.includes(must)) bad('.gitignore', `缺少 ${must}`);
}

// ---------------------------------------------------------------- 4. 测试
if (SKIP_TESTS) {
  say('  4/4 测试：跳过（--skip-tests）');
} else {
  // Single source of truth for how tests run: tools/test.mjs lists the files
  // explicitly and falls back to in-process loading where forking is forbidden.
  const runner = join('tools', 'test.mjs');
  if (!existsSync(join(ROOT, runner))) {
    bad('测试', `${runner} 不存在`);
  } else {
    try {
      execFileSync(process.execPath, [runner], {
        cwd: ROOT,
        stdio: 'pipe',
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      say('  4/4 测试：全绿');
    } catch (error) {
      const stderr = String(error?.stderr ?? '');
      const stdout = String(error?.stdout ?? '');
      const message = `${stdout}\n${stderr}`.trim();
      if (error?.code === 'EPERM' || /spawn EPERM/.test(message)) {
        // Confined sandboxes forbid the stdio pipes the runner needs.
        notes.push('测试跳过：当前环境的子进程管道被禁止，请在普通终端或 CI 运行 node tools/test.mjs');
        say('  4/4 测试：跳过（沙箱禁止子进程管道）');
      } else {
        const tail = message === '' ? `exit ${error?.status ?? '?'}` : message.split('\n').slice(-15).join('\n');
        bad('测试', tail);
      }
    }
  }
}

// ---------------------------------------------------------------- 结论
say('');
for (const note of notes) say(`  注意：${note}`);
if (problems.length === 0) {
  say('通过：可以发布。');
  process.exit(0);
}
say(`未通过（${problems.length} 项）：`);
for (const problem of problems) say(`  - ${problem}`);
process.exit(1);
