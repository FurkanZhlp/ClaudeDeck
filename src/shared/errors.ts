export type ErrorCode =
  | 'ACCOUNT_IN_USE'
  | 'ACCOUNT_RUNNING'
  | 'NOT_FOUND'
  | 'INVALID'
  | 'PATH_MISSING'
  | 'CLAUDE_NOT_FOUND'
  | 'UNKNOWN'

export class DomainError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code)
    this.name = 'DomainError'
  }
}
