import type { LucideIcon } from 'lucide-react'
import {
  Gauge,
  Info,
  KeyRound,
  ListChecks,
  ShieldCheck,
  SlidersHorizontal,
  UsersRound
} from 'lucide-react'
import type { ComponentType } from 'react'
import { ClaudePermissionsSection } from '../permissions/PermissionSections'
import { AboutSection } from './sections/AboutSection'
import { AccountsSection } from './sections/AccountsSection'
import { GeneralSection } from './sections/GeneralSection'
import { GuardSection } from './sections/GuardSection'
import { TestQueueSection } from './sections/TestQueueSection'
import { UsageSection } from './sections/UsageSection'
import type { SettingsSectionId } from './sectionIds'

export type SettingsGroupId = 'accounts' | 'app'

export interface SettingsGroup {
  id: SettingsGroupId
  /** i18n key of the group heading in the navigation. */
  labelKey: string
}

/**
 * One page of the settings view. The view renders the page title and description from the
 * keys, so `component` renders only the controls (no own heading or outer margin).
 */
export interface SettingsSection {
  id: SettingsSectionId
  group: SettingsGroupId
  /** i18n key of the navigation label and page title. */
  labelKey: string
  /** i18n key of the sentence under the page title. */
  descriptionKey?: string
  icon: LucideIcon
  component: ComponentType
  /** Whether the section is offered at all (platform, feature availability). */
  visible: () => boolean
}

const always = (): boolean => true

export const settingsGroups: readonly SettingsGroup[] = [
  { id: 'accounts', labelKey: 'settings.nav.groups.accounts' },
  { id: 'app', labelKey: 'settings.nav.groups.app' }
]

/** Navigation order. A new section is added here. */
export const settingsSections: readonly SettingsSection[] = [
  {
    id: 'accounts',
    group: 'accounts',
    labelKey: 'settings.sections.accounts.label',
    descriptionKey: 'settings.sections.accounts.description',
    icon: UsersRound,
    component: AccountsSection,
    visible: always
  },
  {
    id: 'claude',
    group: 'app',
    labelKey: 'settings.sections.claude.label',
    descriptionKey: 'settings.sections.claude.description',
    icon: KeyRound,
    component: ClaudePermissionsSection,
    visible: always
  },
  {
    id: 'guard',
    group: 'app',
    labelKey: 'settings.sections.guard.label',
    descriptionKey: 'settings.sections.guard.description',
    icon: ShieldCheck,
    component: GuardSection,
    visible: always
  },
  {
    id: 'testQueue',
    group: 'app',
    labelKey: 'settings.sections.testQueue.label',
    descriptionKey: 'settings.sections.testQueue.description',
    icon: ListChecks,
    component: TestQueueSection,
    visible: always
  },
  {
    id: 'usage',
    group: 'app',
    labelKey: 'settings.sections.usage.label',
    descriptionKey: 'settings.sections.usage.description',
    icon: Gauge,
    component: UsageSection,
    visible: always
  },
  {
    id: 'general',
    group: 'app',
    labelKey: 'settings.sections.general.label',
    descriptionKey: 'settings.sections.general.description',
    icon: SlidersHorizontal,
    component: GeneralSection,
    visible: always
  },
  {
    id: 'about',
    group: 'app',
    labelKey: 'settings.sections.about.label',
    descriptionKey: 'settings.sections.about.description',
    icon: Info,
    component: AboutSection,
    visible: always
  }
]

/** Sections offered on this machine, in navigation order. */
export const visibleSettingsSections = (): SettingsSection[] =>
  settingsSections.filter((section) => section.visible())

/** The section to show for a requested id: itself when offered, otherwise the first one. */
export function resolveSettingsSection(
  id: SettingsSectionId,
  sections: readonly SettingsSection[]
): SettingsSection | undefined {
  return sections.find((section) => section.id === id) ?? sections[0]
}
