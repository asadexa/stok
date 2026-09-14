# ADR-003: Mobil çevrimdışı yazma — outbox + idempotency anahtarı

- **Tarih:** 2026-08-12
- **Durum:** Kabul edildi (uygulanmadı — Faz 5)
- **İlgili:** PLAN.md Bölüm 2, D9, T26-T33, T49

## Bağlam

Depoda kapsama yok. Ürünün tamamı buna dayanıyor: telefon el terminaline
dönüşecekse, **çevrimdışıyken de okutma kabul etmek** zorunda. "İnternet
gelince tekrar dene" diyen bir ekran, çalışanı kağıda geri döndürür.

Çevrimdışı yazmanın iki zor sorusu var: kayıt nerede bekleyecek, ve bağlantı
gelince **aynı kayıt iki kez yazılırsa ne olacak**.

## Karar

1. **Outbox.** Çevrimdışı okutma cihazda yerel bir kuyruğa yazılıyor.
   Kullanıcı onayı ANINDA alıyor — sunucuya ulaşmayı beklemiyor.
2. **Idempotency anahtarı okutma anında üretiliyor**, gönderim anında değil.
   Anahtar kaydın kendisiyle birlikte kuyrukta duruyor.
3. Sunucuda `(tenant_id, idempotency_key)` üzerinde **UNIQUE** index. Aynı
   anahtar ikinci kez geldiğinde yeni hareket üretilmiyor; var olan cevap
   dönüyor.
4. Çevrimdışı **tanınmayan barkod REDDEDİLMİYOR**, `unresolved` işaretiyle
   kabul ediliyor. Senkronda çözülüyor, çözülemezse yöneticiye bildirim
   düşüyor (D9).

## Elenen yollar

**Gönderim anında anahtar üretmek.** Kuyruktaki kayıt iki kez gönderilirse
(uygulama çöktü, kullanıcı yeniden açtı) iki farklı anahtar üretilir ve
**çift kayıt** oluşur. Depoda bunun farkı sayım gününe kadar görünmez.

**Zaman damgası + kullanıcı ile tekilleştirme.** Cihaz saati güvenilmez —
yanlış ayarlı telefon gerçek bir senaryo. İki farklı okutma aynı saniyeye
düşerse biri sessizce yutulurdu.

**Çevrimdışı tanınmayan barkodu reddetmek.** En basit kural ve **veri
kaybettiriyor**: çalışan gerçekten bir şey okuttu, sistem onu unutuyor.
İşaretlemek, sonradan düzeltilebilir bir kayıt bırakıyor.

**Çevrimdışını hiç desteklememek.** Ürünün varlık sebebini ortadan
kaldırıyor. PLAN Bölüm 10: "mobil offline yazılmazsa sonradan eklemek mobili
baştan yazmak demek" — bu yüzden karar en baştan verildi, uygulaması
ertelense bile.

## Sonuçlar

**İyi:** Çalışan kapsama düşünmüyor. Okutuyor, onay görüyor, devam ediyor.

**Bedel:** İki doğruluk kaynağı var (cihaz kuyruğu + sunucu defteri) ve
aradaki fark **görünür** olmak zorunda. PLAN Bölüm 8'in "outbox'ta bekleyen
kayıt" metriği ve "bekleyen > 50" alarmı bunun için.

**Bedel:** Stok, çevrimdışı yazan cihaz sayısı kadar geriden geliyor.
Negatif stok kararı (U1) bu yüzden yalnızca bir yetki sorusu değil, aynı
zamanda bir gecikme sorusu.

## Bugünkü durum

**Sunucu tarafı HAZIR:** idempotency anahtarı `createMovement`'ta zorunlu ve
UNIQUE index kurulu; web arayüzü bile anahtarı okutma anında üretiyor. Yani
çift kayıt koruması bugün çalışıyor ve testleri var.

**Cihaz tarafı YOK:** outbox, yerel önbellek ve `unresolved` akışı Faz 5'te.
