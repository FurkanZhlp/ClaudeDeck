import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { renameWithRetry } from '../platform/fs'

// Windows briefly locks files (antivirus, indexer); retried there, a plain rename elsewhere.
const renameFile = renameWithRetry(process.platform)

/** Tek JSON dosyası; yazma atomik (geçici dosya + rename). */
export class JsonStore<T extends object> {
  constructor(
    private readonly file: string,
    private readonly defaults: () => T
  ) {}

  load(): T {
    if (!existsSync(this.file)) return this.defaults()
    try {
      return { ...this.defaults(), ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<T>) }
    } catch {
      // Bozuk dosyanın üstüne yazmadan önce yedekle.
      renameFile(this.file, `${this.file}.corrupt-${Date.now()}`)
      return this.defaults()
    }
  }

  save(data: T): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameFile(tmp, this.file)
  }
}
