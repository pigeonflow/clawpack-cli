import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as child_process from 'child_process'

vi.mock('fs')
vi.mock('child_process')

const mockFs = vi.mocked(fs)
const mockExecSync = vi.mocked(child_process.execSync)

// We need to test linkAgent and unlinkAgent which are exported.
// Internal functions (readManifest, runPostInstall, resolveAuth, setupAuth) are tested indirectly.

beforeEach(() => {
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`process.exit(${code})`) }) as any)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

// Dynamic import to get fresh module each time after mocks are set up
async function importLink() {
  // Clear module cache for fresh import
  vi.resetModules()
  return await import('../link.js')
}

describe('linkAgent', () => {
  it('exits on missing directory', async () => {
    mockFs.existsSync.mockReturnValue(false)
    const { linkAgent } = await importLink()
    expect(() => linkAgent('/nonexistent')).toThrow('process.exit(1)')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Directory not found'))
  })

  it('reads manifest and uses manifest name', async () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('manifest.json')) return JSON.stringify({ name: 'my-agent', version: '1.0.0' })
      throw new Error('ENOENT')
    })
    // agents list returns empty
    mockExecSync.mockImplementation((cmd: any) => {
      if (String(cmd).includes('agents list')) return '[]'
      if (String(cmd).includes('agents add')) return '' as any
      if (String(cmd).includes('agent --agent')) return JSON.stringify({ payloads: [{ text: 'OK' }] })
      return '' as any
    })
    mockFs.mkdirSync.mockReturnValue(undefined as any)
    mockFs.writeFileSync.mockReturnValue(undefined)
    mockFs.copyFileSync.mockReturnValue(undefined)

    const { linkAgent } = await importLink()
    const name = linkAgent('/some/dir', { skipHealthCheck: true, skipPostInstall: true })
    expect(name).toBe('my-agent')
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Linking "my-agent"'))
  })

  it('falls back to dir name when no manifest', async () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT') })
    mockExecSync.mockImplementation((cmd: any) => {
      if (String(cmd).includes('agents list')) return '[]'
      if (String(cmd).includes('agents add')) return '' as any
      return '' as any
    })
    mockFs.mkdirSync.mockReturnValue(undefined as any)
    mockFs.writeFileSync.mockReturnValue(undefined)
    mockFs.copyFileSync.mockReturnValue(undefined)

    const { linkAgent } = await importLink()
    const name = linkAgent('/some/my-workspace', { skipHealthCheck: true, skipPostInstall: true })
    expect(name).toBe('my-workspace')
  })

  it('skips registration if agent already exists', async () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('manifest.json')) return JSON.stringify({ name: 'existing' })
      throw new Error('ENOENT')
    })
    mockExecSync.mockImplementation((cmd: any) => {
      if (String(cmd).includes('agents list')) return JSON.stringify([{ name: 'existing', id: 'existing' }])
      return '' as any
    })
    mockFs.mkdirSync.mockReturnValue(undefined as any)
    mockFs.writeFileSync.mockReturnValue(undefined)
    mockFs.copyFileSync.mockReturnValue(undefined)

    const { linkAgent } = await importLink()
    linkAgent('/some/dir', { skipHealthCheck: true, skipPostInstall: true })
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('already registered, skipping'))
  })

  it('runs post-install script when present', async () => {
    mockFs.existsSync.mockImplementation((p: any) => {
      if (String(p).endsWith('post-install.sh')) return true
      return true
    })
    mockFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('manifest.json')) return JSON.stringify({ name: 'test-agent' })
      throw new Error('ENOENT')
    })
    mockExecSync.mockImplementation((cmd: any) => {
      if (String(cmd).includes('agents list')) return '[]'
      if (String(cmd).includes('agents add')) return '' as any
      return '' as any
    })
    mockFs.mkdirSync.mockReturnValue(undefined as any)
    mockFs.writeFileSync.mockReturnValue(undefined)
    mockFs.copyFileSync.mockReturnValue(undefined)

    const { linkAgent } = await importLink()
    linkAgent('/some/dir', { skipHealthCheck: true })
    // post-install bash command should have been called
    const bashCalls = mockExecSync.mock.calls.filter(c => String(c[0]).includes('bash'))
    expect(bashCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('sets up auth with explicit provider and apiKey', async () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('manifest.json')) return JSON.stringify({ name: 'auth-test' })
      throw new Error('ENOENT')
    })
    mockExecSync.mockImplementation((cmd: any) => {
      if (String(cmd).includes('agents list')) return '[]'
      if (String(cmd).includes('agents add')) return '' as any
      return '' as any
    })
    mockFs.mkdirSync.mockReturnValue(undefined as any)
    mockFs.writeFileSync.mockReturnValue(undefined)

    const { linkAgent } = await importLink()
    linkAgent('/some/dir', {
      provider: 'openrouter',
      apiKey: 'sk-test-key',
      skipHealthCheck: true,
      skipPostInstall: true,
    })

    // Should have written auth-profiles.json
    const writeCall = mockFs.writeFileSync.mock.calls.find(c =>
      String(c[0]).includes('auth-profiles.json')
    )
    expect(writeCall).toBeDefined()
    const written = JSON.parse(writeCall![1] as string)
    expect(written.profiles['openrouter:default'].token).toBe('sk-test-key')
  })

  it('copies auth from main agent when no credentials provided', async () => {
    mockFs.existsSync.mockImplementation((p: any) => {
      if (String(p).includes('main/agent')) return true
      return true
    })
    mockFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('manifest.json')) return JSON.stringify({ name: 'fallback-test' })
      throw new Error('ENOENT')
    })
    mockExecSync.mockImplementation((cmd: any) => {
      if (String(cmd).includes('agents list')) return '[]'
      if (String(cmd).includes('agents add')) return '' as any
      return '' as any
    })
    mockFs.mkdirSync.mockReturnValue(undefined as any)
    mockFs.writeFileSync.mockReturnValue(undefined)
    mockFs.copyFileSync.mockReturnValue(undefined)

    // Clear env
    delete process.env.CLAWPACK_API_KEY

    const { linkAgent } = await importLink()
    linkAgent('/some/dir', { skipHealthCheck: true, skipPostInstall: true })

    expect(mockFs.copyFileSync).toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Auth copied from main'))
  })

  it('writes model config when model is provided', async () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('manifest.json')) return JSON.stringify({ name: 'model-test' })
      throw new Error('ENOENT')
    })
    mockExecSync.mockImplementation((cmd: any) => {
      if (String(cmd).includes('agents list')) return '[]'
      if (String(cmd).includes('agents add')) return '' as any
      return '' as any
    })
    mockFs.mkdirSync.mockReturnValue(undefined as any)
    mockFs.writeFileSync.mockReturnValue(undefined)
    mockFs.copyFileSync.mockReturnValue(undefined)

    const { linkAgent } = await importLink()
    linkAgent('/some/dir', {
      model: 'openrouter/claude-sonnet-4',
      skipHealthCheck: true,
      skipPostInstall: true,
    })

    const modelWrite = mockFs.writeFileSync.mock.calls.find(c =>
      String(c[0]).includes('openclaw.agent.json')
    )
    expect(modelWrite).toBeDefined()
    const written = JSON.parse(modelWrite![1] as string)
    expect(written.model.primary).toBe('openrouter/claude-sonnet-4')
  })
})

describe('unlinkAgent', () => {
  it('removes agent and cleans auth files', async () => {
    mockExecSync.mockReturnValue('' as any)
    mockFs.unlinkSync.mockReturnValue(undefined)
    mockFs.rmSync.mockReturnValue(undefined)

    const { unlinkAgent } = await importLink()
    unlinkAgent('test-agent')

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('openclaw agents remove test-agent'),
      expect.any(Object)
    )
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Removed from OpenClaw'))
    // Should try to unlink auth files
    expect(mockFs.unlinkSync).toHaveBeenCalled()
  })

  it('warns but continues if openclaw remove fails', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('not found') })
    mockFs.unlinkSync.mockReturnValue(undefined)
    mockFs.rmSync.mockReturnValue(undefined)

    const { unlinkAgent } = await importLink()
    unlinkAgent('missing-agent')

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not remove'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('unlinked'))
  })
})

describe('resolveAuth', () => {
  it('returns env var fallback with default provider', async () => {
    process.env.CLAWPACK_API_KEY = 'env-test-key'
    mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT') })
    const { resolveAuth } = await importLink()
    const result = resolveAuth()
    expect(result).toEqual({ provider: 'openrouter', apiKey: 'env-test-key' })
    delete process.env.CLAWPACK_API_KEY
  })

  it('returns config file fallback when ~/.clawpack/config.json has runtime', async () => {
    delete process.env.CLAWPACK_API_KEY
    mockFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes('config.json')) {
        return JSON.stringify({ runtime: { provider: 'anthropic', apiKey: 'cfg-key' } })
      }
      throw new Error('ENOENT')
    })
    const { resolveAuth } = await importLink()
    const result = resolveAuth()
    expect(result).toEqual({ provider: 'anthropic', apiKey: 'cfg-key' })
  })

  it('returns fromMain when no credentials available', async () => {
    delete process.env.CLAWPACK_API_KEY
    mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT') })
    const { resolveAuth } = await importLink()
    const result = resolveAuth()
    expect(result).toEqual({ fromMain: true })
  })

  it('returns explicit provider/apiKey when both provided', async () => {
    const { resolveAuth } = await importLink()
    const result = resolveAuth('openai', 'sk-explicit')
    expect(result).toEqual({ provider: 'openai', apiKey: 'sk-explicit' })
  })
})

describe('health check', () => {
  it('success path — execSync returns valid JSON with payloads', async () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('manifest.json')) return JSON.stringify({ name: 'hc-agent' })
      throw new Error('ENOENT')
    })
    mockExecSync.mockImplementation((cmd: any) => {
      if (String(cmd).includes('agents list')) return '[]'
      if (String(cmd).includes('agents add')) return '' as any
      if (String(cmd).includes('agent --agent')) return JSON.stringify({ payloads: [{ text: 'OK' }] })
      return '' as any
    })
    mockFs.mkdirSync.mockReturnValue(undefined as any)
    mockFs.writeFileSync.mockReturnValue(undefined)
    mockFs.copyFileSync.mockReturnValue(undefined)

    const { linkAgent } = await importLink()
    linkAgent('/some/dir', { skipPostInstall: true })
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Agent responding'))
  })

  it('failure path — warns but does not crash', async () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('manifest.json')) return JSON.stringify({ name: 'hc-fail' })
      throw new Error('ENOENT')
    })
    mockExecSync.mockImplementation((cmd: any) => {
      if (String(cmd).includes('agents list')) return '[]'
      if (String(cmd).includes('agents add')) return '' as any
      if (String(cmd).includes('agent --agent')) throw new Error('timeout')
      return '' as any
    })
    mockFs.mkdirSync.mockReturnValue(undefined as any)
    mockFs.writeFileSync.mockReturnValue(undefined)
    mockFs.copyFileSync.mockReturnValue(undefined)

    const { linkAgent } = await importLink()
    // Should not throw
    const name = linkAgent('/some/dir', { skipPostInstall: true })
    expect(name).toBe('hc-fail')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Health check failed'))
  })

  it('skipHealthCheck option — health check not called', async () => {
    mockExecSync.mockClear()
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('manifest.json')) return JSON.stringify({ name: 'no-hc' })
      throw new Error('ENOENT')
    })
    mockExecSync.mockImplementation((cmd: any) => {
      if (String(cmd).includes('agent --agent')) throw new Error('should not be called')
      if (String(cmd).includes('agents list')) return '[]'
      if (String(cmd).includes('agents add')) return '' as any
      return '' as any
    })
    mockFs.mkdirSync.mockReturnValue(undefined as any)
    mockFs.writeFileSync.mockReturnValue(undefined)
    mockFs.copyFileSync.mockReturnValue(undefined)

    const { linkAgent } = await importLink()
    linkAgent('/some/dir', { skipPostInstall: true, skipHealthCheck: true })
    // No health check command should have been called
    const hcCalls = mockExecSync.mock.calls.filter(c => String(c[0]).includes('agent --agent'))
    expect(hcCalls).toHaveLength(0)
  })
})

describe('registration failure', () => {
  it('exits with code 1 on non-"already exists" error', async () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('manifest.json')) return JSON.stringify({ name: 'reg-fail' })
      throw new Error('ENOENT')
    })
    mockExecSync.mockImplementation((cmd: any) => {
      if (String(cmd).includes('agents list')) return '[]'
      if (String(cmd).includes('agents add')) throw new Error('some other error')
      return '' as any
    })
    mockFs.mkdirSync.mockReturnValue(undefined as any)
    mockFs.writeFileSync.mockReturnValue(undefined)

    const { linkAgent } = await importLink()
    expect(() => linkAgent('/some/dir', { skipPostInstall: true, skipHealthCheck: true })).toThrow('process.exit(1)')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to register'))
  })
})
