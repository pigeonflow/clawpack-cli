import * as path from 'path'
import * as fs from 'fs'
import { execSync, spawnSync, SpawnSyncOptions, SpawnSyncReturns } from 'child_process'

const isWindows = process.platform === 'win32'

interface OcBin {
  cmd: string
  baseArgs: string[]
}

/**
 * Resolve how to invoke openclaw without shell.
 *
 * On Windows, .cmd shims can't be spawned directly without shell:true.
 * Instead we read the .cmd to find the actual .mjs entry point and
 * invoke `node <path/to/openclaw.mjs>` directly.
 */
function resolveOcBin(): OcBin {
  if (isWindows) {
    try {
      const cmdPath = execSync('where openclaw.cmd', { encoding: 'utf-8' })
        .trim().split('\n')[0].trim()
      // The .cmd file always ends with: "%_prog%" "%dp0%\node_modules\openclaw\openclaw.mjs" %*
      // Extract the directory and build the mjs path.
      const dir = path.dirname(cmdPath)
      const mjsPath = path.join(dir, 'node_modules', 'openclaw', 'openclaw.mjs')
      if (fs.existsSync(mjsPath)) {
        return { cmd: process.execPath, baseArgs: [mjsPath] }
      }
    } catch {}
    // fallback: try cmd.exe as last resort
    return { cmd: 'cmd.exe', baseArgs: ['/d', '/s', '/c', 'openclaw'] }
  }

  // Unix: just use the binary name directly
  try {
    const bin = execSync('which openclaw', { encoding: 'utf-8' }).trim()
    if (bin) return { cmd: bin, baseArgs: [] }
  } catch {}
  return { cmd: 'openclaw', baseArgs: [] }
}

export const OC_BIN = resolveOcBin()

export function isOpenclawInstalled(): boolean {
  const result = spawnSync(OC_BIN.cmd, [...OC_BIN.baseArgs, '--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return !result.error && result.status === 0
}

/** Run `openclaw <args>` synchronously, returns stdout */
export function oc(...args: string[]): string {
  const result = spawnSync(OC_BIN.cmd, [...OC_BIN.baseArgs, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 35000,
  } as SpawnSyncOptions) as SpawnSyncReturns<string>
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error((result.stderr || '').trim() || `openclaw exited with code ${result.status}`)
  return (result.stdout || '').trim()
}

/** Run `openclaw <args>` inheriting stdout/stderr (for install/setup commands) */
export function ocInherit(...args: string[]): void {
  spawnSync(OC_BIN.cmd, [...OC_BIN.baseArgs, ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 35000,
  })
}
