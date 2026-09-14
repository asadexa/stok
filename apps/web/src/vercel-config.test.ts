import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * ============================================================================
 * T42 — `vercel.json` İLE KOD ARASINDAKİ BAĞ
 *
 * NEDEN BU DOSYA VAR. `vercel.json` kodun geri kalanına hiçbir derleyici
 * ya da tip tarafından bağlı değil. Cron girdisi bir YOL DİZESİ; rota
 * taşınır, adı değişir ya da `GET` export'u kaldırılırsa zamanlayıcı
 * sessizce 404/405 almaya başlar. Hiçbir test kırmızı yanmaz, hiçbir
 * derleme patlamaz, gün sonu raporu bir daha hiç çıkmaz ve bunu fark
 * etmenin tek yolu raporun gelmediğini görmek olur — G4'ün ta kendisi.
 *
 * JSON YORUM KABUL ETMİYOR, bu yüzden dosyanın gerekçesi PLAN.md'de
 * (T42) ve `docs/uretim-runbook.md` içinde; burada sınanan şey dosyanın
 * KODLA TUTARLI kalması.
 * ============================================================================
 */
describe('vercel.json (T42)', () => {
  const kok = new URL('../', import.meta.url)
  const config = JSON.parse(readFileSync(new URL('vercel.json', kok), 'utf8')) as {
    crons?: { path: string; schedule: string }[]
    functions?: Record<string, { maxDuration?: number }>
  }

  /** `/api/cron` → `src/app/api/cron/route.ts` */
  function rotaDosyasi(yol: string): string {
    return fileURLToPath(new URL(`src/app${yol}/route.ts`, kok))
  }

  it('cron girdisi var ve gösterdiği rota GERÇEKTEN duruyor', () => {
    const cron = config.crons?.find((c) => c.path === '/api/cron')
    expect(cron, 'vercel.json içinde /api/cron girdisi yok').toBeDefined()

    // Yol dizesi ile dosya arasındaki tek bağ bu satır.
    expect(() => readFileSync(rotaDosyasi('/api/cron'), 'utf8')).not.toThrow()
  })

  it('cron SAATLİK koşuyor — HEALTH_ALARM saatlik dedupe istiyor', () => {
    const cron = config.crons?.find((c) => c.path === '/api/cron')

    // `packages/core/src/cron.ts` içinde dedupe anahtarı HEALTH_ALARM için
    // `${kind}:${day}:${hour}`. Günlük bir zamanlayıcıda alarm sınıfı ölü
    // doğardı: sabah bakılır, gün içinde bir daha bakılmaz.
    expect(cron?.schedule).toBe('0 * * * *')
  })

  it('cron rotası GET export ediyor — Vercel Cron başka metot kullanmıyor', async () => {
    // T115'in kalıcı bekçisi. `GET` kaldırılırsa Next 405 döner ve
    // zamanlayıcı "kurulu" görünürken tur hiç çalışmaz.
    const rota = (await import('./app/api/cron/route')) as Record<string, unknown>

    expect(typeof rota.GET, 'cron rotası GET export etmiyor').toBe('function')
    // POST da kalmalı: elle tetikleyenin (curl, systemd timer) doğru metodu.
    expect(typeof rota.POST, 'cron rotası POST export etmiyor').toBe('function')
  })

  it('cron fonksiyonuna maxDuration verilmiş ve dosya yolu doğru', () => {
    const girdiler = Object.entries(config.functions ?? {})
    const cron = girdiler.find(([yol]) => yol.includes('api/cron'))

    expect(cron, 'cron rotası için functions girdisi yok').toBeDefined()
    const [yol, ayar] = cron ?? ['', {}]

    // Vercel'in varsayılan süre sınırı turun tamamı için kısa: tur her
    // kiracı için planlıyor, kuyruğu işliyor ve e-posta gönderiyor.
    expect(ayar.maxDuration).toBeGreaterThanOrEqual(60)
    // Desen var olmayan bir dosyayı gösteriyorsa Vercel onu sessizce yok
    // sayar ve fonksiyon varsayılan sınırla koşar.
    expect(() => readFileSync(fileURLToPath(new URL(yol, kok)), 'utf8')).not.toThrow()
  })
})
