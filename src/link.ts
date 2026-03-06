import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync } from 'child_process'

const isWindows = process.platform === 'win32'
const devNull = isWindows ? '2>NUL' : '2>/dev/null'
const whichCmd = isWindows ? 'where' : 'which'

interface LinkOptions {
  name?: string        // Override agent name (default: derived from manifest or dir name)
  provider?: string    // Auth provider
  apiKey?: string      // Auth API key
  model?: string       // Model override
  skipPostInstall?: boolean
  skipHealthCheck?: boolean
}

/**
 * Read manifest.json from a workspace directory
 */
export function readManifest(workspaceDir: string): { name?: string; slug?: string; version?: string } | null {
  const manifestPath = path.join(workspaceDir, 'manifest.json')
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Run post-install scripts if present
 */
export function runPostInstall(workspaceDir: string, agentName: string, owner?: string, slug?: string): void {
  const postInstallScript = path.join(workspaceDir, 'scripts', 'post-install.sh')
  const postInstallScriptWin = path.join(workspaceDir, 'scripts', 'post-install.bat')

  let scriptCmd: string | null = null

  if (isWindows && fs.existsSync(postInstallScriptWin)) {
    scriptCmd = `"${postInstallScriptWin}"`
  } else if (fs.existsSync(postInstallScript)) {
    if (isWindows) {
      const shPath = postInstallScript.replace(/\\/g, '/')
      scriptCmd = `bash "${shPath}"`
    } else {
      scriptCmd = `bash "${postInstallScript}"`
    }
  }

  if (scriptCmd) {
    console.log(`📦 Running post-install script...`)
    try {
      execSync(scriptCmd, {
        stdio: 'inherit',
        cwd: workspaceDir,
        env: {
          ...process.env,
          CLAWPACK_WORKSPACE: workspaceDir,
          CLAWPACK_AGENT: agentName,
          CLAWPACK_OWNER: owner || '',
          CLAWPACK_SLUG: slug || '',
        },
        shell: isWindows ? 'cmd.exe' : undefined,
      })
      console.log(`   ✅ Post-install complete`)
    } catch (err: any) {
      console.warn(`   ⚠️  Post-install script failed: ${err.message}`)
      console.warn(`   Continuing anyway...`)
    }
  }
}

/**
 * Resolve auth credentials with fallback chain:
 * 1. Explicit provider/apiKey
 * 2. ClawPack config (clawpack credentials set)
 * 3. CLAWPACK_API_KEY env var
 * 4. Copy from main agent
 */
export function resolveAuth(provider?: string, apiKey?: string): { provider?: string; apiKey?: string; fromMain?: boolean } {
  if (provider && apiKey) return { provider, apiKey }

  // Check clawpack config
  const configDir = path.join(os.homedir(), '.clawpack')
  const configFile = path.join(configDir, 'config.json')
  try {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'))
    if (config.runtime?.provider && config.runtime?.apiKey) {
      return { provider: config.runtime.provider, apiKey: config.runtime.apiKey }
    }
  } catch {}

  // Check env
  const envKey = process.env.CLAWPACK_API_KEY
  if (envKey) return { provider: provider || 'openrouter', apiKey: envKey }

  // Fallback to main agent
  return { fromMain: true }
}

/**
 * Set up auth files for an agent
 */
export function setupAuth(agentName: string, opts: { provider?: string; apiKey?: string; fromMain?: boolean }): void {
  const agentDir = path.join(os.homedir(), '.openclaw', 'agents', agentName, 'agent')
  fs.mkdirSync(agentDir, { recursive: true })

  if (opts.fromMain) {
    // Copy from main agent
    const mainDir = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'agent')
    for (const file of ['auth-profiles.json', 'models.json']) {
      const src = path.join(mainDir, file)
      const dst = path.join(agentDir, file)
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst)
      }
    }
    console.log(`   🔑 Auth copied from main agent`)
  } else if (opts.provider && opts.apiKey) {
    // Write auth-profiles.json
    const profileKey = `${opts.provider}:default`
    const authProfiles = {
      version: 1,
      profiles: {
        [profileKey]: {
          type: 'token',
          provider: opts.provider,
          token: opts.apiKey,
        },
      },
      lastGood: {
        [opts.provider]: profileKey,
      },
    }
    fs.writeFileSync(path.join(agentDir, 'auth-profiles.json'), JSON.stringify(authProfiles, null, 2))

    // Write models.json
    const baseUrl = opts.provider === 'openrouter' ? 'https://openrouter.ai/api/v1'
      : opts.provider === 'anthropic' ? 'https://api.anthropic.com'
      : opts.provider === 'openai' ? 'https://api.openai.com/v1'
      : undefined

    if (baseUrl) {
      const models = { providers: { [opts.provider]: { baseUrl, models: [] } } }
      fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(models, null, 2))
    }

    console.log(`   🔑 Auth configured for ${opts.provider}`)
  }
}

/**
 * Link an agent workspace to OpenClaw — makes it fully functional
 */
export function linkAgent(workspaceDir: string, opts: LinkOptions = {}): string {
  const absDir = path.resolve(workspaceDir)

  if (!fs.existsSync(absDir)) {
    console.error(`❌ Directory not found: ${absDir}`)
    process.exit(1)
  }

  // Determine agent name
  const manifest = readManifest(absDir)
  const dirName = path.basename(absDir)
  const agentName = opts.name || manifest?.name || manifest?.slug || dirName

  console.log(`🔗 Linking "${agentName}" from ${absDir}...`)

  // 1. Post-install
  if (!opts.skipPostInstall) {
    runPostInstall(absDir, agentName)
  }

  // 2. Register with OpenClaw
  let alreadyRegistered = false
  try {
    const list = execSync(`openclaw agents list --json ${devNull}`, { encoding: 'utf-8', shell: isWindows ? 'cmd.exe' : undefined })
    const agents = JSON.parse(list)
    alreadyRegistered = agents.some((a: any) => a.name === agentName || a.id === agentName)
  } catch {}

  const resolvedModel = opts.model || (opts.provider ? `${opts.provider}/claude-sonnet-4` : undefined)
  const modelFlag = resolvedModel ? ` --model ${resolvedModel}` : ''

  if (alreadyRegistered) {
    console.log(`   Agent "${agentName}" already registered, skipping add.`)
  } else {
    try {
      execSync(
        `openclaw agents add ${agentName} --workspace "${absDir}"${modelFlag} --non-interactive`,
        { stdio: 'inherit', shell: isWindows ? 'cmd.exe' : undefined }
      )
      console.log(`   ✅ Registered in OpenClaw`)
    } catch (err: any) {
      if (err.message?.includes('already exists') || err.stdout?.includes('already exists') || err.stderr?.includes('already exists')) {
        console.log(`   Agent "${agentName}" already registered.`)
      } else {
        console.error(`❌ Failed to register agent: ${err.message}`)
        process.exit(1)
      }
    }
  }

  // 3. Set up auth
  const auth = resolveAuth(opts.provider, opts.apiKey)
  setupAuth(agentName, auth)

  // 4. Write model config
  if (resolvedModel) {
    const agentDir = path.join(os.homedir(), '.openclaw', 'agents', agentName, 'agent')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'openclaw.agent.json'), JSON.stringify({
      model: { primary: resolvedModel }
    }, null, 2))
  }

  // 5. Health check
  if (!opts.skipHealthCheck) {
    console.log(`   🏥 Running health check...`)
    try {
      const result = execSync(
        `openclaw agent --agent ${agentName} -m "Respond with only: OK" --json --timeout 30 ${devNull}`,
        { encoding: 'utf-8', timeout: 35000, shell: isWindows ? 'cmd.exe' : undefined }
      )
      const parsed = JSON.parse(result)
      const text = parsed.payloads?.[0]?.text || ''
      if (text.length > 0) {
        console.log(`   ✅ Agent responding`)
      }
    } catch {
      console.warn(`   ⚠️  Health check failed (agent may still work)`)
    }
  }

  console.log(`\n🦀 "${agentName}" is linked and ready!`)
  console.log(`   Chat: openclaw agent --agent ${agentName} -m "hello"`)
  console.log(`   Or:   clawpack chat ${agentName}`)

  return agentName
}

/**
 * Unlink an agent from OpenClaw
 */
export function unlinkAgent(agentName: string): void {
  console.log(`🔓 Unlinking "${agentName}"...`)

  // 1. Remove from OpenClaw
  try {
    execSync(
      `openclaw agents remove ${agentName} --non-interactive`,
      { stdio: 'inherit', shell: isWindows ? 'cmd.exe' : undefined }
    )
    console.log(`   ✅ Removed from OpenClaw`)
  } catch (err: any) {
    console.warn(`   ⚠️  Could not remove from OpenClaw: ${err.message}`)
  }

  // 2. Clean up auth files (but NOT the workspace)
  const agentDir = path.join(os.homedir(), '.openclaw', 'agents', agentName)
  const agentAuthDir = path.join(agentDir, 'agent')

  for (const file of ['auth-profiles.json', 'models.json', 'openclaw.agent.json']) {
    const fp = path.join(agentAuthDir, file)
    try { fs.unlinkSync(fp) } catch {}
  }

  // Remove sessions dir
  const sessionsDir = path.join(agentDir, 'sessions')
  try { fs.rmSync(sessionsDir, { recursive: true }) } catch {}

  console.log(`\n✅ "${agentName}" unlinked.`)
  console.log(`   Workspace files were NOT deleted.`)
}
