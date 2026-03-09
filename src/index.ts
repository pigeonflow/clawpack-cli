#!/usr/bin/env node
import { Command } from 'commander'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as tar from 'tar'
import { createWriteStream, createReadStream } from 'fs'
import { pipeline } from 'stream/promises'
import { createGzip, createGunzip } from 'zlib'
import { createRequire } from 'module'
import { execSync, spawnSync } from 'child_process'
import chalk from 'chalk'
import { OC_BIN, oc, ocInherit } from './oc.js'

const require = createRequire(import.meta.url)
const PKG_VERSION: string = require('../package.json').version

const CONFIG_DIR = path.join(os.homedir(), '.clawpack')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const DEFAULT_REGISTRY = 'https://clawpack.io'

interface RuntimeConfig {
  provider?: string
  apiKey?: string
  model?: string
  runtime?: string // e.g. "openclaw@latest", "nullclaw@0.2.0"
}

interface Config {
  apiKey?: string
  registry?: string
  runtime?: RuntimeConfig
}

function loadConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function saveConfig(config: Config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

function getRegistry(): string {
  return process.env.CLAWPACK_REGISTRY || loadConfig().registry || DEFAULT_REGISTRY
}

function getApiKey(): string | undefined {
  return process.env.CLAWPACK_API_KEY || loadConfig().apiKey
}

async function apiRequest(method: string, endpoint: string, body?: any, isForm?: boolean): Promise<any> {
  const registry = getRegistry()
  const apiKey = getApiKey()
  const headers: Record<string, string> = {}

  if (apiKey) headers['x-api-key'] = apiKey
  if (!isForm && body) headers['content-type'] = 'application/json'

  const res = await fetch(`${registry}/api${endpoint}`, {
    method,
    headers,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }

  return res.json()
}

const program = new Command()

program
  .name('clawpack')
  .description('ClawPack — the agent registry')
  .version(PKG_VERSION, '-V, --version')

// LOGIN
program
  .command('login')
  .description('Authenticate with ClawPack')
  .option('--api-key <key>', 'API key')
  .option('--registry <url>', 'Registry URL')
  .action(async (opts) => {
    const config = loadConfig()

    if (opts.apiKey) {
      config.apiKey = opts.apiKey
    } else {
      // Interactive prompt
      process.stdout.write('API Key: ')
      const key = await new Promise<string>((resolve) => {
        let data = ''
        process.stdin.setEncoding('utf-8')
        process.stdin.on('data', (chunk) => {
          data += chunk
          if (data.includes('\n')) {
            process.stdin.pause()
            resolve(data.trim())
          }
        })
        process.stdin.resume()
      })
      config.apiKey = key
    }

    if (opts.registry) config.registry = opts.registry

    saveConfig(config)
    console.log(`✅ Logged in to ${getRegistry()}`)
    console.log(`   Config saved to ${CONFIG_FILE}`)
  })

// WHOAMI
program
  .command('whoami')
  .description('Show current user')
  .action(async () => {
    try {
      const data = await apiRequest('GET', '/v1/auth/me')
      console.log(`Logged in as: ${data.email || data.name || 'unknown'}`)
    } catch (err: any) {
      console.error(`Not logged in or invalid key: ${err.message}`)
      process.exit(1)
    }
  })

// PUSH
program
  .command('push [path]')
  .description('Publish an agent bundle')
  .option('--public', 'Make bundle public (default)', true)
  .option('--private', 'Make bundle private')
  .option('--org <slug>', 'Publish under an organization')
  .option('--changelog <text>', 'Version changelog')
  .action(async (bundlePath: string | undefined, opts) => {
    const dir = path.resolve(bundlePath || '.')
    const manifestPath = path.join(dir, 'manifest.json')

    if (!fs.existsSync(manifestPath)) {
      console.error(`❌ No manifest.json found in ${dir}`)
      console.error('   Create one with: clawpack init')
      process.exit(1)
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    console.log(`📦 Pushing ${manifest.name}@${manifest.version}...`)

    // Create tarball
    const tmpFile = path.join(os.tmpdir(), `clawpack-${Date.now()}.tar.gz`)
    const excludePatterns = manifest.exclude || [
      'node_modules', '*.log', '.git', '.env', '.env.*', '__pycache__', '.DS_Store'
    ]

    await tar.create(
      {
        gzip: true,
        file: tmpFile,
        cwd: path.dirname(dir),
        filter: (p: string) => {
          return !excludePatterns.some((pattern: string) => {
            if (pattern.startsWith('*.')) {
              return p.endsWith(pattern.slice(1))
            }
            return p.includes(pattern)
          })
        },
      },
      [path.basename(dir)]
    )

    const tarball = fs.readFileSync(tmpFile)
    const sizeMb = (tarball.length / 1024 / 1024).toFixed(1)
    console.log(`   Bundle size: ${sizeMb} MB`)

    // Upload
    const formData = new FormData()
    formData.append('tarball', new Blob([tarball]), `${manifest.name}.tar.gz`)
    formData.append('is_public', opts.private ? 'false' : 'true')
    if (opts.changelog) formData.append('changelog', opts.changelog)
    if (opts.org) formData.append('org', opts.org)

    // Auto-detect and send README content
    const readmeCandidates = ['README.md', 'readme.md', 'SOUL.md']
    for (const candidate of readmeCandidates) {
      const readmePath = path.join(dir, candidate)
      if (fs.existsSync(readmePath)) {
        const content = fs.readFileSync(readmePath, 'utf-8')
        formData.append('readme', content)
        break
      }
    }

    try {
      const result = await apiRequest('POST', '/v1/bundles/publish', formData, true)
      console.log(`✅ Published ${result.owner}/${result.slug}@${result.version}`)
      console.log(`   Checksum: ${result.checksum?.slice(0, 12)}...`)
      console.log(`   Install:  clawpack pull ${result.owner}/${result.slug}`)
    } catch (err: any) {
      console.error(`❌ Push failed: ${err.message}`)
      process.exit(1)
    } finally {
      fs.unlinkSync(tmpFile)
    }
  })

// PULL
program
  .command('pull <bundle>')
  .description('Download an agent bundle (owner/slug[@version])')
  .option('--dir <path>', 'Extract to directory', '.')
  .option('--link', 'Register agent in OpenClaw after pulling')
  .option('--provider <name>', 'Provider for --link auth')
  .option('--api-key <key>', 'API key for --link auth')
  .option('--model <model>', 'Model for --link')
  .option('--name <name>', 'Agent name override for --link')
  .action(async (bundle: string, opts) => {
    const match = bundle.match(/^([^/]+)\/([^@]+)(?:@(.+))?$/)
    if (!match) {
      console.error('❌ Invalid bundle format. Use: owner/slug[@version]')
      process.exit(1)
    }

    const [, owner, slug, version] = match
    const ver = version || 'latest'

    console.log(`📥 Pulling ${owner}/${slug}@${ver}...`)

    try {
      const { url, version: resolvedVersion } = await apiRequest(
        'GET',
        `/v1/bundles/${owner}/${slug}/${ver}/download`
      )

      console.log(`   Version: ${resolvedVersion}`)

      // Download tarball
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Download failed: ${res.statusText}`)

      const tarball = Buffer.from(await res.arrayBuffer())
      const targetDir = path.resolve(opts.dir, slug)
      const bundlesCacheDir = path.join(os.homedir(), '.clawpack', 'bundles', owner, slug)

      // Extract to both target dir and bundles cache
      fs.mkdirSync(targetDir, { recursive: true })
      fs.mkdirSync(bundlesCacheDir, { recursive: true })
      const tmpFile = path.join(os.tmpdir(), `clawpack-pull-${Date.now()}.tar.gz`)
      fs.writeFileSync(tmpFile, tarball)

      await tar.extract({
        file: tmpFile,
        cwd: targetDir,
        strip: 1,
      })

      await tar.extract({
        file: tmpFile,
        cwd: bundlesCacheDir,
        strip: 1,
      })

      fs.unlinkSync(tmpFile)
      console.log(`✅ Extracted to ${targetDir}`)

      // Link if requested
      if (opts.link) {
        const { linkAgent } = await import('./link.js')
        linkAgent(targetDir, {
          name: opts.name,
          provider: opts.provider,
          apiKey: opts.apiKey,
          model: opts.model,
        })
      }
    } catch (err: any) {
      console.error(`❌ Pull failed: ${err.message}`)
      process.exit(1)
    }
  })

// SEARCH
program
  .command('search <query>')
  .description('Search for agent bundles')
  .option('--limit <n>', 'Max results', '10')
  .action(async (query: string, opts) => {
    try {
      const { bundles, total } = await apiRequest(
        'GET',
        `/v1/bundles?q=${encodeURIComponent(query)}&limit=${opts.limit}`
      )

      if (!bundles.length) {
        console.log('No bundles found.')
        return
      }

      console.log(`Found ${total} bundle(s):\n`)
      for (const b of bundles) {
        const stars = b.star_count ? `⭐${b.star_count}` : ''
        const downloads = b.download_count ? `📥${b.download_count}` : ''
        const tags = b.tags?.length ? b.tags.map((t: string) => `#${t}`).join(' ') : ''
        console.log(`  ${b.owner}/${b.slug} ${stars} ${downloads}`)
        if (b.description) console.log(`    ${b.description}`)
        if (tags) console.log(`    ${tags}`)
        console.log()
      }
    } catch (err: any) {
      console.error(`❌ Search failed: ${err.message}`)
      process.exit(1)
    }
  })

// LIST
program
  .command('list')
  .description('List your published bundles')
  .action(async () => {
    try {
      // This requires knowing the user's owner slug - use whoami first
      const me = await apiRequest('GET', '/v1/auth/me').catch(() => null)
      if (!me) {
        console.error('Not logged in. Run: clawpack login')
        process.exit(1)
      }

      const { bundles } = await apiRequest('GET', `/v1/bundles?owner=${encodeURIComponent(me.slug || me.name)}&limit=100`)
      if (!bundles?.length) {
        console.log('No bundles published yet. Push your first agent with: clawpack push')
        return
      }

      console.log('Your bundles:\n')
      for (const b of bundles) {
        const visibility = b.is_public ? '🌍' : '🔒'
        console.log(`  ${visibility} ${b.owner}/${b.slug} ⭐${b.star_count} 📥${b.download_count}`)
      }
    } catch (err: any) {
      console.error(`❌ ${err.message}`)
      process.exit(1)
    }
  })

// INIT
program
  .command('init')
  .description('Create a manifest.json for your agent')
  .action(async () => {
    const manifestPath = path.join(process.cwd(), 'manifest.json')
    if (fs.existsSync(manifestPath)) {
      console.log('manifest.json already exists.')
      return
    }

    const dirName = path.basename(process.cwd()).toLowerCase().replace(/[^a-z0-9-]/g, '-')
    const manifest = {
      name: dirName,
      version: '0.1.0',
      description: '',
      author: '',
      tags: [],
    }

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    console.log(`✅ Created manifest.json`)
    console.log(`   Edit it, then run: clawpack push`)
  })

// CREDENTIALS
const credentials = program
  .command('credentials')
  .description('Manage runtime credentials for clawpack run')

credentials
  .command('set')
  .description('Configure provider credentials for running agents')
  .option('--provider <name>', 'Provider name (e.g. github-copilot, openai, anthropic)')
  .option('--api-key <key>', 'Provider API key')
  .option('--model <model>', 'Default model (e.g. github-copilot/claude-sonnet-4)')
  .option('--runtime <runtime>', 'Runtime to use (e.g. openclaw@latest, nullclaw@latest)', 'openclaw@latest')
  .action(async (opts) => {
    const config = loadConfig()
    config.runtime = config.runtime || {}

    if (opts.provider) config.runtime.provider = opts.provider
    if (opts.apiKey) config.runtime.apiKey = opts.apiKey
    if (opts.model) config.runtime.model = opts.model
    if (opts.runtime) config.runtime.runtime = opts.runtime

    if (!opts.provider && !opts.apiKey && !opts.model) {
      // Interactive
      const ask = (prompt: string): Promise<string> => new Promise((resolve) => {
        process.stdout.write(prompt)
        let data = ''
        process.stdin.setEncoding('utf-8')
        process.stdin.on('data', (chunk) => {
          data += chunk
          if (data.includes('\n')) {
            process.stdin.pause()
            resolve(data.trim())
          }
        })
        process.stdin.resume()
      })

      config.runtime.provider = await ask(`Provider [${config.runtime.provider || 'github-copilot'}]: `) || config.runtime.provider || 'github-copilot'
      config.runtime.apiKey = await ask('API Key: ') || config.runtime.apiKey
      config.runtime.model = await ask(`Model [${config.runtime.model || config.runtime.provider + '/claude-sonnet-4'}]: `) || config.runtime.model
      config.runtime.runtime = await ask(`Runtime [${config.runtime.runtime || 'openclaw@latest'}]: `) || config.runtime.runtime || 'openclaw@latest'
    }

    saveConfig(config)
    console.log(`✅ Credentials saved`)
    console.log(`   Provider: ${config.runtime.provider}`)
    console.log(`   Model:    ${config.runtime.model || config.runtime.provider + '/claude-sonnet-4'}`)
    console.log(`   Runtime:  ${config.runtime.runtime || 'openclaw@latest'}`)
    console.log(`   Config:   ${CONFIG_FILE}`)
  })

credentials
  .command('show')
  .description('Show current runtime credentials')
  .action(() => {
    const config = loadConfig()
    if (!config.runtime?.provider) {
      console.log('No credentials configured. Run: clawpack credentials set')
      return
    }
    console.log(`Provider: ${config.runtime.provider}`)
    console.log(`API Key:  ${config.runtime.apiKey ? config.runtime.apiKey.slice(0, 8) + '...' : '(not set)'}`)
    console.log(`Model:    ${config.runtime.model || '(default)'}`)
    console.log(`Runtime:  ${config.runtime.runtime || 'openclaw@latest'}`)
  })

credentials
  .command('clear')
  .description('Remove stored runtime credentials')
  .action(() => {
    const config = loadConfig()
    delete config.runtime
    saveConfig(config)
    console.log('✅ Credentials cleared')
  })

// AGENTS DIR
const AGENTS_DIR = path.join(CONFIG_DIR, 'agents')

// RUN
program
  .command('run <bundle>')
  .description('Pull and run an agent locally')
  .option('--runtime <runtime>', 'Runtime override (e.g. openclaw@latest)')
  .option('--model <model>', 'Model override')
  .option('--provider <name>', 'Provider override')
  .option('--api-key <key>', 'API key override')
  .option('--no-pull', 'Skip pull, use cached workspace')
  .action(async (bundle: string, opts) => {
    const { execSync, spawn } = await import('child_process')

    // Parse bundle identifier
    const match = bundle.match(/^([^/]+)\/([^@]+)(?:@(.+))?$/)
    if (!match) {
      console.error('❌ Invalid bundle format. Use: owner/slug[@version]')
      process.exit(1)
    }
    const [, owner, slug, version] = match
    const agentName = `${owner}-${slug}`

    // Load runtime config (CLI flags override stored config)
    const config = loadConfig()
    const rt = config.runtime || {}
    const provider = opts.provider || rt.provider
    const apiKey = opts.apiKey || rt.apiKey || process.env.CLAWPACK_API_KEY
    const model = opts.model || rt.model
    const runtimeSpec = opts.runtime || rt.runtime || 'openclaw@latest'

    if (!provider || !apiKey) {
      console.log('ℹ️  No runtime credentials configured — launching without provider override.')
      console.log('   To set defaults: clawpack credentials set')
      console.log('   Or pass --provider and --api-key')
      console.log()
    }

    // Parse runtime spec: "openclaw@latest" or "openclaw@1.2.3"
    const [runtimeName, runtimeVersion] = runtimeSpec.split('@')

    // 1. Ensure runtime is available
    console.log(`🔍 Checking runtime: ${runtimeName}...`)
    let runtimeBin: string | null = null

    const isWindows = process.platform === 'win32'
    const whichCmd = isWindows ? 'where' : 'which'
    const devNull = isWindows ? '2>NUL' : '2>/dev/null'

    if (runtimeName === 'openclaw') {
      try {
        const found = execSync(`${whichCmd} openclaw ${devNull}`, { encoding: 'utf-8' }).trim().split('\n')[0]
        if (found) {
          runtimeBin = found
          try {
            const vResult = spawnSync(OC_BIN.cmd, [...OC_BIN.baseArgs, '--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
            const ver = (vResult.stdout || '').trim()
            console.log(`   Found openclaw ${ver}`)
          } catch {
            console.log(`   Found openclaw at ${found}`)
          }
        }
      } catch {}

      if (!runtimeBin) {
        console.log('   OpenClaw not found. Installing via npm...')
        try {
          execSync('npm install -g openclaw', { stdio: 'inherit' })
          runtimeBin = execSync(`${whichCmd} openclaw`, { encoding: 'utf-8' }).trim().split('\n')[0]
          console.log('   ✅ OpenClaw installed')
        } catch {
          console.error('❌ Failed to install OpenClaw. Install manually:')
          console.error('   npm install -g openclaw')
          process.exit(1)
        }
      }
    } else if (runtimeName === 'nullclaw') {
      const candidates = [
        'nullclaw',
        path.join(os.homedir(), '.nullclaw', 'bin', 'nullclaw'),
        ...(isWindows ? [] : ['/usr/local/bin/nullclaw']),
      ]
      for (const c of candidates) {
        try {
          execSync(`${whichCmd} ${c} ${devNull}`, { stdio: 'pipe' })
          runtimeBin = c
          break
        } catch {}
      }
      if (!runtimeBin) {
        console.error(`❌ ${runtimeName} not found in PATH.`)
        console.error('   Install from: https://github.com/pigeonflow/brain-arch-v2')
        process.exit(1)
      }
    } else {
      console.error(`❌ Unknown runtime: ${runtimeName}`)
      console.error('   Supported: openclaw, nullclaw')
      process.exit(1)
    }

    // 2. Pull bundle
    const workspaceDir = path.join(AGENTS_DIR, owner, slug, 'workspace')

    if (opts.pull !== false) {
      const ver = version || 'latest'
      console.log(`📥 Pulling ${owner}/${slug}@${ver}...`)
      try {
        const { url, version: resolvedVersion } = await apiRequest(
          'GET',
          `/v1/bundles/${owner}/${slug}/${ver}/download`
        )
        console.log(`   Version: ${resolvedVersion}`)

        const res = await fetch(url)
        if (!res.ok) throw new Error(`Download failed: ${res.statusText}`)
        const tarball = Buffer.from(await res.arrayBuffer())

        // Clean and extract
        fs.mkdirSync(workspaceDir, { recursive: true })
        const tmpFile = path.join(os.tmpdir(), `clawpack-run-${Date.now()}.tar.gz`)
        fs.writeFileSync(tmpFile, tarball)
        await tar.extract({ file: tmpFile, cwd: workspaceDir, strip: 1 })
        fs.unlinkSync(tmpFile)
        console.log(`   Extracted to ${workspaceDir}`)
      } catch (err: any) {
        console.error(`❌ Pull failed: ${err.message}`)
        process.exit(1)
      }
    }

    if (!fs.existsSync(workspaceDir)) {
      console.error(`❌ Workspace not found: ${workspaceDir}`)
      console.error('   Run without --no-pull to download first.')
      process.exit(1)
    }

    // 3. Run post-install script if present
    const postInstallScript = path.join(workspaceDir, 'scripts', 'post-install.sh')
    const postInstallScriptWin = path.join(workspaceDir, 'scripts', 'post-install.bat')

    let scriptToRun: string | null = null
    let scriptCmd: string

    if (isWindows && fs.existsSync(postInstallScriptWin)) {
      scriptToRun = postInstallScriptWin
      scriptCmd = `"${postInstallScriptWin}"`
    } else if (fs.existsSync(postInstallScript)) {
      scriptToRun = postInstallScript
      if (isWindows) {
        // Use Git Bash on Windows — convert backslashes to forward slashes
        const shPath = postInstallScript.replace(/\\/g, '/')
        scriptCmd = `bash "${shPath}"`
      } else {
        scriptCmd = `bash "${postInstallScript}"`
      }
    } else {
      scriptToRun = null
      scriptCmd = ''
    }

    if (scriptToRun) {
      console.log(`📦 Running post-install script...`)
      try {
        execSync(scriptCmd, {
          stdio: 'inherit',
          cwd: workspaceDir,
          env: {
            ...process.env,
            CLAWPACK_WORKSPACE: workspaceDir,
            CLAWPACK_AGENT: agentName,
            CLAWPACK_OWNER: owner,
            CLAWPACK_SLUG: slug,
          },
          shell: isWindows ? 'cmd.exe' : undefined,
        })
        console.log(`   ✅ Post-install complete`)
      } catch (err: any) {
        console.warn(`   ⚠️  Post-install script failed: ${err.message}`)
        console.warn(`   Continuing anyway...`)
      }
    }

    // 4. Launch with the appropriate runtime
    const resolvedModel = model || (provider ? `${provider}/claude-sonnet-4` : null)
    console.log(`\n🦀 Starting ${owner}/${slug}...`)
    console.log(`   Runtime:   ${runtimeSpec}`)
    console.log(`   Workspace: ${workspaceDir}`)
    if (resolvedModel) console.log(`   Model:     ${resolvedModel}`)
    console.log()

    if (runtimeName === 'openclaw') {
      // Check if agent already registered, register if not
      let needsRegister = true
      try {
        const list = oc('agents', 'list', '--json')
        const agents = JSON.parse(list)
        if (agents.find((a: any) => a.name === agentName)) {
          needsRegister = false
        }
      } catch {}

      if (needsRegister) {
        console.log(`   Registering agent "${agentName}"...`)
        try {
          const addArgs = ['agents', 'add', agentName, '--workspace', workspaceDir, '--non-interactive']
          if (resolvedModel) addArgs.push('--model', resolvedModel)
          ocInherit(...addArgs)
        } catch (err: any) {
          if (err.message?.includes('already exists')) {
            console.log(`   Agent "${agentName}" already registered.`)
          } else {
            console.error(`❌ Failed to register agent: ${err.message}`)
            process.exit(1)
          }
        }
      }

      // Set up auth profile with provider credentials (only if provided)
      if (provider && apiKey) {
        const agentDir = path.join(os.homedir(), '.openclaw', 'agents', agentName, 'agent')
        fs.mkdirSync(agentDir, { recursive: true })

        const authProfilesPath = path.join(agentDir, 'auth-profiles.json')
        const profileKey = `${provider}:default`
        const authProfiles = {
          version: 1,
          profiles: {
            [profileKey]: {
              type: 'token',
              provider,
              token: apiKey,
            },
          },
          lastGood: {
            [provider]: profileKey,
          },
        }
        fs.writeFileSync(authProfilesPath, JSON.stringify(authProfiles, null, 2))
      }

      // Launch agent — one-shot message
      const introMessage = 'Hello! I just pulled you from ClawPack. Introduce yourself.'

      let child
      if (isWindows) {
        // On Windows, spawn via shell with properly quoted command
        const cmd = `"${runtimeBin}" agent --agent ${agentName} --local -m "${introMessage}"`
        child = spawn(cmd, [], {
          stdio: 'inherit',
          env: { ...process.env },
          shell: true,
        })
      } else {
        child = spawn(runtimeBin!, ['agent', '--agent', agentName, '--local', '-m', introMessage], {
          stdio: 'inherit',
          env: { ...process.env },
        })
      }

      child.on('error', (err) => {
        console.error(`❌ Failed to start: ${err.message}`)
        process.exit(1)
      })
      child.on('exit', (code) => process.exit(code || 0))
      process.on('SIGINT', () => child.kill('SIGINT'))
      process.on('SIGTERM', () => child.kill('SIGTERM'))

    } else if (runtimeName === 'nullclaw') {
      // Generate nullclaw config
      const configPath = path.join(workspaceDir, '.nullclaw.json')
      const nullclawConfig = {
        default_temperature: 0.7,
        models: {
          providers: {
            [provider]: { api_key: apiKey },
          },
        },
        agents: {
          defaults: {
            model: { primary: resolvedModel },
          },
        },
        channels: { cli: true },
        memory: {
          profile: 'markdown_only',
          backend: 'markdown',
          auto_save: true,
        },
      }
      fs.writeFileSync(configPath, JSON.stringify(nullclawConfig, null, 2))

      const nullChild = isWindows
        ? spawn(`"${runtimeBin}" --config "${configPath}" --workspace "${workspaceDir}"`, [], {
            stdio: 'inherit', cwd: workspaceDir, shell: true,
          })
        : spawn(runtimeBin!, ['--config', configPath, '--workspace', workspaceDir], {
            stdio: 'inherit', cwd: workspaceDir,
          })

      nullChild.on('error', (err) => {
        console.error(`❌ Failed to start NullClaw: ${err.message}`)
        process.exit(1)
      })
      nullChild.on('exit', (code) => process.exit(code || 0))
      process.on('SIGINT', () => nullChild.kill('SIGINT'))
      process.on('SIGTERM', () => nullChild.kill('SIGTERM'))
    }
  })

program
  .command('update')
  .description('Update clawpack CLI to the latest version')
  .action(async () => {
    const { execSync } = await import('child_process')
    console.log(`Current version: ${PKG_VERSION}`)
    console.log('🔄 Checking for updates...')
    try {
      const latest = execSync('npm view @clawpack/cli version', { encoding: 'utf-8' }).trim()
      if (latest === PKG_VERSION) {
        console.log(`✅ Already on latest version (${PKG_VERSION})`)
        return
      }
      console.log(`   New version available: ${latest}`)
      console.log('   Installing...')
      execSync('npm install -g @clawpack/cli@latest', { stdio: 'inherit' })
      console.log(`✅ Updated to @clawpack/cli@${latest}`)
    } catch (err: any) {
      console.error(`❌ Update failed: ${err.message}`)
      console.error('   Try manually: npm install -g @clawpack/cli@latest')
      process.exit(1)
    }
  })

// LINK
program
  .command('link [path]')
  .description('Register a pulled agent in OpenClaw (post-install, auth, health check)')
  .option('--name <name>', 'Override agent name')
  .option('--provider <name>', 'Auth provider (e.g. openrouter, anthropic)')
  .option('--api-key <key>', 'Auth API key')
  .option('--model <model>', 'Model override')
  .option('--skip-health-check', 'Skip the health check ping')
  .action(async (dir: string | undefined, opts) => {
    const { linkAgent } = await import('./link.js')
    linkAgent(path.resolve(dir || '.'), {
      name: opts.name,
      provider: opts.provider,
      apiKey: opts.apiKey,
      model: opts.model,
      skipHealthCheck: opts.skipHealthCheck,
    })
  })

// UNLINK
program
  .command('unlink <name>')
  .description('Unregister an agent from OpenClaw (keeps workspace files)')
  .action(async (name: string) => {
    const { unlinkAgent } = await import('./link.js')
    unlinkAgent(name)
  })

// PARASITE
program
  .command('parasite [bundle]')
  .description('Hot-swap a ClawPack agent onto another agent\'s channels')
  .option('--host <agent>', 'Host agent to parasitize (default: main)', 'main')
  .option('--provider <name>', 'Auth provider')
  .option('--api-key <key>', 'Auth API key')
  .option('--model <model>', 'Model override')
  .option('--no-pull', 'Skip pull, use already-linked agent')
  .option('--restore [name]', 'Restore a specific parasite (or the only one)')
  .option('--all', 'Restore all parasites (use with --restore)')
  .option('--list', 'List active parasite sessions')
  .action(async (bundle: string | undefined, opts) => {
    const { startParasite, restoreParasite, listParasites } = await import('./parasite.js')
    if (opts.list) {
      listParasites()
    } else if (opts.restore !== undefined) {
      const target = typeof opts.restore === 'string' ? opts.restore : undefined
      await restoreParasite(target, opts.all)
    } else if (!bundle) {
      console.error('❌ Bundle required. Use: clawpack parasite owner/slug --host agent_id')
      console.error('   Or: clawpack parasite --restore [name] | --restore --all | --list')
      process.exit(1)
    } else {
      await startParasite({
        bundle,
        host: opts.host,
        provider: opts.provider,
        apiKey: opts.apiKey,
        model: opts.model,
        noPull: opts.pull === false,
      })
    }
  })

// CHAT
program
  .command('chat <bundle>')
  .description('Start an interactive chat session with a pulled agent')
  .option('--model <model>', 'Override the model')
  .action(async (bundle: string, opts) => {
    const { startChat } = await import('./chat.js')
    await startChat(bundle, { model: opts.model })
  })

// CREATE
function askInput(prompt: string, defaultVal?: string): Promise<string> {
  return new Promise((resolve) => {
    const suffix = defaultVal ? ` [${defaultVal}]` : ''
    process.stdout.write(`${prompt}${suffix}: `)
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => {
      data += chunk
      if (data.includes('\n')) {
        process.stdin.pause()
        resolve(data.trim() || defaultVal || '')
      }
    })
    process.stdin.resume()
  })
}

function choose(prompt: string, options: string[], defaultIdx = 0): Promise<string> {
  return new Promise((resolve) => {
    console.log(`\n${prompt}`)
    options.forEach((o, i) => console.log(`  ${i + 1}) ${o}${i === defaultIdx ? ' (default)' : ''}`))
    process.stdout.write(`Choice [${defaultIdx + 1}]: `)
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => {
      data += chunk
      if (data.includes('\n')) {
        process.stdin.pause()
        const idx = parseInt(data.trim()) - 1
        resolve(options[idx] || options[defaultIdx])
      }
    })
    process.stdin.resume()
  })
}

const PERSONA_BASES: Record<string, string> = {
  coding: "You live in code. Clean APIs are your love language. You hate boilerplate, premature abstraction, and magic. When someone asks for help, you give them the simplest thing that works — then explain why.",
  sales: "You read people. Every conversation is an opportunity to understand what someone actually needs — not what they say they need. You ask great questions, listen carefully, and connect dots others miss.",
  support: "You're the person everyone wishes they got when they called for help. Patient, thorough, and you anticipate the follow-up question before it's asked. You make complex things simple without being condescending.",
  creative: "Your mind works in colors and connections. You see patterns where others see noise. You make unexpected leaps that somehow land perfectly. Constraints don't limit you — they focus you.",
  research: "You're methodical without being boring. Every claim needs evidence, every analysis needs structure. But you also know when to step back and say 'here's what the data actually means' in plain language.",
  assistant: "You're the reliable one. Not flashy, not trying to impress — just genuinely helpful. You remember context, anticipate needs, and handle things before being asked.",
  devops: "Infrastructure is your canvas. You think in systems, pipelines, and failure modes. If it's not automated, it's not done. If it's not monitored, it doesn't exist.",
  custom: "You're a blank canvas with strong opinions. Define your own path.",
}

const PERSONALITY_LAYERS: Record<string, string> = {
  friendly: "Your tone is warm and approachable. You use casual language, the occasional emoji, and make people feel at ease. You're the coworker everyone actually likes talking to.",
  professional: "You communicate with clarity and structure. Formal but never stiff — you respect people's time with well-organized, thoughtful responses.",
  direct: "You don't do filler. Every word earns its place. You say what needs saying, then stop. People come to you because you don't waste their time.",
  witty: "You have a dry sense of humor and a knack for clever asides. Playful without being unprofessional — your personality makes even mundane tasks entertaining.",
  calm: "You're measured and reassuring. Nothing rattles you. Your steady presence makes others feel like everything is under control, even when it's not.",
  energetic: "You bring momentum to everything you do. Enthusiastic without being exhausting, you use that energy to drive progress and keep things moving forward.",
}

const PERSONA_EMOJI: Record<string, string> = {
  assistant: '🤖', coding: '💻', sales: '💼', support: '🎧',
  creative: '🎨', research: '🔬', devops: '⚙️', custom: '✨',
}

function generateSoul(persona: string, personality: string, name: string): string {
  const base = PERSONA_BASES[persona] || PERSONA_BASES.custom
  const layer = PERSONALITY_LAYERS[personality] || PERSONALITY_LAYERS.friendly
  return `# ${name}

## Core

${base}

## Communication Style

${layer}

## Principles

- Quality over quantity — every interaction should leave people better off
- Own your mistakes, learn fast, move on
- Context matters — read the room before you speak
- Be genuinely useful, not performatively busy
`
}

const AGENTS_MD_TEMPLATE = `# AGENTS.md

## Every Session
1. Read \`SOUL.md\` — who you are
2. Read \`USER.md\` if it exists — who you're helping
3. Check \`memory/\` for recent context

## Memory
- Daily notes: \`memory/YYYY-MM-DD.md\`
- Long-term: \`MEMORY.md\`
- Write things down. Memory doesn't survive sessions. Files do.

## Safety
- Don't exfiltrate data
- Ask before destructive or external actions
- \`trash\` > \`rm\`

## External Actions
**Do freely:** Read files, search, organize, learn
**Ask first:** Send emails, post publicly, anything that leaves the machine
`

program
  .command('create [name]')
  .description('Create a new agent project (interactive wizard or from template)')
  .option('--template <owner/slug>', 'Create from a ClawPack template bundle')
  .action(async (nameArg: string | undefined, opts) => {
    if (opts.template) {
      // Template mode
      const match = opts.template.match(/^([^/]+)\/([^@]+)(?:@(.+))?$/)
      if (!match) {
        console.error('❌ Invalid template format. Use: owner/slug')
        process.exit(1)
      }
      const [, owner, slug, version] = match
      const agentName = nameArg || slug
      const targetDir = path.resolve(agentName)

      console.log(`📥 Pulling template ${owner}/${slug}...`)
      try {
        const { url, version: resolvedVersion } = await apiRequest(
          'GET',
          `/v1/bundles/${owner}/${slug}/${version || 'latest'}/download`
        )
        console.log(`   Version: ${resolvedVersion}`)

        const res = await fetch(url)
        if (!res.ok) throw new Error(`Download failed: ${res.statusText}`)
        const tarball = Buffer.from(await res.arrayBuffer())

        fs.mkdirSync(targetDir, { recursive: true })
        const tmpFile = path.join(os.tmpdir(), `clawpack-create-${Date.now()}.tar.gz`)
        fs.writeFileSync(tmpFile, tarball)
        await tar.extract({ file: tmpFile, cwd: targetDir, strip: 1 })
        fs.unlinkSync(tmpFile)

        // Update manifest
        const manifestPath = path.join(targetDir, 'manifest.json')
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
          manifest.version = '0.1.0'
          if (nameArg) manifest.name = nameArg
          fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
        }

        console.log(`\n✅ Created ${agentName}/ from template ${owner}/${slug}`)
        console.log(`\n   cd ${agentName}`)
        console.log(`   clawpack push`)
      } catch (err: any) {
        console.error(`❌ Failed: ${err.message}`)
        process.exit(1)
      }
      return
    }

    // Interactive wizard
    const dirDefault = path.basename(process.cwd())
    const name = await askInput('Agent name', nameArg || dirDefault)
    const description = await askInput('Description (one line)')

    const personas = ['assistant', 'coding', 'sales', 'support', 'creative', 'research', 'devops', 'custom']
    const persona = await choose('Persona type:', personas, 0)

    const personalities = ['friendly', 'professional', 'direct', 'witty', 'calm', 'energetic']
    const personality = await choose('Personality:', personalities, 0)

    const defaultEmoji = PERSONA_EMOJI[persona] || '✨'
    const emoji = await askInput('Emoji', defaultEmoji)

    const targetDir = path.resolve(name)
    if (fs.existsSync(targetDir)) {
      console.error(`❌ Directory ${name}/ already exists`)
      process.exit(1)
    }

    // Create directory structure
    fs.mkdirSync(path.join(targetDir, 'skills'), { recursive: true })
    fs.mkdirSync(path.join(targetDir, 'memory'), { recursive: true })

    // manifest.json
    fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify({
      name,
      version: '0.1.0',
      description,
      tags: [persona, personality],
    }, null, 2) + '\n')

    // SOUL.md
    fs.writeFileSync(path.join(targetDir, 'SOUL.md'), generateSoul(persona, personality, name))

    // AGENTS.md
    fs.writeFileSync(path.join(targetDir, 'AGENTS.md'), AGENTS_MD_TEMPLATE)

    // IDENTITY.md
    fs.writeFileSync(path.join(targetDir, 'IDENTITY.md'), `# ${emoji} ${name}\n\n**Name:** ${name}\n**Emoji:** ${emoji}\n**Type:** ${persona}\n`)

    // README.md
    fs.writeFileSync(path.join(targetDir, 'README.md'), `# ${emoji} ${name}\n\n${description || 'An AI agent built with ClawPack.'}\n\n## Install\n\n\`\`\`bash\nclawpack pull your-username/${name}\n\`\`\`\n\n## Usage\n\n\`\`\`bash\nclawpack run your-username/${name}\n\`\`\`\n\n## Publish\n\n\`\`\`bash\nclawpack push\n\`\`\`\n`)

    // .gitkeep files
    fs.writeFileSync(path.join(targetDir, 'skills', '.gitkeep'), '')
    fs.writeFileSync(path.join(targetDir, 'memory', '.gitkeep'), '')

    console.log(`\n✅ Created ${name}/`)
    console.log(`\n   Next steps:`)
    console.log(`   cd ${name}`)
    console.log(`   # Edit SOUL.md to refine your agent's personality`)
    console.log(`   clawpack push`)
  })

program
  .command('diff <bundle>')
  .description('Compare two versions of an agent bundle')
  .option('--from <version>', 'Base version to compare from')
  .option('--to <version>', 'Target version to compare to (default: latest)')
  .option('--local', 'Compare local working copy against a published version')
  .action(async (bundle: string, opts) => {
    const match = bundle.match(/^([^/]+)\/([^@]+)$/)
    if (!match) {
      console.error('❌ Invalid bundle format. Use: owner/slug')
      process.exit(1)
    }

    const [, owner, slug] = match
    const tmpBase = path.join(os.tmpdir(), `clawpack-diff-${Date.now()}`)

    try {
      // Determine versions to compare
      let fromDir: string
      let toDir: string
      let fromLabel: string
      let toLabel: string

      if (opts.local) {
        // Compare local working copy against a published version
        const localDir = path.resolve('.')
        const localManifest = path.join(localDir, 'manifest.json')
        if (!fs.existsSync(localManifest)) {
          console.error('❌ No manifest.json found in current directory')
          process.exit(1)
        }
        toDir = localDir
        toLabel = 'local'

        const compareVer = opts.from || opts.to || 'latest'
        console.log(`📥 Pulling ${owner}/${slug}@${compareVer} for comparison...`)
        const { url, version: resolvedFrom } = await apiRequest(
          'GET',
          `/v1/bundles/${owner}/${slug}/${compareVer}/download`
        )
        fromLabel = `v${resolvedFrom}`
        fromDir = path.join(tmpBase, 'from')
        fs.mkdirSync(fromDir, { recursive: true })
        const res = await fetch(url)
        if (!res.ok) throw new Error(`Download failed: ${res.status}`)
        const tarPath = path.join(tmpBase, 'from.tar.gz')
        fs.writeFileSync(tarPath, Buffer.from(await res.arrayBuffer()))
        execSync(`tar xzf "${tarPath}" -C "${fromDir}"`, { stdio: 'pipe' })
        // Tarballs extract into a subdirectory — find it
        const fromSub = fs.readdirSync(fromDir).filter(f => fs.statSync(path.join(fromDir, f)).isDirectory())
        if (fromSub.length === 1) fromDir = path.join(fromDir, fromSub[0])
      } else {
        // Compare two published versions
        if (!opts.from) {
          // Get version list to find previous version
          const data = await apiRequest('GET', `/v1/bundles/${owner}/${slug}`)
          const versions = (data.versions || []).map((v: any) => v.version).sort()
          if (versions.length < 2 && !opts.to) {
            console.error('❌ Only one version exists. Use --from and --to, or --local')
            process.exit(1)
          }
          opts.to = opts.to || versions[versions.length - 1]
          opts.from = versions[versions.length - 2]
        }
        if (!opts.to) opts.to = 'latest'

        console.log(`📥 Pulling ${owner}/${slug}@${opts.from}...`)
        const fromRes = await apiRequest('GET', `/v1/bundles/${owner}/${slug}/${opts.from}/download`)
        fromLabel = `v${fromRes.version}`
        fromDir = path.join(tmpBase, 'from')
        fs.mkdirSync(fromDir, { recursive: true })
        const fromTar = path.join(tmpBase, 'from.tar.gz')
        const fromDl = await fetch(fromRes.url)
        if (!fromDl.ok) throw new Error(`Download failed: ${fromDl.status}`)
        fs.writeFileSync(fromTar, Buffer.from(await fromDl.arrayBuffer()))
        execSync(`tar xzf "${fromTar}" -C "${fromDir}"`, { stdio: 'pipe' })
        const fromSub = fs.readdirSync(fromDir).filter(f => fs.statSync(path.join(fromDir, f)).isDirectory())
        if (fromSub.length === 1) fromDir = path.join(fromDir, fromSub[0])

        console.log(`📥 Pulling ${owner}/${slug}@${opts.to}...`)
        const toRes = await apiRequest('GET', `/v1/bundles/${owner}/${slug}/${opts.to}/download`)
        toLabel = `v${toRes.version}`
        toDir = path.join(tmpBase, 'to')
        fs.mkdirSync(toDir, { recursive: true })
        const toTar = path.join(tmpBase, 'to.tar.gz')
        const toDl = await fetch(toRes.url)
        if (!toDl.ok) throw new Error(`Download failed: ${toDl.status}`)
        fs.writeFileSync(toTar, Buffer.from(await toDl.arrayBuffer()))
        execSync(`tar xzf "${toTar}" -C "${toDir}"`, { stdio: 'pipe' })
        const toSub = fs.readdirSync(toDir).filter(f => fs.statSync(path.join(toDir, f)).isDirectory())
        if (toSub.length === 1) toDir = path.join(toDir, toSub[0])
      }

      // Run diff
      console.log(`\n📋 Diff: ${owner}/${slug} ${fromLabel} → ${toLabel}\n`)
      console.log('─'.repeat(60))

      // Collect all files from both dirs
      const collectFiles = (dir: string, prefix = ''): string[] => {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        let files: string[] = []
        for (const e of entries) {
          const rel = prefix ? `${prefix}/${e.name}` : e.name
          if (e.name === '.git' || e.name === 'node_modules' || e.name === 'tickets.db' || e.name === '.gitkeep') continue
          if (e.isDirectory()) {
            files = files.concat(collectFiles(path.join(dir, e.name), rel))
          } else {
            files.push(rel)
          }
        }
        return files
      }

      const fromFiles = new Set(collectFiles(fromDir))
      const toFiles = new Set(collectFiles(toDir))
      const allFiles = new Set([...fromFiles, ...toFiles])
      let hasChanges = false

      for (const file of [...allFiles].sort()) {
        const fromPath = path.join(fromDir, file)
        const toPath = path.join(toDir, file)

        if (!fromFiles.has(file)) {
          hasChanges = true
          console.log(chalk.green(`+ Added: ${file}`))
          const content = fs.readFileSync(toPath, 'utf-8')
          for (const line of content.split('\n').slice(0, 5)) {
            console.log(chalk.green(`  + ${line}`))
          }
          if (content.split('\n').length > 5) console.log(chalk.dim(`  ... (${content.split('\n').length} lines total)`))
          console.log()
        } else if (!toFiles.has(file)) {
          hasChanges = true
          console.log(chalk.red(`- Removed: ${file}`))
          console.log()
        } else {
          const fromContent = fs.readFileSync(fromPath, 'utf-8')
          const toContent = fs.readFileSync(toPath, 'utf-8')
          if (fromContent !== toContent) {
            hasChanges = true
            console.log(chalk.yellow(`~ Modified: ${file}`))

            // Simple line-by-line diff
            const fromLines = fromContent.split('\n')
            const toLines = toContent.split('\n')
            const maxShow = 15
            let shown = 0

            // Find changed lines
            const maxLen = Math.max(fromLines.length, toLines.length)
            for (let i = 0; i < maxLen && shown < maxShow; i++) {
              const fl = fromLines[i]
              const tl = toLines[i]
              if (fl !== tl) {
                if (fl !== undefined && (tl === undefined || fl !== tl)) {
                  console.log(chalk.red(`  - ${fl}`))
                  shown++
                }
                if (tl !== undefined && (fl === undefined || fl !== tl)) {
                  console.log(chalk.green(`  + ${tl}`))
                  shown++
                }
              }
            }
            if (shown >= maxShow) {
              const totalChanges = fromLines.filter((l, i) => l !== toLines[i]).length +
                Math.abs(fromLines.length - toLines.length)
              console.log(chalk.dim(`  ... (${totalChanges}+ more changes)`))
            }
            console.log()
          }
        }
      }

      if (!hasChanges) {
        console.log(chalk.dim('No differences found.'))
      }

      console.log('─'.repeat(60))
    } catch (err: any) {
      console.error(`❌ ${err.message}`)
      process.exit(1)
    } finally {
      // Cleanup temp files
      if (fs.existsSync(tmpBase)) {
        fs.rmSync(tmpBase, { recursive: true, force: true })
      }
    }
  })

program.parse()
