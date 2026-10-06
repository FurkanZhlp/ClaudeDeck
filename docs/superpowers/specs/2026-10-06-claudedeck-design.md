# ClaudeDeck: Tasarım

Tarih: 2026-10-06
Durum: Onaylandı

## Amaç

Birden fazla Claude Pro/Max hesabını tek macOS uygulamasında yönetmek. Kullanıcı projeler
oluşturur, her projeye bir hesap atar. Projedeki her "chat", proje klasöründe açılan gömülü bir
terminal sekmesidir ve içinde atanmış hesapla `claude` CLI çalışır.

## 1. Hesap izolasyonu

- Her hesap ayrı bir Claude Code config klasörüdür:
  `~/Library/Application Support/ClaudeDeck/accounts/<accountId>/`
- PTY başlatılırken env'e `CLAUDE_CONFIG_DIR=<configDir>` eklenir. Oturum, ayarlar ve geçmiş o
  klasörde kalır. Kullanıcının mevcut `~/.claude` kurulumuna dokunulmaz.
- Doğrulandı (Claude Code 2.1.282): boş bir `CLAUDE_CONFIG_DIR` ile `claude auth status`
  `loggedIn: false` döner, varsayılan hesabın Keychain kaydını görmez.
- Hesap ekleme: kullanıcı isim ve renk verir, uygulama config klasörünü oluşturur ve o config ile
  bir terminal sekmesinde `claude auth login` çalıştırır. Kullanıcı tarayıcıdan giriş yapar.
- Hesap durumu: main süreç `CLAUDE_CONFIG_DIR=<configDir> claude auth status` çalıştırır, JSON
  çıktısından `loggedIn` ve `email` okunur. Uygulama açılışında ve login sekmesi kapanınca yenilenir.
- Token'lara uygulama dokunmaz; saklama tamamen Claude Code'a aittir.

## 2. Veri modeli

`electron-store` ile tek JSON dosyası (`~/Library/Application Support/ClaudeDeck/config.json`).

```ts
type Account = { id: string; name: string; color: string; configDir: string; email?: string }
type Project = { id: string; name: string; path: string; accountId: string }
type Session = {
  id: string
  projectId: string
  title: string
  kind: 'claude' | 'shell'
  createdAt: number
}
```

- Projenin hesabı değişirse yalnızca yeni açılan sekmeler yeni hesabı kullanır. Çalışan
  sekmelerin üstünde "eski hesapla çalışıyor" rozeti görünür.
- Hesap silinirken o hesaba bağlı proje varsa silme engellenir. Silme onayında config klasörünün
  de silinip silinmeyeceği sorulur.

## 3. Arayüz

- Sol sidebar: projeler listesi, her projenin altında oturumları. Proje satırında hesap rengi ve adı.
- Ana alan: seçili oturumun terminali (xterm.js). Üstte o projenin oturum sekmeleri ve
  "+ Claude", "+ Shell" butonları.
- Ayarlar > Hesaplar: ekle, yeniden giriş, durum yenile, sil.
- Proje oluştur/düzenle diyaloğu: klasör seç, isim, hesap seç.
- Görünür olmayan sekmelerin PTY'si çalışmaya devam eder; yalnızca görünüm değişir. Her oturumun
  xterm örneği bellekte tutulur ve DOM'a takılıp çıkarılır.
- Arayüz dili Türkçe.

## 4. Mimari

Stack: Electron + electron-vite + React + TypeScript + Tailwind + shadcn/ui, xterm.js
(+ fit addon), node-pty, electron-store. Paket yöneticisi pnpm. Paketleme electron-builder
(dmg, arm64).

- **main**
  - `PtyManager`: oturum başına bir PTY. `spawn(sessionId, {cwd, env, command})`, `write`,
    `resize`, `kill`, çıkış olayları. Uygulama kapanırken tüm PTY'leri sonlandırır.
  - `buildSessionEnv(account, kind)`: login shell env'i + `CLAUDE_CONFIG_DIR`. Saf fonksiyon, test edilir.
  - `resolveShellEnv()`: Finder'dan açılan uygulamada PATH eksik olduğundan kullanıcının login
    shell'inden (`$SHELL -ilc env`) env bir kez okunur ve önbelleğe alınır.
  - `AccountService`: config klasörü oluşturma, `claude auth status` okuma, silme.
  - `Store`: electron-store sarmalayıcısı, CRUD.
- **preload**: `contextBridge` ile dar API: `pty.*`, `store.*`, `accounts.*`, `dialog.pickFolder`.
- **renderer**: React. Durum Zustand ile, kaynak store; değişiklikler IPC üzerinden kalıcılaşır.
- Güvenlik: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (preload uyumlu
  olduğu sürece), CSP, harici URL'ler `shell.openExternal` ile tarayıcıda.

Komutlar:
- Claude oturumu: login shell içinde `claude` (ilk açılış) veya `claude --continue` (kayıtlı
  oturum yeniden başlatılırken, kullanıcı seçerse).
- Shell oturumu: kullanıcının `$SHELL`'i, aynı env ile.

## 5. Hata durumları

- `claude` PATH'te bulunamazsa: uyarı ekranı ve kurulum yönergesi.
- Proje klasörü yoksa: proje "klasör bulunamadı" olarak işaretlenir, oturum açılmaz.
- Hesap giriş yapılmamışsa: Claude oturumu açılmadan önce uyarı ve "Giriş yap" butonu.
- PTY süreci biterse: terminalde "süreç sonlandı" mesajı ve "Yeniden başlat" butonu.
- Uygulama yeniden açıldığında oturumlar listede durur ama süreçler başlatılmaz; seçilince
  "Yeni başlat" veya "Kaldığı yerden (`--continue`)" sorulur.

## 6. Kapsam dışı

API key desteği, kota/kullanım göstergesi, terminal bölme, cihazlar arası senkron, auto-update,
Windows/Linux, notarization (public sürümden önce ele alınacak).

## 7. Test

- Vitest birim testleri: `buildSessionEnv`, store CRUD ve kurallar (bağlı projesi olan hesabın
  silinememesi), `claude auth status` çıktı ayrıştırma.
- Elle uçtan uca: iki hesap, iki proje; her projede açılan Claude sekmesinde `/status` farklı
  e-posta göstermeli.

## Repo

`/Volumes/Furkan-SSD/Projects/Furkan/ClaudeDeck`, GitHub'da private repo olarak başlar, ileride public.
