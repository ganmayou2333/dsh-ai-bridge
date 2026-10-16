#!/usr/bin/env node
/**
 * Hermetic test for scripts/register.mjs.
 *
 * Everything is redirected into a scratch directory via --root / --project, so
 * no real client configuration is read or written. The write path is exercised
 * for real (files are created), which is the part worth testing: shape, merge,
 * idempotency and dry-run behaviour.
 *
 * Usage: node scripts/register-selftest.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REGISTER = join(HERE, 'register.mjs')

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail.length > 0 ? `\n      ${detail}` : ''}\n`)
}

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [REGISTER, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const getAt = (object, key) => key.reduce((node, segment) => node?.[segment], object)

async function main() {
  process.stdout.write(`register selftest (node ${process.version}, platform ${process.platform})\n`)
  const scratch = mkdtempSync(join(tmpdir(), 'register-selftest-'))
  const args = (extra) => ['--root', scratch, '--project', scratch, '--server', 'C:\\tools\\dsh-mcp-connector\\server.mjs', ...extra]

  try {
    // --list
    const list = await run(args(['--list']))
    check('--list exits 0', list.code === 0, `exit=${list.code}`)
    check(
      '--list names every supported client',
      ['cursor', 'vscode', 'zcode', 'codebuddy', 'codex', 'stepcode', 'claude-code', 'doubao-work'].every((name) =>
        list.stdout.includes(name),
      ),
      list.stdout.split('\n')[2] ?? '',
    )
    check(
      '--list marks doubao-work as an in-app client (no config file to write)',
      /doubao-work\s+App 内配置/.test(list.stdout),
      list.stdout.split('\n').find((line) => line.startsWith('doubao-work')) ?? '',
    )

    // 豆包工作：App 内配置，只打印要粘贴的内容（HTTP 传输，不是 stdio）
    {
      const work = await run(args(['--client', 'doubao-work', '--token', 'T0KEN']))
      check('doubao-work: exits 0', work.code === 0, work.stderr.trim())
      check(
        'doubao-work: prints a streamable-http entry pointing at the HTTP endpoint',
        work.stdout.includes('"type": "streamable-http"') &&
          work.stdout.includes('"url": "http://127.0.0.1:8790/mcp"'),
        work.stdout.split('\n').slice(0, 12).join(' | '),
      )
      check(
        'doubao-work: carries the bearer token in a header (App 里的自定义 Headers)',
        work.stdout.includes('"Authorization": "Bearer T0KEN"') && work.stdout.includes('Authorization = Bearer T0KEN'),
      )
      check(
        'doubao-work: includes both install routes, the start command and the side-effect check',
        work.stdout.includes('技能 · 连接器 · 伙伴') &&
          work.stdout.includes('--http --host 127.0.0.1 --port 8790 --token T0KEN') &&
          work.stdout.includes('clients.json'),
      )
      check(
        'doubao-work: never prints a stdio entry (it cannot run a local process)',
        !work.stdout.includes('"command": "node"') && !work.stdout.includes('"type": "stdio"'),
      )
      check('doubao-work: writes no config file anywhere in the scratch root', !existsSync(join(scratch, 'doubao-work')))
    }
    {
      const noToken = await run(args(['--client', 'doubao-work']))
      check(
        'doubao-work: without --token it shows a placeholder and says to pin one',
        noToken.stdout.includes('<TOKEN>') && noToken.stdout.includes('占位符'),
        noToken.stdout.split('\n').find((line) => line.includes('TOKEN')) ?? '',
      )
    }
    {
      const custom = await run(args(['--client', 'doubao-work', '--http-url', 'http://127.0.0.1:9999/x', '--token', 'A']))
      check(
        'doubao-work: --http-url drives both the entry and the start command port',
        custom.stdout.includes('"url": "http://127.0.0.1:9999/x"') && custom.stdout.includes('--port 9999') && custom.stdout.includes('--token A'),
      )
    }
    {
      // 没有 DSH_HOME 时必须提示分叉风险，而不是默默给一条会读错队列的命令
      const noHome = await run(args(['--client', 'doubao-work', '--token', 'A']), { DSH_HOME: '' })
      check(
        'doubao-work: without DSH_HOME it warns about the two connector directories',
        noHome.stdout.includes('.dsh-mcp-connector') && noHome.stdout.includes('各说各话') && !noHome.stdout.includes("$env:DSH_HOME="),
      )
      const withHome = await run(args(['--client', 'doubao-work', '--token', 'A']), { DSH_HOME: 'C:\\scratch-dsh' })
      check(
        'doubao-work: with DSH_HOME the start command pins it (no split queue)',
        withHome.stdout.includes("$env:DSH_HOME='C:\\scratch-dsh'; node"),
        withHome.stdout.split('\n').find((line) => line.includes('DSH_HOME')) ?? '',
      )
    }

    // JSON, user scope, nested key
    for (const [client, keyPath, needsType] of [
      ['cursor', ['mcpServers'], false],
      ['kimi-code', ['mcpServers'], false],
      ['zcode', ['mcp', 'servers'], false],
      ['codebuddy', ['mcpServers'], true],
      ['minimax', ['mcpServers'], true],
      ['qwen', ['mcpServers'], false],
    ]) {
      const applied = await run(args(['--client', client]))
      check(`${client}: apply exits 0`, applied.code === 0, applied.stderr.trim())
      const file = applied.stdout.match(/已写入 (.+)/)?.[1]?.trim()
      const config = file !== undefined && existsSync(file) ? readJson(file) : undefined
      const entry = config === undefined ? undefined : getAt(config, [...keyPath, 'dsh'])
      check(
        `${client}: entry lands at ${keyPath.join('.')}.dsh`,
        entry !== undefined && entry.command === 'node' && entry.args[0] === 'C:\\tools\\dsh-mcp-connector\\server.mjs',
        JSON.stringify(entry),
      )
      check(`${client}: stdio type ${needsType ? 'present' : 'absent as documented'}`, needsType ? entry?.type === 'stdio' : entry?.type === undefined)
    }

    // Project scope uses --project
    const vscode = await run(args(['--client', 'vscode']))
    const vscodePath = join(scratch, '.vscode', 'mcp.json')
    check('vscode: writes into the project directory', vscode.code === 0 && existsSync(vscodePath), vscodePath)
    check('vscode: uses the `servers` key with an explicit stdio type', getAt(readJson(vscodePath), ['servers', 'dsh'])?.type === 'stdio')

    // Merge, not overwrite
    const cursorPath = join(scratch, '.cursor', 'mcp.json')
    const merged = readJson(cursorPath)
    merged.mcpServers.other = { command: 'node', args: ['other.mjs'] }
    writeFileSync(cursorPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    await run(args(['--client', 'cursor']))
    const afterMerge = readJson(cursorPath)
    check('an unrelated server entry survives a re-apply', afterMerge.mcpServers.other?.args?.[0] === 'other.mjs')
    check('re-applying keeps exactly one dsh entry', Object.keys(afterMerge.mcpServers).filter((key) => key === 'dsh').length === 1)
    check('a backup of the previous file is kept', existsSync(`${cursorPath}.bak`))

    // TOML clients
    const codexPath = join(scratch, '.codex', 'config.toml')
    mkdirSync(dirname(codexPath), { recursive: true })
    writeFileSync(codexPath, 'model = "deepseek-flash"\n', 'utf8')
    await run(args(['--client', 'codex']))
    await run(args(['--client', 'codex']))
    const toml = readFileSync(codexPath, 'utf8')
    check('codex: appends a [mcp_servers.dsh] section', toml.includes('[mcp_servers.dsh]'))
    check('codex: applying twice does not duplicate the section', toml.split('[mcp_servers.dsh]').length - 1 === 1)
    check('codex: existing content is preserved', toml.includes('model = "deepseek-flash"'))

    const stepcodePath = join(scratch, '.stepcode', 'config.toml')
    await run(args(['--client', 'stepcode']))
    check('stepcode: writes its own TOML section', readFileSync(stepcodePath, 'utf8').includes('[mcp_servers.dsh]'))

    // TOML: replacing our own section must stop at the next table header, not
    // swallow a table that happens to follow it.
    const edgeRoot = join(scratch, 'edge-toml')
    const edgeToml = join(edgeRoot, '.codex', 'config.toml')
    mkdirSync(dirname(edgeToml), { recursive: true })
    writeFileSync(edgeToml, '[mcp_servers.dsh]\ncommand = "stale"\n\n[other]\nkeep = true\n', 'utf8')
    await run(['--root', edgeRoot, '--project', scratch, '--server', 'C:\\x\\server.mjs', '--client', 'codex'])
    const edge = readFileSync(edgeToml, 'utf8')
    check('TOML: an existing dsh section is replaced, not duplicated', edge.split('[mcp_servers.dsh]').length - 1 === 1)
    check('TOML: the stale entry is actually gone', !edge.includes('command = "stale"'))
    check('TOML: a following unrelated table survives', edge.includes('[other]') && edge.includes('keep = true'))

    // TOML with an env sub-table, applied twice.
    const envRoot = join(scratch, 'edge-toml-env')
    const envToml = join(envRoot, '.codex', 'config.toml')
    const envArgs = ['--root', envRoot, '--project', scratch, '--server', 'C:\\x\\server.mjs', '--client', 'codex', '--dsh-bin', 'C:\\dsh.cmd']
    await run(envArgs)
    await run(envArgs)
    const envText = readFileSync(envToml, 'utf8')
    check('TOML: an env sub-table is written when DSH_BIN is given', envText.includes('[mcp_servers.dsh.env]') && envText.includes('DSH_BIN = "C:\\\\dsh.cmd"'), envText.replace(/\n/g, ' | ').slice(0, 120))
    check('TOML: re-applying with env keeps one section and one env table', envText.split('[mcp_servers.dsh]').length - 1 === 1 && envText.split('[mcp_servers.dsh.env]').length - 1 === 1)

    // --client all drives every entry point in one pass.
    const allRoot = join(scratch, 'every-client')
    const all = await run(['--root', allRoot, '--project', allRoot, '--server', 'C:\\x\\server.mjs', '--client', 'all'])
    check(
      '--client all covers every client',
      all.code === 0 && ['cursor', 'vscode', 'kimi-code', 'zcode', 'codebuddy', 'minimax', 'qwen', 'qoder', 'codex', 'stepcode', 'claude-code'].every((name) => all.stdout.includes(name)),
      `${all.stdout.split('\n').length} lines`,
    )
    check(
      '--client all wrote the file-backed clients and printed a command for the CLI-managed one',
      existsSync(join(allRoot, '.cursor', 'mcp.json')) && existsSync(join(allRoot, '.zcode', 'cli', 'config.json')) && all.stdout.includes('claude mcp add'),
    )

    // Dry run must not touch the filesystem
    const dryPath = join(scratch, '.dryrun', 'mcp.json')
    const dry = await run(['--root', join(scratch, '.dryrun'), '--project', scratch, '--server', 'C:\\x\\server.mjs', '--client', 'cursor', '--dry-run'])
    check('--dry-run prints the planned config', dry.code === 0 && dry.stdout.includes('mcpServers'), dry.stdout.split('\n')[0])
    check('--dry-run writes nothing', !existsSync(dryPath), dryPath)

    // CLI-managed client: command only, never a file
    const claude = await run(args(['--client', 'claude-code']))
    check('claude-code: prints the register command instead of writing', claude.code === 0 && claude.stdout.includes('claude mcp add'), claude.stdout.trim())
    check('claude-code: creates no file', !existsSync(join(scratch, '.claude.json')))

    // Unknown client
    const unknown = await run(args(['--client', 'nope']))
    check('an unknown client exits 1 with the valid names', unknown.code === 1 && unknown.stderr.includes('未知客户端'), unknown.stderr.trim())
  } catch (error) {
    check('register selftest completed', false, String(error))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
