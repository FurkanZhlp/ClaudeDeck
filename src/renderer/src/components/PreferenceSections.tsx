import { ChevronRight, RefreshCw } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { TEST_QUEUE_LIMITS } from '@shared/testQueueLimits'
import type { TestQueueMode, TestQueueSettingsPatch, TrayMetric, UsageDisplay } from '@shared/types'
import { isWindows } from '../platform'
import { useApp } from '../store'
import { BuiltinList } from '../testQueue/settings/BuiltinList'
import { CustomRules } from '../testQueue/settings/CustomRules'
import { HookStatusList } from '../testQueue/settings/HookStatusList'
import { NumberInput } from '../testQueue/settings/NumberInput'
import { TryCommand } from '../testQueue/settings/TryCommand'
import { useTestQueue } from '../testQueue/testQueueStore'
import { Button } from '../ui/Button'
import { Segmented } from '../ui/Segmented'
import { inputClass, sectionTitleClass } from '../ui/styles'
import { Switch } from '../ui/Switch'

const TRAY_AUTO = 'auto'
const TRAY_SELECTED = 'selected'

function Row({
  label,
  hint,
  children,
  disabled
}: {
  label: string
  hint?: string
  children: ReactNode
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className={`flex items-center justify-between gap-4 ${disabled ? 'text-muted' : ''}`}>
      <span className="min-w-0">
        <span className="block">{label}</span>
        {hint && <span className="block text-[12px] leading-snug text-muted">{hint}</span>}
      </span>
      {children}
    </div>
  )
}

/**
 * Settings > Usage: display mode and the macOS menu bar item. Windows has no tray yet, so its
 * menu bar options are hidden there.
 */
export function UsageSettingsSection(): React.JSX.Element | null {
  const { t } = useTranslation()
  const usage = useApp((s) => s.data?.settings.usage)
  const setUsageSettings = useApp((s) => s.setUsageSettings)
  if (!usage) return null

  return (
    <section className="mt-6 space-y-3">
      <h3 className={sectionTitleClass}>{t('settings.usage')}</h3>
      <Row label={t('settings.usageDisplay')}>
        <Segmented<UsageDisplay>
          label={t('settings.usageDisplay')}
          value={usage.display}
          options={[
            { value: 'used', label: t('settings.displayUsed') },
            { value: 'remaining', label: t('settings.displayRemaining') }
          ]}
          onChange={(display) => void setUsageSettings({ display })}
        />
      </Row>
      {!isWindows && <MenuBarSettings />}
    </section>
  )
}

function MenuBarSettings(): React.JSX.Element | null {
  const { t } = useTranslation()
  const usage = useApp((s) => s.data?.settings.usage)
  const accounts = useApp((s) => s.data?.accounts) ?? []
  const setUsageSettings = useApp((s) => s.setUsageSettings)
  if (!usage) return null
  const trayOff = !usage.trayEnabled

  return (
    <>
      <Switch
        label={t('settings.trayEnabled')}
        hint={t('settings.trayEnabledHint')}
        checked={usage.trayEnabled}
        onChange={(trayEnabled) => void setUsageSettings({ trayEnabled })}
      />
      <Row label={t('settings.trayMetric')} disabled={trayOff}>
        <Segmented<TrayMetric>
          label={t('settings.trayMetric')}
          value={usage.trayMetric}
          disabled={trayOff}
          options={[
            { value: 'session', label: t('settings.metricSession') },
            { value: 'weekly', label: t('settings.metricWeekly') },
            { value: 'both', label: t('settings.metricBoth') }
          ]}
          onChange={(trayMetric) => void setUsageSettings({ trayMetric })}
        />
      </Row>
      <Row label={t('settings.trayAccount')} disabled={trayOff}>
        <select
          aria-label={t('settings.trayAccount')}
          className={`${inputClass} max-w-52 disabled:opacity-50`}
          disabled={trayOff}
          value={usage.trayAccount}
          onChange={(event) => void setUsageSettings({ trayAccount: event.target.value })}
        >
          <option value={TRAY_AUTO}>{t('settings.trayAccountAuto')}</option>
          <option value={TRAY_SELECTED}>{t('settings.trayAccountSelected')}</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </Row>
    </>
  )
}

const subTitleClass = 'pt-2 text-[12px] font-medium text-muted'

/**
 * Settings > Test queue: the opt-in switch (it writes a hook into every account's Claude
 * settings), concurrency, rules and the hook status. Saved on change, like the other sections.
 */
export function TestQueueSettingsSection(): React.JSX.Element | null {
  const { t } = useTranslation()
  const settings = useApp((s) => s.data?.settings.testQueue)
  const saveSettings = useTestQueue((s) => s.saveSettings)
  if (!settings) return null

  const save = async (patch: TestQueueSettingsPatch): Promise<string | null> => {
    const code = await saveSettings(patch)
    if (code) useApp.getState().setError(code)
    return code
  }
  /** Fields without an empty state never commit null. */
  const whole =
    (commit: (value: number) => void) =>
    (value: number | null): void => {
      if (value !== null) commit(value)
    }
  const auto = settings.mode === 'auto'
  const L = TEST_QUEUE_LIMITS

  return (
    <section className="mt-6 space-y-3">
      <h3 className={sectionTitleClass}>{t('testQueue.title')}</h3>
      <Switch
        label={t('testQueue.settings.enabled')}
        hint={t('testQueue.settings.enabledHint')}
        checked={settings.enabled}
        onChange={(enabled) => void save({ enabled })}
      />
      {settings.enabled && (
        <>
          <Row
            label={t('testQueue.settings.mode')}
            hint={t(`testQueue.settings.modeHint.${settings.mode}`)}
          >
            <Segmented<TestQueueMode>
              label={t('testQueue.settings.mode')}
              value={settings.mode}
              options={[
                { value: 'fixed', label: t('testQueue.mode.fixed') },
                { value: 'auto', label: t('testQueue.mode.auto') }
              ]}
              onChange={(mode) => void save({ mode })}
            />
          </Row>
          {auto ? (
            <Row label={t('testQueue.settings.autoMax')} hint={t('testQueue.settings.autoMaxHint')}>
              <NumberInput
                label={t('testQueue.settings.autoMax')}
                value={settings.auto.maxConcurrent}
                min={L.autoMaxConcurrent.min}
                max={L.autoMaxConcurrent.max}
                allowEmpty
                placeholder={t('testQueue.settings.automatic')}
                onCommit={(maxConcurrent) => void save({ auto: { maxConcurrent } })}
              />
            </Row>
          ) : (
            <Row label={t('testQueue.settings.maxConcurrent')}>
              <NumberInput
                label={t('testQueue.settings.maxConcurrent')}
                value={settings.maxConcurrent}
                min={L.maxConcurrent.min}
                max={L.maxConcurrent.max}
                onCommit={whole((value) => void save({ maxConcurrent: value }))}
              />
            </Row>
          )}
          <Row label={t('testQueue.settings.maxWait')} hint={t('testQueue.settings.maxWaitHint')}>
            <NumberInput
              label={t('testQueue.settings.maxWait')}
              value={settings.maxWaitMinutes}
              min={L.maxWaitMinutes.min}
              max={L.maxWaitMinutes.max}
              unit={t('testQueue.settings.unitMinutes')}
              onCommit={whole((value) => void save({ maxWaitMinutes: value }))}
            />
          </Row>

          <details className="group/advanced rounded-lg border border-border">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 hover:bg-fg/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
              <ChevronRight
                size={13}
                aria-hidden
                className="text-muted transition-transform group-open/advanced:rotate-90 motion-reduce:transition-none"
              />
              {t('testQueue.settings.advanced')}
            </summary>
            <div className="space-y-2.5 px-3 pb-3 pt-1">
              {auto && (
                <>
                  <Row
                    label={t('testQueue.settings.cpuHigh')}
                    hint={t('testQueue.settings.cpuHighHint')}
                  >
                    <NumberInput
                      label={t('testQueue.settings.cpuHigh')}
                      value={settings.auto.cpuHighPercent}
                      min={L.cpuHighPercent.min}
                      max={L.cpuHighPercent.max}
                      unit="%"
                      onCommit={whole((value) => void save({ auto: { cpuHighPercent: value } }))}
                    />
                  </Row>
                  <Row
                    label={t('testQueue.settings.cpuResume')}
                    hint={t('testQueue.settings.cpuResumeHint')}
                  >
                    <NumberInput
                      label={t('testQueue.settings.cpuResume')}
                      value={settings.auto.cpuResumePercent}
                      min={L.cpuResumePercent.min}
                      max={Math.min(L.cpuResumePercent.max, settings.auto.cpuHighPercent - 1)}
                      unit="%"
                      onCommit={whole((value) => void save({ auto: { cpuResumePercent: value } }))}
                    />
                  </Row>
                  <Row
                    label={t('testQueue.settings.minMemory')}
                    hint={t('testQueue.settings.minMemoryHint')}
                  >
                    <NumberInput
                      label={t('testQueue.settings.minMemory')}
                      value={settings.auto.minAvailableMemoryPercent}
                      min={L.minAvailableMemoryPercent.min}
                      max={L.minAvailableMemoryPercent.max}
                      unit="%"
                      onCommit={whole(
                        (value) => void save({ auto: { minAvailableMemoryPercent: value } })
                      )}
                    />
                  </Row>
                  <Row
                    label={t('testQueue.settings.rampUp')}
                    hint={t('testQueue.settings.rampUpHint')}
                  >
                    <NumberInput
                      label={t('testQueue.settings.rampUp')}
                      value={settings.auto.rampUpSeconds}
                      min={L.rampUpSeconds.min}
                      max={L.rampUpSeconds.max}
                      unit={t('testQueue.settings.unitSeconds')}
                      onCommit={whole((value) => void save({ auto: { rampUpSeconds: value } }))}
                    />
                  </Row>
                </>
              )}
              <Row
                label={t('testQueue.settings.startGrace')}
                hint={t('testQueue.settings.startGraceHint')}
              >
                <NumberInput
                  label={t('testQueue.settings.startGrace')}
                  value={settings.startGraceSeconds}
                  min={L.startGraceSeconds.min}
                  max={L.startGraceSeconds.max}
                  unit={t('testQueue.settings.unitSeconds')}
                  onCommit={whole((value) => void save({ startGraceSeconds: value }))}
                />
              </Row>
              <Row
                label={t('testQueue.settings.backgroundHold')}
                hint={t('testQueue.settings.backgroundHoldHint')}
              >
                <NumberInput
                  label={t('testQueue.settings.backgroundHold')}
                  value={settings.backgroundMaxHoldMinutes}
                  min={L.backgroundMaxHoldMinutes.min}
                  max={L.backgroundMaxHoldMinutes.max}
                  unit={t('testQueue.settings.unitMinutes')}
                  onCommit={whole((value) => void save({ backgroundMaxHoldMinutes: value }))}
                />
              </Row>
            </div>
          </details>

          <h4 className={subTitleClass}>{t('testQueue.settings.builtins')}</h4>
          <BuiltinList
            disabled={settings.disabledBuiltins}
            onChange={(disabledBuiltins) => void save({ disabledBuiltins })}
          />

          <h4 className={subTitleClass}>{t('testQueue.settings.customRules')}</h4>
          <CustomRules
            patterns={settings.customPatterns}
            onSave={(customPatterns) => saveSettings({ customPatterns })}
          />

          <h4 className={subTitleClass}>{t('testQueue.try.title')}</h4>
          <TryCommand />

          <h4 className={subTitleClass}>{t('testQueue.hooks.title')}</h4>
          <HookStatusList />
        </>
      )}
    </section>
  )
}

/** Settings > General: login item. */
export function GeneralSettingsSection(): React.JSX.Element | null {
  const { t } = useTranslation()
  const launchAtLogin = useApp((s) => s.data?.settings.launchAtLogin)
  const setLaunchAtLogin = useApp((s) => s.setLaunchAtLogin)
  const [packaged, setPackaged] = useState(true)

  useEffect(() => {
    let alive = true
    window.api.app
      .packaged()
      .then((value) => alive && setPackaged(value))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  if (launchAtLogin === undefined) return null
  const hint = packaged
    ? t('settings.launchAtLoginHint')
    : `${t('settings.launchAtLoginHint')} ${t('settings.launchAtLoginDev')}`

  return (
    <section className="mt-6 space-y-2">
      <h3 className={sectionTitleClass}>{t('settings.general')}</h3>
      <Switch
        label={t('settings.launchAtLogin')}
        hint={hint}
        checked={launchAtLogin}
        onChange={(enabled) => void setLaunchAtLogin(enabled)}
      />
    </section>
  )
}

/** Settings > About: version and a manual update check (the app menu is macOS only). */
export function AboutSettingsSection(): React.JSX.Element {
  const { t } = useTranslation()
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.api.app
      .version()
      .then((value) => alive && setVersion(value))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  return (
    <section className="mt-6 space-y-2">
      <h3 className={sectionTitleClass}>{t('settings.about')}</h3>
      <Row label={version ? t('settings.version', { version }) : 'ClaudeDeck'}>
        <Button onClick={() => void window.api.app.checkUpdates()}>
          <RefreshCw size={14} />
          {t('settings.checkUpdates')}
        </Button>
      </Row>
    </section>
  )
}
