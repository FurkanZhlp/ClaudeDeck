import en from './locales/en.json'
import tr from './locales/tr.json'
import type { Language } from './types'

const dictionaries: Record<Language, object> = { tr, en }

export type Translate = (key: string, vars?: Record<string, string | number>) => string

export function createTranslator(language: Language): Translate {
  return (key, vars) => {
    const value = key
      .split('.')
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
        dictionaries[language]
      )
    const text = typeof value === 'string' ? value : key
    return vars
      ? text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ''))
      : text
  }
}
