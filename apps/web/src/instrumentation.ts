import { assertServerConfig, warnOptionalConfig } from './server/config'

/**
 * ============================================================================
 * T116 — YAPILANDIRMA KONTROLÜ ÜRETİMDE DE KOŞSUN
 *
 * Next bu kancayı sunucu örneği başlarken BİR KEZ çağırıyor — Vercel'de
 * serverless fonksiyonu ilk kez ayağa kalktığında da. `next.config.ts`
 * üretimde hiç yüklenmediği için tek gerçek çalışma anı burası.
 *
 * NEDEN ÖNCE `console.error` SONRA `throw`. Fırlatılan hatanın nereye
 * yazılacağı platforma göre değişiyor; konsola kendimiz yazmak, mesajın
 * operatörün log akışında GÖRÜNMESİNİ garanti ediyor. Sadece fırlatmak,
 * "fonksiyon çöktü" satırıyla yetinilen bir platformda eksiğin ne
 * olduğunu gizleyebilirdi.
 *
 * FIRLATMAK DOĞRU: eksik yapılandırmayla uygulama zaten çalışamıyor.
 * Yutup devam etmek, hatayı ilk giriş denemesine ertelerdi — düzeltmeye
 * çalıştığımız arızanın ta kendisi.
 *
 * `nodejs` KONTROLÜ: bu kanca Edge çalışma zamanında da çağrılabiliyor ve
 * orada `process.env` aynı değişkenlerle dolmuyor. Edge'de koşup boş yere
 * patlamasın.
 * ============================================================================
 */
export function register(): void {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  try {
    assertServerConfig()
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    throw err
  }

  warnOptionalConfig()
}
