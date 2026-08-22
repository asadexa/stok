-- ============================================================================
-- GİRİŞ (LOGIN) İÇİN TENANT ÇÖZÜMÜ
--
-- Tavuk-yumurta problemi: RLS politikaları `app.tenant_id` ayarlı değilken
-- HİÇBİR satır geçirmiyor (bilinçli, güvenli varsayılan). Ama giriş anında
-- kullanıcının hangi tenant'a ait olduğunu HENÜZ BİLMİYORUZ — öğrenmek için
-- users tablosunu okumamız gerekiyor, okumak için de tenant'ı bilmemiz.
--
-- Denenip ELENEN yollar:
--
--   1. Uygulamanın sahip rolüyle bağlanıp aramak
--      → D5'in tamamını çöpe atar. Uygulama asla sahip rolüyle bağlanmaz.
--
--   2. `current_tenant_id() IS NULL` iken her satırı geçiren bir politika
--      → Güvenli varsayılanı TERSİNE çevirir: tenant ayarlamayı unutan her
--        kod yolu bütün müşterilerin verisini görür. En kötü hata tipi.
--
--   3. Ayrı bir global `user_directory` tablosu
--      → İkinci bir e-posta kaynağı. Senkron trigger'ı bozulursa giriş
--        sessizce çalışmaz hale gelir. Tek kaynak ilkesine aykırı.
--
-- SEÇİLEN YOL: dar kapsamlı bir SECURITY DEFINER fonksiyonu.
--
--   • Fonksiyon SADECE (user_id, tenant_id) döner. Parola özeti, ad, rol
--     yok — onların hepsi ikinci adımda, tenant bağlamı kurulduktan sonra
--     normal RLS altında okunuyor.
--   • Fonksiyon tabloların SAHİBİ olarak çalışıyor. FORCE ROW LEVEL SECURITY
--     açık olduğu için sahip de politikalara tabi; bu yüzden users üzerinde
--     SADECE SAHİP ROLÜNE ait, `app.auth_lookup` ayarına bağlı ikinci bir
--     politika var. Uygulama rolü bu politikayı KULLANAMAZ (policy `TO`
--     ile role bağlı), yani `set_config('app.auth_lookup','on')` çağırsa
--     bile hiçbir şey değişmez.
--   • Yerelde sahip rolü superuser olduğu için RLS zaten atlanıyor;
--     Supabase'de sahip superuser değil ve politika devreye giriyor.
--     İki ortamda da aynı davranış.
--
-- Sızıntı yüzeyi: "bu e-posta bir tenant'ta var mı" ve o tenant'ın UUID'si.
-- Parola özeti, isim, rol, hiçbir iş verisi bu yoldan çıkmıyor.
-- ============================================================================

-- Politika, migration'ı çalıştıran role (tabloların sahibi) bağlanıyor.
-- Rol adı sabit yazılmıyor: üretimde 'postgres' olmayabilir.
DO $$
BEGIN
  EXECUTE format(
    $f$
      CREATE POLICY auth_lookup ON users
        FOR SELECT
        TO %I
        USING (current_setting('app.auth_lookup', true) = 'on')
    $f$,
    current_user
  );
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_lookup_user(p_email text)
  RETURNS TABLE (user_id uuid, tenant_id uuid)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  -- SECURITY DEFINER fonksiyonlarında search_path sabitlemek zorunlu:
  -- aksi halde çağıran, kendi şemasına sahte bir `users` koyup fonksiyonu
  -- kandırabilir.
  SET search_path = public, pg_temp
AS $$
BEGIN
  -- LOCAL: sadece bu fonksiyonun içinde bulunduğu transaction boyunca.
  PERFORM set_config('app.auth_lookup', 'on', true);

  RETURN QUERY
    SELECT u.id, u.tenant_id
      FROM users u
     WHERE lower(u.email) = lower(btrim(p_email))
     ORDER BY u.created_at
     LIMIT 10;

  PERFORM set_config('app.auth_lookup', '', true);
END
$$;
--> statement-breakpoint

COMMENT ON FUNCTION auth_lookup_user(text) IS
  'Giris icin e-postadan tenant cozumu. Sadece (user_id, tenant_id) doner; parola ozeti ve diger alanlar tenant baglami kurulduktan sonra normal RLS altinda okunur.';
--> statement-breakpoint

-- Varsayılan olarak PUBLIC her fonksiyonu çalıştırabilir. SECURITY DEFINER
-- bir fonksiyonda bu kabul edilemez: yetkiyi açıkça daraltıyoruz.
REVOKE ALL ON FUNCTION auth_lookup_user(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_lookup_user(text) TO stok_app;
--> statement-breakpoint

-- E-posta araması küçük harfe indirgenerek yapılıyor; index de öyle olmalı,
-- yoksa kullanıcı sayısı büyüdükçe her giriş tam tarama yapar.
CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
