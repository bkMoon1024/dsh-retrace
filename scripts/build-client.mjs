#!/usr/bin/env node
/**
 * 生成 lib/client.bundle.js（宿主实际加载的入口，package.json exports["./client"]）。
 *
 * 仓库里没有 esbuild（私有工具链不随仓库分发），所以这里用一份确定性变换代替打包器：
 *  1. lib/badge.js 与 lib/client.js 是仅有的两个模块，且 client.js 只依赖 react + badge；
 *  2. 去掉 `import ... from 'react'`，改成从 require('react') 取同名绑定；
 *  3. badge.js 内联进来（与既有 bundle 一致：运行时只 require("react")）；
 *  4. 去掉顶层 `export ` 前缀，末尾用 module.exports 暴露四个导出。
 *
 * 变换必须是幂等的：`node scripts/build-client.mjs --check` 用同样的输出和仓库里的
 * bundle 逐字节比对，任何一边手改过都会失败。行为等价性由隔离测试保证——那套用例
 * 对 client.js 和 client.bundle.js 各跑一遍。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXPORT_NAMES = ['name', 'inject', '__setMessageEditorWire', 'apply']

/** 去掉顶层 `export ` 前缀（只匹配行首声明，避免误伤字符串与注释）。 */
function stripExports(source) {
  return source.replace(/^export (?=(?:async )?(?:const|let|var|function|class)\b)/gm, '')
}

/** 收集行首导出的名字，用来断言 bundle 的 module.exports 没漏。 */
function exportedNames(source) {
  const names = []
  const pattern = /^export (?:async )?(?:const|let|var|function|class) ([A-Za-z_$][\w$]*)/gm
  for (const match of source.matchAll(pattern)) names.push(match[1])
  return names
}

/** 把 `import { a, b } from 'react'` 改写成 require + 解构。 */
function rewriteReactImport(source) {
  const pattern = /^import \{([^}]+)\} from 'react'\r?\n/m
  const match = source.match(pattern)
  if (match === null) throw new Error("client.js: react import not found")
  const names = match[1].split(',').map((name) => name.trim()).filter(Boolean)
  const lines = ['var import_react = require("react");']
  for (const name of names) lines.push(`var ${name} = import_react.${name};`)
  return source.replace(pattern, lines.join('\n') + '\n')
}

/** 去掉 `import ... from './badge.js'`（badge 由本脚本内联）。 */
function dropBadgeImport(source) {
  const pattern = /^import \{[^}]+\} from '\.\/badge\.js'\r?\n/m
  if (!pattern.test(source)) throw new Error("client.js: badge import not found")
  return source.replace(pattern, '')
}

function build() {
  // 源文件是 CRLF：先归一到 LF 再拼接，否则产物会混行尾（写盘时统一转 CRLF）。
  const read = (file) => readFileSync(join(ROOT, 'lib', file), 'utf8').split('\r\n').join('\n')
  const badge = read('badge.js')
  const client = read('client.js')

  const badgeNames = exportedNames(badge)
  if (badgeNames.length === 0) throw new Error('badge.js: no exports found')

  let body = rewriteReactImport(stripExports(dropBadgeImport(client)))
  const clientNames = exportedNames(client)
  const missing = EXPORT_NAMES.filter((name) => !clientNames.includes(name))
  if (missing.length > 0) throw new Error(`client.js: missing exports ${missing.join(', ')}`)

  const header = [
    'window.__ModuleLoader__.load({id: "dsh-retrace", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
  ]
  const parts = [
    ...header,
    '',
    `// lib/badge.js（内联，与 esbuild 产物一致：运行时只 require("react")）`,
    stripExports(badge).trimEnd(),
    '',
    '// lib/client.js',
    body.trimEnd(),
    '',
    `module.exports = { ${EXPORT_NAMES.join(', ')} };`,
    'return module.exports; }});',
    '',
  ]
  return parts.join('\n')
}

const target = join(ROOT, 'lib/client.bundle.js')

function main() {
  const generated = build()
  const check = process.argv.includes('--check')

  if (check) {
    let current = ''
    try { current = readFileSync(target, 'utf8') } catch { current = '' }
    const normalize = (text) => text.split('\r\n').join('\n').trimEnd()
    if (normalize(current) !== normalize(generated)) {
      console.error('client.bundle.js 与 client.js 不同步：跑 `node scripts/build-client.mjs` 重新生成。')
      process.exit(1)
    }
    console.log('client.bundle.js is in sync with client.js')
    return
  }

  // 仓库其它文件是 CRLF，产物保持一致以免整文件 diff。
  writeFileSync(target, generated.split('\n').join('\r\n'), 'utf8')
  console.log(`wrote ${target}`)
}

export { build }

if (process.argv[1] !== undefined && process.argv[1].endsWith('build-client.mjs')) main()
