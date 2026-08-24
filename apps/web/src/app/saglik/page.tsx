import { actorCan, systemHealth } from '@stok/core'
import type { HealthCheck, HealthLevel } from '@stok/core'
import { appDb } from '@stok/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Shell } from '@/components/shell'
import { formatDateTime } from '@/lib/format'
import { currentActor } from '@/server/session'

/**
 * ============================================================================
 * T25 — SİSTEM SAĞLIĞI
 *
 * PANELDE DEĞİL, KENDİ SAYFASINDA. Invariant kontrolü tüm hareketleri
 * gruplayarak tarıyor; milyon satırlık bir defterde saniyeler sürebilir ve
 * her panel yenilemesinde bunu beklemek kabul edilemez. Panelde sadece bir
 * rozet var, ayrıntı burada.
 *
 * Her satırda DURUM + NE YAPMALI. "3 bekleyen iş" yöneticiye bir şey
 * söylemez; "3 iş kuyrukta, en eskisi 2 saattir bekliyor — arka plan işçisi
 * çalışmıyor olabilir" söyler.
 * ============================================================================
 */

const TONE: Record<HealthLevel, { border: string; text: string; icon: string; label: string }> = {
  ok: { border: 'border-giris', text: 'text-giris', icon: '✓', label: 'Sorun yok' },
  warn: { border: 'border-slate-400', text: 'text-slate-700', icon: '!', label: 'Dikkat' },
  error: { border: 'border-kritik', text: 'text-kritik', icon: '⚠', label: 'Sorun var' },
}

export default async function HealthPage() {
  const actor = await currentActor()
  if (!actor) redirect('/giris')
  if (!actorCan(actor, 'user:manage')) redirect('/panel')

  const health = await systemHealth(actor, { db: appDb() })
  const overall = TONE[health.level]

  return (
    <Shell role={actor.role} active="/saglik">
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">Sistem sağlığı</h1>
        <Link href="/panel" className="text-sm text-slate-600 underline">
          Panele dön
        </Link>
      </div>

      <div
        className={`mb-6 flex items-center gap-3 rounded-md border bg-white p-4 ${overall.border}`}
      >
        {/* Renk tek başına anlam taşımıyor: ikon ve metin de var. */}
        <span aria-hidden className={`text-2xl ${overall.text}`}>
          {overall.icon}
        </span>
        <div>
          <p className={`font-semibold ${overall.text}`}>{overall.label}</p>
          <p className="text-sm text-slate-600">
            Kontrol zamanı: {formatDateTime(health.checkedAt)}
          </p>
        </div>
      </div>

      <ul className="space-y-3">
        {health.checks.map((check) => (
          <CheckRow key={check.key} check={check} />
        ))}
      </ul>

      <p className="mt-6 text-sm text-slate-600">
        Bu sayfa her açılışta yeniden hesaplanıyor. Defter kontrolü bütün hareketleri tarar;
        büyük depolarda birkaç saniye sürebilir.
      </p>
    </Shell>
  )
}

function CheckRow({ check }: { check: HealthCheck }) {
  const tone = TONE[check.level]
  return (
    <li className={`rounded-md border bg-white p-4 ${tone.border}`}>
      <div className="flex items-start gap-3">
        <span aria-hidden className={`text-xl ${tone.text}`}>
          {tone.icon}
        </span>
        <div>
          <p className={check.level === 'ok' ? '' : `font-medium ${tone.text}`}>{check.summary}</p>
          {check.hint ? <p className="mt-1 text-sm text-slate-600">{check.hint}</p> : null}
        </div>
      </div>
    </li>
  )
}
