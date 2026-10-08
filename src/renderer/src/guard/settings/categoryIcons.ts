import type { LucideIcon } from 'lucide-react'
import {
  CloudDownload,
  Container,
  Cpu,
  Database,
  FileLock,
  GitBranch,
  HardDrive,
  ListPlus,
  Rocket
} from 'lucide-react'
import type { GuardCategoryId } from '@shared/types'

export const CATEGORY_ICONS: Record<GuardCategoryId | 'custom', LucideIcon> = {
  disk: HardDrive,
  sensitive: FileLock,
  git: GitBranch,
  fetchExec: CloudDownload,
  docker: Container,
  database: Database,
  publish: Rocket,
  system: Cpu,
  custom: ListPlus
}

export const subTitleClass = 'pt-2 text-[12px] font-medium text-muted'
