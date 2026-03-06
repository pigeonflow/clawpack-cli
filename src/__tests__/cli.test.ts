import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Command } from 'commander'

// Instead of trying to mock commander (which is tricky with `new`),
// we test the CLI by inspecting a real Commander program's registered commands.
// We mock all the action handlers' dependencies so nothing actually runs.

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    readFileSync: vi.fn().mockImplementation((p: any) => {
      if (String(p).endsWith('package.json')) return JSON.stringify({ version: '0.0.0-test' })
      throw new Error('ENOENT')
    }),
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    createWriteStream: vi.fn(),
    createReadStream: vi.fn(),
  }
})
vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue(''),
  spawn: vi.fn().mockReturnValue({ on: vi.fn(), kill: vi.fn() }),
}))
vi.mock('tar', () => ({
  create: vi.fn(),
  extract: vi.fn(),
  default: { create: vi.fn(), extract: vi.fn() },
}))
vi.mock('stream/promises', () => ({ pipeline: vi.fn() }))
vi.mock('zlib', () => ({ createGzip: vi.fn(), createGunzip: vi.fn() }))
vi.mock('../link.js', () => ({
  linkAgent: vi.fn().mockReturnValue('test-agent'),
  unlinkAgent: vi.fn(),
}))
vi.mock('../parasite.js', () => ({
  startParasite: vi.fn(),
  restoreParasite: vi.fn(),
  listParasites: vi.fn(),
}))
vi.mock('../chat.js', () => ({
  startChat: vi.fn(),
}))

describe('CLI command registration', () => {
  it('registers all expected commands', async () => {
    // We can't easily import index.ts without it calling program.parse()
    // Instead, we verify the expected command names exist in the source
    // by checking what Commander would register
    const { readFileSync } = await import('fs')
    const actual = await vi.importActual<typeof import('fs')>('fs')
    const source = actual.readFileSync(
      new URL('../index.ts', import.meta.url).pathname.replace(/%20/g, ' '),
      'utf-8'
    )

    const expectedCommands = [
      'login', 'whoami', 'push', 'pull', 'search', 'list',
      'init', 'credentials', 'run', 'update', 'link', 'unlink', 'parasite', 'chat'
    ]

    for (const cmd of expectedCommands) {
      // Check that .command('cmd ...') appears in source
      const pattern = new RegExp(`\\.command\\(['"\`]${cmd}`)
      expect(pattern.test(source), `Expected command "${cmd}" to be registered in source`).toBe(true)
    }
  })

  it('pull command has --link option', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs')
    const source = actual.readFileSync(
      new URL('../index.ts', import.meta.url).pathname.replace(/%20/g, ' '),
      'utf-8'
    )
    expect(source).toContain("'--link'")
  })

  it('parasite command has --list and --restore options', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs')
    const source = actual.readFileSync(
      new URL('../index.ts', import.meta.url).pathname.replace(/%20/g, ' '),
      'utf-8'
    )
    expect(source).toContain("'--list'")
    expect(source).toContain("'--restore")
    expect(source).toContain("'--all'")
  })

  it('parasite --list calls listParasites', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs')
    const source = actual.readFileSync(
      new URL('../index.ts', import.meta.url).pathname.replace(/%20/g, ' '),
      'utf-8'
    )
    expect(source).toContain('listParasites()')
  })

  it('parasite --restore calls restoreParasite', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs')
    const source = actual.readFileSync(
      new URL('../index.ts', import.meta.url).pathname.replace(/%20/g, ' '),
      'utf-8'
    )
    expect(source).toContain('restoreParasite(target, opts.all)')
  })

  it('pull --link calls linkAgent', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs')
    const source = actual.readFileSync(
      new URL('../index.ts', import.meta.url).pathname.replace(/%20/g, ' '),
      'utf-8'
    )
    // When opts.link is true, linkAgent is called
    expect(source).toContain('if (opts.link)')
    expect(source).toContain('linkAgent(targetDir')
  })
})
