'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * ============================================================================
 * KOMUT PALETİ — T86 (Kural 05'in işlevsel karşılığı)
 *
 * Tasarım tuvali Kural 05: "Arama hep görünür, hep odaklı. Barkod okuyucu
 * klavye taklidi yapar ve okuduğunu ODAKTAKİ alana yazar. Odak boştaysa
 * okutma kaybolur ve kullanıcı bunu fark etmez."
 *
 * Üst şeritteki arama kutusu kuralın yarısını karşılıyordu (görünür), ama
 * odaklı değildi — ve odaklı YAPILAMAZDI: her sayfada odağı almak, Giriş/Çıkış
 * ekranının barkod alanından odağı çalardı. Palet bu düğümü çözüyor: odak
 * normalde sayfanındır, `Ctrl+K` ile bir tuşta aramaya geçiyor.
 *
 * ÜÇ SONUÇ, ÜÇ EYLEM:
 *   barkod tam eşleşme  →  Giriş/Çıkış (okutma yapılmış, iş yazılacak)
 *   ad / stok kodu      →  ürün kartı
 *   sonuç yok           →  yeni ürün ekle   (PLAN.md boş durum tablosu)
 *
 * BARKOD SONUCU HER ZAMAN EN ÜSTTE ve ilk seçili. Depoda en sık yapılan iş
 * okutup hareket yazmak; o yolu ikinci sıraya koymak, en sık işi en yavaş
 * yol yapardı.
 *
 * `<dialog>` KULLANILMIYOR, elle kurulmuş bir katman var: `showModal()`
 * odak tuzağını kendi kuruyor ama Safari'de `Escape` davranışı ve
 * `::backdrop` desteği sürüm sürüm değişiyor. Buradaki katman `Escape`,
 * dış tıklama ve ok tuşlarını açıkça yönetiyor — üçü de test edilebilir.
 *
 * PALET BİR EK YOL, TEK YOL DEĞİL. JavaScript kapalıysa üst şeritteki
 * `GET /stok` formu çalışmaya devam ediyor.
 * ============================================================================
 */

interface Hit {
  productId: string
  sku: string
  name: string
  category: string | null
  unit: string
  qty: number
  critical: boolean
}

interface SearchResult {
  barcode: {
    barcode: string
    productId: string
    name: string
    sku: string
    unit: string
    qty: number
    archived: boolean
  } | null
  products: Hit[]
}

interface Row {
  key: string
  href: string
  title: string
  detail: string
  kind: 'barkod' | 'urun' | 'yeni'
}

const EMPTY: SearchResult = { barcode: null, products: [] }

function toRows(result: SearchResult, query: string, canCreate: boolean): Row[] {
  const rows: Row[] = []

  if (result.barcode) {
    const b = result.barcode
    rows.push({
      key: `b:${b.barcode}`,
      // Barkodu adres çubuğuna taşıyoruz: Giriş/Çıkış ekranı zaten `?barkod=`
      // ile çalışıyor ve okutma adımı atlanmış oluyor.
      href: `/hareket?barkod=${encodeURIComponent(b.barcode)}`,
      title: b.name,
      detail: b.archived
        ? `${b.sku} · ARŞİVDE — hareket yazılamaz`
        : `${b.sku} · mevcut ${b.qty} ${b.unit.toLowerCase()} · Giriş/Çıkış`,
      kind: 'barkod',
    })
  }

  for (const p of result.products) {
    // Barkod eşleşmesiyle aynı ürünü iki kez listeleme.
    if (result.barcode?.productId === p.productId) continue
    rows.push({
      key: `p:${p.productId}`,
      href: `/urunler/${p.productId}`,
      title: p.name,
      detail: `${p.sku}${p.category ? ` · ${p.category}` : ''} · ${p.critical ? 'kritik' : 'stok'} ${p.qty}`,
      kind: 'urun',
    })
  }

  if (rows.length === 0 && query.trim().length >= 2 && canCreate) {
    rows.push({
      key: 'yeni',
      href: `/urunler/yeni?ad=${encodeURIComponent(query.trim())}`,
      title: `"${query.trim()}" için yeni ürün ekle`,
      detail: 'Aranan bulunamadı',
      kind: 'yeni',
    })
  }

  return rows
}

export function CommandPalette({ canCreate }: { canCreate: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<SearchResult>(EMPTY)
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const rows = toRows(result, query, canCreate)

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setResult(EMPTY)
    setActive(0)
  }, [])

  // Ctrl+K / Cmd+K. `keydown` belgede: kullanıcı nerede olursa olsun açılmalı.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Arama. 180ms bekleme: barkod okuyucu bütün kodu milisaniyeler içinde
  // yazıyor ve her karakterde sorgu açmak 13 gereksiz istek demek olurdu.
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < 2) {
      setResult(EMPTY)
      return
    }

    const ac = new AbortController()
    const timer = window.setTimeout(async () => {
      setBusy(true)
      try {
        const res = await fetch(`/api/arama?q=${encodeURIComponent(q)}`, {
          signal: ac.signal,
        })
        if (!res.ok) return
        setResult((await res.json()) as SearchResult)
        setActive(0)
      } catch {
        // İptal edilen istek ya da ağ hatası. Bir sonraki tuş yeniden dener.
      } finally {
        setBusy(false)
      }
    }, 180)

    return () => {
      window.clearTimeout(timer)
      ac.abort()
    }
  }, [query, open])

  if (!open) return null

  function go(row: Row | undefined) {
    if (!row) return
    close()
    router.push(row.href)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 p-4 pt-[12vh]"
      // Dış tıklama kapatıyor. `currentTarget` kontrolü şart: panelin
      // içindeki bir tıklama da buraya kabarıyor.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Ara"
        className="w-full max-w-xl overflow-hidden rounded-[14px] border border-line bg-surface shadow-card"
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <svg
            aria-hidden
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="shrink-0 text-ink-3"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((i) => Math.min(i + 1, rows.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                go(rows[active])
              }
            }}
            placeholder="Barkod okutun ya da ürün adı / stok kodu yazın"
            aria-label="Ürün, stok kodu veya barkod ara"
            className="h-14 w-full bg-transparent text-base outline-none placeholder:text-ink-3"
          />
          <kbd className="shrink-0 rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-3">
            Esc
          </kbd>
        </div>

        <div className="max-h-[52vh] overflow-y-auto">
          {query.trim().length < 2 ? (
            <p className="px-4 py-6 text-center text-[13.5px] text-ink-3">
              En az iki harf yazın. Barkod okutursanız doğrudan Giriş/Çıkış
              ekranına geçilir.
            </p>
          ) : rows.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13.5px] text-ink-3">
              {busy ? 'Aranıyor…' : 'Sonuç yok.'}
            </p>
          ) : (
            <ul>
              {rows.map((row, i) => (
                <li key={row.key} className="border-t border-line first:border-t-0">
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(row)}
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left ${
                      i === active ? 'bg-accent-soft' : ''
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`grid size-8 shrink-0 place-items-center rounded-lg text-[11px] font-semibold ${
                        row.kind === 'barkod'
                          ? 'bg-ok-soft text-ok-soft-ink'
                          : row.kind === 'yeni'
                            ? 'bg-accent-soft text-accent-soft-ink'
                            : 'bg-surface-2 text-ink-2'
                      }`}
                    >
                      {row.kind === 'barkod' ? '⎸⎹' : row.kind === 'yeni' ? '+' : '#'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] leading-tight font-semibold">
                        {row.title}
                      </span>
                      <span className="block truncate font-mono text-[11.5px] leading-tight text-ink-3">
                        {row.detail}
                      </span>
                    </span>
                    {i === active ? (
                      <kbd className="shrink-0 rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-3">
                        ↵
                      </kbd>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
