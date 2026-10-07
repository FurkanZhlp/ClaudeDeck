/** Accepted ranges for test queue settings; main clamps to them, the UI uses them for inputs. */
export const TEST_QUEUE_LIMITS = {
  maxConcurrent: { min: 1, max: 32 },
  autoMaxConcurrent: { min: 1, max: 32 },
  cpuHighPercent: { min: 10, max: 100 },
  /** Also kept below cpuHighPercent. */
  cpuResumePercent: { min: 5, max: 99 },
  minAvailableMemoryPercent: { min: 0, max: 90 },
  rampUpSeconds: { min: 0, max: 600 },
  maxWaitMinutes: { min: 1, max: 240 },
  startGraceSeconds: { min: 10, max: 900 },
  backgroundMaxHoldMinutes: { min: 1, max: 480 },
  /** Custom rules per list (global or per project). */
  maxPatterns: 100,
  maxPatternLength: 300,
  /** Disabled built-in ids per list. */
  maxDisabledBuiltins: 200
} as const

/** Pattern and built-in rule ids. */
export const TEST_RULE_ID = /^[A-Za-z0-9_.:-]{1,64}$/
