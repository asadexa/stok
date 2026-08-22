-- ============================================================================
-- KABA KUVVET SAYACI (T51, tehdit S9)
--
-- Problem: giriş endpoint'i açık ve parola sınırsız denenebiliyor. scrypt
-- her denemeyi ~100 ms'ye çıkarıyor ama bu koruma DEĞİL: saldırgan paralel
-- ve dağıtık deneme yapar, ayrıca her deneme sunucu CPU'su yer — yani
-- sayaçsız bir giriş endpoint'i aynı zamanda bir hizmet reddi kapısıdır.
--
-- NEDEN AYRI BİR TABLO VE NEDEN RLS DIŞI:
-- Sayaç, kullanıcı DOĞRULANMADAN ÖNCE artmak zorunda. O anda tenant
-- bilinmiyor (auth_lookup_user henüz çağrılmadı ya da e-posta hiç kayıtlı
-- değil). Tenant'a bağlanamayan bir sayacı tenant'a göre süzemeyiz.
--
-- Bu yüzden tablo tenant_id TAŞIMIYOR ve uygulama rolü tabloya DOĞRUDAN
-- ERİŞEMİYOR. Erişimin tamamı üç SECURITY DEFINER fonksiyonundan geçiyor:
--
--   auth_record_failure()  başarısız denemeyi atomik olarak sayar
--   auth_read_attempts()   mevcut sayacı okur
--   auth_clear_attempts()  başarılı girişten sonra sıfırlar
--
-- Böylece uygulama "kaç deneme oldu" sorusunu sorabiliyor ama sayacı
-- silemiyor, başkasının satırını okuyamıyor, tabloyu tarayamıyor.
-- Uygulama kodundaki bir hata sayacı devre dışı bırakamaz.
--
-- POLİTİKA BURADA DEĞİL: eşik, kilit süresi ve üstel artış TypeScript
-- tarafında (packages/core/src/rate-limit.ts). Tablo sadece SAYIYOR.
-- Sebebi somut: giriş kilidi (5 hata → üstel) ile PIN kilidi (D-2.5:
-- 5 hata → 60 sn, 10 hata → tam giriş) farklı kurallar ve ikisi de aynı
-- depoyu kullanacak. Kuralı SQL'e gömmek, ikinci kural geldiğinde
-- migration yazmayı gerektirirdi.
-- ============================================================================

CREATE TABLE auth_attempts (
  -- LOGIN_EMAIL | LOGIN_IP | PIN — packages/shared/src/roles.ts ile senkron
  scope             text        NOT NULL,
  -- Normalize edilmiş e-posta, IP adresi veya kullanıcı kimliği.
  subject           text        NOT NULL,
  failures          integer     NOT NULL DEFAULT 0,
  first_failure_at  timestamptz NOT NULL,
  last_failure_at   timestamptz NOT NULL,
  PRIMARY KEY (scope, subject),
  CONSTRAINT auth_attempts_scope_ck
    CHECK (scope IN ('LOGIN_EMAIL', 'LOGIN_IP', 'PIN')),
  CONSTRAINT auth_attempts_failures_ck CHECK (failures >= 0),
  -- Subject uzunluğu sınırlı: sayaç anahtarı kullanıcı girdisinden
  -- geliyor ve sınırsız uzunluk, tabloyu şişirmenin ucuz yolu olurdu.
  CONSTRAINT auth_attempts_subject_ck CHECK (length(subject) BETWEEN 1 AND 320)
);
--> statement-breakpoint

-- Temizlik taraması bu index'i kullanıyor.
CREATE INDEX auth_attempts_last_failure_idx ON auth_attempts (last_failure_at);
--> statement-breakpoint

-- Uygulama rolü tabloya DOĞRUDAN dokunamaz. Varsayılan yetkiler
-- (db/init/01-roles.sql) SELECT/INSERT/UPDATE/DELETE veriyordu; hepsini
-- geri alıyoruz. Tek yol fonksiyonlar.
REVOKE ALL ON TABLE auth_attempts FROM stok_app;
--> statement-breakpoint

-- RLS, tenant için değil ikinci bir kapı olarak açık: yetki bir şekilde
-- geri verilse bile uygulama rolüne satır geçmez. Politika SADECE sahip
-- role tanımlı, yani SECURITY DEFINER fonksiyonları çalışır.
ALTER TABLE auth_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE auth_attempts FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint

DO $$
BEGIN
  EXECUTE format(
    $f$
      CREATE POLICY definer_only ON auth_attempts
        TO %I
        USING (true)
        WITH CHECK (true)
    $f$,
    current_user
  );
END
$$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------
-- SAYAÇ FONKSİYONLARI
--
-- Zaman DIŞARIDAN veriliyor (p_now). Testlerin sahte saatle kilit süresini
-- ve pencere sıfırlamasını sınayabilmesi için; üretimde uygulama kendi
-- saatini geçiyor ve sunucular arası sapma dakika ölçeğinde önemsiz.
-- ---------------------------------------------------------------------------

/**
 * Başarısız denemeyi sayar ve YENİ sayacı döner. Tek ifade, atomik:
 * aynı anda gelen yirmi deneme yirmi kez artırır, hiçbiri kaybolmaz.
 *
 * `p_window_seconds`: son hatanın üzerinden bu kadar süre geçtiyse sayaç
 * sıfırdan başlar. Olmasaydı bir yıl boyunca beş kez parolasını yanlış
 * yazan kullanıcı kalıcı olarak cezalı kalırdı.
 */
CREATE OR REPLACE FUNCTION auth_record_failure(
  p_scope          text,
  p_subject        text,
  p_window_seconds integer,
  p_now            timestamptz DEFAULT now()
)
  RETURNS TABLE (failures integer, last_failure_at timestamptz)
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  INSERT INTO auth_attempts AS a (scope, subject, failures, first_failure_at, last_failure_at)
  VALUES (p_scope, p_subject, 1, p_now, p_now)
  ON CONFLICT (scope, subject) DO UPDATE
    SET failures = CASE
          WHEN a.last_failure_at < p_now - make_interval(secs => p_window_seconds) THEN 1
          ELSE a.failures + 1
        END,
        first_failure_at = CASE
          WHEN a.last_failure_at < p_now - make_interval(secs => p_window_seconds) THEN p_now
          ELSE a.first_failure_at
        END,
        last_failure_at = p_now
  RETURNING a.failures, a.last_failure_at;
$$;
--> statement-breakpoint

/** Mevcut sayaç. Pencere dışındaysa sıfır sayılır (yazma yapmaz). */
CREATE OR REPLACE FUNCTION auth_read_attempts(
  p_scope          text,
  p_subject        text,
  p_window_seconds integer,
  p_now            timestamptz DEFAULT now()
)
  RETURNS TABLE (failures integer, last_failure_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT a.failures, a.last_failure_at
    FROM auth_attempts a
   WHERE a.scope = p_scope
     AND a.subject = p_subject
     AND a.last_failure_at >= p_now - make_interval(secs => p_window_seconds);
$$;
--> statement-breakpoint

/** Başarılı girişten sonra sayacı siler. */
CREATE OR REPLACE FUNCTION auth_clear_attempts(p_scope text, p_subject text)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  DELETE FROM auth_attempts WHERE scope = p_scope AND subject = p_subject;
$$;
--> statement-breakpoint

/**
 * Eskimiş satırları siler. Saldırgan rastgele e-postalarla tabloyu
 * şişirebilir; IP sayacı hızı sınırlıyor ama tablo yine de büyür.
 * Gün sonu cron'u (T34) bunu çağıracak.
 */
CREATE OR REPLACE FUNCTION auth_prune_attempts(
  p_older_than_seconds integer,
  p_now                timestamptz DEFAULT now()
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM auth_attempts
   WHERE last_failure_at < p_now - make_interval(secs => p_older_than_seconds);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_record_failure(text, text, integer, timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_read_attempts(text, text, integer, timestamptz)  FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_clear_attempts(text, text)                       FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_prune_attempts(integer, timestamptz)             FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION auth_record_failure(text, text, integer, timestamptz) TO stok_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_read_attempts(text, text, integer, timestamptz)  TO stok_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_clear_attempts(text, text)                       TO stok_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_prune_attempts(integer, timestamptz)             TO stok_app;
