-- ============================================================================
-- CRON İÇİN TENANT LİSTESİ (T34)
--
-- Gün sonu raporu ve kritik stok taraması HER tenant için çalışmalı, ama
-- cron'un oturumu yok: `app.tenant_id` ayarlı değilken RLS hiçbir satır
-- geçirmiyor. 0004'teki tavuk-yumurta probleminin aynısı, bu kez giriş
-- yerine zamanlanmış iş için.
--
-- Denenip ELENEN yollar:
--
--   1. Cron'a BYPASSRLS ya da sahip rolü vermek
--      → D5'i çöpe atar. Uygulama hiçbir yoldan sahip rolüyle bağlanmıyor;
--        cron da uygulamanın içinde çalışıyor (aynı süreç, aynı havuz).
--
--   2. Tenant kimliklerini ortam değişkenine yazmak
--      → Yeni müşteri eklendiğinde raporu SESSİZCE çıkmaz. Tam olarak
--        G4'ün tarif ettiği hata sınıfı: kimse fark etmiyor.
--
--   3. `tenants` tablosunu okuyan ikinci bir fonksiyon
--      → Gereksiz. İhtiyaç duyulan iki alan (tenant ve raporu isteyen
--        kullanıcının kimliği) zaten `users` içinde; ikinci bir tablonun
--        politikasını gevşetmek yüzeyi boşuna büyütürdü.
--
-- SEÇİLEN YOL: 0004'ün `auth_lookup` politikasını YENİDEN KULLANAN dar bir
-- SECURITY DEFINER fonksiyonu. Politika zaten "tenant bağlamı KURULMADAN
-- ÖNCE kimlik çözümü yapan, sahip yetkili, search_path'i sabitlenmiş bir
-- fonksiyon okuyor" demek; cron'un tenant taraması tam olarak bu.
-- İkinci bir politika açmak, `users` üzerinde yalnızca ayar adı farklı iki
-- kapı bırakırdı — biri kapatılıp diğeri unutulabilir.
--
-- Sızıntı yüzeyi: tenant UUID'leri ve her birinin en eski aktif
-- yöneticisinin UUID'si. E-posta, ad, parola özeti, hiçbir iş verisi bu
-- yoldan çıkmıyor. Tenant UUID'sini bilmek zaten yetki DEĞİL: uygulama
-- kodu `withTenant()`'a istediği kimliği verebiliyor, RLS'in koruduğu şey
-- bu değil — WHERE'i unutan sorgu.
-- ============================================================================

CREATE OR REPLACE FUNCTION cron_tenants()
  RETURNS TABLE (tenant_id uuid, user_id uuid)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  -- 0004'teki gerekçenin aynısı: sabitlenmezse çağıran kendi şemasına
  -- sahte bir `users` koyup fonksiyonu kandırabilir.
  SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM set_config('app.auth_lookup', 'on', true);

  -- Tenant başına TEK satır: en eski aktif yönetici. Kuyruk satırı bir
  -- kullanıcıya bağlanmak zorunda (`requested_by` NOT NULL); "sistem" diye
  -- sahte bir kullanıcı uydurmak denetim izinde gerçek olmayan bir isim
  -- bırakırdı.
  RETURN QUERY
    SELECT DISTINCT ON (u.tenant_id) u.tenant_id, u.id
      FROM users u
     WHERE u.role = 'ADMIN' AND u.active = true
     ORDER BY u.tenant_id, u.created_at;

  PERFORM set_config('app.auth_lookup', '', true);
END
$$;
--> statement-breakpoint

COMMENT ON FUNCTION cron_tenants() IS
  'Zamanlanmis isler icin tenant listesi: her tenant ve en eski aktif yoneticisi. Sadece UUID doner.';
--> statement-breakpoint

REVOKE ALL ON FUNCTION cron_tenants() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION cron_tenants() TO stok_app;
