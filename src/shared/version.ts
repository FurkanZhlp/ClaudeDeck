/** "v1.2.3" veya "1.2.3-beta.1" gibi sürümleri karşılaştırır; a > b ise pozitif döner. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { core: number[]; pre: string | null } => {
    const [core, pre] = v.trim().replace(/^v/i, '').split('-', 2)
    return { core: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) {
    const diff = (x.core[i] ?? 0) - (y.core[i] ?? 0)
    if (diff !== 0) return diff
  }
  // Ön sürüm, aynı numaralı kararlı sürümden küçüktür.
  if (x.pre === y.pre) return 0
  if (x.pre === null) return 1
  if (y.pre === null) return -1
  return x.pre.localeCompare(y.pre, 'en', { numeric: true })
}
