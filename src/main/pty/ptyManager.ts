import * as pty from 'node-pty'

export interface SpawnOptions {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

export interface PtySink {
  data(id: string, data: string): void
  exit(id: string, exitCode: number): void
}

export class PtyManager {
  private readonly ptys = new Map<string, pty.IPty>()

  constructor(private readonly sink: PtySink) {}

  spawn(id: string, opts: SpawnOptions): void {
    this.kill(id)
    const proc = pty.spawn(opts.file, opts.args, {
      name: 'xterm-256color',
      cols: Math.max(opts.cols, 2),
      rows: Math.max(opts.rows, 2),
      cwd: opts.cwd,
      env: opts.env
    })
    this.ptys.set(id, proc)
    proc.onData((data) => this.sink.data(id, data))
    proc.onExit(({ exitCode }) => {
      // kill() ile sonlandırılan ya da yerine yenisi açılan süreç için olay gönderme.
      if (this.ptys.get(id) !== proc) return
      this.ptys.delete(id)
      this.sink.exit(id, exitCode)
    })
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 2) return
    try {
      this.ptys.get(id)?.resize(cols, rows)
    } catch {
      // süreç kapanırken resize hata verebilir
    }
  }

  kill(id: string): void {
    const proc = this.ptys.get(id)
    if (!proc) return
    this.ptys.delete(id)
    try {
      proc.kill()
    } catch {
      // zaten kapanmış
    }
  }

  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id)
  }
}
