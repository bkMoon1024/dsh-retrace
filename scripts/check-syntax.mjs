#!/usr/bin/env node
/**
 * 仓库自检：语法 + 版本一致性 + 产物同步。
 *
 * 为什么需要它：这个仓库没有构建链（scripts/ 里的打包器不在仓库里），
 * 所以“改完 client.js 忘了同步 client.bundle.js”“README/AGENTS 的版本号停在旧值”
 * 这类错误没有任何机制拦得住。这个脚本把三件事变成一次可重复的检查。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

/** dynamic-*.js 是注入式函数体片段（不是完整模块），node --check 必然报错，跳过。 */
const FRAGMENT = /^dynamic-(client|host)\.js$/

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name.endsWith('.js')) out.push(full)
  }
  return out
}

for (const file of walk(join(ROOT, 'lib'))) {
  const rel = relative(ROOT, file).split('\\').join('/')
  if (FRAGMENT.test(rel.split('/').pop())) continue
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    failures.push(`${rel}: ${String(error.stderr ?? error.message).split('\n').slice(0, 3).join(' ')}`)
  }
}

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const expectations = [
  ['README.md', `Current version: **${version}**`],
  ['README.zh.md', `当前版本 **${version}**`],
  ['AGENTS.md', `**当前版本**：v${version}`],
]
for (const [file, needle] of expectations) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  if (!text.includes(needle)) failures.push(`${file}: 版本号不是 ${version}（找不到「${needle}」）`)
}

try {
  execFileSync(process.execPath, [join(ROOT, 'scripts/build-client.mjs'), '--check'], { stdio: 'pipe' })
} catch (error) {
  failures.push(`client.bundle.js 同步检查失败：${String(error.stdout ?? '').trim() || String(error.message)}`)
}

if (failures.length > 0) {
  console.error(failures.map((line) => `FAIL ${line}`).join('\n'))
  process.exit(1)
}
console.log(`check ok: syntax, version ${version}, bundle in sync`)
