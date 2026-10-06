import { compareVersions } from '../../shared/version'
import type { UpdateInfo } from '../../shared/types'

export const REPO = 'FurkanZhlp/ClaudeDeck'
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`

interface GitHubRelease {
  tag_name?: unknown
  html_url?: unknown
  draft?: unknown
}

/** GitHub yanıtını yorumlar; yalnızca github.com/<repo>/releases altındaki adresler kabul edilir. */
export function parseLatestRelease(json: unknown, currentVersion: string): UpdateInfo {
  const release = (json ?? {}) as GitHubRelease
  const latest = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/i, '') : null
  const url =
    typeof release.html_url === 'string' &&
    release.html_url.startsWith(`https://github.com/${REPO}/releases/`)
      ? release.html_url
      : RELEASES_URL
  const available =
    !!latest && release.draft !== true && compareVersions(latest, currentVersion) > 0
  return { currentVersion, latestVersion: latest, available, url }
}

export async function checkForUpdate(
  currentVersion: string,
  fetchFn: typeof fetch
): Promise<UpdateInfo> {
  const response = await fetchFn(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ClaudeDeck' }
  })
  // Henüz hiç release yoksa GitHub 404 döner.
  if (response.status === 404) return parseLatestRelease(null, currentVersion)
  if (!response.ok) throw new Error(`GitHub ${response.status}`)
  return parseLatestRelease(await response.json(), currentVersion)
}
