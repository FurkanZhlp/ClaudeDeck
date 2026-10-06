// pnpm hoisted kurulumu bazı dosya sistemlerinde (ör. harici APFS disk) çalıştırma bitlerini
// korumuyor. .bin hedeflerini ve node-pty spawn-helper'ı çalıştırılabilir yapar.
import { chmodSync, existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

function makeExecutable(file) {
  if (existsSync(file) && statSync(file).isFile()) chmodSync(file, statSync(file).mode | 0o111)
}

const bin = 'node_modules/.bin'
if (existsSync(bin)) {
  for (const name of readdirSync(bin)) {
    try {
      makeExecutable(realpathSync(join(bin, name)))
    } catch {
      // kırık bağlantı
    }
  }
}

const prebuilds = 'node_modules/node-pty/prebuilds'
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) makeExecutable(join(prebuilds, dir, 'spawn-helper'))
}
