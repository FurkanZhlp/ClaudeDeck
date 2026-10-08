import { LogIn, Pencil, Plus, RotateCw, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Account, Language } from '@shared/types'
import { ProfileSection } from '../onboarding/ProfileSection'
import { ClaudePermissionsSection } from '../permissions/PermissionSections'
import {
  AboutSettingsSection,
  GeneralSettingsSection,
  TestQueueSettingsSection,
  UsageSettingsSection
} from './PreferenceSections'
import { useOnboarding } from '../onboarding/onboardingStore'
import { useApp } from '../store'
import { AccountDot } from '../ui/AccountDot'
import { Button } from '../ui/Button'
import { ColorPicker } from '../ui/ColorPicker'
import { Field } from '../ui/Field'
import { Modal } from '../ui/Modal'
import { ACCOUNT_COLORS, inputClass, sectionTitleClass } from '../ui/styles'

export function SettingsDialog(): React.JSX.Element | null {
  const open = useApp((s) => s.settingsOpen)
  return open ? <SettingsContent /> : null
}

function SettingsContent(): React.JSX.Element | null {
  const { t } = useTranslation()
  const data = useApp((s) => s.data)
  const setSettingsOpen = useApp((s) => s.setSettingsOpen)
  const setLanguage = useApp((s) => s.setLanguage)
  const createAccount = useApp((s) => s.createAccount)
  const [name, setName] = useState('')
  const [color, setColor] = useState(ACCOUNT_COLORS[0])
  if (!data) return null

  const add = (event: FormEvent): void => {
    event.preventDefault()
    if (!name.trim()) return
    void createAccount({ name, color }).then((accountId) => {
      setName('')
      if (accountId) useOnboarding.getState().startForAccount(accountId, { startAt: 'signIn' })
    })
  }

  return (
    <Modal title={t('settings.title')} onClose={() => setSettingsOpen(false)} width="max-w-2xl">
      <section className="space-y-3">
        <h3 className={sectionTitleClass}>{t('settings.accounts')}</h3>
        {data.accounts.length === 0 && <p className="text-muted">{t('settings.noAccounts')}</p>}
        <ul className="space-y-2">
          {data.accounts.map((account) => (
            <AccountRow key={account.id} account={account} />
          ))}
        </ul>
        <form
          onSubmit={add}
          className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-border p-3"
        >
          <Field label={t('settings.accountName')} className="min-w-48 flex-1">
            <input
              className={inputClass}
              value={name}
              placeholder={t('settings.accountNamePlaceholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <div className="space-y-1.5">
            <span className="block text-[12px] font-medium text-muted">{t('settings.color')}</span>
            <ColorPicker value={color} onChange={setColor} label={t('settings.color')} />
          </div>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            <Plus size={14} />
            {t('settings.addAccount')}
          </Button>
        </form>
      </section>

      <UsageSettingsSection />
      <GeneralSettingsSection />
      <ClaudePermissionsSection />
      <TestQueueSettingsSection />

      <section className="mt-6 space-y-2">
        <h3 className={sectionTitleClass}>{t('settings.language')}</h3>
        <select
          className={`${inputClass} max-w-60`}
          value={data.settings.language ?? 'system'}
          onChange={(event) =>
            void setLanguage(
              event.target.value === 'system' ? null : (event.target.value as Language)
            )
          }
        >
          <option value="system">{t('settings.languageSystem')}</option>
          <option value="tr">Türkçe</option>
          <option value="en">English</option>
        </select>
      </section>

      <AboutSettingsSection />
    </Modal>
  )
}

function AccountRow({ account }: { account: Account }): React.JSX.Element {
  const { t } = useTranslation()
  const status = useApp((s) => s.statuses[account.id])
  const inUse = useApp((s) => !!s.data?.projects.some((p) => p.accountId === account.id))
  const refreshStatus = useApp((s) => s.refreshStatus)
  const setLoginAccount = useApp((s) => s.setLoginAccount)
  const removeAccount = useApp((s) => s.removeAccount)
  const setError = useApp((s) => s.setError)
  const [confirming, setConfirming] = useState(false)
  const [deleteFiles, setDeleteFiles] = useState(true)
  const [editing, setEditing] = useState(false)

  const loggedIn = typeof status === 'object' && status.loggedIn
  const label =
    typeof status !== 'object'
      ? t('settings.checking')
      : status.loggedIn
        ? [t('settings.loggedIn'), status.email].filter(Boolean).join(' · ')
        : t('settings.loggedOut')

  if (editing) {
    return (
      <li className="animate-fade-up rounded-lg border border-accent/50 bg-bg p-3">
        <AccountEditForm account={account} onDone={() => setEditing(false)} />
      </li>
    )
  }

  return (
    <li className="rounded-lg border border-border bg-bg p-3">
      <div className="flex items-center gap-3">
        <AccountDot color={account.color} size={10} />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{account.name}</div>
          <div className={`truncate text-[12px] ${loggedIn ? 'text-ok' : 'text-muted'}`}>
            {label}
          </div>
        </div>
        <Button
          variant="ghost"
          aria-label={t('settings.refresh')}
          data-tooltip={t('settings.refresh')}
          onClick={() => void refreshStatus(account.id)}
        >
          <RotateCw size={14} />
        </Button>
        <Button
          variant="ghost"
          aria-label={t('settings.edit')}
          data-tooltip={t('settings.edit')}
          onClick={() => {
            setConfirming(false)
            setEditing(true)
          }}
        >
          <Pencil size={14} />
        </Button>
        <Button onClick={() => setLoginAccount(account.id)}>
          <LogIn size={14} />
          {loggedIn ? t('settings.relogin') : t('settings.login')}
        </Button>
        <Button
          variant="ghost"
          aria-label={t('settings.remove')}
          data-tooltip={t('settings.remove')}
          onClick={() => (inUse ? setError('ACCOUNT_IN_USE') : setConfirming(true))}
        >
          <Trash2 size={14} />
        </Button>
      </div>
      <div className="mt-3 border-t border-border pt-3">
        <ProfileSection accountId={account.id} />
      </div>
      {confirming && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <p>{t('settings.removeConfirm', { name: account.name })}</p>
          <label className="flex items-center gap-2 text-muted">
            <input
              type="checkbox"
              checked={deleteFiles}
              onChange={(event) => setDeleteFiles(event.target.checked)}
            />
            {t('settings.removeFiles')}
          </label>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={() => void removeAccount(account.id, deleteFiles)}>
              {t('settings.remove')}
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}

function AccountEditForm({
  account,
  onDone
}: {
  account: Account
  onDone: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const updateAccount = useApp((s) => s.updateAccount)
  const [name, setName] = useState(account.name)
  const [color, setColor] = useState(account.color)
  const changed = name.trim() !== account.name || color !== account.color

  const save = (event: FormEvent): void => {
    event.preventDefault()
    if (!name.trim()) return
    if (!changed) return onDone()
    void updateAccount(account.id, { name, color }).then((ok) => ok && onDone())
  }

  return (
    <form className="space-y-3" onSubmit={save}>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('settings.accountName')} className="min-w-48 flex-1">
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              // Keep Escape from closing the whole settings dialog.
              if (event.key === 'Escape') {
                event.stopPropagation()
                onDone()
              }
            }}
            autoFocus
          />
        </Field>
        <div className="space-y-1.5">
          <span className="block text-[12px] font-medium text-muted">{t('settings.color')}</span>
          <ColorPicker value={color} onChange={setColor} label={t('settings.color')} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-muted">
          <AccountDot color={color} size={10} />
          <span className="truncate">{name.trim() || account.name}</span>
        </span>
        <div className="flex gap-2">
          <Button onClick={onDone}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </form>
  )
}
