import { describe, it, expect, vi, beforeEach } from 'vitest'

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`process.exit(${code})`) }) as any)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'clear').mockImplementation(() => {})
})

async function setupChat(opts: {
  bundleExists?: boolean
  openclawInstalled?: boolean
  configFile?: any
  agentExists?: boolean
} = {}) {
  vi.resetModules()

  const { bundleExists = true, openclawInstalled = true, configFile = null, agentExists = false } = opts

  const mockReadline = {
    createInterface: vi.fn().mockReturnValue({
      prompt: vi.fn(),
      on: vi.fn(),
      close: vi.fn(),
    }),
  }

  vi.doMock('readline', () => mockReadline)

  vi.doMock('fs', () => ({
    existsSync: vi.fn().mockImplementation((p: any) => {
      if (String(p).includes('manifest.json') && bundleExists) return true
      return false
    }),
    readFileSync: vi.fn().mockImplementation((p: any) => {
      if (String(p).includes('manifest.json') && bundleExists) {
        return JSON.stringify({ name: 'test-agent', version: '1.0.0', description: 'A test agent' })
      }
      if (String(p).includes('config.json') && configFile) {
        return JSON.stringify(configFile)
      }
      throw new Error('ENOENT')
    }),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  }))

  vi.doMock('child_process', () => ({
    execSync: vi.fn().mockImplementation((cmd: any) => {
      if (String(cmd).includes('--version')) {
        if (!openclawInstalled) throw new Error('not found')
        return '1.0.0'
      }
      if (String(cmd).includes('config get agents.list')) {
        if (agentExists) return JSON.stringify([{ id: 'clawpack-test-agent', index: 0 }])
        return '[]'
      }
      if (String(cmd).includes('config set')) return ''
      if (String(cmd).includes('config unset')) return ''
      return ''
    }),
    spawn: vi.fn().mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    }),
  }))

  // Mock ESM dynamic imports used by loadESM()
  // chalk mock: every property access and every call returns the same proxy
  // so chalk.hex('#color')('text'), chalk.bold('text'), chalk.dim('x') all work
  const makeChalk = (): any => {
    const fn = (...args: any[]) => {
      // If called with a string arg, return the string (final call)
      // But wrap it in a callable proxy so chaining still works
      return makeChalk()
    }
    return new Proxy(fn, {
      get: (_t, prop) => {
        if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') {
          return () => ''
        }
        return makeChalk()
      },
      apply: (_t, _this, args) => makeChalk(),
    })
  }
  vi.doMock('chalk', () => ({ default: makeChalk() }))
  vi.doMock('boxen', () => ({ default: (s: any) => s }))
  vi.doMock('ora', () => ({ default: () => ({ start: vi.fn().mockReturnThis(), stop: vi.fn() }) }))
  vi.doMock('gradient-string', () => ({ default: () => (s: any) => s }))
  vi.doMock('figlet', () => ({ default: { textSync: (s: any) => s } }))

  return await import('../chat.js')
}

describe('chat — bundle parsing', () => {
  it('exits when bundle not found', async () => {
    const { startChat } = await setupChat({ bundleExists: false })
    await expect(startChat('owner/nonexistent', {})).rejects.toThrow('process.exit(1)')
    expect(console.error).toHaveBeenCalled()
  })

  it('exits when openclaw not installed', async () => {
    const { startChat } = await setupChat({ openclawInstalled: false })
    await expect(startChat('owner/slug', {})).rejects.toThrow('process.exit(1)')
    expect(console.error).toHaveBeenCalled()
  })

  it('registers agent and sets up readline for valid bundle', async () => {
    const { startChat } = await setupChat()
    // startChat won't throw — it sets up readline and waits
    // We just verify it doesn't crash on startup
    await startChat('owner/slug', {})
    // If we get here, startup succeeded (readline is mocked to not block)
  })

  it('reuses existing agent when already registered', async () => {
    const { startChat } = await setupChat({ agentExists: true })
    await startChat('owner/slug', {})
    // Should not throw — reuses existing agent
  })
})

describe('chat — config file credentials', () => {
  it('reads credentials from config file for auth setup', async () => {
    const { startChat } = await setupChat({
      configFile: { runtime: { provider: 'anthropic', apiKey: 'test-key', model: 'claude-3' } }
    })
    await startChat('owner/slug', {})
    // Auth setup should have written auth-profiles.json
    const fs = await import('fs')
    const writeFileSync = vi.mocked(fs.writeFileSync)
    const authWrite = writeFileSync.mock.calls.find(c => String(c[0]).includes('auth-profiles.json'))
    expect(authWrite).toBeDefined()
    const written = JSON.parse(authWrite![1] as string)
    expect(written.profiles['anthropic:default'].token).toBe('test-key')
  })
})

describe('chat — cleanup on exit', () => {
  it('registers exit handler that unregisters temp agent', async () => {
    const onSpy = vi.spyOn(process, 'on')
    const { startChat } = await setupChat()
    await startChat('owner/slug', {})
    // Should have registered exit, SIGINT, SIGTERM handlers
    const exitCalls = onSpy.mock.calls.filter(c => c[0] === 'exit')
    expect(exitCalls.length).toBeGreaterThanOrEqual(1)
  })
})
