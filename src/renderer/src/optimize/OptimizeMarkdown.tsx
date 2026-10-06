import { Children, isValidElement, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import '../notes/notes.css'
import './optimize.css'

function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? textOf(child.props.children)
          : ''
    )
    .join('')
}

function diffClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@'))
    return 'diff-line diff-hunk'
  if (line.startsWith('+')) return 'diff-line diff-add'
  if (line.startsWith('-')) return 'diff-line diff-del'
  return 'diff-line'
}

const components: Components = {
  // Only http(s) links leave the app (the main process asks first); others do nothing.
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault()
        if (href && /^https?:\/\//i.test(href)) window.open(href)
      }}
    >
      {children}
    </a>
  ),
  // No remote requests from Claude's text; show the alt text instead of loading images.
  img: ({ alt }) => (alt ? <span className="notes-image-alt">{alt}</span> : null),
  code: ({ className, children }) => {
    if (!className?.split(' ').includes('language-diff')) {
      return <code className={className}>{children}</code>
    }
    const lines = textOf(children).replace(/\n$/, '').split('\n')
    return (
      <code className={className}>
        {lines.map((line, index) => (
          <span key={index} className={diffClass(line)}>
            {line || ' '}
          </span>
        ))}
      </code>
    )
  }
}

/** Claude's Markdown (rationale, preview, summaries) without raw HTML. */
export function OptimizeMarkdown({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="notes-markdown optimize-markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </Markdown>
    </div>
  )
}
