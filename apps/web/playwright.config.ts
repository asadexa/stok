import { defineConfig, devices } from '@playwright/test'

/**
 * ============================================================================
 * T93 — DUMAN TESTİ
 *
 * NEDEN TARAYICI, NEDEN `curl` DEĞİL.
 * Giriş bir Next.js Server Action (`apps/web/src/app/giris/page.tsx` içinde
 * `'use server'`). Düz bir form POST'u değil: çağırmak için derlemeye göre
 * değişen bir `Next-Action` kimliği gerekiyor. `curl` ile sürdürülebilir
 * şekilde tetiklenemez, ve giriş denenmezse bu testin varlık sebebi kalmaz —
 * T58'de `GET /giris` çalışıyordu, düşen şey İLK GİRİŞ DENEMESİYDİ.
 *
 * SUNUCUYU PLAYWRIGHT YÖNETİYOR. CI'da elle arka plana atıp `curl` ile
 * beklemek, "açık port hazır demek değil" hatasının (T59) aynısını iş
 * akışında tekrarlamak olurdu. `webServer.url` gerçek bir yanıt bekliyor.
 *
 * `next build` ÖNCE ÇALIŞMALI. `pnpm run start` derlenmiş çıktıyı açıyor;
 * derleme burada tetiklenmiyor çünkü yerelde her test koşusunda yeniden
 * derlemek dakikalar yer.
 * ============================================================================
 */

const PORT = Number(process.env.SMOKE_PORT ?? 3000)
const BASE_URL = process.env.SMOKE_BASE_URL ?? `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',

  // Duman testi sıralı: aynı demo verisine ve aynı oturum sayaçlarına
  // vuruyorlar. Paralellik burada hız değil, yanlış alarm üretir.
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,
  // Tekrar denemek YOK. Duman testi kırılgan olmamalı; kırılgansa kendisi
  // düzeltilmeli. `retries` kırılganlığı gizler ve zamanla teste güven biter.
  retries: 0,
  timeout: 60_000,

  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: BASE_URL,
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    // Hata anında ne olduğunu göstersin: T61'in dersi, teşhisin kimseye
    // ulaşmamasının hatanın kendisinden pahalı olduğuydu.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'pnpm run start',
    url: BASE_URL,
    // Yerelde `pnpm dev` açıksa ona bağlan; CI'da her zaman kendi sunucusunu
    // açsın, yoksa önceki adımdan sızmış bir süreç testi yalancı yeşil yapar.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Sunucu günlüğü test çıktısına aksın. T61 tam olarak bunun yokluğuydu:
    // `SERVER_ERROR` görünüyordu, sunucu tarafında hiçbir iz yoktu.
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
