export const IPC = {
  stateGet: 'state:get',
  accountCreate: 'account:create',
  accountUpdate: 'account:update',
  accountRemove: 'account:remove',
  accountStatus: 'account:status',
  projectCreate: 'project:create',
  projectUpdate: 'project:update',
  projectRemove: 'project:remove',
  sessionCreate: 'session:create',
  sessionRename: 'session:rename',
  sessionRemove: 'session:remove',
  settingsSetLanguage: 'settings:setLanguage',
  ptyStartSession: 'pty:startSession',
  ptyStartLogin: 'pty:startLogin',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',
  systemPickFolder: 'system:pickFolder',
  systemPathExists: 'system:pathExists',
  systemClaudeAvailable: 'system:claudeAvailable',
  menuOpenSettings: 'menu:openSettings'
} as const

export type IpcResult<T> = { ok: true; data: T } | { ok: false; code: string }

export const loginPtyId = (accountId: string): string => `login:${accountId}`
