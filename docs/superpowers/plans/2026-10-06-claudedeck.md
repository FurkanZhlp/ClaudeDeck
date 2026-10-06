# ClaudeDeck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Birden fazla Claude Pro/Max hesabını projelere atayan ve her projede o hesapla çalışan `claude` terminal sekmeleri açan Electron macOS uygulaması.

**Architecture:** Main süreç: JSON durum deposu (Repository), hesap servisi (`claude auth status/login/logout`), node-pty tabanlı PtyManager, sonuç zarflı IPC. Hesap izolasyonu PTY env'ine `CLAUDE_CONFIG_DIR` basılarak sağlanır. Renderer: React + Zustand + xterm.js; terminal örnekleri bir havuzda yaşar, görünüm değişince DOM'a takılıp çıkarılır. tr/en i18n, metinler `src/shared/locales` altında, main ve renderer ortak kullanır.

**Tech Stack:** Electron, electron-vite 5, React 19, TypeScript, Tailwind v4, Zustand 5, @xterm/xterm 6, node-pty 1.1, i18next/react-i18next, lucide-react, Vitest, electron-builder, pnpm.

Spec: `docs/superpowers/specs/2026-10-06-claudedeck-design.md`

**Spec'ten bilinçli sapmalar:**
- `electron-store` yerine ~30 satırlık `JsonStore` (electron-store 11 ESM-only, CJS main ile sürtünme; ayrıca test edilebilirlik).
- shadcn yerine birkaç küçük el yapımı UI primitive (Button, Modal, Field). Uygulama küçük, shadcn CLI'nin electron-vite alias kurulumu fayda getirmiyor.
- Pencere kapanınca uygulama kapanır (macOS'ta da). PTY'lerin sahipsiz kalmasını önler.

Kod stili: template'in Prettier ayarları (tek tırnak, noktalı virgül yok, 100 kolon). Yorumlar Türkçe ve seyrek.

---

## Dosya yapısı

```
src/shared/            ortam bağımsız (node/DOM yok)
  types.ts             veri modeli
  errors.ts            DomainError + kodlar
  ipc.ts               kanal adları, IpcResult, loginPtyId
  api.ts               preload'un renderer'a açtığı API arayüzü
  language.ts          resolveLanguage
  translate.ts         main için basit çevirmen
  locales/tr.json, en.json
  locales.test.ts, language.test.ts
src/main/
  index.ts             uygulama yaşam döngüsü, pencere
  ipc.ts               IPC handler kaydı
  menu.ts              yerelleştirilmiş uygulama menüsü
  state/jsonStore.ts (+test)   atomik JSON dosya deposu
  state/repository.ts (+test)  CRUD + iş kuralları
  env/shellEnv.ts (+test)      login shell env, oturum env'i
  accounts/accountService.ts (+test)  claude auth komutları, config klasörü
  pty/ptyManager.ts    node-pty yönetimi
src/preload/index.ts   contextBridge API
src/renderer/src/
  main.tsx, App.tsx, i18n.ts, store.ts, global.d.ts, assets/main.css
  terminal/terminalPool.ts, terminal/TerminalView.tsx
  ui/Button.tsx, ui/Modal.tsx, ui/Field.tsx, ui/styles.ts, ui/Notice.tsx, ui/AccountDot.tsx, ui/SessionIcon.tsx
  components/Sidebar.tsx, Workspace.tsx, Welcome.tsx, SessionTabs.tsx, SessionPane.tsx,
             StartPanel.tsx, ProjectDialog.tsx, SettingsDialog.tsx, LoginDialog.tsx,
             ClaudeBanner.tsx, ErrorToast.tsx
```

---

### Task 1: İskelet

**Files:** repo köküne electron-vite `react-ts` şablonu, `pnpm-workspace.yaml`, `vitest.config.ts`, tsconfig ve vite config düzenlemeleri.

- [ ] **Step 1: Şablonu repo köküne kopyala**

```bash
cd /Volumes/Furkan-SSD/Projects/Furkan/ClaudeDeck
SCR=$(mktemp -d)
(cd "$SCR" && yes '' | npm create @quick-start/electron@latest app -- --template react-ts --skip)
rsync -a --exclude README.md --exclude .gitignore "$SCR/app/" ./
rm -rf "$SCR" src/renderer/src/components/Versions.tsx src/renderer/src/assets/base.css \
  src/renderer/src/assets/electron.svg src/renderer/src/assets/wavy-lines.svg src/preload/index.d.ts
```

- [ ] **Step 2: package.json kimliği ve script'ler**

`package.json` içinde: `"name": "claudedeck"`, `"productName": "ClaudeDeck"`, `"description": "Çoklu Claude hesabı ile proje bazlı terminal yöneticisi"`, `"author": "FurkanZhlp"`, `"homepage": "https://github.com/FurkanZhlp/ClaudeDeck"`, `"private": true`. `scripts` içine `"test": "vitest run"` ekle, `build:win`/`build:linux` sil, `build:mac` değerini `"pnpm build && electron-builder --mac"` yap. `npm run` geçen yerleri `pnpm` yap.

- [ ] **Step 3: pnpm ayarı (native modüller için hoisted)**

`pnpm-workspace.yaml` (pnpm 11 `allowBuilds` kullanır):
```yaml
nodeLinker: hoisted
allowBuilds:
  electron: true
  esbuild: true
  node-pty: true
  electron-winstaller: false
```
Harici diskte hoisted kurulum çalıştırma bitlerini kaybedebildiği için `scripts/fix-permissions.mjs` postinstall'da `.bin` hedeflerini ve node-pty `spawn-helper`'ı `chmod +x` yapar. Electron yükseltmesinden sonra ikili dosya inmemişse `node node_modules/electron/install.js`.

- [ ] **Step 4: Bağımlılıklar**

```bash
pnpm install
pnpm add node-pty
pnpm add -D electron@latest @xterm/xterm @xterm/addon-fit @xterm/addon-web-links zustand i18next react-i18next lucide-react tailwindcss @tailwindcss/vite vitest
```

- [ ] **Step 5: `electron.vite.config.ts`**

```ts
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
```

- [ ] **Step 6: `vitest.config.ts`**

```ts
import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] }
})
```

- [ ] **Step 7: tsconfig'ler**

`tsconfig.node.json`:
```json
{
  "extends": "@electron-toolkit/tsconfig/tsconfig.node.json",
  "include": [
    "electron.vite.config.*",
    "vitest.config.ts",
    "src/main/**/*",
    "src/preload/**/*",
    "src/shared/**/*"
  ],
  "compilerOptions": {
    "composite": true,
    "resolveJsonModule": true,
    "types": ["electron-vite/node"]
  }
}
```

`tsconfig.web.json`:
```json
{
  "extends": "@electron-toolkit/tsconfig/tsconfig.web.json",
  "include": ["src/renderer/src/**/*", "src/shared/**/*"],
  "exclude": ["src/**/*.test.ts"],
  "compilerOptions": {
    "composite": true,
    "jsx": "react-jsx",
    "resolveJsonModule": true,
    "baseUrl": ".",
    "paths": {
      "@renderer/*": ["src/renderer/src/*"],
      "@shared/*": ["src/shared/*"]
    }
  }
}
```

- [ ] **Step 8: electron-builder.yml**

```yaml
appId: com.furkanzhlp.claudedeck
productName: ClaudeDeck
directories:
  buildResources: build
files:
  - '!**/.vscode/*'
  - '!src/*'
  - '!docs/*'
  - '!electron.vite.config.{js,ts,mjs,cjs}'
  - '!vitest.config.ts'
  - '!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,CHANGELOG.md,README.md}'
  - '!{.env,.env.*,.npmrc,pnpm-lock.yaml,pnpm-workspace.yaml}'
  - '!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}'
asarUnpack:
  - resources/**
  - node_modules/node-pty/**
mac:
  target:
    - target: dmg
      arch: [arm64]
  category: public.app-category.developer-tools
  entitlementsInherit: build/entitlements.mac.plist
  notarize: false
dmg:
  artifactName: ${name}-${version}-${arch}.${ext}
npmRebuild: true
```

- [ ] **Step 9: Geçici App ve doğrulama**

`src/renderer/src/App.tsx` geçici olarak `export default function App() { return <div>ClaudeDeck</div> }`. `src/preload/index.ts` geçici olarak yalnızca `export {}`. `src/renderer/index.html` başlığını `ClaudeDeck` yap. `src/renderer/src/main.tsx` içindeki `./assets/main.css` importu kalsın; `main.css` içeriğini geçici olarak `@import 'tailwindcss';` yap.

Run: `pnpm typecheck && pnpm exec electron-vite build`
Expected: hata yok, `out/main/index.js`, `out/preload/index.js` oluşur. Preload `.mjs` çıkarsa (sandbox CJS ister) `electron.vite.config.ts` içinde `preload: { build: { rollupOptions: { output: { format: 'cjs' } } } }` ekle.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "İskelet: electron-vite react-ts, Tailwind v4, Vitest"
```

---

### Task 2: Paylaşılan tipler, hatalar, IPC sözleşmesi

**Files:** Create `src/shared/types.ts`, `src/shared/errors.ts`, `src/shared/ipc.ts`, `src/shared/api.ts`

- [ ] **Step 1: `src/shared/types.ts`**

```ts
export type SessionKind = 'claude' | 'shell'
export type Language = 'tr' | 'en'

export interface Account {
  id: string
  name: string
  color: string
  configDir: string
  email?: string
}

export interface Project {
  id: string
  name: string
  path: string
  accountId: string
}

export interface Session {
  id: string
  projectId: string
  title: string
  kind: SessionKind
  createdAt: number
}

export interface Settings {
  /** null: sistem dilini kullan */
  language: Language | null
}

export interface AppState {
  accounts: Account[]
  projects: Project[]
  sessions: Session[]
  settings: Settings
}

export interface AccountStatus {
  loggedIn: boolean
  email?: string
}

export type AccountInput = Pick<Account, 'name' | 'color'>
export type ProjectInput = Pick<Project, 'name' | 'path' | 'accountId'>
```

- [ ] **Step 2: `src/shared/errors.ts`**

```ts
export type ErrorCode =
  | 'ACCOUNT_IN_USE'
  | 'NOT_FOUND'
  | 'INVALID'
  | 'PATH_MISSING'
  | 'CLAUDE_NOT_FOUND'
  | 'UNKNOWN'

export class DomainError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code)
    this.name = 'DomainError'
  }
}
```

- [ ] **Step 3: `src/shared/ipc.ts`**

```ts
export const IPC = {
  stateGet: 'state:get',
  accountCreate: 'account:create',
  accountUpdate: 'account:update',
  accountRemove: 'account:remove',
  accountStatus: 'account:status',
  projectCreate: 'project:create',
  projectUpdate: 'project:update',
  projectRemove: 'project:remove',
  sessionCreate: 'session:create',
  sessionRename: 'session:rename',
  sessionRemove: 'session:remove',
  settingsSetLanguage: 'settings:setLanguage',
  ptyStartSession: 'pty:startSession',
  ptyStartLogin: 'pty:startLogin',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',
  systemPickFolder: 'system:pickFolder',
  systemPathExists: 'system:pathExists',
  systemClaudeAvailable: 'system:claudeAvailable',
  menuOpenSettings: 'menu:openSettings'
} as const

export type IpcResult<T> = { ok: true; data: T } | { ok: false; code: string }

export const loginPtyId = (accountId: string): string => `login:${accountId}`
```

- [ ] **Step 4: `src/shared/api.ts`**

```ts
import type {
  Account,
  AccountInput,
  AccountStatus,
  AppState,
  Language,
  ProjectInput,
  Session,
  SessionKind
} from './types'

type Unsubscribe = () => void

export interface Api {
  state: { get(): Promise<AppState> }
  accounts: {
    create(input: AccountInput): Promise<{ state: AppState; account: Account }>
    update(id: string, patch: Partial<AccountInput>): Promise<AppState>
    remove(id: string, deleteFiles: boolean): Promise<AppState>
    status(id: string): Promise<{ status: AccountStatus; state: AppState }>
  }
  projects: {
    create(input: ProjectInput): Promise<AppState>
    update(id: string, patch: Partial<ProjectInput>): Promise<AppState>
    remove(id: string): Promise<AppState>
  }
  sessions: {
    create(
      projectId: string,
      kind: SessionKind,
      title: string
    ): Promise<{ state: AppState; session: Session }>
    rename(id: string, title: string): Promise<AppState>
    remove(id: string): Promise<AppState>
  }
  settings: { setLanguage(language: Language | null): Promise<AppState> }
  pty: {
    startSession(
      sessionId: string,
      resume: boolean,
      cols: number,
      rows: number
    ): Promise<{ accountId: string }>
    startLogin(accountId: string, cols: number, rows: number): Promise<null>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): Promise<null>
    onData(cb: (id: string, data: string) => void): Unsubscribe
    onExit(cb: (id: string, exitCode: number) => void): Unsubscribe
  }
  system: {
    pickFolder(): Promise<string | null>
    pathExists(path: string): Promise<boolean>
    claudeAvailable(): Promise<boolean>
    onOpenSettings(cb: () => void): Unsubscribe
  }
}
```

- [ ] **Step 5: Typecheck ve commit**

Run: `pnpm typecheck` → Expected: PASS
```bash
git add src/shared && git commit -m "Paylaşılan tipler ve IPC sözleşmesi"
```

---

### Task 3: Dil çözümü, çeviriler, main çevirmeni

**Files:** Create `src/shared/language.ts`, `src/shared/translate.ts`, `src/shared/locales/tr.json`, `src/shared/locales/en.json`; Test `src/shared/language.test.ts`, `src/shared/locales.test.ts`

- [ ] **Step 1: Failing testler**

`src/shared/language.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { resolveLanguage } from './language'

describe('resolveLanguage', () => {
  it('kullanıcı tercihi varsa onu döner', () => {
    expect(resolveLanguage('en', 'tr-TR')).toBe('en')
  })
  it('tercih yoksa tr ile başlayan sistem dilinde tr döner', () => {
    expect(resolveLanguage(null, 'tr-TR')).toBe('tr')
    expect(resolveLanguage(null, 'TR')).toBe('tr')
  })
  it('diğer sistem dillerinde en döner', () => {
    expect(resolveLanguage(null, 'de-DE')).toBe('en')
  })
})
```

`src/shared/locales.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import tr from './locales/tr.json'
import { createTranslator } from './translate'

const keys = (obj: object, prefix = ''): string[] =>
  Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]
  )

describe('çeviriler', () => {
  it('tr ve en aynı anahtarlara sahip', () => {
    expect(keys(tr).sort()).toEqual(keys(en).sort())
  })
  it('uzun tire içermez', () => {
    expect(JSON.stringify([tr, en])).not.toMatch(/[–—]/)
  })
  it('createTranslator değişkenleri yerleştirir', () => {
    expect(createTranslator('tr')('session.claudeTitle', { n: 2 })).toBe('Claude 2')
    expect(createTranslator('en')('menu.quit')).toBe('Quit ClaudeDeck')
  })
  it('bilinmeyen anahtarda anahtarın kendisini döner', () => {
    expect(createTranslator('tr')('yok.boyle')).toBe('yok.boyle')
  })
})
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu gör**

Run: `pnpm test` → Expected: FAIL (`./language`, `./translate`, locales bulunamadı)

- [ ] **Step 3: `src/shared/language.ts`**

```ts
import type { Language } from './types'

export const LANGUAGES: readonly Language[] = ['tr', 'en']

export function resolveLanguage(preference: Language | null, locale: string): Language {
  if (preference) return preference
  return locale.toLowerCase().startsWith('tr') ? 'tr' : 'en'
}
```

- [ ] **Step 4: `src/shared/translate.ts`**

```ts
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
    return vars ? text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? '')) : text
  }
}
```

- [ ] **Step 5: `src/shared/locales/tr.json`**

```json
{
  "common": {
    "cancel": "Vazgeç",
    "save": "Kaydet",
    "delete": "Sil",
    "close": "Kapat"
  },
  "sidebar": {
    "projects": "Projeler",
    "newProject": "Yeni proje",
    "editProject": "Projeyi düzenle",
    "settings": "Ayarlar",
    "noProjects": "Henüz proje yok."
  },
  "welcome": {
    "title": "ClaudeDeck'e hoş geldiniz",
    "step1": "Ayarlar'dan bir Claude hesabı ekleyin ve giriş yapın.",
    "step2": "Bir proje oluşturun, klasörünü seçin ve hesap atayın.",
    "step3": "Projede Claude sekmesi açın; atanan hesapla çalışır.",
    "addAccount": "Hesap ekle",
    "newProject": "Proje oluştur"
  },
  "project": {
    "createTitle": "Yeni proje",
    "editTitle": "Projeyi düzenle",
    "name": "Ad",
    "namePlaceholder": "ör. Web sitesi",
    "path": "Klasör",
    "pickFolder": "Klasör seç",
    "account": "Hesap",
    "noAccounts": "Proje oluşturmadan önce en az bir hesap ekleyin.",
    "openSettings": "Ayarları aç",
    "accountChangeNote": "Hesap değişikliği yeni açılan oturumlara uygulanır; çalışan oturumlar önceki hesapla devam eder.",
    "confirmDelete": "\"{{name}}\" projesi ve oturumları silinsin mi? Klasördeki dosyalara dokunulmaz."
  },
  "session": {
    "newClaude": "Claude",
    "newShell": "Terminal",
    "claudeTitle": "Claude {{n}}",
    "shellTitle": "Terminal {{n}}",
    "start": "Başlat",
    "resume": "Kaldığı yerden devam et",
    "exited": "Süreç sonlandı (çıkış kodu {{code}}).",
    "restart": "Yeniden başlat",
    "close": "Kapat",
    "confirmClose": "Bu oturum hâlâ çalışıyor. Kapatılsın mı?",
    "staleAccount": "Bu oturum önceki hesapla çalışıyor. Yeni hesabı kullanmak için yeniden başlatın.",
    "notLoggedIn": "\"{{account}}\" hesabında giriş yapılmamış görünüyor.",
    "login": "Giriş yap",
    "startAnyway": "Yine de başlat",
    "pathMissing": "Proje klasörü bulunamadı: {{path}}",
    "noSessions": "Bu projede oturum yok. Yukarıdan yeni bir Claude veya Terminal sekmesi açın.",
    "accountLabel": "Hesap: {{name}}"
  },
  "settings": {
    "title": "Ayarlar",
    "accounts": "Hesaplar",
    "noAccounts": "Henüz hesap yok.",
    "addAccount": "Hesap ekle",
    "accountName": "Hesap adı",
    "accountNamePlaceholder": "ör. Kişisel, İş",
    "color": "Renk",
    "checking": "Kontrol ediliyor...",
    "loggedIn": "Giriş yapıldı",
    "loggedOut": "Giriş yapılmadı",
    "login": "Giriş yap",
    "relogin": "Yeniden giriş",
    "refresh": "Durumu yenile",
    "remove": "Hesabı sil",
    "removeConfirm": "\"{{name}}\" hesabı silinsin mi?",
    "removeFiles": "Hesabın oturumunu kapat ve yerel dosyalarını da sil",
    "language": "Dil",
    "languageSystem": "Sistem dili"
  },
  "login": {
    "title": "{{name}} için giriş",
    "hint": "Tarayıcıda açılan sayfadan bu hesaba ait Claude kullanıcısıyla giriş yapın. Tamamlanınca pencereyi kapatın.",
    "done": "Giriş işlemi bitti. Pencereyi kapatabilirsiniz."
  },
  "errors": {
    "ACCOUNT_IN_USE": "Bu hesap bir veya daha fazla projeye atanmış. Önce o projelerin hesabını değiştirin.",
    "NOT_FOUND": "Kayıt bulunamadı.",
    "INVALID": "Eksik veya geçersiz bilgi.",
    "PATH_MISSING": "Proje klasörü bulunamadı.",
    "CLAUDE_NOT_FOUND": "claude komutu bulunamadı. Claude Code'u kurun: curl -fsSL https://claude.ai/install.sh | bash",
    "UNKNOWN": "Beklenmeyen bir hata oluştu."
  },
  "menu": {
    "about": "ClaudeDeck hakkında",
    "settings": "Ayarlar...",
    "hide": "ClaudeDeck'i gizle",
    "hideOthers": "Diğerlerini gizle",
    "showAll": "Tümünü göster",
    "quit": "ClaudeDeck'ten çık",
    "edit": "Düzen",
    "undo": "Geri al",
    "redo": "Yinele",
    "cut": "Kes",
    "copy": "Kopyala",
    "paste": "Yapıştır",
    "selectAll": "Tümünü seç",
    "view": "Görünüm",
    "reload": "Yeniden yükle",
    "devTools": "Geliştirici araçları",
    "fullscreen": "Tam ekran",
    "window": "Pencere"
  }
}
```

- [ ] **Step 6: `src/shared/locales/en.json`**

```json
{
  "common": {
    "cancel": "Cancel",
    "save": "Save",
    "delete": "Delete",
    "close": "Close"
  },
  "sidebar": {
    "projects": "Projects",
    "newProject": "New project",
    "editProject": "Edit project",
    "settings": "Settings",
    "noProjects": "No projects yet."
  },
  "welcome": {
    "title": "Welcome to ClaudeDeck",
    "step1": "Add a Claude account in Settings and sign in.",
    "step2": "Create a project, pick its folder and assign an account.",
    "step3": "Open a Claude tab in the project; it runs with the assigned account.",
    "addAccount": "Add account",
    "newProject": "Create project"
  },
  "project": {
    "createTitle": "New project",
    "editTitle": "Edit project",
    "name": "Name",
    "namePlaceholder": "e.g. Website",
    "path": "Folder",
    "pickFolder": "Choose folder",
    "account": "Account",
    "noAccounts": "Add at least one account before creating a project.",
    "openSettings": "Open settings",
    "accountChangeNote": "Account changes apply to newly opened sessions; running sessions keep the previous account.",
    "confirmDelete": "Delete project \"{{name}}\" and its sessions? Files in the folder are not touched."
  },
  "session": {
    "newClaude": "Claude",
    "newShell": "Terminal",
    "claudeTitle": "Claude {{n}}",
    "shellTitle": "Terminal {{n}}",
    "start": "Start",
    "resume": "Continue where it left off",
    "exited": "Process exited (exit code {{code}}).",
    "restart": "Restart",
    "close": "Close",
    "confirmClose": "This session is still running. Close it?",
    "staleAccount": "This session runs with the previous account. Restart it to use the new account.",
    "notLoggedIn": "Account \"{{account}}\" does not appear to be signed in.",
    "login": "Sign in",
    "startAnyway": "Start anyway",
    "pathMissing": "Project folder not found: {{path}}",
    "noSessions": "No sessions in this project. Open a new Claude or Terminal tab above.",
    "accountLabel": "Account: {{name}}"
  },
  "settings": {
    "title": "Settings",
    "accounts": "Accounts",
    "noAccounts": "No accounts yet.",
    "addAccount": "Add account",
    "accountName": "Account name",
    "accountNamePlaceholder": "e.g. Personal, Work",
    "color": "Color",
    "checking": "Checking...",
    "loggedIn": "Signed in",
    "loggedOut": "Not signed in",
    "login": "Sign in",
    "relogin": "Sign in again",
    "refresh": "Refresh status",
    "remove": "Delete account",
    "removeConfirm": "Delete account \"{{name}}\"?",
    "removeFiles": "Also sign out and delete the account's local files",
    "language": "Language",
    "languageSystem": "System language"
  },
  "login": {
    "title": "Sign in for {{name}}",
    "hint": "Sign in on the page that opens in your browser with the Claude user for this account. Close this window when done.",
    "done": "Sign-in finished. You can close this window."
  },
  "errors": {
    "ACCOUNT_IN_USE": "This account is assigned to one or more projects. Change those projects' account first.",
    "NOT_FOUND": "Record not found.",
    "INVALID": "Missing or invalid information.",
    "PATH_MISSING": "Project folder not found.",
    "CLAUDE_NOT_FOUND": "The claude command was not found. Install Claude Code: curl -fsSL https://claude.ai/install.sh | bash",
    "UNKNOWN": "An unexpected error occurred."
  },
  "menu": {
    "about": "About ClaudeDeck",
    "settings": "Settings...",
    "hide": "Hide ClaudeDeck",
    "hideOthers": "Hide Others",
    "showAll": "Show All",
    "quit": "Quit ClaudeDeck",
    "edit": "Edit",
    "undo": "Undo",
    "redo": "Redo",
    "cut": "Cut",
    "copy": "Copy",
    "paste": "Paste",
    "selectAll": "Select All",
    "view": "View",
    "reload": "Reload",
    "devTools": "Developer Tools",
    "fullscreen": "Toggle Full Screen",
    "window": "Window"
  }
}
```

- [ ] **Step 7: Testleri çalıştır**

Run: `pnpm test` → Expected: PASS (7 test)

- [ ] **Step 8: Commit**

```bash
git add src/shared && git commit -m "tr/en çeviriler ve dil çözümü"
```

---

### Task 4: JsonStore

**Files:** Create `src/main/state/jsonStore.ts`; Test `src/main/state/jsonStore.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { JsonStore } from './jsonStore'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claudedeck-store-'))
  file = join(dir, 'nested', 'config.json')
})

describe('JsonStore', () => {
  it('dosya yoksa varsayılanı döner', () => {
    expect(new JsonStore(file, () => ({ a: 1 })).load()).toEqual({ a: 1 })
  })

  it('kaydeder ve geri okur, eksik alanları varsayılandan tamamlar', () => {
    const store = new JsonStore<{ a: number; b?: string }>(file, () => ({ a: 1, b: 'x' }))
    store.save({ a: 2 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 2 })
    expect(store.load()).toEqual({ a: 2, b: 'x' })
  })

  it('bozuk dosyayı yedekleyip varsayılana döner', () => {
    new JsonStore(file, () => ({})).save({})
    writeFileSync(file, '{bozuk')
    expect(new JsonStore(file, () => ({ a: 1 })).load()).toEqual({ a: 1 })
    expect(readdirSync(join(dir, 'nested')).some((f) => f.startsWith('config.json.corrupt-'))).toBe(
      true
    )
  })
})
```

- [ ] **Step 2: Çalıştır** → `pnpm test src/main/state/jsonStore.test.ts` → FAIL (modül yok)

- [ ] **Step 3: Implementasyon**

```ts
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
```

- [ ] **Step 4: Çalıştır** → PASS
- [ ] **Step 5: Commit** → `git add src/main/state && git commit -m "Atomik JSON deposu"`

---

### Task 5: Repository (CRUD + kurallar)

**Files:** Create `src/main/state/repository.ts`; Test `src/main/state/repository.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AppState } from '../../shared/types'
import { JsonStore } from './jsonStore'
import { emptyState, Repository } from './repository'

let dir: string
let n: number

const make = (): Repository =>
  new Repository(
    new JsonStore<AppState>(join(dir, 'config.json'), emptyState),
    join(dir, 'accounts'),
    () => `id${++n}`
  )

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claudedeck-repo-'))
  n = 0
})

describe('Repository', () => {
  it('hesabın config klasörünü hesap kökü altına koyar ve adı kırpar', () => {
    const { account } = make().createAccount({ name: ' İş ', color: '#2563eb' })
    expect(account).toEqual({
      id: 'id1',
      name: 'İş',
      color: '#2563eb',
      configDir: join(dir, 'accounts', 'id1')
    })
  })

  it('durumu diske yazar, yeni örnek aynı durumu yükler', () => {
    make().createAccount({ name: 'A', color: '#000' })
    expect(make().get().accounts.map((a) => a.name)).toEqual(['A'])
  })

  it('boş adı reddeder', () => {
    expect(() => make().createAccount({ name: '  ', color: '#000' })).toThrowError('INVALID')
  })

  it('olmayan hesapla proje oluşturmayı reddeder', () => {
    expect(() => make().createProject({ name: 'P', path: '/tmp', accountId: 'yok' })).toThrowError(
      'NOT_FOUND'
    )
  })

  it('projeye atanmış hesabın silinmesini engeller', () => {
    const repo = make()
    const { account } = repo.createAccount({ name: 'A', color: '#000' })
    repo.createProject({ name: 'P', path: '/tmp', accountId: account.id })
    expect(() => repo.removeAccount(account.id)).toThrowError('ACCOUNT_IN_USE')
  })

  it('proje hesabını değiştirir', () => {
    const repo = make()
    const a = repo.createAccount({ name: 'A', color: '#000' }).account
    const b = repo.createAccount({ name: 'B', color: '#111' }).account
    repo.createProject({ name: 'P', path: '/tmp', accountId: a.id })
    const projectId = repo.get().projects[0].id
    expect(repo.updateProject(projectId, { accountId: b.id }).projects[0].accountId).toBe(b.id)
    expect(() => repo.updateProject(projectId, { accountId: 'yok' })).toThrowError('NOT_FOUND')
  })

  it('proje silinince oturumlarını da siler ve id listesini döner', () => {
    const repo = make()
    const { account } = repo.createAccount({ name: 'A', color: '#000' })
    repo.createProject({ name: 'P', path: '/tmp', accountId: account.id })
    const projectId = repo.get().projects[0].id
    const { session } = repo.createSession(projectId, 'claude', 'Claude 1')
    const { state, removedSessionIds } = repo.removeProject(projectId)
    expect(removedSessionIds).toEqual([session.id])
    expect(state.sessions).toEqual([])
  })

  it('geçersiz oturum türünü reddeder', () => {
    const repo = make()
    const { account } = repo.createAccount({ name: 'A', color: '#000' })
    repo.createProject({ name: 'P', path: '/tmp', accountId: account.id })
    const projectId = repo.get().projects[0].id
    expect(() => repo.createSession(projectId, 'x' as 'claude', 'T')).toThrowError('INVALID')
  })

  it('dil ayarını doğrular', () => {
    const repo = make()
    expect(repo.setLanguage('en').settings.language).toBe('en')
    expect(repo.setLanguage(null).settings.language).toBeNull()
    expect(() => repo.setLanguage('de' as 'en')).toThrowError('INVALID')
  })
})
```

- [ ] **Step 2: Çalıştır** → FAIL

- [ ] **Step 3: Implementasyon `src/main/state/repository.ts`**

```ts
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DomainError } from '../../shared/errors'
import { LANGUAGES } from '../../shared/language'
import type {
  Account,
  AccountInput,
  AppState,
  Language,
  Project,
  ProjectInput,
  Session,
  SessionKind
} from '../../shared/types'
import type { JsonStore } from './jsonStore'

export const emptyState = (): AppState => ({
  accounts: [],
  projects: [],
  sessions: [],
  settings: { language: null }
})

function requireText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new DomainError('INVALID')
  return value.trim()
}

export class Repository {
  private state: AppState

  constructor(
    private readonly store: JsonStore<AppState>,
    private readonly accountsRoot: string,
    private readonly newId: () => string = randomUUID
  ) {
    this.state = store.load()
  }

  get(): AppState {
    return this.state
  }

  account(id: string): Account {
    return this.find(this.state.accounts, id)
  }

  project(id: string): Project {
    return this.find(this.state.projects, id)
  }

  session(id: string): Session {
    return this.find(this.state.sessions, id)
  }

  createAccount(input: AccountInput): { state: AppState; account: Account } {
    const id = this.newId()
    const account: Account = {
      id,
      name: requireText(input.name),
      color: requireText(input.color),
      configDir: join(this.accountsRoot, id)
    }
    const state = this.commit({ ...this.state, accounts: [...this.state.accounts, account] })
    return { state, account }
  }

  updateAccount(id: string, patch: Partial<Pick<Account, 'name' | 'color' | 'email'>>): AppState {
    this.account(id)
    const clean: Partial<Account> = {}
    if (patch.name !== undefined) clean.name = requireText(patch.name)
    if (patch.color !== undefined) clean.color = requireText(patch.color)
    if (patch.email !== undefined) clean.email = patch.email
    return this.commit({
      ...this.state,
      accounts: this.state.accounts.map((a) => (a.id === id ? { ...a, ...clean } : a))
    })
  }

  removeAccount(id: string): AppState {
    this.account(id)
    if (this.state.projects.some((p) => p.accountId === id)) throw new DomainError('ACCOUNT_IN_USE')
    return this.commit({ ...this.state, accounts: this.state.accounts.filter((a) => a.id !== id) })
  }

  createProject(input: ProjectInput): AppState {
    const project: Project = {
      id: this.newId(),
      name: requireText(input.name),
      path: requireText(input.path),
      accountId: this.account(input.accountId).id
    }
    return this.commit({ ...this.state, projects: [...this.state.projects, project] })
  }

  updateProject(id: string, patch: Partial<ProjectInput>): AppState {
    this.project(id)
    const clean: Partial<Project> = {}
    if (patch.name !== undefined) clean.name = requireText(patch.name)
    if (patch.path !== undefined) clean.path = requireText(patch.path)
    if (patch.accountId !== undefined) clean.accountId = this.account(patch.accountId).id
    return this.commit({
      ...this.state,
      projects: this.state.projects.map((p) => (p.id === id ? { ...p, ...clean } : p))
    })
  }

  removeProject(id: string): { state: AppState; removedSessionIds: string[] } {
    this.project(id)
    const removedSessionIds = this.state.sessions.filter((s) => s.projectId === id).map((s) => s.id)
    const state = this.commit({
      ...this.state,
      projects: this.state.projects.filter((p) => p.id !== id),
      sessions: this.state.sessions.filter((s) => s.projectId !== id)
    })
    return { state, removedSessionIds }
  }

  createSession(
    projectId: string,
    kind: SessionKind,
    title: string
  ): { state: AppState; session: Session } {
    this.project(projectId)
    if (kind !== 'claude' && kind !== 'shell') throw new DomainError('INVALID')
    const session: Session = {
      id: this.newId(),
      projectId,
      kind,
      title: requireText(title),
      createdAt: Date.now()
    }
    const state = this.commit({ ...this.state, sessions: [...this.state.sessions, session] })
    return { state, session }
  }

  renameSession(id: string, title: string): AppState {
    this.session(id)
    const clean = requireText(title)
    return this.commit({
      ...this.state,
      sessions: this.state.sessions.map((s) => (s.id === id ? { ...s, title: clean } : s))
    })
  }

  removeSession(id: string): AppState {
    this.session(id)
    return this.commit({ ...this.state, sessions: this.state.sessions.filter((s) => s.id !== id) })
  }

  setLanguage(language: Language | null): AppState {
    if (language !== null && !LANGUAGES.includes(language)) throw new DomainError('INVALID')
    return this.commit({ ...this.state, settings: { ...this.state.settings, language } })
  }

  private find<T extends { id: string }>(list: T[], id: string): T {
    const item = list.find((x) => x.id === id)
    if (!item) throw new DomainError('NOT_FOUND')
    return item
  }

  private commit(next: AppState): AppState {
    this.store.save(next)
    this.state = next
    return next
  }
}
```

- [ ] **Step 4: Çalıştır** → PASS
- [ ] **Step 5: Commit** → `git add src/main/state && git commit -m "Repository: hesap, proje, oturum CRUD ve kurallar"`

---

### Task 6: Shell env ve oturum env'i

**Files:** Create `src/main/env/shellEnv.ts`; Test `src/main/env/shellEnv.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest'
import { buildSessionEnv, parseEnvOutput, sanitizeEnv, withFallbackPath } from './shellEnv'

describe('parseEnvOutput', () => {
  it('işaretçiden sonraki NUL ayrımlı değişkenleri okur', () => {
    const out = 'motd çıktısı\n__CLAUDEDECK_ENV__PATH=/usr/bin\0HOME=/Users/x\0EQ=a=b\0'
    expect(parseEnvOutput(out)).toEqual({ PATH: '/usr/bin', HOME: '/Users/x', EQ: 'a=b' })
  })
  it('işaretçi yoksa boş nesne döner', () => {
    expect(parseEnvOutput('PATH=/bin')).toEqual({})
  })
})

describe('sanitizeEnv', () => {
  it('tanımsızları ve Claude Code iç değişkenlerini atar', () => {
    expect(
      sanitizeEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/x', U: undefined })
    ).toEqual({ PATH: '/bin' })
  })
})

describe('withFallbackPath', () => {
  it('eksik yaygın dizinleri PATH sonuna ekler, var olanı tekrarlamaz', () => {
    expect(withFallbackPath({ PATH: '/usr/bin:/opt/homebrew/bin' }, '/Users/x').PATH).toBe(
      '/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Users/x/.local/bin'
    )
  })
})

describe('buildSessionEnv', () => {
  it('hesabın config klasörünü ve terminal değişkenlerini ekler', () => {
    expect(buildSessionEnv({ PATH: '/bin' }, { configDir: '/acc/1' })).toEqual({
      PATH: '/bin',
      CLAUDE_CONFIG_DIR: '/acc/1',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'ClaudeDeck',
      LANG: 'en_US.UTF-8'
    })
  })
  it('mevcut LANG değerini korur', () => {
    expect(buildSessionEnv({ LANG: 'tr_TR.UTF-8' }, { configDir: '/a' }).LANG).toBe('tr_TR.UTF-8')
  })
})
```

- [ ] **Step 2: Çalıştır** → FAIL

- [ ] **Step 3: Implementasyon**

```ts
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import type { Account } from '../../shared/types'

type Env = Record<string, string>

const MARKER = '__CLAUDEDECK_ENV__'
// Uygulama bir Claude Code oturumundan başlatılmışsa bu değişkenler alt süreçlere sızmasın.
const STRIPPED = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CONFIG_DIR',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE'
])

export function parseEnvOutput(out: string): Env {
  const start = out.lastIndexOf(MARKER)
  if (start < 0) return {}
  const env: Env = {}
  for (const entry of out.slice(start + MARKER.length).split('\0')) {
    const eq = entry.indexOf('=')
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return env
}

export function sanitizeEnv(env: Record<string, string | undefined>): Env {
  const out: Env = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !STRIPPED.has(key)) out[key] = value
  }
  return out
}

export function withFallbackPath(env: Env, home: string): Env {
  const parts = (env.PATH ?? '').split(':').filter(Boolean)
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', `${home}/.local/bin`]) {
    if (!parts.includes(dir)) parts.push(dir)
  }
  return { ...env, PATH: parts.join(':') }
}

export function buildSessionEnv(base: Env, account: Pick<Account, 'configDir'>): Env {
  return {
    ...base,
    CLAUDE_CONFIG_DIR: account.configDir,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'ClaudeDeck',
    LANG: base.LANG || 'en_US.UTF-8'
  }
}

export function defaultShell(env: Env): string {
  return env.SHELL || '/bin/zsh'
}

let cached: Promise<Env> | null = null

/** Finder'dan açılan uygulamada PATH eksik olur; kullanıcının login shell env'i bir kez okunur. */
export function resolveShellEnv(): Promise<Env> {
  cached ??= new Promise((resolve) => {
    const current = sanitizeEnv(process.env)
    execFile(
      defaultShell(current),
      ['-ilc', `printf '${MARKER}'; env -0`],
      { timeout: 10_000, maxBuffer: 10 * 1024 * 1024, env: current },
      (_error, stdout) => {
        const parsed = parseEnvOutput(String(stdout ?? ''))
        const base = Object.keys(parsed).length > 0 ? sanitizeEnv(parsed) : current
        resolve(withFallbackPath(base, homedir()))
      }
    )
  })
  return cached
}
```

- [ ] **Step 4: Çalıştır** → PASS
- [ ] **Step 5: Commit** → `git add src/main/env && git commit -m "Login shell env çözümü ve oturum env'i"`

---

### Task 7: AccountService

**Files:** Create `src/main/accounts/accountService.ts`; Test `src/main/accounts/accountService.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest'
import { isInside, parseAuthStatus } from './accountService'

describe('parseAuthStatus', () => {
  it('giriş durumunu ve e-postayı okur', () => {
    expect(
      parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.co"}')
    ).toEqual({ loggedIn: true, email: 'a@b.co' })
  })
  it('giriş yoksa loggedIn false döner', () => {
    expect(parseAuthStatus('{"loggedIn": false, "authMethod": "none"}')).toEqual({
      loggedIn: false
    })
  })
  it('JSON öncesindeki gürültüyü tolere eder', () => {
    expect(parseAuthStatus('Uyarı: x\n{"loggedIn":true}').loggedIn).toBe(true)
  })
  it('geçersiz çıktıyı giriş yok sayar', () => {
    expect(parseAuthStatus('zsh: command not found: claude')).toEqual({ loggedIn: false })
  })
})

describe('isInside', () => {
  it('yalnızca kökün altındaki yolları kabul eder', () => {
    expect(isInside('/a/accounts', '/a/accounts/1')).toBe(true)
    expect(isInside('/a/accounts', '/a/accounts')).toBe(false)
    expect(isInside('/a/accounts', '/a/other')).toBe(false)
    expect(isInside('/a/accounts', '/a/accounts/../x')).toBe(false)
  })
})
```

- [ ] **Step 2: Çalıştır** → FAIL

- [ ] **Step 3: Implementasyon**

```ts
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { DomainError } from '../../shared/errors'
import type { Account, AccountStatus } from '../../shared/types'
import { buildSessionEnv } from '../env/shellEnv'

type Env = Record<string, string>

export function parseAuthStatus(stdout: string): AccountStatus {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end < start) return { loggedIn: false }
  try {
    const json = JSON.parse(stdout.slice(start, end + 1)) as { loggedIn?: unknown; email?: unknown }
    const status: AccountStatus = { loggedIn: json.loggedIn === true }
    if (typeof json.email === 'string') status.email = json.email
    return status
  } catch {
    return { loggedIn: false }
  }
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function run(args: string[], env: Env): Promise<string> {
  return new Promise((done) => {
    // claude giriş yoksa sıfırdan farklı kodla çıkabilir; stdout yine de değerlendirilir.
    execFile('claude', args, { env, timeout: 15_000 }, (_error, stdout) => done(String(stdout ?? '')))
  })
}

export class AccountService {
  constructor(
    private readonly accountsRoot: string,
    private readonly baseEnv: () => Promise<Env>
  ) {}

  ensureConfigDir(account: Account): void {
    mkdirSync(account.configDir, { recursive: true, mode: 0o700 })
  }

  async status(account: Account): Promise<AccountStatus> {
    const env = buildSessionEnv(await this.baseEnv(), account)
    return parseAuthStatus(await run(['auth', 'status'], env))
  }

  /** Keychain'deki oturumu temizler, sonra config klasörünü siler. */
  async destroy(account: Account): Promise<void> {
    if (!isInside(this.accountsRoot, account.configDir)) throw new DomainError('UNKNOWN')
    await run(['auth', 'logout'], buildSessionEnv(await this.baseEnv(), account))
    rmSync(account.configDir, { recursive: true, force: true })
  }

  async claudeAvailable(): Promise<boolean> {
    const env = await this.baseEnv()
    return new Promise((done) =>
      execFile('/usr/bin/which', ['claude'], { env }, (error) => done(!error))
    )
  }
}
```

- [ ] **Step 4: Çalıştır** → PASS
- [ ] **Step 5: Commit** → `git add src/main/accounts && git commit -m "Hesap servisi: claude auth durum, çıkış, config klasörü"`

---

### Task 8: PtyManager

**Files:** Create `src/main/pty/ptyManager.ts`

Native modül; birim testi yok, Task 10'da uygulama içinden doğrulanır.

- [ ] **Step 1: Implementasyon**

```ts
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
```

- [ ] **Step 2: Typecheck** → `pnpm typecheck:node` → PASS
- [ ] **Step 3: Commit** → `git add src/main/pty && git commit -m "node-pty yöneticisi"`

---

### Task 9: IPC, menü, main giriş noktası, preload

**Files:** Create `src/main/ipc.ts`, `src/main/menu.ts`; Replace `src/main/index.ts`, `src/preload/index.ts`

- [ ] **Step 1: `src/main/ipc.ts`**

```ts
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { DomainError } from '../shared/errors'
import { IPC, loginPtyId, type IpcResult } from '../shared/ipc'
import type { AccountInput, Language, ProjectInput, SessionKind } from '../shared/types'
import type { AccountService } from './accounts/accountService'
import { buildSessionEnv, defaultShell, resolveShellEnv } from './env/shellEnv'
import type { PtyManager } from './pty/ptyManager'
import type { Repository } from './state/repository'

interface Deps {
  repo: Repository
  accounts: AccountService
  ptys: PtyManager
  getWindow: () => BrowserWindow | null
  onLanguageChange: () => void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResult<unknown>> => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (error) {
      if (error instanceof DomainError) return { ok: false, code: error.code }
      console.error(`[ipc] ${channel}`, error)
      return { ok: false, code: 'UNKNOWN' }
    }
  })
}

const isText = (v: unknown): v is string => typeof v === 'string'
const isSize = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0

export function registerIpc({ repo, accounts, ptys, getWindow, onLanguageChange }: Deps): void {
  handle(IPC.stateGet, () => repo.get())

  handle(IPC.accountCreate, (input: AccountInput) => {
    const result = repo.createAccount({ name: input?.name, color: input?.color })
    accounts.ensureConfigDir(result.account)
    return result
  })
  handle(IPC.accountUpdate, (id: string, patch: Partial<AccountInput>) =>
    repo.updateAccount(id, { name: patch?.name, color: patch?.color })
  )
  handle(IPC.accountRemove, async (id: string, deleteFiles: boolean) => {
    const account = repo.account(id)
    const state = repo.removeAccount(id)
    ptys.kill(loginPtyId(id))
    if (deleteFiles === true) await accounts.destroy(account)
    return state
  })
  handle(IPC.accountStatus, async (id: string) => {
    const account = repo.account(id)
    const status = await accounts.status(account)
    const state =
      status.email && status.email !== account.email
        ? repo.updateAccount(id, { email: status.email })
        : repo.get()
    return { status, state }
  })

  handle(IPC.projectCreate, (input: ProjectInput) =>
    repo.createProject({ name: input?.name, path: input?.path, accountId: input?.accountId })
  )
  handle(IPC.projectUpdate, (id: string, patch: Partial<ProjectInput>) =>
    repo.updateProject(id, { name: patch?.name, path: patch?.path, accountId: patch?.accountId })
  )
  handle(IPC.projectRemove, (id: string) => {
    const { state, removedSessionIds } = repo.removeProject(id)
    removedSessionIds.forEach((sessionId) => ptys.kill(sessionId))
    return state
  })

  handle(IPC.sessionCreate, (projectId: string, kind: SessionKind, title: string) =>
    repo.createSession(projectId, kind, title)
  )
  handle(IPC.sessionRename, (id: string, title: string) => repo.renameSession(id, title))
  handle(IPC.sessionRemove, (id: string) => {
    ptys.kill(id)
    return repo.removeSession(id)
  })

  handle(IPC.settingsSetLanguage, (language: Language | null) => {
    const state = repo.setLanguage(language)
    onLanguageChange()
    return state
  })

  handle(IPC.ptyStartSession, async (sessionId: string, resume: boolean, cols: number, rows: number) => {
    if (!isSize(cols) || !isSize(rows)) throw new DomainError('INVALID')
    const session = repo.session(sessionId)
    const project = repo.project(session.projectId)
    const account = repo.account(project.accountId)
    if (!existsSync(project.path)) throw new DomainError('PATH_MISSING')
    if (session.kind === 'claude' && !(await accounts.claudeAvailable())) {
      throw new DomainError('CLAUDE_NOT_FOUND')
    }
    accounts.ensureConfigDir(account)
    const base = await resolveShellEnv()
    const command = resume === true ? 'claude --continue' : 'claude'
    ptys.spawn(sessionId, {
      file: defaultShell(base),
      args: session.kind === 'claude' ? ['-ilc', command] : ['-il'],
      cwd: project.path,
      env: buildSessionEnv(base, account),
      cols,
      rows
    })
    return { accountId: account.id }
  })

  handle(IPC.ptyStartLogin, async (accountId: string, cols: number, rows: number) => {
    if (!isSize(cols) || !isSize(rows)) throw new DomainError('INVALID')
    const account = repo.account(accountId)
    if (!(await accounts.claudeAvailable())) throw new DomainError('CLAUDE_NOT_FOUND')
    accounts.ensureConfigDir(account)
    const base = await resolveShellEnv()
    ptys.spawn(loginPtyId(accountId), {
      file: defaultShell(base),
      args: ['-ilc', 'claude auth login'],
      cwd: homedir(),
      env: buildSessionEnv(base, account),
      cols,
      rows
    })
    return null
  })

  ipcMain.on(IPC.ptyWrite, (_event, id: unknown, data: unknown) => {
    if (isText(id) && isText(data)) ptys.write(id, data)
  })
  ipcMain.on(IPC.ptyResize, (_event, id: unknown, cols: unknown, rows: unknown) => {
    if (isText(id) && isSize(cols) && isSize(rows)) ptys.resize(id, cols, rows)
  })
  handle(IPC.ptyKill, (id: string) => {
    if (isText(id)) ptys.kill(id)
    return null
  })

  handle(IPC.systemPickFolder, async () => {
    const options: OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const win = getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handle(IPC.systemPathExists, (path: string) => isText(path) && existsSync(path))
  handle(IPC.systemClaudeAvailable, () => accounts.claudeAvailable())
}
```

- [ ] **Step 2: `src/main/menu.ts`**

```ts
import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { Translate } from '../shared/translate'

export function buildMenu(t: Translate, opts: { dev: boolean; openSettings: () => void }): Menu {
  const view: MenuItemConstructorOptions[] = [{ role: 'togglefullscreen', label: t('menu.fullscreen') }]
  if (opts.dev) {
    view.unshift(
      { role: 'reload', label: t('menu.reload') },
      { role: 'toggleDevTools', label: t('menu.devTools') },
      { type: 'separator' }
    )
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: t('menu.about') },
        { type: 'separator' },
        { label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: opts.openSettings },
        { type: 'separator' },
        { role: 'hide', label: t('menu.hide') },
        { role: 'hideOthers', label: t('menu.hideOthers') },
        { role: 'unhide', label: t('menu.showAll') },
        { type: 'separator' },
        { role: 'quit', label: t('menu.quit') }
      ]
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') }
      ]
    },
    { label: t('menu.view'), submenu: view },
    { role: 'windowMenu', label: t('menu.window') }
  ]
  return Menu.buildFromTemplate(template)
}
```

- [ ] **Step 3: `src/main/index.ts` (tamamen değiştir)**

```ts
import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { IPC } from '../shared/ipc'
import { resolveLanguage } from '../shared/language'
import { createTranslator } from '../shared/translate'
import { AccountService } from './accounts/accountService'
import { resolveShellEnv } from './env/shellEnv'
import { registerIpc } from './ipc'
import { buildMenu } from './menu'
import { PtyManager } from './pty/ptyManager'
import { JsonStore } from './state/jsonStore'
import { emptyState, Repository } from './state/repository'

const userData = app.getPath('userData')
const accountsRoot = join(userData, 'accounts')
const repo = new Repository(new JsonStore(join(userData, 'config.json'), emptyState), accountsRoot)
const accounts = new AccountService(accountsRoot, resolveShellEnv)

let mainWindow: BrowserWindow | null = null

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

const ptys = new PtyManager({
  data: (id, data) => send(IPC.ptyData, id, data),
  exit: (id, exitCode) => send(IPC.ptyExit, id, exitCode)
})

function applyMenu(): void {
  const t = createTranslator(resolveLanguage(repo.get().settings.language, app.getLocale()))
  Menu.setApplicationMenu(
    buildMenu(t, { dev: is.dev, openSettings: () => send(IPC.menuOpenSettings) })
  )
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = win

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    mainWindow = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })
  // Renderer yeniden yüklenince terminal görünümleri kaybolur; sahipsiz süreç bırakma.
  win.webContents.on('did-finish-load', () => ptys.killAll())

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.furkanzhlp.claudedeck')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  registerIpc({ repo, accounts, ptys, getWindow: () => mainWindow, onLanguageChange: applyMenu })
  applyMenu()
  void resolveShellEnv()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => ptys.killAll())
```

- [ ] **Step 4: `src/preload/index.ts` (tamamen değiştir)**

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api } from '../shared/api'
import { IPC, type IpcResult } from '../shared/ipc'

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result.ok) throw new Error(result.code)
  return result.data
}

function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: Api = {
  state: { get: () => call(IPC.stateGet) },
  accounts: {
    create: (input) => call(IPC.accountCreate, input),
    update: (id, patch) => call(IPC.accountUpdate, id, patch),
    remove: (id, deleteFiles) => call(IPC.accountRemove, id, deleteFiles),
    status: (id) => call(IPC.accountStatus, id)
  },
  projects: {
    create: (input) => call(IPC.projectCreate, input),
    update: (id, patch) => call(IPC.projectUpdate, id, patch),
    remove: (id) => call(IPC.projectRemove, id)
  },
  sessions: {
    create: (projectId, kind, title) => call(IPC.sessionCreate, projectId, kind, title),
    rename: (id, title) => call(IPC.sessionRename, id, title),
    remove: (id) => call(IPC.sessionRemove, id)
  },
  settings: { setLanguage: (language) => call(IPC.settingsSetLanguage, language) },
  pty: {
    startSession: (sessionId, resume, cols, rows) =>
      call(IPC.ptyStartSession, sessionId, resume, cols, rows),
    startLogin: (accountId, cols, rows) => call(IPC.ptyStartLogin, accountId, cols, rows),
    write: (id, data) => ipcRenderer.send(IPC.ptyWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.ptyResize, id, cols, rows),
    kill: (id) => call(IPC.ptyKill, id),
    onData: (cb) => subscribe(IPC.ptyData, cb),
    onExit: (cb) => subscribe(IPC.ptyExit, cb)
  },
  system: {
    pickFolder: () => call(IPC.systemPickFolder),
    pathExists: (path) => call(IPC.systemPathExists, path),
    claudeAvailable: () => call(IPC.systemClaudeAvailable),
    onOpenSettings: (cb) => subscribe(IPC.menuOpenSettings, cb)
  }
}

contextBridge.exposeInMainWorld('api', api)
```

- [ ] **Step 5: Typecheck + build**

Run: `pnpm typecheck:node && pnpm exec electron-vite build` → Expected: PASS

- [ ] **Step 6: Commit** → `git add src && git commit -m "Main süreç: IPC, menü, pencere, preload API"`

---

### Task 10: Renderer temeli (stil, i18n, store, terminal havuzu)

**Files:** Create `src/renderer/src/global.d.ts`, `i18n.ts`, `store.ts`, `terminal/terminalPool.ts`, `terminal/TerminalView.tsx`; Replace `assets/main.css`, `main.tsx`; Modify `src/renderer/index.html`

- [ ] **Step 1: `src/renderer/src/global.d.ts`**

```ts
import type { Api } from '@shared/api'

declare global {
  interface Window {
    api: Api
  }
}

export {}
```

- [ ] **Step 2: `src/renderer/src/assets/main.css`**

```css
@import 'tailwindcss';

:root {
  --bg: #f7f7f5;
  --panel: #efeeea;
  --elevated: #ffffff;
  --border: #e0dfd9;
  --fg: #1d1d1b;
  --muted: #6b6a64;
  --accent: #c96442;
  --accent-fg: #ffffff;
  --danger: #dc2626;
  --ok: #15803d;
  --warn: #b45309;
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1a1a18;
    --panel: #141413;
    --elevated: #242421;
    --border: #2f2f2b;
    --fg: #ecebe6;
    --muted: #9b9a93;
    --accent: #d97757;
    --accent-fg: #ffffff;
    --danger: #f87171;
    --ok: #4ade80;
    --warn: #fbbf24;
    color-scheme: dark;
  }
}

@theme inline {
  --color-bg: var(--bg);
  --color-panel: var(--panel);
  --color-elevated: var(--elevated);
  --color-border: var(--border);
  --color-fg: var(--fg);
  --color-muted: var(--muted);
  --color-accent: var(--accent);
  --color-accent-fg: var(--accent-fg);
  --color-danger: var(--danger);
  --color-ok: var(--ok);
  --color-warn: var(--warn);
  --font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
}

html,
body,
#root {
  height: 100%;
}

body {
  margin: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-sans);
  font-size: 13px;
  -webkit-font-smoothing: antialiased;
  user-select: none;
}

input,
select,
textarea {
  user-select: text;
}

.drag {
  -webkit-app-region: drag;
}

.no-drag {
  -webkit-app-region: no-drag;
}

.xterm {
  height: 100%;
  padding: 8px 0 0 12px;
}
```

- [ ] **Step 3: `src/renderer/index.html`**

```html
<!doctype html>
<html lang="tr">
  <head>
    <meta charset="UTF-8" />
    <title>ClaudeDeck</title>
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
    />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: `src/renderer/src/i18n.ts`**

```ts
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shared/locales/en.json'
import tr from '@shared/locales/tr.json'

void i18n.use(initReactI18next).init({
  resources: { tr: { translation: tr }, en: { translation: en } },
  lng: 'tr',
  fallbackLng: 'en',
  interpolation: { escapeValue: false }
})

export default i18n
```

- [ ] **Step 5: `src/renderer/src/main.tsx`**

```tsx
import './assets/main.css'
import './i18n'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
```

- [ ] **Step 6: `src/renderer/src/terminal/terminalPool.ts`**

```ts
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

/** Her oturumun xterm örneği burada yaşar; görünüm değişince yalnızca DOM'a takılıp çıkarılır. */
interface Entry {
  term: Terminal
  fit: FitAddon
  host: HTMLDivElement
  opened: boolean
  pending: { resume: boolean } | null
}

const THEME: ITheme = {
  background: '#141413',
  foreground: '#ecebe6',
  cursor: '#d97757',
  cursorAccent: '#141413',
  selectionBackground: '#d9775755'
}

const entries = new Map<string, Entry>()

function create(id: string): Entry {
  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, Monaco, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 10_000,
    // Türkçe Q klavyede @ gibi karakterler Option ile yazılır; Meta'ya çevirme.
    macOptionIsMeta: false,
    theme: THEME
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)))
  term.onData((data) => window.api.pty.write(id, data))
  const host = document.createElement('div')
  host.style.width = '100%'
  host.style.height = '100%'
  const entry: Entry = { term, fit, host, opened: false, pending: null }
  entries.set(id, entry)
  return entry
}

function ensure(id: string): Entry {
  return entries.get(id) ?? create(id)
}

export function requestStart(id: string, resume: boolean): void {
  const entry = ensure(id)
  if (entry.opened) entry.term.write('\r\n')
  entry.pending = { resume }
}

export function takePending(id: string): { resume: boolean } | null {
  const entry = entries.get(id)
  if (!entry?.pending) return null
  const pending = entry.pending
  entry.pending = null
  return pending
}

export function attach(id: string, container: HTMLElement): void {
  const entry = ensure(id)
  if (entry.host.parentElement !== container) container.appendChild(entry.host)
  if (!entry.opened) {
    entry.term.open(entry.host)
    entry.opened = true
  }
}

export function detach(id: string): void {
  entries.get(id)?.host.remove()
}

export function fit(id: string): { cols: number; rows: number } | null {
  const entry = entries.get(id)
  if (!entry?.opened || !entry.host.isConnected) return null
  try {
    entry.fit.fit()
  } catch {
    return null
  }
  return { cols: entry.term.cols, rows: entry.term.rows }
}

export function focus(id: string): void {
  entries.get(id)?.term.focus()
}

export function write(id: string, data: string): void {
  entries.get(id)?.term.write(data)
}

export function dispose(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  entry.term.dispose()
  entry.host.remove()
  entries.delete(id)
}
```

- [ ] **Step 7: `src/renderer/src/terminal/TerminalView.tsx`**

```tsx
import { useEffect, useRef } from 'react'
import * as pool from './terminalPool'

interface Props {
  id: string
  /** İlk ölçüm yapıldığında bir kez çağrılır; süreç başlatmak için. */
  onReady?: (cols: number, rows: number) => void
}

export function TerminalView({ id, onReady }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const onReadyRef = useRef(onReady)

  useEffect(() => {
    onReadyRef.current = onReady
  })

  useEffect(() => {
    const container = ref.current
    if (!container) return
    pool.attach(id, container)

    const sync = (): void => {
      const size = pool.fit(id)
      if (size) window.api.pty.resize(id, size.cols, size.rows)
    }
    const frame = requestAnimationFrame(() => {
      const size = pool.fit(id)
      pool.focus(id)
      if (size) onReadyRef.current?.(size.cols, size.rows)
    })
    const observer = new ResizeObserver(sync)
    observer.observe(container)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      pool.detach(id)
    }
  }, [id])

  return <div ref={ref} className="h-full w-full overflow-hidden bg-[#141413]" />
}
```

- [ ] **Step 8: `src/renderer/src/store.ts`**

```ts
import { create } from 'zustand'
import { resolveLanguage } from '@shared/language'
import type {
  AccountInput,
  AccountStatus,
  AppState,
  Language,
  ProjectInput,
  SessionKind
} from '@shared/types'
import i18n from './i18n'
import * as pool from './terminal/terminalPool'

export type Running = { accountId: string; exitCode: number | null; runId: number }
export type ProjectDialogState = { mode: 'create' } | { mode: 'edit'; projectId: string } | null
export type StatusEntry = AccountStatus | 'checking'

export const errorCode = (error: unknown): string =>
  error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'UNKNOWN'

interface AppStore {
  data: AppState | null
  statuses: Record<string, StatusEntry>
  claudeAvailable: boolean | null
  selectedProjectId: string | null
  selectedSessionId: string | null
  lastSession: Record<string, string>
  running: Record<string, Running>
  settingsOpen: boolean
  projectDialog: ProjectDialogState
  loginAccountId: string | null
  error: string | null

  init: () => Promise<void>
  setError: (code: string | null) => void
  setLanguage: (language: Language | null) => Promise<void>
  refreshStatus: (accountId: string) => Promise<void>
  createAccount: (input: AccountInput) => Promise<void>
  removeAccount: (id: string, deleteFiles: boolean) => Promise<void>
  setSettingsOpen: (open: boolean) => void
  setProjectDialog: (state: ProjectDialogState) => void
  setLoginAccount: (accountId: string | null) => void
  saveProject: (input: ProjectInput, editId?: string) => Promise<void>
  removeProject: (id: string) => Promise<void>
  selectProject: (id: string) => void
  selectSession: (id: string) => void
  createSession: (kind: SessionKind) => Promise<void>
  startSession: (id: string, resume: boolean) => void
  spawn: (id: string, resume: boolean, cols: number, rows: number) => Promise<void>
  closeSession: (id: string) => Promise<void>
}

let initialized = false

function applyLanguage(state: AppState): void {
  const language = resolveLanguage(state.settings.language, navigator.language)
  void i18n.changeLanguage(language)
  document.documentElement.lang = language
}

function firstSessionOf(state: AppState, projectId: string | null): string | null {
  if (!projectId) return null
  return (
    state.sessions
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt)[0]?.id ?? null
  )
}

export const useApp = create<AppStore>((set, get) => {
  async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn()
    } catch (error) {
      set({ error: errorCode(error) })
      return undefined
    }
  }

  return {
    data: null,
    statuses: {},
    claudeAvailable: null,
    selectedProjectId: null,
    selectedSessionId: null,
    lastSession: {},
    running: {},
    settingsOpen: false,
    projectDialog: null,
    loginAccountId: null,
    error: null,

    async init() {
      if (initialized) return
      initialized = true
      window.api.pty.onData((id, data) => pool.write(id, data))
      window.api.pty.onExit((id, exitCode) => {
        const run = get().running[id]
        if (run) set({ running: { ...get().running, [id]: { ...run, exitCode } } })
      })
      window.api.system.onOpenSettings(() => set({ settingsOpen: true }))

      const data = await window.api.state.get()
      applyLanguage(data)
      const selectedProjectId = data.projects[0]?.id ?? null
      set({ data, selectedProjectId, selectedSessionId: firstSessionOf(data, selectedProjectId) })
      void window.api.system.claudeAvailable().then((claudeAvailable) => set({ claudeAvailable }))
      data.accounts.forEach((account) => void get().refreshStatus(account.id))
    },

    setError: (error) => set({ error }),

    async setLanguage(language) {
      const data = await guard(() => window.api.settings.setLanguage(language))
      if (!data) return
      set({ data })
      applyLanguage(data)
    },

    async refreshStatus(accountId) {
      set({ statuses: { ...get().statuses, [accountId]: 'checking' } })
      const result = await guard(() => window.api.accounts.status(accountId))
      const statuses = { ...get().statuses }
      if (result) {
        statuses[accountId] = result.status
        set({ data: result.state, statuses })
      } else {
        delete statuses[accountId]
        set({ statuses })
      }
    },

    async createAccount(input) {
      const result = await guard(() => window.api.accounts.create(input))
      if (result) set({ data: result.state, loginAccountId: result.account.id })
    },

    async removeAccount(id, deleteFiles) {
      const data = await guard(() => window.api.accounts.remove(id, deleteFiles))
      if (!data) return
      const statuses = { ...get().statuses }
      delete statuses[id]
      set({ data, statuses })
    },

    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    setProjectDialog: (projectDialog) => set({ projectDialog }),
    setLoginAccount: (loginAccountId) => set({ loginAccountId }),

    async saveProject(input, editId) {
      const data = await guard(() =>
        editId ? window.api.projects.update(editId, input) : window.api.projects.create(input)
      )
      if (!data) return
      if (editId) {
        set({ data, projectDialog: null })
      } else {
        set({
          data,
          projectDialog: null,
          selectedProjectId: data.projects.at(-1)?.id ?? null,
          selectedSessionId: null
        })
      }
    },

    async removeProject(id) {
      const before = get().data
      const data = await guard(() => window.api.projects.remove(id))
      if (!data || !before) return
      const running = { ...get().running }
      for (const session of before.sessions.filter((s) => s.projectId === id)) {
        pool.dispose(session.id)
        delete running[session.id]
      }
      const selectedProjectId = data.projects[0]?.id ?? null
      set({
        data,
        running,
        projectDialog: null,
        selectedProjectId,
        selectedSessionId: firstSessionOf(data, selectedProjectId)
      })
    },

    selectProject(id) {
      const { data, lastSession } = get()
      if (!data) return
      const remembered = lastSession[id]
      const valid = remembered && data.sessions.some((s) => s.id === remembered)
      set({ selectedProjectId: id, selectedSessionId: valid ? remembered : firstSessionOf(data, id) })
    },

    selectSession(id) {
      const session = get().data?.sessions.find((s) => s.id === id)
      if (!session) return
      set({
        selectedProjectId: session.projectId,
        selectedSessionId: id,
        lastSession: { ...get().lastSession, [session.projectId]: id }
      })
    },

    async createSession(kind) {
      const { data, selectedProjectId } = get()
      const project = data?.projects.find((p) => p.id === selectedProjectId)
      if (!data || !project) return
      const n = data.sessions.filter((s) => s.projectId === project.id && s.kind === kind).length + 1
      const title = i18n.t(kind === 'claude' ? 'session.claudeTitle' : 'session.shellTitle', { n })
      const result = await guard(() => window.api.sessions.create(project.id, kind, title))
      if (!result) return
      set({ data: result.state })
      get().selectSession(result.session.id)
      const status = get().statuses[project.accountId]
      const signedOut = kind === 'claude' && typeof status === 'object' && !status.loggedIn
      if (!signedOut) get().startSession(result.session.id, false)
    },

    startSession(id, resume) {
      const { data, running } = get()
      const session = data?.sessions.find((s) => s.id === id)
      const project = data?.projects.find((p) => p.id === session?.projectId)
      if (!session || !project) return
      pool.requestStart(id, resume)
      const runId = (running[id]?.runId ?? 0) + 1
      set({ running: { ...running, [id]: { accountId: project.accountId, exitCode: null, runId } } })
    },

    async spawn(id, resume, cols, rows) {
      const result = await guard(() => window.api.pty.startSession(id, resume, cols, rows))
      const running = { ...get().running }
      const run = running[id]
      if (result && run) running[id] = { ...run, accountId: result.accountId }
      if (!result) delete running[id]
      set({ running })
    },

    async closeSession(id) {
      const data = await guard(() => window.api.sessions.remove(id))
      if (!data) return
      pool.dispose(id)
      const running = { ...get().running }
      delete running[id]
      const { selectedProjectId, selectedSessionId } = get()
      set({
        data,
        running,
        selectedSessionId:
          selectedSessionId === id ? firstSessionOf(data, selectedProjectId) : selectedSessionId
      })
    }
  }
})
```

- [ ] **Step 9: Typecheck** → `pnpm typecheck:web` (App.tsx geçici haliyle) → PASS
- [ ] **Step 10: Commit** → `git add src/renderer && git commit -m "Renderer temeli: tema, i18n, store, terminal havuzu"`

---

### Task 11: UI primitive'leri

**Files:** Create `src/renderer/src/ui/{styles.ts,Button.tsx,Modal.tsx,Field.tsx,Notice.tsx,AccountDot.tsx,SessionIcon.tsx}`

- [ ] **Step 1: `ui/styles.ts`**

```ts
export const inputClass =
  'no-drag w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-accent'

export const sectionTitleClass = 'text-[11px] font-semibold uppercase tracking-wide text-muted'
```

- [ ] **Step 2: `ui/Button.tsx`**

```tsx
import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:brightness-110',
  secondary: 'border border-border bg-elevated text-fg hover:bg-panel',
  danger: 'bg-danger text-white hover:brightness-110',
  ghost: 'text-muted hover:bg-panel hover:text-fg'
}

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }

export function Button({ variant = 'secondary', className = '', ...props }: Props): React.JSX.Element {
  return (
    <button
      type="button"
      className={`no-drag inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition disabled:pointer-events-none disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  )
}
```

- [ ] **Step 3: `ui/Modal.tsx`**

```tsx
import { X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
  width?: string
  closeOnEscape?: boolean
}

export function Modal({
  title,
  onClose,
  children,
  width = 'max-w-lg',
  closeOnEscape = true
}: Props): React.JSX.Element {
  const { t } = useTranslation()

  useEffect(() => {
    if (!closeOnEscape) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, closeOnEscape])

  return (
    <div
      className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-full w-full ${width} flex-col overflow-hidden rounded-xl border border-border bg-elevated shadow-2xl`}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            aria-label={t('common.close')}
            className="rounded p-1 text-muted hover:bg-panel hover:text-fg"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: `ui/Field.tsx`**

```tsx
import type { ReactNode } from 'react'

export function Field({
  label,
  children,
  className = ''
}: {
  label: string
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <label className={`block space-y-1.5 ${className}`}>
      <span className="block text-[12px] font-medium text-muted">{label}</span>
      {children}
    </label>
  )
}
```

- [ ] **Step 5: `ui/Notice.tsx`**

```tsx
import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'

export function Notice({
  tone,
  children
}: {
  tone: 'warn' | 'danger'
  children: ReactNode
}): React.JSX.Element {
  const color = tone === 'danger' ? 'text-danger' : 'text-warn'
  return (
    <div className="flex gap-2.5 rounded-lg border border-border bg-bg p-3">
      <AlertTriangle size={16} className={`mt-0.5 shrink-0 ${color}`} />
      <div className="min-w-0 flex-1 space-y-3">{children}</div>
    </div>
  )
}
```

- [ ] **Step 6: `ui/AccountDot.tsx`**

```tsx
export function AccountDot({ color, size = 8 }: { color: string; size?: number }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-full"
      style={{ background: color, width: size, height: size }}
    />
  )
}
```

- [ ] **Step 7: `ui/SessionIcon.tsx`**

```tsx
import { Bot, SquareTerminal } from 'lucide-react'
import type { SessionKind } from '@shared/types'
import type { Running } from '../store'

export function SessionIcon({ kind, size = 13 }: { kind: SessionKind; size?: number }): React.JSX.Element {
  return kind === 'claude' ? (
    <Bot size={size} className="shrink-0" />
  ) : (
    <SquareTerminal size={size} className="shrink-0" />
  )
}

export function StatusDot({ run }: { run: Running | undefined }): React.JSX.Element | null {
  if (!run) return null
  const color = run.exitCode === null ? 'bg-ok' : 'bg-muted'
  return <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${color}`} />
}
```

- [ ] **Step 8: Typecheck + commit**

Run: `pnpm typecheck:web` → PASS
```bash
git add src/renderer/src/ui && git commit -m "UI primitive'leri"
```

---

### Task 12: Ekranlar ve diyaloglar

**Files:** Create `src/renderer/src/components/*.tsx`; Replace `src/renderer/src/App.tsx`

- [ ] **Step 1: `components/Sidebar.tsx`**

```tsx
import { Folder, Pencil, Plus, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { AccountDot } from '../ui/AccountDot'
import { Button } from '../ui/Button'
import { SessionIcon, StatusDot } from '../ui/SessionIcon'
import { sectionTitleClass } from '../ui/styles'

export function Sidebar(): React.JSX.Element | null {
  const { t } = useTranslation()
  const data = useApp((s) => s.data)
  const selectedProjectId = useApp((s) => s.selectedProjectId)
  const selectedSessionId = useApp((s) => s.selectedSessionId)
  const running = useApp((s) => s.running)
  const selectProject = useApp((s) => s.selectProject)
  const selectSession = useApp((s) => s.selectSession)
  const setProjectDialog = useApp((s) => s.setProjectDialog)
  const setSettingsOpen = useApp((s) => s.setSettingsOpen)
  if (!data) return null

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-panel">
      <div className="drag h-11 shrink-0" />
      <div className="flex items-center justify-between px-3 pb-2">
        <span className={sectionTitleClass}>{t('sidebar.projects')}</span>
        <button
          type="button"
          aria-label={t('sidebar.newProject')}
          title={t('sidebar.newProject')}
          className="no-drag rounded p-1 text-muted hover:bg-elevated hover:text-fg"
          onClick={() => setProjectDialog({ mode: 'create' })}
        >
          <Plus size={14} />
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {data.projects.length === 0 && <p className="px-2 py-3 text-muted">{t('sidebar.noProjects')}</p>}
        {data.projects.map((project) => {
          const account = data.accounts.find((a) => a.id === project.accountId)
          const sessions = data.sessions.filter((s) => s.projectId === project.id)
          const active = project.id === selectedProjectId
          return (
            <div key={project.id} className="mb-1">
              <div
                role="button"
                tabIndex={0}
                className={`group flex items-center gap-2 rounded-md px-2 py-1.5 ${active ? 'bg-elevated' : 'hover:bg-elevated/60'}`}
                onClick={() => selectProject(project.id)}
                onKeyDown={(event) => event.key === 'Enter' && selectProject(project.id)}
              >
                <Folder size={14} className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{project.name}</div>
                  {account && (
                    <div className="flex items-center gap-1.5 text-[11px] text-muted">
                      <AccountDot color={account.color} size={6} />
                      <span className="truncate">{account.name}</span>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  aria-label={t('sidebar.editProject')}
                  title={t('sidebar.editProject')}
                  className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-fg focus:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation()
                    setProjectDialog({ mode: 'edit', projectId: project.id })
                  }}
                >
                  <Pencil size={12} />
                </button>
              </div>
              {sessions.length > 0 && (
                <ul className="ml-4 mt-0.5 border-l border-border pl-2">
                  {sessions.map((session) => (
                    <li key={session.id}>
                      <button
                        type="button"
                        className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left ${session.id === selectedSessionId ? 'text-fg' : 'text-muted hover:text-fg'}`}
                        onClick={() => selectSession(session.id)}
                      >
                        <SessionIcon kind={session.kind} size={12} />
                        <span className="min-w-0 flex-1 truncate">{session.title}</span>
                        <StatusDot run={running[session.id]} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </nav>

      <div className="border-t border-border p-2">
        <Button variant="ghost" className="w-full justify-start" onClick={() => setSettingsOpen(true)}>
          <Settings size={14} />
          {t('sidebar.settings')}
        </Button>
      </div>
    </aside>
  )
}
```

- [ ] **Step 2: `components/Welcome.tsx`**

```tsx
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { Button } from '../ui/Button'

export function Welcome(): React.JSX.Element {
  const { t } = useTranslation()
  const setSettingsOpen = useApp((s) => s.setSettingsOpen)
  const setProjectDialog = useApp((s) => s.setProjectDialog)
  const hasAccounts = useApp((s) => (s.data?.accounts.length ?? 0) > 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="drag h-11 shrink-0" />
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-md space-y-5">
          <h1 className="text-xl font-semibold">{t('welcome.title')}</h1>
          <ol className="list-decimal space-y-2 pl-5 text-muted">
            <li>{t('welcome.step1')}</li>
            <li>{t('welcome.step2')}</li>
            <li>{t('welcome.step3')}</li>
          </ol>
          <div className="flex gap-2">
            <Button variant={hasAccounts ? 'secondary' : 'primary'} onClick={() => setSettingsOpen(true)}>
              {t('welcome.addAccount')}
            </Button>
            <Button
              variant={hasAccounts ? 'primary' : 'secondary'}
              onClick={() => setProjectDialog({ mode: 'create' })}
            >
              {t('welcome.newProject')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: `components/SessionTabs.tsx`**

```tsx
import { AlertTriangle, Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../store'
import { Button } from '../ui/Button'
import { SessionIcon, StatusDot } from '../ui/SessionIcon'

export function SessionTabs({ projectId }: { projectId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const sessions = useApp(
    useShallow((s) => (s.data?.sessions ?? []).filter((x) => x.projectId === projectId))
  )
  const projectAccountId = useApp(
    (s) => s.data?.projects.find((p) => p.id === projectId)?.accountId
  )
  const selectedSessionId = useApp((s) => s.selectedSessionId)
  const running = useApp((s) => s.running)
  const selectSession = useApp((s) => s.selectSession)
  const createSession = useApp((s) => s.createSession)
  const closeSession = useApp((s) => s.closeSession)

  const close = (id: string): void => {
    const run = running[id]
    if (run && run.exitCode === null && !window.confirm(t('session.confirmClose'))) return
    void closeSession(id)
  }

  return (
    <div className="drag flex h-11 shrink-0 items-end gap-2 border-b border-border bg-panel px-2">
      <div role="tablist" className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
        {sessions.map((session) => {
          const run = running[session.id]
          const active = session.id === selectedSessionId
          const stale = !!run && run.exitCode === null && run.accountId !== projectAccountId
          return (
            <div
              key={session.id}
              role="tab"
              tabIndex={0}
              aria-selected={active}
              className={`no-drag group flex h-8 max-w-52 shrink-0 cursor-default items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 ${active ? 'border-border bg-bg text-fg' : 'border-transparent text-muted hover:text-fg'}`}
              onClick={() => selectSession(session.id)}
              onKeyDown={(event) => event.key === 'Enter' && selectSession(session.id)}
            >
              <SessionIcon kind={session.kind} />
              <span className="truncate">{session.title}</span>
              <StatusDot run={run} />
              {stale && (
                <span title={t('session.staleAccount')} className="text-warn">
                  <AlertTriangle size={12} />
                </span>
              )}
              <button
                type="button"
                aria-label={t('session.close')}
                className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-panel focus:opacity-100"
                onClick={(event) => {
                  event.stopPropagation()
                  close(session.id)
                }}
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>
      <div className="no-drag flex shrink-0 items-center gap-1 pb-1.5">
        <Button variant="ghost" onClick={() => void createSession('claude')}>
          <Plus size={14} />
          {t('session.newClaude')}
        </Button>
        <Button variant="ghost" onClick={() => void createSession('shell')}>
          <Plus size={14} />
          {t('session.newShell')}
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: `components/StartPanel.tsx`**

```tsx
import { LogIn, Play } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Session } from '@shared/types'
import { useApp } from '../store'
import { AccountDot } from '../ui/AccountDot'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'
import { SessionIcon } from '../ui/SessionIcon'

export function StartPanel({ session }: { session: Session }): React.JSX.Element | null {
  const { t } = useTranslation()
  const project = useApp((s) => s.data?.projects.find((p) => p.id === session.projectId))
  const account = useApp((s) => s.data?.accounts.find((a) => a.id === project?.accountId))
  const status = useApp((s) => (project ? s.statuses[project.accountId] : undefined))
  const startSession = useApp((s) => s.startSession)
  const setLoginAccount = useApp((s) => s.setLoginAccount)
  const setProjectDialog = useApp((s) => s.setProjectDialog)
  const [checked, setChecked] = useState<{ path: string; exists: boolean } | null>(null)
  const path = project?.path

  useEffect(() => {
    if (!path) return
    let alive = true
    void window.api.system.pathExists(path).then((exists) => {
      if (alive) setChecked({ path, exists })
    })
    return () => {
      alive = false
    }
  }, [path])

  if (!project || !account) return null
  const pathKnown = checked?.path === project.path
  const pathMissing = pathKnown && !checked.exists
  const signedOut = session.kind === 'claude' && typeof status === 'object' && !status.loggedIn

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-md space-y-4 rounded-xl border border-border bg-elevated p-6">
        <div className="flex items-center gap-2 text-base font-semibold">
          <SessionIcon kind={session.kind} size={18} />
          {session.title}
        </div>
        <div className="space-y-1 text-muted">
          <div className="truncate" title={project.path}>
            {project.path}
          </div>
          <div className="flex items-center gap-2">
            <AccountDot color={account.color} />
            {t('session.accountLabel', { name: account.name })}
          </div>
        </div>

        {pathMissing ? (
          <Notice tone="danger">
            <p>{t('session.pathMissing', { path: project.path })}</p>
            <Button onClick={() => setProjectDialog({ mode: 'edit', projectId: project.id })}>
              {t('sidebar.editProject')}
            </Button>
          </Notice>
        ) : signedOut ? (
          <Notice tone="warn">
            <p>{t('session.notLoggedIn', { account: account.name })}</p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => setLoginAccount(account.id)}>
                <LogIn size={14} />
                {t('session.login')}
              </Button>
              <Button onClick={() => startSession(session.id, false)}>{t('session.startAnyway')}</Button>
            </div>
          </Notice>
        ) : (
          <div className="flex gap-2">
            <Button variant="primary" disabled={!pathKnown} onClick={() => startSession(session.id, false)}>
              <Play size={14} />
              {t('session.start')}
            </Button>
            {session.kind === 'claude' && (
              <Button disabled={!pathKnown} onClick={() => startSession(session.id, true)}>
                {t('session.resume')}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: `components/SessionPane.tsx`**

```tsx
import { RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { TerminalView } from '../terminal/TerminalView'
import * as pool from '../terminal/terminalPool'
import { Button } from '../ui/Button'
import { StartPanel } from './StartPanel'

export function SessionPane({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const session = useApp((s) => s.data?.sessions.find((x) => x.id === sessionId))
  const run = useApp((s) => s.running[sessionId])
  const startSession = useApp((s) => s.startSession)
  const spawn = useApp((s) => s.spawn)
  const closeSession = useApp((s) => s.closeSession)

  if (!session) return null
  if (!run) return <StartPanel session={session} />

  const onReady = (cols: number, rows: number): void => {
    const pending = pool.takePending(session.id)
    if (pending) void spawn(session.id, pending.resume, cols, rows)
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-[#141413]">
      <div className="min-h-0 flex-1">
        <TerminalView key={run.runId} id={session.id} onReady={onReady} />
      </div>
      {run.exitCode !== null && (
        <div className="flex items-center gap-2 border-t border-border bg-elevated px-4 py-2.5">
          <span className="flex-1 text-muted">{t('session.exited', { code: run.exitCode })}</span>
          <Button variant="primary" onClick={() => startSession(session.id, false)}>
            <RotateCw size={14} />
            {t('session.restart')}
          </Button>
          {session.kind === 'claude' && (
            <Button onClick={() => startSession(session.id, true)}>{t('session.resume')}</Button>
          )}
          <Button variant="ghost" onClick={() => void closeSession(session.id)}>
            {t('session.close')}
          </Button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 6: `components/Workspace.tsx`**

```tsx
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { SessionPane } from './SessionPane'
import { SessionTabs } from './SessionTabs'
import { Welcome } from './Welcome'

export function Workspace(): React.JSX.Element {
  const { t } = useTranslation()
  const projectId = useApp((s) => s.selectedProjectId)
  const sessionId = useApp((s) => s.selectedSessionId)
  const projectExists = useApp((s) => !!s.data?.projects.some((p) => p.id === s.selectedProjectId))

  if (!projectId || !projectExists) return <Welcome />

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SessionTabs projectId={projectId} />
      {sessionId ? (
        <SessionPane key={sessionId} sessionId={sessionId} />
      ) : (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-muted">
          {t('session.noSessions')}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 7: `components/ProjectDialog.tsx`**

```tsx
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

function ProjectForm({ dialog }: { dialog: NonNullable<ProjectDialogState> }): React.JSX.Element | null {
  const { t } = useTranslation()
  const data = useApp((s) => s.data)
  const setProjectDialog = useApp((s) => s.setProjectDialog)
  const setSettingsOpen = useApp((s) => s.setSettingsOpen)
  const saveProject = useApp((s) => s.saveProject)
  const removeProject = useApp((s) => s.removeProject)
  const editing =
    dialog.mode === 'edit' ? data?.projects.find((p) => p.id === dialog.projectId) : undefined
  const [name, setName] = useState(editing?.name ?? '')
  const [path, setPath] = useState(editing?.path ?? '')
  const [accountId, setAccountId] = useState(editing?.accountId ?? data?.accounts[0]?.id ?? '')
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
```

- [ ] **Step 8: `components/SettingsDialog.tsx`**

```tsx
import { LogIn, Plus, RotateCw, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Account, Language } from '@shared/types'
import { useApp } from '../store'
import { AccountDot } from '../ui/AccountDot'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Modal } from '../ui/Modal'
import { inputClass, sectionTitleClass } from '../ui/styles'

const COLORS = ['#c96442', '#2563eb', '#16a34a', '#9333ea', '#db2777', '#0891b2']

export function SettingsDialog(): React.JSX.Element | null {
  const open = useApp((s) => s.settingsOpen)
  return open ? <SettingsContent /> : null
}

function SettingsContent(): React.JSX.Element | null {
  const { t } = useTranslation()
  const data = useApp((s) => s.data)
  const setSettingsOpen = useApp((s) => s.setSettingsOpen)
  const setLanguage = useApp((s) => s.setLanguage)
  const createAccount = useApp((s) => s.createAccount)
  const [name, setName] = useState('')
  const [color, setColor] = useState(COLORS[0])
  if (!data) return null

  const add = (event: FormEvent): void => {
    event.preventDefault()
    if (!name.trim()) return
    void createAccount({ name, color }).then(() => setName(''))
  }

  return (
    <Modal title={t('settings.title')} onClose={() => setSettingsOpen(false)} width="max-w-2xl">
      <section className="space-y-3">
        <h3 className={sectionTitleClass}>{t('settings.accounts')}</h3>
        {data.accounts.length === 0 && <p className="text-muted">{t('settings.noAccounts')}</p>}
        <ul className="space-y-2">
          {data.accounts.map((account) => (
            <AccountRow key={account.id} account={account} />
          ))}
        </ul>
        <form
          onSubmit={add}
          className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-border p-3"
        >
          <Field label={t('settings.accountName')} className="min-w-48 flex-1">
            <input
              className={inputClass}
              value={name}
              placeholder={t('settings.accountNamePlaceholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <div className="space-y-1.5">
            <span className="block text-[12px] font-medium text-muted">{t('settings.color')}</span>
            <div className="flex h-[30px] items-center gap-1.5">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  aria-pressed={color === c}
                  onClick={() => setColor(c)}
                  className={`size-5 rounded-full ring-offset-2 ring-offset-elevated ${color === c ? 'ring-2 ring-fg' : ''}`}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            <Plus size={14} />
            {t('settings.addAccount')}
          </Button>
        </form>
      </section>

      <section className="mt-6 space-y-2">
        <h3 className={sectionTitleClass}>{t('settings.language')}</h3>
        <select
          className={`${inputClass} max-w-60`}
          value={data.settings.language ?? 'system'}
          onChange={(event) =>
            void setLanguage(event.target.value === 'system' ? null : (event.target.value as Language))
          }
        >
          <option value="system">{t('settings.languageSystem')}</option>
          <option value="tr">Türkçe</option>
          <option value="en">English</option>
        </select>
      </section>
    </Modal>
  )
}

function AccountRow({ account }: { account: Account }): React.JSX.Element {
  const { t } = useTranslation()
  const status = useApp((s) => s.statuses[account.id])
  const inUse = useApp((s) => !!s.data?.projects.some((p) => p.accountId === account.id))
  const refreshStatus = useApp((s) => s.refreshStatus)
  const setLoginAccount = useApp((s) => s.setLoginAccount)
  const removeAccount = useApp((s) => s.removeAccount)
  const setError = useApp((s) => s.setError)
  const [confirming, setConfirming] = useState(false)
  const [deleteFiles, setDeleteFiles] = useState(true)

  const loggedIn = typeof status === 'object' && status.loggedIn
  const label =
    typeof status !== 'object'
      ? t('settings.checking')
      : status.loggedIn
        ? [t('settings.loggedIn'), status.email].filter(Boolean).join(' · ')
        : t('settings.loggedOut')

  return (
    <li className="rounded-lg border border-border bg-bg p-3">
      <div className="flex items-center gap-3">
        <AccountDot color={account.color} size={10} />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{account.name}</div>
          <div className={`truncate text-[12px] ${loggedIn ? 'text-ok' : 'text-muted'}`}>{label}</div>
        </div>
        <Button
          variant="ghost"
          aria-label={t('settings.refresh')}
          title={t('settings.refresh')}
          onClick={() => void refreshStatus(account.id)}
        >
          <RotateCw size={14} />
        </Button>
        <Button onClick={() => setLoginAccount(account.id)}>
          <LogIn size={14} />
          {loggedIn ? t('settings.relogin') : t('settings.login')}
        </Button>
        <Button
          variant="ghost"
          aria-label={t('settings.remove')}
          title={t('settings.remove')}
          onClick={() => (inUse ? setError('ACCOUNT_IN_USE') : setConfirming(true))}
        >
          <Trash2 size={14} />
        </Button>
      </div>
      {confirming && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <p>{t('settings.removeConfirm', { name: account.name })}</p>
          <label className="flex items-center gap-2 text-muted">
            <input
              type="checkbox"
              checked={deleteFiles}
              onChange={(event) => setDeleteFiles(event.target.checked)}
            />
            {t('settings.removeFiles')}
          </label>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={() => void removeAccount(account.id, deleteFiles)}>
              {t('settings.remove')}
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}
```

- [ ] **Step 9: `components/LoginDialog.tsx`**

```tsx
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
```

- [ ] **Step 10: `components/ClaudeBanner.tsx`**

```tsx
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'

export function ClaudeBanner(): React.JSX.Element | null {
  const { t } = useTranslation()
  const available = useApp((s) => s.claudeAvailable)
  if (available !== false) return null
  return (
    <div className="flex items-center gap-2 border-b border-border bg-elevated px-4 py-2 text-warn">
      <AlertTriangle size={14} className="shrink-0" />
      <span className="select-text">{t('errors.CLAUDE_NOT_FOUND')}</span>
    </div>
  )
}
```

- [ ] **Step 11: `components/ErrorToast.tsx`**

```tsx
import { X } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'

export function ErrorToast(): React.JSX.Element | null {
  const { t } = useTranslation()
  const error = useApp((s) => s.error)
  const setError = useApp((s) => s.setError)

  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), 6000)
    return () => clearTimeout(timer)
  }, [error, setError])

  if (!error) return null
  return (
    <div
      role="alert"
      className="fixed bottom-4 right-4 z-[60] flex max-w-sm items-start gap-3 rounded-lg border border-border bg-elevated p-3 shadow-xl"
    >
      <span className="flex-1 text-danger">{t(`errors.${error}`, { defaultValue: t('errors.UNKNOWN') })}</span>
      <button
        type="button"
        aria-label={t('common.close')}
        className="text-muted hover:text-fg"
        onClick={() => setError(null)}
      >
        <X size={14} />
      </button>
    </div>
  )
}
```

- [ ] **Step 12: `App.tsx`**

```tsx
import { useEffect } from 'react'
import { ClaudeBanner } from './components/ClaudeBanner'
import { ErrorToast } from './components/ErrorToast'
import { LoginDialog } from './components/LoginDialog'
import { ProjectDialog } from './components/ProjectDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { Workspace } from './components/Workspace'
import { useApp } from './store'

export default function App(): React.JSX.Element {
  const init = useApp((s) => s.init)
  const ready = useApp((s) => s.data !== null)

  useEffect(() => {
    void init()
  }, [init])

  if (!ready) return <div className="drag h-full" />

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <ClaudeBanner />
        <Workspace />
      </main>
      <ProjectDialog />
      <SettingsDialog />
      <LoginDialog />
      <ErrorToast />
    </div>
  )
}
```

- [ ] **Step 13: Typecheck, lint, test, build**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm exec electron-vite build`
Expected: hepsi PASS. Lint hatası varsa (ör. react-refresh, hooks kuralları) düzelt.

- [ ] **Step 14: Commit** → `git add -A && git commit -m "Arayüz: kenar çubuğu, sekmeler, terminal, proje ve ayar diyalogları"`

---

### Task 13: Uygulama içi doğrulama

- [ ] **Step 1:** `pnpm dev` ile uygulamayı aç (arka planda). Kontrol listesi:
  1. Hoş geldiniz ekranı görünür, menü Türkçe (sistem dili tr ise).
  2. Ayarlar → hesap ekle ("Test A") → giriş penceresi açılır, terminalde `claude auth login` çıktısı görünür. (Gerçek giriş kullanıcıya bırakılır; pencere kapatılınca durum "Giriş yapılmadı" görünür.)
  3. Proje oluştur (geçici klasör, Test A) → "+ Terminal" → shell açılır; `echo $CLAUDE_CONFIG_DIR` hesabın klasörünü yazar.
  4. "+ Claude" → hesap giriş yapmamışsa uyarı paneli; "Yine de başlat" → claude açılır.
  5. Sekmeler arası geçişte terminal içeriği korunur; pencere yeniden boyutlanınca terminal uyar.
  6. Dil "English" → arayüz ve menü İngilizceye döner.
  7. `exit` → "Süreç sonlandı" çubuğu, "Yeniden başlat" çalışır.
- [ ] **Step 2:** Bulunan hataları düzelt, `pnpm typecheck && pnpm test` tekrar, commit.

---

### Task 14: Paketleme ve README

- [ ] **Step 1:** `pnpm build:mac` → `dist/ClaudeDeck-1.0.0-arm64.dmg` oluşur. `dist/mac-arm64/ClaudeDeck.app` Finder'dan açılır, "+ Terminal" çalışır (PATH çözümü ve node-pty unpack doğrulaması). İmzasız olduğu için ilk açılışta sağ tık → Aç gerekebilir.
- [ ] **Step 2:** README'yi kurulum, geliştirme komutları (`pnpm dev`, `pnpm test`, `pnpm build:mac`), hesap izolasyonunun nasıl çalıştığı ve veri konumu (`~/Library/Application Support/ClaudeDeck`) ile güncelle.
- [ ] **Step 3:** Commit + push → `git add -A && git commit -m "Paketleme ve README" && git push`
