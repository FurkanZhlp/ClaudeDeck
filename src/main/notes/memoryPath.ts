import { join } from 'node:path'

/** Claude Code names per-project folders after the cwd with every non-alphanumeric as "-". */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Folder where Claude Code keeps auto memory for a project under an account's config dir. */
export function memoryDir(configDir: string, projectPath: string): string {
  return join(configDir, 'projects', encodeProjectPath(projectPath), 'memory')
}
