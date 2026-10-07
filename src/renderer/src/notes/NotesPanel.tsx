import { FileText, FolderOpen, NotebookText, SquarePen, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { NoteFile } from '@shared/types'
import { errorCode, useApp } from '../store'
import { sectionTitleClass } from '../ui/styles'
import { resolveNoteLink } from './links'
import { useNotes } from './notesStore'
import { formatRelative } from './relativeTime'
import { pickNote, useNoteList } from './useNoteList'
import './notes.css'

const CLOCK_TICK_MS = 60_000

const report = (error: unknown): void => useApp.getState().setError(errorCode(error))

const iconButtonClass =
  'no-drag rounded p-1.5 text-muted transition-colors hover:bg-elevated hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40'

const displayName = (name: string): string => name.replace(/\.md$/i, '')

type Shown = { projectId: string; name: string; content: string }

export function NotesPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const projectName = useApp((s) => s.data?.projects.find((p) => p.id === projectId)?.name ?? '')
  const remembered = useNotes((s) => s.selected[projectId])
  const select = useNotes((s) => s.select)
  const setOpen = useNotes((s) => s.setOpen)
  const { notes, version } = useNoteList(projectId)
  const current = notes ? pickNote(notes, remembered) : null

  // Watch the memory folder while the panel shows this project.
  useEffect(() => {
    window.api.notes.watch(projectId).catch(report)
    return () => {
      window.api.notes.unwatch(projectId).catch(() => undefined)
    }
  }, [projectId])

  // Read the selected note again after every list reload; keep the old text until it arrives.
  const [shown, setShown] = useState<Shown | null>(null)
  useEffect(() => {
    if (!current || version === 0) return
    let active = true
    window.api.notes.read(projectId, current).then(
      (content) => {
        if (active) setShown({ projectId, name: current, content })
      },
      (error: unknown) => {
        if (active) report(error)
      }
    )
    return () => {
      active = false
    }
  }, [projectId, current, version])

  // A different note starts at the top; a reload of the same note keeps its scroll position.
  const previewRef = useRef<HTMLDivElement>(null)
  const shownKey = shown ? `${shown.projectId}/${shown.name}` : ''
  useLayoutEffect(() => {
    previewRef.current?.scrollTo({ top: 0 })
  }, [shownKey])

  const visible = shown && shown.projectId === projectId && shown.name === current ? shown : null
  const names = notes?.map((n) => n.name) ?? []

  const components: Components = {
    a: ({ href, children }) => (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault()
          const link = resolveNoteLink(href, names)
          if (link?.kind === 'note') select(projectId, link.name)
          else if (link?.kind === 'external') window.open(link.url)
        }}
      >
        {children}
      </a>
    ),
    // Notes never load images (no remote requests from note content); show the alt text.
    img: ({ alt }) => (alt ? <span className="notes-image-alt">{alt}</span> : null)
  }

  return (
    <aside
      aria-label={t('notes.title')}
      className="notes-panel-in flex w-[360px] shrink-0 flex-col border-l border-border bg-panel"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <NotebookText size={15} className="shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13px] font-semibold leading-tight">{t('notes.title')}</h2>
          <div className="truncate text-[11px] leading-tight text-muted">{projectName}</div>
        </div>
        <button
          type="button"
          className={iconButtonClass}
          aria-label={t('notes.openInEditor')}
          data-tooltip={t('notes.openInEditor')}
          disabled={!current}
          onClick={() => current && window.api.notes.open(projectId, current).catch(report)}
        >
          <SquarePen size={15} />
        </button>
        <button
          type="button"
          className={iconButtonClass}
          aria-label={t('notes.reveal')}
          data-tooltip={t('notes.reveal')}
          onClick={() => window.api.notes.reveal(projectId).catch(report)}
        >
          <FolderOpen size={15} />
        </button>
        <button
          type="button"
          className={iconButtonClass}
          aria-label={t('notes.close')}
          data-tooltip={t('notes.close')}
          onClick={() => setOpen(false)}
        >
          <X size={15} />
        </button>
      </header>

      {notes && notes.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <NoteList
            notes={notes ?? []}
            current={current}
            onSelect={(name) => select(projectId, name)}
          />
          <div ref={previewRef} className="scroll-area min-h-0 flex-1 overflow-y-auto bg-elevated">
            {visible &&
              (visible.content.trim() ? (
                <article className="notes-markdown">
                  <Markdown remarkPlugins={[remarkGfm]} components={components}>
                    {visible.content}
                  </Markdown>
                </article>
              ) : (
                <p className="px-5 py-6 text-muted">{t('notes.emptyNote')}</p>
              ))}
          </div>
        </>
      )}
    </aside>
  )
}

function NoteList({
  notes,
  current,
  onSelect
}: {
  notes: NoteFile[]
  current: string | null
  onSelect: (name: string) => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const listRef = useRef<HTMLUListElement>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  const move = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    const index = notes.findIndex((n) => n.name === current)
    const last = notes.length - 1
    const next =
      event.key === 'ArrowDown'
        ? Math.min(index + 1, last)
        : event.key === 'ArrowUp'
          ? Math.max(index - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null
    if (next === null || next < 0) return
    event.preventDefault()
    const name = notes[next].name
    onSelect(name)
    listRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus()
  }

  return (
    <div className="shrink-0 border-b border-border">
      <div className={`px-4 pb-1 pt-3 ${sectionTitleClass}`}>{t('notes.listLabel')}</div>
      <ul
        ref={listRef}
        role="listbox"
        aria-label={t('notes.listLabel')}
        className="max-h-[38vh] overflow-y-auto px-2 pb-2"
        onKeyDown={move}
      >
        {notes.map((note, index) => {
          const active = note.name === current
          return (
            <li
              key={note.name}
              role="option"
              aria-selected={active}
              data-index={index}
              tabIndex={active ? 0 : -1}
              className={`flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent ${active ? 'bg-elevated text-fg' : 'text-muted hover:bg-elevated/60 hover:text-fg'}`}
              onClick={() => onSelect(note.name)}
            >
              <FileText size={13} className="shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-medium">{displayName(note.name)}</span>
              <time
                dateTime={new Date(note.updatedAt).toISOString()}
                className="shrink-0 text-[11px] tabular-nums text-muted"
                title={t('notes.updated', {
                  time: new Date(note.updatedAt).toLocaleString(i18n.language)
                })}
              >
                {formatRelative(note.updatedAt, i18n.language, now)}
              </time>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function EmptyState(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-elevated text-muted">
        <NotebookText size={20} aria-hidden />
      </div>
      <h3 className="text-[14px] font-semibold">{t('notes.emptyTitle')}</h3>
      <p className="max-w-[17rem] leading-relaxed text-muted">{t('notes.emptyBody')}</p>
      <p className="max-w-[17rem] text-[12px] leading-relaxed text-muted">
        {t('notes.emptyAccounts')}
      </p>
    </div>
  )
}
