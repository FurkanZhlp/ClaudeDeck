# ClaudeDeck

Birden fazla Claude Pro/Max hesabını projelere atayan ve her projede o hesapla çalışan `claude` terminalleri açan macOS uygulaması.

## Nasıl çalışır

- **Hesap:** Her hesap kendi Claude Code config klasörünü kullanır (`~/Library/Application Support/ClaudeDeck/accounts/<id>/`). Terminaller `CLAUDE_CONFIG_DIR` ile başlatıldığı için hesaplar birbirine karışmaz. Mevcut `~/.claude` kurulumunuza dokunulmaz. Token'ları Claude Code kendisi saklar (macOS Keychain); uygulama okumaz.
- **Proje:** Bir klasör ve atanmış bir hesap.
- **Sekme:** Projede açılan Claude ya da düz Terminal sekmesi. Claude sekmeleri kendi konuşma kimliğini tutar; "Kaldığı yerden devam et" o sekmenin konuşmasını açar.
- **Dil:** Türkçe ve İngilizce. Varsayılan sistem dili, Ayarlar'dan değiştirilebilir.

## Gereksinimler

- macOS (Apple Silicon)
- [Claude Code](https://docs.claude.com/claude-code): `curl -fsSL https://claude.ai/install.sh | bash`

## Kullanım

1. Ayarlar > Hesaplar'dan hesap ekleyin. Açılan pencerede `claude auth login` çalışır; tarayıcıdan o hesapla giriş yapın.
2. Kenar çubuğundaki `+` ile proje oluşturun: klasör seçin, hesap atayın.
3. Üst şeritten `+ Claude` veya `+ Terminal` ile sekme açın.

Terminaldeki linkler Cmd+tık ile açılır.

## Geliştirme

```bash
pnpm install
pnpm dev          # geliştirme modu
pnpm test         # birim testleri (Vitest)
pnpm lint
pnpm typecheck
pnpm build:mac    # dist/claudedeck-<sürüm>-arm64.dmg
```

İmzasız/notarize edilmemiş derlemede ilk açılışta Finder'da sağ tık > Aç gerekebilir.

## Yapı

```
src/main      Electron ana süreç: durum deposu, hesap servisi, PTY yöneticisi, IPC
src/preload   Renderer'a açılan dar API (contextBridge)
src/renderer  React arayüzü, xterm.js terminal havuzu
src/shared    Tipler, IPC sözleşmesi, tr/en çeviriler
docs/         Tasarım ve uygulama planı
```
