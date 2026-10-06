import { FolderOpen, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp, type ProjectDialogState } from '../store'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Modal } from '../ui/Modal'
import { inputClass } from '../ui/styles'

export function ProjectDialog(): React.JSX.Element | null {
  const dialog = useApp((s) => s.projectDialog)
  if (!dialog) return null
  return <ProjectForm key={dialog.mode === 'edit' ? dialog.projectId : 'create'} dialog={dialog} />
}

function ProjectForm({
  dialog
}: {
  dialog: NonNullable<ProjectDialogState>
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const data = useApp((s) => s.data)
  const setProjectDialog = useApp((s) => s.setProjectDialog)
  const setSettingsOpen = useApp((s) => s.setSettingsOpen)
  const saveProject = useApp((s) => s.saveProject)
  const removeProject = useApp((s) => s.removeProject)
  const selectedAccountId = useApp((s) => s.selectedAccountId)
  const editing =
    dialog.mode === 'edit' ? data?.projects.find((p) => p.id === dialog.projectId) : undefined
  const [name, setName] = useState(editing?.name ?? '')
  const [path, setPath] = useState(editing?.path ?? '')
  const [accountId, setAccountId] = useState(
    editing?.accountId ?? selectedAccountId ?? data?.accounts[0]?.id ?? ''
  )
  if (!data) return null

  const close = (): void => setProjectDialog(null)
  const pick = async (): Promise<void> => {
    const dir = await window.api.system.pickFolder()
    if (!dir) return
    setPath(dir)
    if (!name.trim()) setName(dir.split('/').filter(Boolean).at(-1) ?? '')
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void saveProject({ name, path, accountId }, editing?.id)
  }
  const remove = (): void => {
    if (editing && window.confirm(t('project.confirmDelete', { name: editing.name }))) {
      void removeProject(editing.id)
    }
  }
  const valid = name.trim() !== '' && path !== '' && accountId !== ''

  return (
    <Modal title={t(editing ? 'project.editTitle' : 'project.createTitle')} onClose={close}>
      {data.accounts.length === 0 ? (
        <div className="space-y-3">
          <p className="text-muted">{t('project.noAccounts')}</p>
          <Button
            variant="primary"
            onClick={() => {
              close()
              setSettingsOpen(true)
            }}
          >
            {t('project.openSettings')}
          </Button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <Field label={t('project.name')}>
            <input
              className={inputClass}
              value={name}
              placeholder={t('project.namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </Field>
          <Field label={t('project.path')}>
            <div className="flex gap-2">
              <input className={`${inputClass} flex-1`} value={path} readOnly />
              <Button onClick={() => void pick()}>
                <FolderOpen size={14} />
                {t('project.pickFolder')}
              </Button>
            </div>
          </Field>
          <Field label={t('project.account')}>
            <select
              className={inputClass}
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              {data.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email ? `${account.name} (${account.email})` : account.name}
                </option>
              ))}
            </select>
          </Field>
          {editing && accountId !== editing.accountId && (
            <p className="text-[12px] text-warn">{t('project.accountChangeNote')}</p>
          )}
          <div className="flex items-center justify-between pt-2">
            {editing ? (
              <Button variant="ghost" className="text-danger" onClick={remove}>
                <Trash2 size={14} />
                {t('common.delete')}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button onClick={close}>{t('common.cancel')}</Button>
              <Button type="submit" variant="primary" disabled={!valid}>
                {t('common.save')}
              </Button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  )
}
