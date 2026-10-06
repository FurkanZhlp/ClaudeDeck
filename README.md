<p align="center">
  <img src="docs/icon.png" width="128" height="128" alt="ClaudeDeck ikonu">
</p>

<h1 align="center">ClaudeDeck</h1>

<p align="center">
  Birden fazla Claude Pro/Max hesabını projelere atayın; her projede o hesapla çalışan <code>claude</code> terminalleri açın.
</p>

<p align="center">
  <a href="https://github.com/FurkanZhlp/ClaudeDeck/releases/latest"><strong>Son sürümü indir</strong></a>
</p>

![Claude oturumu](docs/screenshots/claude-session.png)

## Neden?

Kişisel ve iş için ayrı Claude hesaplarınız varsa Claude Code'da hesap değiştirmek sürekli çıkış/giriş demektir. ClaudeDeck'te hesabı projeye bir kez atarsınız; o projede açtığınız her Claude sekmesi doğru hesapla başlar. Farklı hesaplara atanmış projeler yan yana, aynı anda çalışır.

## Özellikler

- **Çoklu hesap:** Her hesap kendi izole Claude Code config klasörünü kullanır. Hesaplar birbirine karışmaz, mevcut `~/.claude` kurulumunuza dokunulmaz.
- **Proje bazlı hesap:** Proje = klasör + hesap. Hesabı değiştirdiğinizde yeni sekmeler yeni hesapla açılır.
- **Sekmeler:** Bir projede istediğiniz kadar Claude ve düz Terminal sekmesi. Arka plandaki sekmeler çalışmaya devam eder.
- **Kaldığı yerden devam:** Her Claude sekmesi kendi konuşmasını hatırlar; uygulamayı yeniden açtığınızda o sekmenin konuşmasına dönebilirsiniz.
- **Türkçe ve İngilizce arayüz:** Varsayılan sistem dili, Ayarlar'dan değiştirilebilir.
- **Güncelleme bildirimi:** Yeni sürüm yayınlandığında uygulama içinde haber verir.

| Hesap izolasyonu | Ayarlar |
| --- | --- |
| ![Terminal](docs/screenshots/terminal.png) | ![Ayarlar](docs/screenshots/settings.png) |
| **Yeni proje** | **Giriş yapılmamış hesap uyarısı** |
| ![Yeni proje](docs/screenshots/new-project.png) | ![Giriş uyarısı](docs/screenshots/signed-out.png) |

## Kurulum

Gereksinimler: Apple Silicon Mac ve [Claude Code](https://docs.claude.com/en/docs/claude-code):

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

1. [Releases](https://github.com/FurkanZhlp/ClaudeDeck/releases/latest) sayfasından `.dmg` dosyasını indirin, ClaudeDeck'i Uygulamalar klasörüne sürükleyin.
2. Uygulama henüz Apple tarafından notarize edilmediği için macOS ilk açılışta engelleyebilir. Bu durumda bir kez şunu çalıştırın:

   ```bash
   xattr -dr com.apple.quarantine /Applications/ClaudeDeck.app
   ```

## Kullanım

1. **Ayarlar > Hesaplar**'dan hesap ekleyin. Açılan pencerede `claude auth login` çalışır; tarayıcıda o hesapla giriş yapın.
2. Kenar çubuğundaki **+** ile proje oluşturun: klasör seçin, hesap atayın.
3. Üst şeritten **+ Claude** veya **+ Terminal** ile sekme açın.

Terminaldeki linkler Cmd+tık ile açılır.

## Nasıl çalışır

Claude Code, oturum ve ayarlarını `CLAUDE_CONFIG_DIR` ile verilen klasörde tutar. ClaudeDeck her hesap için `~/Library/Application Support/ClaudeDeck/accounts/<id>/` klasörü oluşturur ve Claude'u bu değişkenle başlatır. Kabuk yapılandırmanız (`.zshrc` vb.) bu değeri ezemesin diye değişken komut satırında yeniden verilir; `ANTHROPIC_API_KEY` gibi kimlik değişkenleri Claude sekmelerinden kaldırılır.

Giriş bilgilerini Claude Code kendisi macOS Anahtar Zinciri'nde saklar; ClaudeDeck token okumaz ve saklamaz.

## Geliştirme

```bash
pnpm install
pnpm dev          # geliştirme modu
pnpm test         # birim testleri (Vitest)
pnpm lint
pnpm typecheck
pnpm build:mac    # dist/claudedeck-<sürüm>-arm64.dmg
```

```
src/main      Electron ana süreç: durum deposu, hesap servisi, PTY yöneticisi, güncelleme denetimi, IPC
src/preload   Renderer'a açılan dar API (contextBridge)
src/renderer  React arayüzü, xterm.js terminal havuzu
src/shared    Tipler, IPC sözleşmesi, tr/en çeviriler
docs/         Tasarım, uygulama planı, ekran görüntüleri
```

Yeni sürüm yayınlamak için `package.json` içindeki `version` değerini artırın, `pnpm build:mac` ile derleyin ve `v<sürüm>` etiketiyle GitHub release oluşturup `.dmg` dosyasını ekleyin. Uygulama `releases/latest` uç noktasını denetler.

## Not

ClaudeDeck bağımsız bir projedir; Anthropic ile bağlantılı değildir.
