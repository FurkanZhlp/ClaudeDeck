import { statSync } from 'node:fs'
import { expect, it } from 'vitest'

/** True when the suite runs on Windows. */
export const isWindows = process.platform === 'win32'

/** A test that only makes sense on macOS / Linux (`/bin/sh`, real symlinks). */
export const posixOnly = it.skipIf(isWindows)

/** A test that needs a real Windows host (PowerShell, junctions, file locking). */
export const windowsOnly = it.runIf(isWindows)

/**
 * Asserts the permission bits of `path`. Windows does not store POSIX modes (`stat` reports
 * 0o666 / 0o777 there, the `%APPDATA%` ACL is the boundary), so the check only runs elsewhere.
 */
export function expectMode(path: string, mode: number): void {
  if (isWindows) return
  expect(statSync(path).mode & 0o777).toBe(mode)
}

type PlatformModule = typeof import('../main/platform')

/**
 * `vi.mock('../platform', ...)` factory body: the real module, but `claudeLaunch` and
 * `spawnDefaults` always produce the macOS spec (login shell, process group). Lets tests of code
 * that spawns claude run on any host without a claude.exe; the win32 spec has its own tests in
 * platform/launch.test.ts.
 */
export function withDarwinLaunch(actual: PlatformModule): PlatformModule {
  const darwin = actual.createPlatform('darwin')
  return {
    ...actual,
    platform: {
      ...actual.platform,
      claudeLaunch: darwin.claudeLaunch,
      spawnDefaults: darwin.spawnDefaults
    }
  }
}
