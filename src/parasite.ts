import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync } from 'child_process'
import { linkAgent } from './link.js'

const isWindows = process.platform === 'win32'
const CONFIG_DIR = path.join(os.homedir(), '.clawpack')
const STATE_FILE = path.join(CONFIG_DIR, '.parasite-state.json')
const devNull = isWindows ? '2>NUL' : '2>/dev/null'

interface ParasiteSession {
  parasiteAgentId: string
  hostAgentId: string
  swappedDefault?: boolean          // true if we made this parasite the default
  swappedBindingIndices?: number[]  // original indices of bindings we rerouted
  addedBindingMark?: boolean        // true if we added a catch-all binding
  originalDefaultAgent?: string     // who was default before
  startedAt: string
}

interface ParasiteStateFile {
  version: 2
  sessions: ParasiteSession[]
  /** Snapshot of bindings before first parasite. Used for --restore --all */
  originalBindings?: any[]
  originalDefaultAgent?: string
}

function getOpenClawConfigPath(): string {
  return path.join(os.homedir(), '.openclaw', 'openclaw.json')
}

function readOpenClawConfig(): any {
  try {
    return JSON.parse(fs.readFileSync(getOpenClawConfigPath(), 'utf-8'))
  } catch {
    console.error('❌ Could not read OpenClaw config')
    process.exit(1)
  }
}

function writeOpenClawConfig(config: any): void {
  fs.writeFileSync(getOpenClawConfigPath(), JSON.stringify(config, null, 2))
}

function restartGateway(): void {
  console.log('   🔄 Restarting gateway...')
  try {
    execSync('openclaw gateway restart', {
      stdio: 'pipe',
      timeout: 15000,
      shell: isWindows ? 'cmd.exe' : undefined,
    })
    console.log('   ✅ Gateway restarted')
  } catch {
    console.warn('   ⚠️  Could not restart gateway (may need manual restart)')
  }
}

function loadStateFile(): ParasiteStateFile {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
    // Migrate v1 → v2
    if (!raw.version || raw.version === 1 || raw.parasiteAgentId) {
      return {
        version: 2,
        sessions: [raw as ParasiteSession],
        originalBindings: raw.originalConfig?.bindings,
        originalDefaultAgent: raw.originalConfig?.defaultAgent,
      }
    }
    return raw
  } catch {
    return { version: 2, sessions: [] }
  }
}

function saveStateFile(state: ParasiteStateFile): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function clearStateFile(): void {
  try { fs.unlinkSync(STATE_FILE) } catch {}
}

/**
 * Apply parasite config swap — extracted for testability.
 * Mutates config in place, returns the session with swap metadata.
 */
export function applyParasiteConfig(
  config: any,
  parasiteAgentId: string,
  hostAgentId: string,
): Pick<ParasiteSession, 'swappedDefault' | 'addedBindingMark' | 'originalDefaultAgent'> {
  const agentsList = config.agents?.list || []
  const parasiteAgent = agentsList.find((a: any) => a.id === parasiteAgentId)
  const currentDefault = agentsList.find((a: any) => a.default || a.isDefault)
  const result: Pick<ParasiteSession, 'swappedDefault' | 'addedBindingMark' | 'originalDefaultAgent'> = {
    originalDefaultAgent: currentDefault?.id,
  }

  // Reroute bindings
  if (config.bindings && config.bindings.length > 0) {
    for (const binding of config.bindings) {
      if (binding.agentId === hostAgentId) {
        binding._parasiteOriginal = hostAgentId
        binding.agentId = parasiteAgentId
      }
    }
  }

  // Default swap or catch-all
  if (!currentDefault || currentDefault.id === hostAgentId) {
    for (const agent of agentsList) delete agent.default
    if (parasiteAgent) parasiteAgent.default = true
    result.swappedDefault = true
  } else {
    if (!config.bindings) config.bindings = []
    config.bindings.unshift({
      agentId: parasiteAgentId,
      match: { channel: '*' },
      _parasite: true,
    })
    result.addedBindingMark = true
  }

  return result
}

/**
 * Undo parasite config swap for a single session — extracted for testability.
 * Mutates config in place.
 */
export function unapplyParasiteConfig(config: any, session: ParasiteSession): void {
  const agentsList = config.agents?.list || []

  if (session.swappedDefault && session.originalDefaultAgent) {
    const parasite = agentsList.find((a: any) => a.id === session.parasiteAgentId)
    if (parasite) delete parasite.default
    const original = agentsList.find((a: any) => a.id === session.originalDefaultAgent)
    if (original) original.default = true
  }

  if (session.addedBindingMark && config.bindings) {
    config.bindings = config.bindings.filter(
      (b: any) => !(b._parasite && b.agentId === session.parasiteAgentId)
    )
  }

  if (config.bindings) {
    for (const binding of config.bindings) {
      if (binding.agentId === session.parasiteAgentId && binding._parasiteOriginal === session.hostAgentId) {
        binding.agentId = session.hostAgentId
        delete binding._parasiteOriginal
      }
    }
  }
}

function restoreOne(session: ParasiteSession): void {
  console.log(`🔓 Restoring "${session.hostAgentId}" (removing parasite "${session.parasiteAgentId}")...`)

  const config = readOpenClawConfig()
  unapplyParasiteConfig(config, session)
  writeOpenClawConfig(config)
  console.log(`   ✅ "${session.hostAgentId}" restored`)
}

function restoreAll(): void {
  const stateFile = loadStateFile()
  if (stateFile.sessions.length === 0) {
    console.log('No active parasite sessions.')
    return
  }

  // If we have the original snapshot, just slam it back
  if (stateFile.originalBindings !== undefined || stateFile.originalDefaultAgent) {
    console.log(`🔓 Restoring all (${stateFile.sessions.length} parasites)...`)

    const config = readOpenClawConfig()
    const agentsList = config.agents?.list || []

    // Restore default
    if (stateFile.originalDefaultAgent) {
      for (const a of agentsList) delete a.default
      const orig = agentsList.find((a: any) => a.id === stateFile.originalDefaultAgent)
      if (orig) orig.default = true
    }

    // Restore bindings
    if (stateFile.originalBindings !== undefined) {
      config.bindings = stateFile.originalBindings
    } else {
      // Remove all parasite markers
      if (config.bindings) {
        config.bindings = config.bindings.filter((b: any) => !b._parasite)
        for (const b of config.bindings) {
          if (b._parasiteOriginal) {
            b.agentId = b._parasiteOriginal
            delete b._parasiteOriginal
          }
        }
      }
    }

    writeOpenClawConfig(config)
    clearStateFile()
    restartGateway()

    for (const s of stateFile.sessions) {
      console.log(`   ✅ "${s.parasiteAgentId}" → "${s.hostAgentId}" restored`)
    }
    console.log(`\n✅ All parasites removed.`)
    return
  }

  // Fallback: restore one by one
  for (const session of [...stateFile.sessions].reverse()) {
    restoreOne(session)
  }
  clearStateFile()
  restartGateway()
  console.log(`\n✅ All ${stateFile.sessions.length} parasites removed.`)
}

export interface ParasiteOptions {
  bundle: string
  host: string
  provider?: string
  apiKey?: string
  model?: string
  noPull?: boolean
}

export async function startParasite(opts: ParasiteOptions): Promise<void> {
  const stateFile = loadStateFile()

  // Check if this host already has a parasite
  const existingOnHost = stateFile.sessions.find(s => s.hostAgentId === opts.host)
  if (existingOnHost) {
    console.log(`⚠️  "${opts.host}" already has parasite "${existingOnHost.parasiteAgentId}" (since ${existingOnHost.startedAt})`)
    console.log(`   Restore it first: clawpack parasite --restore ${existingOnHost.parasiteAgentId}`)
    process.exit(1)
  }

  // Parse bundle
  const match = opts.bundle.match(/^([^/]+)\/([^@]+)(?:@(.+))?$/)
  if (!match) {
    console.error('❌ Invalid bundle format. Use: owner/slug[@version]')
    process.exit(1)
  }
  const [, owner, slug] = match
  const parasiteAgentId = `${owner}-${slug}`

  // Check if same parasite already active
  if (stateFile.sessions.find(s => s.parasiteAgentId === parasiteAgentId)) {
    console.log(`⚠️  "${parasiteAgentId}" is already an active parasite.`)
    console.log(`   Restore it first: clawpack parasite --restore ${parasiteAgentId}`)
    process.exit(1)
  }

  console.log(`🦠 Parasiting ${opts.bundle} onto "${opts.host}"...\n`)

  // Pull + link if needed
  if (!opts.noPull) {
    let alreadyLinked = false
    try {
      const list = execSync(`openclaw agents list --json ${devNull}`, { encoding: 'utf-8', shell: isWindows ? 'cmd.exe' : undefined })
      const agents = JSON.parse(list)
      alreadyLinked = agents.some((a: any) => a.id === parasiteAgentId)
    } catch {}

    if (!alreadyLinked) {
      const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
      let registry = 'https://clawpack.io'
      let apiKey: string | undefined
      try {
        const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
        if (config.registry) registry = config.registry
        if (config.apiKey) apiKey = config.apiKey
      } catch {}
      apiKey = apiKey || process.env.CLAWPACK_API_KEY

      const ver = match[3] || 'latest'
      console.log(`📥 Pulling ${owner}/${slug}@${ver}...`)

      const headers: Record<string, string> = {}
      if (apiKey) headers['x-api-key'] = apiKey

      const res = await fetch(`${registry}/api/v1/bundles/${owner}/${slug}/${ver}/download`, { headers })
      if (!res.ok) throw new Error(`Pull failed: ${res.status}`)

      const { url, version } = await res.json() as { url: string; version: string }
      console.log(`   Version: ${version}`)

      const tarballRes = await fetch(url)
      if (!tarballRes.ok) throw new Error(`Download failed: ${tarballRes.statusText}`)

      const tarball = Buffer.from(await tarballRes.arrayBuffer())
      const workspaceDir = path.join(CONFIG_DIR, 'agents', owner, slug, 'workspace')
      fs.mkdirSync(workspaceDir, { recursive: true })

      const tmpFile = path.join(os.tmpdir(), `clawpack-parasite-${Date.now()}.tar.gz`)
      fs.writeFileSync(tmpFile, tarball)

      const tar = await import('tar')
      await tar.extract({ file: tmpFile, cwd: workspaceDir, strip: 1 })
      try { fs.unlinkSync(tmpFile) } catch {}

      console.log(`   Extracted to ${workspaceDir}\n`)

      linkAgent(workspaceDir, {
        name: parasiteAgentId,
        provider: opts.provider,
        apiKey: opts.apiKey,
        model: opts.model,
        skipHealthCheck: true,
      })
      console.log()
    } else {
      console.log(`   Agent "${parasiteAgentId}" already linked, reusing.\n`)
    }
  }

  // Read config and build session state
  const config = readOpenClawConfig()
  const agentsList = config.agents?.list || []

  const hostAgent = agentsList.find((a: any) => a.id === opts.host)
  if (!hostAgent) {
    console.error(`❌ Host agent "${opts.host}" not found in OpenClaw config`)
    console.error(`   Available: ${agentsList.map((a: any) => a.id).join(', ')}`)
    process.exit(1)
  }

  const parasiteAgent = agentsList.find((a: any) => a.id === parasiteAgentId)
  if (!parasiteAgent) {
    console.error(`❌ Parasite agent "${parasiteAgentId}" not found in OpenClaw config`)
    process.exit(1)
  }

  const currentDefault = agentsList.find((a: any) => a.default || a.isDefault)

  // Save original snapshot on first parasite only
  const isFirstParasite = stateFile.sessions.length === 0
  if (isFirstParasite) {
    stateFile.originalBindings = config.bindings ? JSON.parse(JSON.stringify(config.bindings)) : undefined
    stateFile.originalDefaultAgent = currentDefault?.id
  }

  // Swap routing
  console.log(`🔀 Swapping routes from "${opts.host}" → "${parasiteAgentId}"...`)

  const swapResult = applyParasiteConfig(config, parasiteAgentId, opts.host)

  const session: ParasiteSession = {
    parasiteAgentId,
    hostAgentId: opts.host,
    originalDefaultAgent: swapResult.originalDefaultAgent,
    startedAt: new Date().toISOString(),
    swappedDefault: swapResult.swappedDefault,
    addedBindingMark: swapResult.addedBindingMark,
  }

  stateFile.sessions.push(session)
  saveStateFile(stateFile)
  writeOpenClawConfig(config)
  restartGateway()

  console.log()
  console.log(`🦠 PARASITE ACTIVE`)
  console.log(`   Host:     ${opts.host}`)
  console.log(`   Parasite: ${parasiteAgentId}`)
  console.log(`   Active parasites: ${stateFile.sessions.length}`)
  console.log()
  console.log(`   Press Ctrl+C to restore "${opts.host}"`)
  console.log(`   Or from another terminal:`)
  console.log(`     clawpack parasite --restore ${parasiteAgentId}`)
  console.log(`     clawpack parasite --restore --all`)
  console.log(`     clawpack parasite --list`)
  console.log()

  // Wait for SIGINT/SIGTERM, restore just this session
  const cleanup = () => {
    restoreSpecific(parasiteAgentId)
    process.exit(0)
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  await new Promise(() => {})
}

function restoreSpecific(parasiteAgentId: string): void {
  const stateFile = loadStateFile()
  const idx = stateFile.sessions.findIndex(s => s.parasiteAgentId === parasiteAgentId)

  if (idx === -1) {
    console.log(`No active parasite "${parasiteAgentId}" found.`)
    return
  }

  const session = stateFile.sessions[idx]
  restoreOne(session)

  stateFile.sessions.splice(idx, 1)

  if (stateFile.sessions.length === 0) {
    clearStateFile()
  } else {
    saveStateFile(stateFile)
  }

  restartGateway()
  console.log(`\n✅ "${parasiteAgentId}" removed. ${stateFile.sessions.length} parasite(s) remaining.`)
}

export async function restoreParasite(target?: string, all?: boolean): Promise<void> {
  if (all) {
    restoreAll()
    return
  }

  if (target) {
    restoreSpecific(target)
    return
  }

  // No target — restore all if only one, otherwise prompt
  const stateFile = loadStateFile()
  if (stateFile.sessions.length === 0) {
    console.log('No active parasite sessions.')
    return
  }

  if (stateFile.sessions.length === 1) {
    restoreSpecific(stateFile.sessions[0].parasiteAgentId)
    return
  }

  console.log(`Multiple active parasites. Specify which to restore:\n`)
  for (const s of stateFile.sessions) {
    console.log(`  🦠 ${s.parasiteAgentId} → ${s.hostAgentId} (since ${s.startedAt})`)
  }
  console.log()
  console.log(`  clawpack parasite --restore <name>`)
  console.log(`  clawpack parasite --restore --all`)
}

export function listParasites(): void {
  const stateFile = loadStateFile()

  if (stateFile.sessions.length === 0) {
    console.log('No active parasite sessions.')
    return
  }

  console.log(`🦠 Active parasites (${stateFile.sessions.length}):\n`)
  for (const s of stateFile.sessions) {
    const duration = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 60000)
    console.log(`  ${s.parasiteAgentId} → ${s.hostAgentId}`)
    console.log(`    Started: ${s.startedAt} (${duration}m ago)`)
    if (s.swappedDefault) console.log(`    Mode: default agent swap`)
    if (s.addedBindingMark) console.log(`    Mode: catch-all binding`)
    console.log()
  }
}
