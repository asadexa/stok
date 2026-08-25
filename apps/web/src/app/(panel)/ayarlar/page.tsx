import { roleLabel } from '@stok/shared'
import { changeOwnPassword, currentProfile } from '@stok/core'
import { appDb } from '@stok/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { Alert, Notice, SubmitButton } from '@/components/field'
import { type FormParams, errorQuery, messageFrom, text } from '@/server/form'
import { currentActor } from '@/server/session'
import {
  type Theme,
  readSoundEnabled,
  readTheme,
  writeSoundEnabled,
  writeTheme,
} from '@/server/theme'

/**
 * ============================================================================
 * T75 — AYARLAR (tasarım incelemesi, karar TD2)
 *
 * KAPSAM ÜÇ ŞEY, DAHA FAZLASI DEĞİL: hesap bilgisi, parola, görünüm.
 *
 * "Ayarlar" en kolay şişen ekran. Bu üründe işletme ayarı (vergi no, adres),
 * bildirim tercihi ve varsayılan kritik eşik gibi maddelerin hiçbirinin
 * arkasında veri modeli yok; koymak, açılınca hiçbir şey yapmayan anahtarlar
 * dizmek olurdu. Buraya yalnızca BUGÜN GERÇEKTEN ÇALIŞAN üç şey girdi.
 *
 * TEMA BURADA AÇIKÇA SEÇİLİYOR, üst şeritteki düğmede döngüyle. İkisi aynı
 * çereze yazıyor. Döngü hızlı ama üç durumdan hangisinde olduğunu ikonla
 * anlatıyor; burada üç seçenek de yazıyla görünüyor ve "Sistem"in ne demek
 * olduğu açıklanıyor. Sık kullanılan yol kısa, öğrenilen yol açık.
 * ============================================================================
 */

interface AyarParams extends FormParams {
  kaydedildi?: string
}

const THEME_OPTIONS: { value: Theme | 'system'; label: string; hint: string }[] = [
  {
    value: 'system',
    label: 'Sistem',
    hint: 'İşletim sisteminiz koyu temadaysa uygulama da koyu açılır.',
  },
  { value: 'light', label: 'Açık', hint: 'Her zaman açık tema.' },
  { value: 'dark', label: 'Koyu', hint: 'Her zaman koyu tema. Gece vardiyasında göz yormuyor.' },
]

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<AyarParams>
}) {
  const actor = await currentActor()
  if (!actor) redirect('/giris')

  const params = await searchParams
  const message = messageFrom(params)
  const [profile, theme, soundEnabled] = await Promise.all([
    currentProfile(actor, { db: appDb() }),
    readTheme(),
    readSoundEnabled(),
  ])

  async function saveTheme(form: FormData) {
    'use server'
    const value = String(form.get('tema') ?? '')
    // 'system' çereze YAZILMIYOR, çerez SİLİNİYOR: yokluk zaten "sistemi
    // takip et" demek ve tek durumu iki şekilde temsil etmek, ileride
    // ikisinin ayrışmasına davetiye çıkarır (server/theme.ts).
    await writeTheme(value === 'light' || value === 'dark' ? value : null)
    revalidatePath('/', 'layout')
    redirect('/ayarlar?kaydedildi=tema')
  }

  async function saveSound(form: FormData) {
    'use server'
    // Onay kutusu İŞARETLİ DEĞİLSE tarayıcı alanı hiç göndermiyor; yokluk
    // "kapalı" demek. `=== 'acik'` yazmak, gönderilmeyen alanı da kapalı
    // sayıyor ve iki durumu tek kontrolle ayırıyor.
    await writeSoundEnabled(form.get('ses') === 'acik')
    redirect('/ayarlar?kaydedildi=ses')
  }

  async function savePassword(form: FormData) {
    'use server'
    const owner = await currentActor()
    if (!owner) redirect('/giris')

    // YÖNLENDİRMELER `try` DIŞINDA: `redirect()` akış kontrolü için
    // fırlatıyor, içeride bırakılırsa başarı yolu kendi catch'ine düşer.
    let target: string
    try {
      await changeOwnPassword(
        owner,
        {
          currentPassword: text(form, 'mevcut'),
          password: text(form, 'yeni'),
        },
        { db: appDb() },
      )
      // Parola değişince TÜM oturumlar kapanıyor (core: revokeSessions).
      // Bu oturum da kapandı, yani kullanıcı zaten giriş ekranına düşecek.
      // Oraya bir işaretle gidiyoruz ki "ne oldu" sorusu ekranda cevaplansın.
      target = '/giris?bilgi=parola'
    } catch (err) {
      target = `/ayarlar?${errorQuery(err)}`
    }
    redirect(target)
  }

  return (
    <div className="grid max-w-4xl gap-4">
      {message ? <Alert>{message}</Alert> : null}
      {params.kaydedildi === 'tema' ? <Notice>Tema tercihiniz kaydedildi.</Notice> : null}
      {params.kaydedildi === 'ses' ? <Notice>Ses tercihiniz kaydedildi.</Notice> : null}

      {/* ── HESAP ─────────────────────────────────────────────── */}
      <section
        aria-label="Hesap"
        className="rounded-card border border-line bg-surface p-4 shadow-card sm:p-5"
      >
        <h2 className="font-display text-base font-semibold">Hesap</h2>
        <p className="mt-1 text-[13.5px] text-ink-2">
          Ad, e-posta ve rol yalnızca yönetici tarafından değiştirilebilir.
        </p>

        <dl className="mt-4 grid gap-3 sm:grid-cols-3">
          <Field label="Ad" value={profile?.name ?? '—'} />
          <Field label="E-posta" value={profile?.email ?? '—'} mono />
          <Field label="Rol" value={roleLabel(actor.role)} />
        </dl>
      </section>

      {/* ── GÖRÜNÜM ───────────────────────────────────────────── */}
      <section
        aria-label="Görünüm"
        className="rounded-card border border-line bg-surface p-4 shadow-card sm:p-5"
      >
        <h2 className="font-display text-base font-semibold">Görünüm</h2>
        <p className="mt-1 text-[13.5px] text-ink-2">
          Tercih bu tarayıcıda saklanıyor. Üst şeritteki düğmeyle de
          değiştirebilirsiniz.
        </p>

        <form action={saveTheme} className="mt-4">
          <fieldset>
            <legend className="sr-only">Tema</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {THEME_OPTIONS.map((opt) => {
                const current = (theme ?? 'system') === opt.value
                return (
                  <label
                    key={opt.value}
                    className={`flex cursor-pointer gap-3 rounded-control border p-3 ${
                      current ? 'border-accent bg-accent-soft' : 'border-line-control'
                    }`}
                  >
                    <input
                      type="radio"
                      name="tema"
                      value={opt.value}
                      defaultChecked={current}
                      className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
                    />
                    <span className="min-w-0">
                      <span
                        className={`block text-sm font-semibold ${
                          current ? 'text-accent-soft-ink' : ''
                        }`}
                      >
                        {opt.label}
                      </span>
                      <span className="mt-0.5 block text-[12.5px] text-ink-3">{opt.hint}</span>
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>

          <div className="mt-4">
            <SubmitButton tone="secondary">Temayı kaydet</SubmitButton>
          </div>
        </form>
      </section>

      {/* ── SES VE TİTREŞİM ───────────────────────────────────── */}
      <section
        aria-label="Ses ve titreşim"
        className="rounded-card border border-line bg-surface p-4 shadow-card sm:p-5"
      >
        <h2 className="font-display text-base font-semibold">Ses ve titreşim</h2>
        <p className="mt-1 max-w-[62ch] text-[13.5px] text-ink-2">
          Giriş/Çıkış ekranında kayıt tamamlanınca kısa bir bip ve titreşim
          verilir: başarılı tek bip, hata çift bip. Ekrana bakmadan çalışmak
          içindir.
        </p>

        <form action={saveSound} className="mt-4">
          <label className="flex max-w-md cursor-pointer gap-3 rounded-control border border-line-control p-3">
            <input
              type="checkbox"
              name="ses"
              value="acik"
              defaultChecked={soundEnabled}
              className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
            />
            <span>
              <span className="block text-sm font-semibold">Sesli geri bildirim açık</span>
              <span className="mt-0.5 block text-[12.5px] text-ink-3">
                Sessiz bir ortamda çalışıyorsanız kapatın. Titreşim de birlikte
                kapanır.
              </span>
            </span>
          </label>

          <div className="mt-4">
            <SubmitButton tone="secondary">Kaydet</SubmitButton>
          </div>
        </form>
      </section>

      {/* ── PAROLA ────────────────────────────────────────────── */}
      <section
        aria-label="Parola"
        className="rounded-card border border-line bg-surface p-4 shadow-card sm:p-5"
      >
        <h2 className="font-display text-base font-semibold">Parola değiştir</h2>
        <p className="mt-1 max-w-[62ch] text-[13.5px] text-ink-2">
          Mevcut parolanız isteniyor: açık kalmış bir oturumun başına geçen
          birinin parolanızı değiştirip sizi kilitlemesini engelliyor.
        </p>

        <form action={savePassword} className="mt-4 grid max-w-md gap-4">
          {/*
            `type="password"` alanları `TextField` üzerinden gitmiyor, çünkü o
            bileşen `text | number | search` kabul ediyor. Parola alanını oraya
            eklemek, tarayıcı parola yöneticisine dair davranışı (autocomplete
            ipuçları) her metin alanına taşırdı.
          */}
          <PasswordField
            name="mevcut"
            label="Mevcut parola"
            autoComplete="current-password"
          />
          <PasswordField
            name="yeni"
            label="Yeni parola"
            autoComplete="new-password"
            hint="En az 8 karakter."
          />

          <p className="max-w-[62ch] text-[12.5px] text-ink-3">
            Parola değişince açık olan <b>tüm</b> oturumlar kapanır ve yeniden
            giriş yapmanız gerekir. Telefonunuz da dahil.
          </p>

          <div>
            <SubmitButton>Parolayı değiştir</SubmitButton>
          </div>
        </form>
      </section>
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[12.5px] text-ink-3">{label}</dt>
      <dd className={`mt-0.5 font-medium ${mono ? 'font-mono text-[13.5px]' : ''}`}>{value}</dd>
    </div>
  )
}

function PasswordField({
  name,
  label,
  hint,
  autoComplete,
}: {
  name: string
  label: string
  hint?: string
  autoComplete: 'current-password' | 'new-password'
}) {
  return (
    <label className="block">
      <span className="text-[13px] font-semibold">{label}</span>
      <input
        type="password"
        name={name}
        required
        autoComplete={autoComplete}
        className="mt-1.5 h-13 w-full rounded-control border border-line-control bg-surface px-3.5 text-base text-ink"
      />
      {hint ? <span className="mt-1.5 block text-xs text-ink-3">{hint}</span> : null}
    </label>
  )
}
