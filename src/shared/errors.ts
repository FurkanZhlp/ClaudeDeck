export type ErrorCode =
  | 'ACCOUNT_IN_USE'
  | 'ACCOUNT_RUNNING'
  | 'NOT_FOUND'
  | 'INVALID'
  | 'PATH_MISSING'
  | 'CLAUDE_NOT_FOUND'
  /** The feature is not available on this operating system yet (e.g. optimize on Windows). */
  | 'UNSUPPORTED'
  | 'UNKNOWN'

export class DomainError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code)
    this.name = 'DomainError'
  }
}
