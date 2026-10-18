@echo off
rem Stok - Windows'ta cift tiklayarak yerel baslatma (yalniz gelistirme ve demo).
rem Asil isi `pnpm demo` yapiyor (scripts/demo.mjs): .env, Docker veritabani,
rem bagimliliklar, migration, bos veritabaninda ornek veri, sunucu. Bu dosya
rem yalniz onun calisabilecegi ortami denetliyor; adimlari ikinci kez yazmak
rem iki kurulum kaynagi yaratirdi. --seed ve db:reset bilerek YOK: ikisi de
rem mevcut veriyi siliyor.
setlocal
set "RC=0"
for /f "tokens=2 delims=:." %%c in ('chcp') do set "ESKI_CP=%%c"
rem Turkce mesajlar ve demo'nun UTF-8 ciktisi icin; cikista eski sayfa geri yukleniyor.
chcp 65001 >nul

rem Cift tiklamada calisma dizini bu dosyanin klasoru olmayabilir; yol bosluklu da olabilir.
cd /d "%~dp0"
if errorlevel 1 (
  set "HATA=Proje klasörüne geçilemedi. Ağ klasöründeyse projeyi yerel bir diske kopyalayın."
  set "RC=1"
  goto hata
)

echo.
echo  Stok - yerel başlatıcı
echo  Yalnız geliştirme ve demo içindir; gerçek işletme verisi olan bilgisayarda kullanmayın.
echo  Proje klasörü: %CD%
echo.

rem --- Node.js: package.json "engines" ile aynı aralık (22-24) ---
where node >nul 2>nul
if errorlevel 1 (
  set "HATA=Node.js bulunamadı. Node.js 22, 23 ya da 24 kurup bu dosyayı tekrar çalıştırın: https://nodejs.org"
  set "RC=1"
  goto hata
)
for /f "usebackq delims=" %%v in (`node -v`) do set "NODE_SURUM=%%v"
rem `call`: node bazi surum yoneticilerinde bir .cmd; call'siz cagrilan .cmd bu dosyaya geri donmezdi.
call node -e "const m=Number(process.versions.node.split('.')[0]);process.exit(m>=22&&m<=24?0:1)"
if errorlevel 1 (
  set "HATA=Node.js %NODE_SURUM% uygun değil; 22, 23 ya da 24 gerekli: https://nodejs.org"
  set "RC=1"
  goto hata
)
echo  [tamam] Node.js %NODE_SURUM%

rem --- pnpm: gerekli surum package.json "packageManager" alanindan okunuyor ---
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').packageManager.split('@')[1]"`) do set "PNPM_GEREKLI=%%v"
set "PNPM_SURUM="
where pnpm >nul 2>nul
if not errorlevel 1 for /f "usebackq delims=" %%v in (`pnpm --version 2^>nul`) do set "PNPM_SURUM=%%v"
rem Yeni pnpm, package.json'daki surume kendisi geciyor; o durumda yeniden kurulmuyor.
if "%PNPM_SURUM%"=="%PNPM_GEREKLI%" goto pnpm_tamam

if defined PNPM_SURUM echo  pnpm %PNPM_SURUM% bulundu, gerekli sürüm %PNPM_GEREKLI%.
echo  pnpm %PNPM_GEREKLI% kullanıcı hesabınıza kuruluyor; yönetici izni gerekmez...
rem npm'in global dizini Windows'ta kullanici hesabinda (%APPDATA%\npm).
call npm install -g pnpm@%PNPM_GEREKLI%
if errorlevel 1 (
  set "HATA=pnpm kurulamadı. Elle kurmak için: npm install -g pnpm@%PNPM_GEREKLI%"
  set "RC=1"
  goto hata
)
set "PATH=%APPDATA%\npm;%PATH%"
set "PNPM_SURUM="
for /f "usebackq delims=" %%v in (`pnpm --version 2^>nul`) do set "PNPM_SURUM=%%v"
if not "%PNPM_SURUM%"=="%PNPM_GEREKLI%" (
  set "HATA=pnpm kuruldu ama %PNPM_GEREKLI% sürümü bu pencerede çalışmıyor. Pencereyi kapatıp dosyayı tekrar çalıştırın."
  set "RC=1"
  goto hata
)

:pnpm_tamam
echo  [tamam] pnpm %PNPM_SURUM%
echo.
echo  Bağımlılıklar, yerel veritabanı ve sunucu hazırlanıyor: pnpm demo
echo  Mevcut veriye dokunulmaz; örnek veri yalnız veritabanında hiç ürün yoksa yüklenir.
echo.
echo  Sunucu açılınca tarayıcıda şu adrese gidin:  http://localhost:3000
echo  Durdurmak için bu pencerede Ctrl+C.
echo.

call pnpm demo
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  set "HATA=Başlatma %RC% koduyla durdu; nedeni yukarıdaki satırlarda yazıyor. Sunucuyu Ctrl+C ile siz durdurduysanız bu beklenen bir durumdur."
  goto hata
)
goto son

:hata
echo.
echo  [HATA] %HATA%
echo.
echo  Pencereyi kapatmak için bir tuşa basın.
pause >nul

:son
chcp %ESKI_CP% >nul
endlocal & exit /b %RC%
