import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import { execSync, spawnSync } from 'child_process'

const BUNDLES_DIR = path.join(os.homedir(), '.clawpack', 'bundles')
const CONFIG_FILE = path.join(os.homedir(), '.clawpack', 'config.json')

interface BundleManifest {
  name: string
  version: string
  description?: string
  author?: string
  tags?: string[]
}

// ── Helpers ────────────────────────────────────────────────

async function loadESM() {
  const chalk = (await import('chalk')).default
  const boxen = (await import('boxen')).default
  const ora = (await import('ora')).default
  const gradient = (await import('gradient-string')).default
  const figlet = (await import('figlet')).default
  return { chalk, boxen, ora, gradient, figlet }
}

function findBundle(ownerSlug: string): { dir: string; manifest: BundleManifest } | null {
  const match = ownerSlug.match(/^([^/]+)\/(.+)$/)
  if (!match) return null
  const [, owner, slug] = match
  const dir = path.join(BUNDLES_DIR, owner, slug)
  const manifestPath = path.join(dir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) return null
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  return { dir, manifest }
}

function isOpenclawInstalled(): boolean {
  try {
    execSync('openclaw --version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

/** Run `openclaw <args>` synchronously via shell — works cross-platform with .cmd shims */
function oc(...args: string[]): string {
  const result = spawnSync('openclaw', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
    shell: true,
  })
  if (result.error) throw result.error
  return (result.stdout || '').trim()
}

function getAgentCount(): number {
  try {
    const result = oc('config', 'get', 'agents.list')
    const parsed = JSON.parse(result)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

function registerAgent(agentId: string, workspace: string, index: number): void {
  oc('config', 'set', `agents.list[${index}].id`, agentId)
  oc('config', 'set', `agents.list[${index}].name`, agentId)
  oc('config', 'set', `agents.list[${index}].workspace`, workspace)

  // Set up auth-profiles.json for the new agent
  const homeDir = os.homedir()
  const agentAuth = path.join(homeDir, '.openclaw', 'agents', agentId, 'agent', 'auth-profiles.json')
  fs.mkdirSync(path.dirname(agentAuth), { recursive: true })

  // Prefer ClawPack credentials (from `clawpack credentials set`)
  let wrote = false
  let configuredProvider = ''
  let configuredModel = ''
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
    const provider = config.runtime?.provider
    const apiKey = config.runtime?.apiKey || process.env.CLAWPACK_API_KEY
    configuredModel = config.runtime?.model || ''
    if (provider && apiKey) {
      configuredProvider = provider
      const profileKey = `${provider}:default`
      const authProfiles = {
        version: 1,
        profiles: {
          [profileKey]: { type: 'token', provider, token: apiKey },
        },
        lastGood: { [provider]: profileKey },
      }
      fs.writeFileSync(agentAuth, JSON.stringify(authProfiles, null, 2))

      // Write models.json so openclaw discovers the provider
      const modelsPath = path.join(path.dirname(agentAuth), 'models.json')
      const modelsJson: any = { providers: { [provider]: { models: [] } } }
      if (provider === 'github-copilot') {
        modelsJson.providers[provider].baseUrl = 'https://api.business.githubcopilot.com'
      }
      fs.writeFileSync(modelsPath, JSON.stringify(modelsJson, null, 2))

      wrote = true
    }
  } catch {}

  // Fallback: inherit from main agent
  if (!wrote) {
    const mainAuth = path.join(homeDir, '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json')
    const mainModels = path.join(homeDir, '.openclaw', 'agents', 'main', 'agent', 'models.json')
    if (fs.existsSync(mainAuth) && !fs.existsSync(agentAuth)) {
      fs.copyFileSync(mainAuth, agentAuth)
    }
    if (fs.existsSync(mainModels)) {
      fs.copyFileSync(mainModels, path.join(path.dirname(agentAuth), 'models.json'))
    }
  }

  // Set model on the agent config if we know it
  if (configuredModel) {
    try { oc('config', 'set', `agents.list[${index}].model.primary`, configuredModel) } catch {}
  }
}

function unregisterAgent(index: number): void {
  try { oc('config', 'unset', `agents.list[${index}]`) } catch {}
}

function checkAgentExists(agentId: string): { exists: boolean; index: number } {
  try {
    const result = oc('config', 'get', 'agents.list')
    const parsed = JSON.parse(result)
    if (Array.isArray(parsed)) {
      const idx = parsed.findIndex((a: any) => a.id === agentId)
      if (idx >= 0) return { exists: true, index: idx }
    }
  } catch {}
  return { exists: false, index: -1 }
}

function parseResponse(stdout: string): string {
  let text = stdout.trim()
  try {
    const parsed = JSON.parse(text)
    const data = parsed.result || parsed
    if (data.payloads?.length) {
      text = data.payloads.map((p: any) => p.text).filter(Boolean).join('\n')
    } else {
      text = data.reply || data.message || data.text || data.content || text
    }
  } catch {
    // Not JSON — use raw but strip common stderr noise
    text = text.split('\n').filter(l => !l.includes('[agents/auth-profiles]')).join('\n').trim()
  }
  return text
}

// ── Main Chat Function ─────────────────────────────────────

export async function startChat(ownerSlug: string, opts: { model?: string }) {
  const { chalk, boxen, ora, gradient, figlet } = await loadESM()

  // 1. Validate bundle exists
  const bundle = findBundle(ownerSlug)
  if (!bundle) {
    console.error(chalk.red(`\n  ❌ Bundle not found: ${ownerSlug}`))
    console.error(chalk.dim(`     Pull it first: `) + chalk.cyan(`clawpack pull ${ownerSlug}`))
    console.error(chalk.dim(`     Bundles dir: ${BUNDLES_DIR}\n`))
    process.exit(1)
  }

  // 2. Check openclaw is installed
  if (!isOpenclawInstalled()) {
    console.error(chalk.red(`\n  ❌ openclaw is not installed`))
    console.error(chalk.dim(`     Install it:`))
    console.error(chalk.cyan(`       npm install -g openclaw`))
    console.error(chalk.dim(`     Or visit: https://openclaw.dev\n`))
    process.exit(1)
  }

  const { manifest, dir } = bundle
  const agentId = `clawpack-${ownerSlug.replace('/', '-')}`

  // 3. Register agent with openclaw pointing at bundle workspace
  let agentIndex: number
  const existing = checkAgentExists(agentId)
  if (existing.exists) {
    agentIndex = existing.index
    oc('config', 'set', `agents.list[${agentIndex}].workspace`, dir)
  } else {
    agentIndex = getAgentCount()
    registerAgent(agentId, dir, agentIndex)
  }

  // Cleanup on exit
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (!existing.exists) {
      unregisterAgent(agentIndex)
    }
  }
  process.on('exit', cleanup)
  process.on('SIGTERM', () => { cleanup(); process.exit(0) })

  // Double SIGINT to exit
  let sigintCount = 0
  let sigintTimer: ReturnType<typeof setTimeout> | null = null
  process.on('SIGINT', () => {
    sigintCount++
    if (sigintCount >= 2) {
      cleanup()
      process.exit(0)
    }
    console.log('\n  Press Ctrl+C again to exit.')
    if (sigintTimer) clearTimeout(sigintTimer)
    sigintTimer = setTimeout(() => { sigintCount = 0 }, 2000)
  })

  // 4. Show startup UI
  console.clear()

  const figletText = figlet.textSync('ClawPack', { font: 'Small' })
  const orangeGradient = gradient(['#FF6B35', '#FF4500', '#FF8C00'])
  console.log(orangeGradient(figletText))

  const showInfoPanel = () => {
    const info = [
      `${chalk.bold('Agent:')}   ${chalk.white(manifest.name)}`,
      `${chalk.bold('Version:')} ${chalk.dim(manifest.version)}`,
      `${chalk.bold('Owner:')}   ${chalk.dim(ownerSlug.split('/')[0])}`,
      manifest.description ? `${chalk.bold('About:')}   ${chalk.italic(manifest.description)}` : '',
    ].filter(Boolean).join('\n')

    console.log(boxen(info, {
      padding: 1,
      margin: { top: 0, bottom: 1, left: 1, right: 1 },
      borderStyle: 'round',
      borderColor: '#FF6B35',
      title: '🦀 Agent Info',
      titleAlignment: 'left',
    }))
  }
  showInfoPanel()

  console.log(chalk.dim('  Commands: /exit /quit /clear /info'))
  console.log(chalk.dim('  ─────────────────────────────────\n'))

  // 5. Set up readline
  let rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.hex('#FF6B35')('🦀 > '),
  })

  // Prevent SIGINT from closing readline — we handle it ourselves
  rl.on('SIGINT', () => {
    // Absorb — let the process-level SIGINT handler deal with it
    rl.write('\n')
    rl.prompt()
  })

  const sessionId = `clawpack-${Date.now()}`

  // 6. Send message via openclaw agent with --agent flag
  const sendMessage = (message: string): string => {
    const args = ['agent', '--local', '--agent', agentId, '--session-id', sessionId, '-m', message, '--json']
    if (opts.model) args.push('--model', opts.model)

    // Use spawnSync with stdio: ['ignore', 'pipe', 'pipe'] so the child process
    // never touches the parent's stdin stream. On Windows, execSync with 'pipe'
    // still interferes with the parent stdin, causing readline to emit 'close'
    // and exit the chat after the first message.
    const result = spawnSync('openclaw', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
      shell: true,
    })

    if (result.error) {
      throw new Error(result.error.message)
    }

    const stdout = result.stdout || ''
    const stderr = result.stderr || ''

    if (result.status !== 0 && !stdout.trim()) {
      throw new Error(stderr.trim() || `openclaw exited with code ${result.status}`)
    }

    return parseResponse(stdout.trim() || stderr.trim())
  }

  // 7. Format agent response with left border
  const formatResponse = (text: string) => {
    const lines = text.split('\n')
    const formatted = lines.map(line =>
      chalk.hex('#FF8C00')('  │ ') + chalk.white(line)
    ).join('\n')
    return '\n' + formatted + '\n'
  }

  // 8. Interactive loop
  rl.prompt()

  const lineHandler = async (line: string) => {
    const input = line.trim()

    if (!input) {
      rl.prompt()
      return
    }

    if (input === '/exit' || input === '/quit') {
      console.log(chalk.hex('#FF6B35')('\n  👋 See you later! 🦀\n'))
      rl.close()
      process.exit(0)
    }

    if (input === '/clear') {
      console.clear()
      rl.prompt()
      return
    }

    if (input === '/info') {
      showInfoPanel()
      rl.prompt()
      return
    }

    const spinner = ora({
      text: chalk.dim('Thinking...'),
      color: 'yellow',
      spinner: 'dots',
    }).start()

    try {
      const response = sendMessage(input)
      spinner.stop()
      console.log(formatResponse(response))
    } catch (err: any) {
      spinner.stop()
      console.log(chalk.red(`\n  ⚠️  Error: ${err.message}\n`))
    }

    rl.prompt()
  }

  rl.on('line', lineHandler)

  const closeHandler = () => {
    // On Windows, readline can close unexpectedly (e.g. after child process).
    // Only recreate if stdin is still alive.
    if (process.stdin.destroyed || process.stdin.readableEnded) {
      cleanup()
      process.exit(0)
      return
    }
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.hex('#FF6B35')('🦀 > '),
    })
    rl.on('SIGINT', () => {
      rl.write('\n')
      rl.prompt()
    })
    rl.on('line', lineHandler)
    rl.on('close', closeHandler)
    rl.prompt()
  }

  rl.on('close', closeHandler)
}
