import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { loginPtyId } from '@shared/ipc'
import { errorCode, useApp } from '../store'
import { TerminalView } from '../terminal/TerminalView'
import * as pool from '../terminal/terminalPool'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'

export function LoginDialog(): React.JSX.Element | null {
  const accountId = useApp((s) => s.loginAccountId)
  return accountId ? <LoginContent key={accountId} accountId={accountId} /> : null
}

function LoginContent({ accountId }: { accountId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const account = useApp((s) => s.data?.accounts.find((a) => a.id === accountId))
  const setLoginAccount = useApp((s) => s.setLoginAccount)
  const refreshStatus = useApp((s) => s.refreshStatus)
  const setError = useApp((s) => s.setError)
  const [done, setDone] = useState(false)
  const started = useRef(false)
  const ptyId = loginPtyId(accountId)

  useEffect(
    () =>
      window.api.pty.onExit((id) => {
        if (id !== ptyId) return
        setDone(true)
        void refreshStatus(accountId)
      }),
    [ptyId, accountId, refreshStatus]
  )

  const close = useCallback(() => {
    void window.api.pty.kill(ptyId)
    pool.dispose(ptyId)
    setLoginAccount(null)
    void refreshStatus(accountId)
  }, [ptyId, accountId, setLoginAccount, refreshStatus])

  const onReady = (cols: number, rows: number): void => {
    if (started.current) return
    started.current = true
    window.api.pty.startLogin(accountId, cols, rows).catch((error) => setError(errorCode(error)))
  }

  if (!account) return null
  return (
    <Modal
      title={t('login.title', { name: account.name })}
      onClose={close}
      width="max-w-3xl"
      closeOnEscape={false}
    >
      <p className="mb-3 text-muted">{done ? t('login.done') : t('login.hint')}</p>
      <div className="h-80 overflow-hidden rounded-md border border-border">
        <TerminalView id={ptyId} onReady={onReady} />
      </div>
      <div className="mt-3 flex justify-end">
        <Button variant="primary" onClick={close}>
          {t('common.close')}
        </Button>
      </div>
    </Modal>
  )
}
