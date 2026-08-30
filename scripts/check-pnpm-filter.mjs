#!/usr/bin/env node
/**
 * `pnpm --filter X <script>` KULLANIMINI YASAKLAR.
 *
 * NEDEN VAR. pnpm, `--filter <paket>` sonrasındaki ilk kelimeyi script değil
 * ÇALIŞTIRILABİLİR sayıyor. Windows'ta `pnpm --filter @stok/db migrate`
 * komutu `'migrate' is not recognized` veriyor; Linux ve macOS'ta ise
 * çoğunlukla çalışıyor. Yani hata YALNIZCA Windows'ta görünüyor ve
 * geliştirme makinesi Windows olmayan biri onu hiç görmüyor.
 *
 * T57'de bu tam olarak yaşandı: kullanıcı ilk komutta duvara tosladı ve on
 * iki çağrı düzeltildi. On üçüncüsü sessizce eklenebilir — bu betik onu
 * eklendiği anda yakalıyor.
 *
 * NEDEN WINDOWS CI YETMİYOR. Windows işi bu çağrıların hepsini KOŞMUYOR:
 * README'deki, hata mesajlarındaki ve dokümandaki komutlar hiç
 * çalıştırılmıyor. T57'nin on üçüncü örneği zaten öyle bir yerdeydi —
 * `packages/db/src/testing.ts` içinde, kullanıcıya gösterilen bir hata
 * mesajının içinde. Statik tarama orayı görüyor, koşan bir test görmüyor.
 *
 * Doğru biçim: `pnpm --filter <paket> run <script>` ya da
 *              `pnpm --filter <paket> exec <binary>`
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '..')

// Yalnızca sürüm kontrolündeki dosyalar: node_modules ve derleme çıktısı
// bizim sorunumuz değil. `git ls-files` bunu bedavaya çözüyor.
const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(json|mjs|js|ts|tsx|md|yml|yaml)$/.test(f))

// `--filter <paket>` sonrası ilk kelime: `run` veya `exec` DEĞİLSE hata.
//
// `<` ile başlayanlar hariç: `pnpm --filter X <script>` bir komut değil,
// kuralın KENDİSİNİ anlatan dokümantasyon yer tutucusu (CLAUDE.md, PLAN.md,
// demo-testi skill'i). Onları da hata sayarsak koruma, varlık sebebini
// açıklayan metni suçlar ve ilk çare korumayı kapatmak olur.
const PATTERN = /pnpm\s+--filter\s+\S+\s+(?!run\b|exec\b|--|<)(\S+)/

const bulgular = []

for (const file of files) {
  let content
  try {
    content = readFileSync(resolve(ROOT, file), 'utf8')
  } catch {
    continue // ikili dosya veya silinmiş
  }

  content.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim()
    // Yorum satırları hariç: bu betiğin ve demo.mjs'in kendi açıklamaları
    // hatayı ANLATIYOR, işlemiyor.
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('#')) return

    const m = PATTERN.exec(line)
    if (m) bulgular.push({ file, line: i + 1, text: trimmed, word: m[1] })
  })
}

if (bulgular.length === 0) {
  console.log(`pnpm --filter kullanımı temiz (${files.length} dosya tarandı).`)
  process.exit(0)
}

console.error('')
console.error('HATA: `pnpm --filter X <script>` kullanımı bulundu.')
console.error('pnpm ilk kelimeyi script değil çalıştırılabilir sayıyor;')
console.error("Windows'ta `'<script>' is not recognized` veriyor (T57).")
console.error('')
for (const b of bulgular) {
  console.error(`  ${b.file}:${b.line}`)
  console.error(`    ${b.text}`)
  console.error(`    -> "run ${b.word}" veya "exec ${b.word}" olmalı`)
  console.error('')
}
process.exit(1)
