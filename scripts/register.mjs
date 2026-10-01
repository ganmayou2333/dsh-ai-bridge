#!/usr/bin/env node
/**
 * register.mjs — put the connector into an MCP client's config without hand
 * editing JSON/TOML for every client.
 *
 * The per-client shapes come from docs/design-notes.md and
 * skills/dsh-mcp-connector/references/client-configs.md, where each entry
 * carries its evidence level. This script only encodes what those say.
 *
 * Usage:
 *   node scripts/register.mjs --list
 *   node scripts/register.mjs --client cursor --dry-run
 *   node scripts/register.mjs --client vscode --project <dir>
 *   node scripts/register.mjs --client all --dry-run
 *
 * Options:
 *   --client <name>     cursor | vscode | kimi-code | zcode | codebuddy |
 *                       minimax | qwen | qoder | codex | stepcode | claude-code | all
 *   --dry-run           print the target file and the resulting content, write nothing
 *   --root <dir>        config root for user-scope clients (default: home directory)
 *   --project <dir>     project directory for project-scope clients (default: cwd)
 *   --server <path>     connector entry point (default: ../dsh-mcp-connector/server.mjs)
 *   --dsh-bin <path>    value for DSH_BIN (omitted when not given)
 *   --workspace <dir>   value for DSH_WORKSPACE (omitted when not given)
 *
 * Writes keep a `.bak` copy of an existing file. `claude-code` is never written
 * to: its config is CLI-managed, so the script prints the `claude mcp add`
 * command instead.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SERVER = resolve(HERE, '..', 'dsh-mcp-connector', 'server.mjs')
const ENTRY_NAME = 'dsh'

/** Every supported client, with the shape its config file needs. */
const CLIENTS = {
  cursor: { file: '.cursor/mcp.json', scope: 'user', format: 'json', key: ['mcpServers'], entry: {} },
  vscode: { file: '.vscode/mcp.json', scope: 'project', format: 'json', key: ['servers'], entry: { type: 'stdio' } },
  'kimi-code': { file: '.kimi-code/mcp.json', scope: 'user', format: 'json', key: ['mcpServers'], entry: {}, note: '官方 schema 未收录 type 字段' },
  zcode: { file: '.zcode/cli/config.json', scope: 'user', format: 'json', key: ['mcp', 'servers'], entry: {} },
  codebuddy: { file: '.codebuddy.json', scope: 'user', format: 'json', key: ['mcpServers'], entry: { type: 'stdio' } },
  minimax: { file: '.minimax/mcp.json', scope: 'user', format: 'json', key: ['mcpServers'], entry: { type: 'stdio' } },
  qwen: { file: '.qwen/settings.json', scope: 'user', format: 'json', key: ['mcpServers'], entry: {} },
  qoder: { file: '.mcp.json', scope: 'project', format: 'json', key: ['mcpServers'], entry: {} },
  codex: { file: '.codex/config.toml', scope: 'user', format: 'toml', key: ['mcp_servers', ENTRY_NAME], entry: {} },
  stepcode: { file: '.stepcode/config.toml', scope: 'user', format: 'toml', key: ['mcp_servers', ENTRY_NAME], entry: {} },
  'claude-code': { scope: 'command', format: 'command' },
}

function parseArgs(argv) {
  const options = { client: undefined, dryRun: false, root: homedir(), project: process.cwd(), server: DEFAULT_SERVER, dshBin: undefined, workspace: undefined, list: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--list') options.list = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--client') options.client = String(argv[++index] ?? '')
    else if (arg === '--root') options.root = resolve(String(argv[++index] ?? options.root))
    else if (arg === '--project') options.project = resolve(String(argv[++index] ?? options.project))
    else if (arg === '--server') options.server = resolve(String(argv[++index] ?? options.server))
    else if (arg === '--dsh-bin') options.dshBin = String(argv[++index] ?? '')
    else if (arg === '--workspace') options.workspace = String(argv[++index] ?? '')
  }
  return options
}

function targetPath(spec, options) {
  const base = spec.scope === 'project' ? options.project : options.root
  return join(base, spec.file)
}

function buildEnv(options) {
  const env = {}
  if (options.dshBin !== undefined && options.dshBin.length > 0) env.DSH_BIN = options.dshBin
  if (options.workspace !== undefined && options.workspace.length > 0) env.DSH_WORKSPACE = options.workspace
  return env
}

function buildEntry(spec, options) {
  const entry = { ...spec.entry, command: 'node', args: [options.server] }
  const env = buildEnv(options)
  if (Object.keys(env).length > 0) entry.env = env
  return entry
}

/** The command form for CLI-managed clients. */
function commandLine(options) {
  const envFlags = []
  if (options.dshBin) envFlags.push(`-e DSH_BIN="${options.dshBin}"`)
  if (options.workspace) envFlags.push(`-e DSH_WORKSPACE="${options.workspace}"`)
  return `claude mcp add ${ENTRY_NAME} -s user ${envFlags.join(' ')} -- node "${options.server}"`.replace(/\s+/g, ' ')
}

function readJsonAt(object, key) {
  return key.reduce((node, segment) => (node !== null && typeof node === 'object' ? node[segment] : undefined), object)
}

function writeJsonAt(object, key, value) {
  let node = object
  for (const segment of key.slice(0, -1)) {
    if (node[segment] === null || typeof node[segment] !== 'object' || Array.isArray(node[segment])) node[segment] = {}
    node = node[segment]
  }
  node[key[key.length - 1]] = value
}

async function planJson(spec, options) {
  const path = targetPath(spec, options)
  let existing = {}
  if (existsSync(path)) {
    try {
      existing = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      throw new Error(`${path} 不是合法 JSON，拒绝覆盖：${error.message}`)
    }
  }
  const already = readJsonAt(existing, spec.key)?.[ENTRY_NAME] !== undefined
  writeJsonAt(existing, spec.key, { ...(readJsonAt(existing, spec.key) ?? {}), [ENTRY_NAME]: buildEntry(spec, options) })
  return { path, content: `${JSON.stringify(existing, null, 2)}\n`, existed: existsSync(path), already }
}

function upsertToml(source, section, entry) {
  const lines = [
    `[${section}]`,
    'command = "node"',
    `args = ["${entry.args[0].replace(/\\/g, '\\\\')}"]`,
    ...(entry.env
      ? ['', `[${section}.env]`, ...Object.entries(entry.env).map(([key, value]) => `${key} = "${String(value).replace(/\\/g, '\\\\')}"`)]
      : []),
    '',
  ]
  const header = `[${section}]`
  const start = source.indexOf(header)
  if (start === -1) {
    const separator = source.length === 0 || source.endsWith('\n') ? '' : '\n'
    return { text: `${source}${separator}${lines.join('\n')}`, replaced: false }
  }
  // Replace the section up to the next top-level table header.
  const rest = source.slice(start + header.length)
  const nextHeader = rest.search(/\n\[(?!mcp_servers\.dsh)/)
  const end = nextHeader === -1 ? source.length : start + header.length + nextHeader + 1
  return { text: `${source.slice(0, start)}${lines.join('\n')}${source.slice(end)}`, replaced: true }
}

async function planToml(spec, options) {
  const path = targetPath(spec, options)
  const source = existsSync(path) ? await readFile(path, 'utf8') : ''
  const section = spec.key.join('.')
  const already = source.includes(`[${section}]`)
  const { text } = upsertToml(source, section, buildEntry(spec, options))
  return { path, content: text, existed: existsSync(path), already }
}

async function apply(plan) {
  await mkdir(dirname(plan.path), { recursive: true })
  if (plan.existed) await copyFile(plan.path, `${plan.path}.bak`)
  await writeFile(plan.path, plan.content, 'utf8')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.list || options.client === undefined) {
    process.stdout.write(`连接器入口: ${options.server}\n存在: ${existsSync(options.server)}\n\n`)
    for (const [name, spec] of Object.entries(CLIENTS)) {
      if (spec.scope === 'command') {
        process.stdout.write(`${name.padEnd(12)} CLI 管理，脚本只打印命令\n`)
        continue
      }
      const path = targetPath(spec, options)
      const registered = existsSync(path) && (await readFile(path, 'utf8')).includes(ENTRY_NAME)
      process.stdout.write(
        `${name.padEnd(12)} ${existsSync(path) ? '存在' : '不存在'}  ${registered ? '已注册' : '未注册'}  ${path}\n`,
      )
    }
    if (options.client === undefined && !options.list) {
      process.stdout.write('\n用法: node scripts/register.mjs --client <name> [--dry-run]\n')
      process.exitCode = 1
    }
    return
  }

  const names = options.client === 'all' ? Object.keys(CLIENTS) : [options.client]
  for (const name of names) {
    const spec = CLIENTS[name]
    if (spec === undefined) {
      process.stderr.write(`未知客户端: ${name}\n可选: ${Object.keys(CLIENTS).join(', ')}, all\n`)
      process.exitCode = 1
      return
    }

    if (spec.scope === 'command') {
      process.stdout.write(`${name}: 请运行\n  ${commandLine(options)}\n`)
      continue
    }

    const plan = spec.format === 'json' ? await planJson(spec, options) : await planToml(spec, options)
    if (options.dryRun) {
      process.stdout.write(`${name} -> ${plan.path}${plan.already ? '  (将覆盖已有的 dsh 条目)' : ''}\n${plan.content}\n`)
    } else {
      await apply(plan)
      process.stdout.write(`${name} -> 已写入 ${plan.path}${plan.existed ? '（原文件备份为 .bak）' : ''}\n`)
    }
  }
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`)
  process.exitCode = 1
})
