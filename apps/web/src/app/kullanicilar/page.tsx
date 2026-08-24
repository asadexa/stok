import { ROLES, ROLE_VALUES, type Role, roleLabel } from '@stok/shared'
import { actorCan, createUser, listTenantUsers, setUserPassword, updateUser } from '@stok/core'
import { appDb } from '@stok/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Alert, Notice, SelectField, SubmitButton, TextField } from '@/components/field'
import { Shell } from '@/components/shell'
import { type FormParams, errorQuery, messageFrom, optionalText, text } from '@/server/form'
import { currentActor } from '@/server/session'

/**
 * ============================================================================
 * T24 — KULLANICI YÖNETİMİ
 *
 * PAROLAYI YÖNETİCİ BELİRLİYOR, davet e-postası yok. Depo işletmesinde
 * çalışanın çoğu zaman iş e-postası yok; davet bağlantısı gidecek bir
 * adres de yok. Gerçekte olan şu: yönetici parolayı belirliyor ve sözlü
 * olarak veriyor. Akışı buna göre kurmak, "e-postanı kontrol et" deyip
 * çıkmaz sokağa sokmaktan dürüst.
 *
 * İKİ KİLİT SUNUCUDA (users.ts): yönetici kendini düşüremiyor ve son
 * yönetici korunuyor. Buradaki gizlemeler sadece görgü kuralı — asıl
 * kontrol serviste ve testleri orada.
 *
 * SİLME YOK, PASİFLEŞTİRME VAR. İşten ayrılan çalışanın geçmiş
 * hareketleri defterde duruyor ve denetimde tam da onlar aranıyor.
 * ============================================================================
 */

interface UserParams extends FormParams {
  eklendi?: string
  guncellendi?: string
  parola?: string
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<UserParams>
}) {
  const actor = await currentActor()
  if (!actor) redirect('/giris')
  if (!actorCan(actor, 'user:manage')) redirect('/panel')

  const params = await searchParams
  const message = messageFrom(params)
  const people = await listTenantUsers(actor, { db: appDb() })

  async function addUser(form: FormData) {
    'use server'
    const owner = await currentActor()
    if (!owner) redirect('/giris')

    // Yönlendirmeler `try` DIŞINDA: Next'in `redirect()` fonksiyonu akış
    // kontrolü için fırlatıyor, içeride bırakılırsa başarı yolu kendi
    // catch'ine düşer ve kullanıcı, kayıt gerçekten yazılmışken hata görür.
    let target: string
    try {
      await createUser(
        owner,
        {
          email: text(form, 'email'),
          name: text(form, 'ad'),
          role: text(form, 'rol'),
          password: text(form, 'parola'),
          ...(optionalText(form, 'pin') ? { pin: optionalText(form, 'pin') } : {}),
        },
        { db: appDb() },
      )
      target = '/kullanicilar?eklendi=1'
    } catch (err) {
      target = `/kullanicilar?${errorQuery(err)}`
    }
    redirect(target)
  }

  async function changeUser(form: FormData) {
    'use server'
    const owner = await currentActor()
    if (!owner) redirect('/giris')

    const userId = text(form, 'userId')
    const patch: Record<string, unknown> = {}
    if (form.get('rol')) patch.role = text(form, 'rol')
    if (form.get('islem') === 'pasif') patch.active = false
    if (form.get('islem') === 'aktif') patch.active = true

    let target: string
    try {
      await updateUser(owner, userId, patch, { db: appDb() })
      target = '/kullanicilar?guncellendi=1'
    } catch (err) {
      target = `/kullanicilar?${errorQuery(err)}`
    }
    redirect(target)
  }

  async function resetPassword(form: FormData) {
    'use server'
    const owner = await currentActor()
    if (!owner) redirect('/giris')

    let target: string
    try {
      await setUserPassword(
        owner,
        text(form, 'userId'),
        { password: text(form, 'yeniParola') },
        { db: appDb() },
      )
      target = '/kullanicilar?parola=1'
    } catch (err) {
      target = `/kullanicilar?${errorQuery(err)}`
    }
    redirect(target)
  }

  return (
    <Shell role={actor.role} active="/kullanicilar">
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">Kullanıcılar</h1>
        <Link href="/panel" className="text-sm text-slate-600 underline">
          Panele dön
        </Link>
      </div>

      <div className="mb-4 space-y-3">
        {message ? <Alert>{message}</Alert> : null}
        {params.eklendi ? <Notice>Kullanıcı eklendi. Parolayı kendisine iletin.</Notice> : null}
        {params.guncellendi ? <Notice>Değişiklik kaydedildi.</Notice> : null}
        {params.parola ? (
          <Notice>Parola değiştirildi ve kullanıcının açık oturumları kapatıldı.</Notice>
        ) : null}
      </div>

      <section aria-label="Kullanıcı listesi" className="mb-6 rounded-md border border-slate-200 bg-white">
        <h2 className="border-b border-slate-200 px-4 py-3 font-semibold">
          {people.length} kullanıcı
        </h2>
        <ul>
          {people.map((person) => (
            <li key={person.id} className="border-t border-slate-100 px-4 py-3 first:border-t-0">
              <div className="flex flex-wrap items-center gap-3">
                <span className={`font-medium ${person.active ? '' : 'text-slate-400'}`}>
                  {person.name}
                </span>
                <span className="rounded-md bg-slate-100 px-2 py-1 text-xs">
                  {roleLabel(person.role)}
                </span>
                {person.active ? null : (
                  <span className="rounded-md bg-slate-200 px-2 py-1 text-xs">Pasif</span>
                )}
                {person.id === actor.userId ? (
                  <span className="text-xs text-slate-500">(siz)</span>
                ) : null}
              </div>

              <div className="mt-3 flex flex-wrap items-end gap-3">
                {/* Rol değiştirme */}
                <form action={changeUser} className="flex items-end gap-2">
                  <input type="hidden" name="userId" value={person.id} />
                  <label className="text-sm">
                    <span className="block text-slate-600">Rol</span>
                    <select
                      name="rol"
                      defaultValue={person.role}
                      className="mt-1 h-11 rounded-md border border-slate-300 bg-white px-2"
                    >
                      {ROLE_VALUES.map((r: Role) => (
                        <option key={r} value={r}>
                          {ROLES[r].tr}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="submit"
                    className="h-11 rounded-md border border-slate-300 px-4 text-sm hover:bg-slate-100"
                  >
                    Değiştir
                  </button>
                </form>

                {/* Aktiflik */}
                <form action={changeUser}>
                  <input type="hidden" name="userId" value={person.id} />
                  <input type="hidden" name="islem" value={person.active ? 'pasif' : 'aktif'} />
                  <button
                    type="submit"
                    disabled={person.id === actor.userId}
                    title={
                      person.id === actor.userId
                        ? 'Kendinizi pasifleştiremezsiniz'
                        : undefined
                    }
                    className={`h-11 rounded-md border px-4 text-sm disabled:opacity-40 ${
                      person.active
                        ? 'border-kritik text-kritik hover:bg-kritik-bg'
                        : 'border-slate-300 hover:bg-slate-100'
                    }`}
                  >
                    {person.active ? 'Pasifleştir' : 'Aktifleştir'}
                  </button>
                </form>

                {/* Parola sıfırlama */}
                <form action={resetPassword} className="flex items-end gap-2">
                  <input type="hidden" name="userId" value={person.id} />
                  <label className="text-sm">
                    <span className="block text-slate-600">Yeni parola</span>
                    <input
                      name="yeniParola"
                      type="text"
                      minLength={8}
                      required
                      placeholder="en az 8 karakter"
                      // `type="password"` DEĞİL: yönetici parolayı
                      // çalışana sözlü olarak verecek, yazdığını görmesi
                      // gerekiyor. Gizlemek burada güvenlik değil engel.
                      className="mt-1 h-11 w-44 rounded-md border border-slate-300 px-2"
                    />
                  </label>
                  <button
                    type="submit"
                    className="h-11 rounded-md border border-slate-300 px-4 text-sm hover:bg-slate-100"
                  >
                    Sıfırla
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <form
        action={addUser}
        className="max-w-2xl space-y-5 rounded-md border border-slate-200 bg-white p-5"
      >
        <h2 className="font-semibold">Yeni kullanıcı</h2>

        <div className="grid gap-5 sm:grid-cols-2">
          <TextField name="ad" label="Ad soyad" required />
          <TextField name="email" label="E-posta" required hint="Giriş için kullanılacak." />
        </div>

        <div className="grid gap-5 sm:grid-cols-3">
          <SelectField
            name="rol"
            label="Rol"
            defaultValue="STAFF"
            options={ROLE_VALUES.map((r: Role) => ({ value: r, label: ROLES[r].tr }))}
            hint="Çalışan fiyat göremez ve ürün tanımlayamaz."
          />
          <TextField
            name="parola"
            label="Parola"
            required
            hint="En az 8 karakter. Kullanıcıya siz ileteceksiniz."
          />
          <TextField name="pin" label="PIN (isteğe bağlı)" hint="Paylaşılan telefonda hızlı geçiş için 4-8 rakam." />
        </div>

        <SubmitButton>Kullanıcıyı ekle</SubmitButton>
      </form>
    </Shell>
  )
}
