import type { UsageDisplay } from '@shared/types'
import { useApp } from '../store'

/** Whether usage is shown as used or remaining percentage (Settings > Usage). */
export const useUsageDisplay = (): UsageDisplay =>
  useApp((s) => s.data?.settings.usage.display ?? 'used')
