import { win32 } from 'node:path'
import * as pty from 'node-pty'

export interface SpawnOptions {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
  accountId: string
}

export interface PtySink {
  data(id: string, data: string): void
  exit(id: string, exitCode: number): void
}

export class PtyManager {
  private readonly ptys = new Map<string, { proc: pty.IPty; accountId: string }>()
  private readonly generations = new Map<string, number>()
  private epoch = 0

  constructor(private readonly sink: PtySink) {}

  /** Başlatma öncesi alınır; arada kill/killAll çağrılırsa spawn iptal olur. */
  ticket(id: string): string {
    return `${this.epoch}:${this.generations.get(id) ?? 0}`
  }

  /** Bilet geçersizse süreç açmaz ve false döner. */
  spawn(id: string, opts: SpawnOptions, ticket: string): boolean {
    if (ticket !== this.ticket(id)) return false
    // Windows: the launch spec carries the located executable; a bare name would be searched
    // in the cwd (the project) first.
    if (process.platform === 'win32' && !win32.isAbsolute(opts.file)) {
      throw new Error(`executable path is not absolute: ${opts.file}`)
    }
    this.kill(id)
    const proc = pty.spawn(opts.file, opts.args, {
      name: 'xterm-256color',
      cols: Math.max(opts.cols, 2),
      rows: Math.max(opts.rows, 2),
      cwd: opts.cwd,
      env: opts.env
    })
    this.ptys.set(id, { proc, accountId: opts.accountId })
    proc.onData((data) => this.sink.data(id, data))
    proc.onExit(({ exitCode }) => {
      // kill() ile sonlandırılan ya da yerine yenisi açılan süreç için olay gönderme.
      if (this.ptys.get(id)?.proc !== proc) return
      this.ptys.delete(id)
      this.sink.exit(id, exitCode)
    })
    return true
  }

  has(id: string): boolean {
    return this.ptys.has(id)
  }

  hasAccount(accountId: string): boolean {
    return [...this.ptys.values()].some((entry) => entry.accountId === accountId)
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 2) return
    try {
      this.ptys.get(id)?.proc.resize(cols, rows)
    } catch {
      // süreç kapanırken resize hata verebilir
    }
  }

  kill(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    const entry = this.ptys.get(id)
    if (!entry) return
    this.ptys.delete(id)
    try {
      entry.proc.kill()
    } catch {
      // zaten kapanmış
    }
  }

  killAll(): void {
    this.epoch++
    for (const id of [...this.ptys.keys()]) this.kill(id)
  }
}
