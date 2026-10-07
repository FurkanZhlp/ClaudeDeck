import { compareVersions } from '../../shared/version'
import type { UpdateInfo } from '../../shared/types'

export const REPO = 'FurkanZhlp/ClaudeDeck'
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`
const RELEASES_PATH = `/${REPO}/releases/`

/**
 * Windows NSIS installer name template. electron-builder's `nsis.artifactName` must be exactly
 * this, or Windows clients never see an update (see isInstallerFor).
 */
export const WINDOWS_ARTIFACT_NAME = '${name}-${version}-${arch}-setup.${ext}'

/** The part of a Windows installer name that identifies its arch, e.g. `-x64-setup.exe`. */
function windowsInstallerSuffix(arch: string): string {
  const template = WINDOWS_ARTIFACT_NAME.slice(WINDOWS_ARTIFACT_NAME.indexOf('-${arch}'))
  return template.replace('${arch}', arch).replace('${ext}', 'exe').toLowerCase()
}

/** The platform and CPU architecture an update has to ship an installer for. */
export interface UpdateTarget {
  platform: NodeJS.Platform
  arch: string
}

interface GitHubRelease {
  tag_name?: unknown
  html_url?: unknown
  draft?: unknown
  assets?: unknown
}

const currentTarget = (): UpdateTarget => ({ platform: process.platform, arch: process.arch })

/** Whether an asset name is the Windows installer for the target (see WINDOWS_ARTIFACT_NAME). */
export function isInstallerFor(name: string, target: UpdateTarget): boolean {
  if (target.platform !== 'win32') return false
  return name.toLowerCase().endsWith(windowsInstallerSuffix(target.arch))
}

/**
 * Only Windows requires a matching installer: Windows builds lag the macOS one, so a release
 * without them must not prompt Windows users. macOS keeps the earlier behaviour (no asset check),
 * so an update is not hidden while the .dmg is still uploading.
 */
function hasInstaller(assets: unknown, target: UpdateTarget): boolean {
  if (target.platform !== 'win32') return true
  if (!Array.isArray(assets)) return false
  return assets.some((asset: unknown) => {
    const name = (asset as { name?: unknown } | null)?.name
    return typeof name === 'string' && isInstallerFor(name, target)
  })
}

/**
 * The normalised release page URL, or null unless it is https://github.com/<repo>/releases/...
 * (checked after parsing, so dot segments, credentials and other hosts or ports are rejected).
 */
export function releasePageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  const ok =
    parsed.protocol === 'https:' &&
    parsed.host === 'github.com' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.pathname.startsWith(RELEASES_PATH) &&
    !parsed.pathname.split('/').some((segment) => segment === '..' || /^%2e%2e$/i.test(segment))
  return ok ? parsed.href : null
}

/**
 * GitHub yanıtını yorumlar; yalnızca github.com/<repo>/releases altındaki adresler kabul edilir.
 * On Windows a newer release only counts when it ships the installer for this arch.
 */
export function parseLatestRelease(
  json: unknown,
  currentVersion: string,
  target: UpdateTarget = currentTarget()
): UpdateInfo {
  const release = (json ?? {}) as GitHubRelease
  const latest = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/i, '') : null
  const url = releasePageUrl(release.html_url) ?? RELEASES_URL
  const available =
    !!latest &&
    release.draft !== true &&
    compareVersions(latest, currentVersion) > 0 &&
    hasInstaller(release.assets, target)
  return { currentVersion, latestVersion: latest, available, url }
}

export async function checkForUpdate(
  currentVersion: string,
  fetchFn: typeof fetch,
  target: UpdateTarget = currentTarget()
): Promise<UpdateInfo> {
  const response = await fetchFn(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ClaudeDeck' }
  })
  // Henüz hiç release yoksa GitHub 404 döner.
  if (response.status === 404) return parseLatestRelease(null, currentVersion, target)
  if (!response.ok) throw new Error(`GitHub ${response.status}`)
  return parseLatestRelease(await response.json(), currentVersion, target)
}
