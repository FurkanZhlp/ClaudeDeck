import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { TEST_QUEUE_LIMITS } from '@shared/testQueueLimits'
import type { TestQueueMode, TestQueueSettingsPatch } from '@shared/types'
import { useApp } from '../../store'
import { BuiltinList } from '../../testQueue/settings/BuiltinList'
import { CustomRules } from '../../testQueue/settings/CustomRules'
import { HookStatusList } from '../../testQueue/settings/HookStatusList'
import { NumberInput } from '../../testQueue/settings/NumberInput'
import { TryCommand } from '../../testQueue/settings/TryCommand'
import { useTestQueue } from '../../testQueue/testQueueStore'
import { Segmented } from '../../ui/Segmented'
import { Switch } from '../../ui/Switch'
import { SettingRow } from '../SettingRow'

const subTitleClass = 'pt-2 text-[12px] font-medium text-muted'

/**
 * Settings > Test queue: the opt-in switch (it writes a hook into every account's Claude
 * settings), concurrency, rules and the hook status. Saved on change, like the other sections.
 */
export function TestQueueSection(): React.JSX.Element | null {
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
    <div className="space-y-3">
      <Switch
        label={t('testQueue.settings.enabled')}
        hint={t('testQueue.settings.enabledHint')}
        checked={settings.enabled}
        onChange={(enabled) => void save({ enabled })}
      />
      {settings.enabled && (
        <>
          <SettingRow
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
          </SettingRow>
          {auto ? (
            <SettingRow
              label={t('testQueue.settings.autoMax')}
              hint={t('testQueue.settings.autoMaxHint')}
            >
              <NumberInput
                label={t('testQueue.settings.autoMax')}
                value={settings.auto.maxConcurrent}
                min={L.autoMaxConcurrent.min}
                max={L.autoMaxConcurrent.max}
                allowEmpty
                placeholder={t('testQueue.settings.automatic')}
                onCommit={(maxConcurrent) => void save({ auto: { maxConcurrent } })}
              />
            </SettingRow>
          ) : (
            <SettingRow label={t('testQueue.settings.maxConcurrent')}>
              <NumberInput
                label={t('testQueue.settings.maxConcurrent')}
                value={settings.maxConcurrent}
                min={L.maxConcurrent.min}
                max={L.maxConcurrent.max}
                onCommit={whole((value) => void save({ maxConcurrent: value }))}
              />
            </SettingRow>
          )}
          <SettingRow
            label={t('testQueue.settings.maxWait')}
            hint={t('testQueue.settings.maxWaitHint')}
          >
            <NumberInput
              label={t('testQueue.settings.maxWait')}
              value={settings.maxWaitMinutes}
              min={L.maxWaitMinutes.min}
              max={L.maxWaitMinutes.max}
              unit={t('testQueue.settings.unitMinutes')}
              onCommit={whole((value) => void save({ maxWaitMinutes: value }))}
            />
          </SettingRow>

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
                  <SettingRow
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
                  </SettingRow>
                  <SettingRow
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
                  </SettingRow>
                  <SettingRow
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
                  </SettingRow>
                  <SettingRow
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
                  </SettingRow>
                </>
              )}
              <SettingRow
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
              </SettingRow>
              <SettingRow
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
              </SettingRow>
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
    </div>
  )
}
