import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

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
      renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      return this.defaults()
    }
  }

  save(data: T): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
}
