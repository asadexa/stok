#!/usr/bin/env bash
#
# Demo kurulumu: sıfırdan çalışır bir sisteme tek komutla.
#
#   ./scripts/demo.sh
#
# Ne yapıyor: veritabanını ayağa kaldırır, migration'ları uygular, örnek
# veriyi yükler ve web sunucusunu başlatır.
#
# HER ADIMDA DURUYOR. `set -e` yetmez; her adımın kendi hata mesajı var
# çünkü "command failed with exit code 1" satırı, ilk kez kuran birine
# hiçbir şey söylemez.

set -euo pipefail
cd "$(dirname "$0")/.."

BLUE='\033[0;34m'; GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; OFF='\033[0m'
step() { printf "\n${BLUE}▶ %s${OFF}\n" "$1"; }
ok()   { printf "${GREEN}  ✓ %s${OFF}\n" "$1"; }
warn() { printf "${YELLOW}  ! %s${OFF}\n" "$1"; }
die()  { printf "\n${RED}✗ %s${OFF}\n\n" "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Gereksinimler"
# ---------------------------------------------------------------------------
command -v node >/dev/null || die "Node.js kurulu değil. https://nodejs.org (sürüm 22 veya üstü)"
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js $NODE_MAJOR bulundu, 22 veya üstü gerekli."
ok "Node.js $(node -v)"

command -v pnpm >/dev/null || die "pnpm kurulu değil. Kurmak için: npm install -g pnpm"
ok "pnpm $(pnpm -v)"

# ---------------------------------------------------------------------------
step "Ayar dosyası"
# ---------------------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  ok ".env oluşturuldu (.env.example kopyalandı)"
else
  ok ".env zaten var, dokunulmadı"
fi
set -a; . ./.env; set +a

# ---------------------------------------------------------------------------
step "Veritabanı"
# ---------------------------------------------------------------------------
# Çalışan bir Postgres varsa ona bağlanıyoruz; yoksa Docker ile açıyoruz.
# Docker'ı zorunlu tutmak, elinde zaten Postgres olan kullanıcıyı gereksiz
# yere ikinci bir kuruluma sokardı.
DB_PORT="${DATABASE_URL##*:}"; DB_PORT="${DB_PORT%%/*}"

if pg_isready -h localhost -p "$DB_PORT" -q 2>/dev/null; then
  ok "localhost:$DB_PORT üzerinde çalışan bir Postgres bulundu"
elif command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  docker compose up -d >/dev/null || die "docker compose başarısız. 'docker compose up -d' çıktısına bakın."
  printf "  Hazır olması bekleniyor"
  for _ in $(seq 1 30); do
    if docker compose exec -T db pg_isready -U postgres -d stok >/dev/null 2>&1; then
      printf "\n"; ok "Veritabanı hazır (Docker)"; break
    fi
    printf "."; sleep 1
  done
  docker compose exec -T db pg_isready -U postgres -d stok >/dev/null 2>&1 \
    || die "Veritabanı 30 saniyede açılmadı. 'docker compose logs db' ile bakın."
else
  die "Ne çalışan bir Postgres ne de Docker bulundu.
  Seçenek 1: Docker Desktop'ı kurup açın, sonra bu scripti tekrar çalıştırın.
  Seçenek 2: Kendi Postgres'inizi $DB_PORT portunda çalıştırın ve .env içindeki
             DATABASE_URL / MIGRATION_DATABASE_URL satırlarını ona göre düzenleyin."
fi

# ---------------------------------------------------------------------------
step "Bağımlılıklar"
# ---------------------------------------------------------------------------
pnpm install --frozen-lockfile >/dev/null || die "pnpm install başarısız."
ok "Paketler kurulu"

# ---------------------------------------------------------------------------
step "Migration'lar"
# ---------------------------------------------------------------------------
pnpm --filter @stok/db migrate >/dev/null 2>&1 || die "Migration başarısız.
  Elle görmek için: pnpm --filter @stok/db migrate"
ok "Şema güncel"

# ---------------------------------------------------------------------------
step "Örnek veri"
# ---------------------------------------------------------------------------
# Seed MEVCUT VERİYİ SİLİYOR. Demo verisiyle oynanmış bir veritabanını
# sessizce sıfırlamak, "bir saattir test ediyordum" diyen kullanıcı için
# kabul edilemez.
if [ "${1:-}" = "--seed" ]; then
  RESEED=yes
elif pnpm --filter @stok/db exec tsx -e "
  import { adminDbUnsafe } from './src/client.js'
  const { client, db } = adminDbUnsafe()
  const r = await db.execute('SELECT count(*)::int AS n FROM products')
  console.log([...r][0].n); await client.end(); process.exit(0)
" 2>/dev/null | tail -1 | grep -qv '^0$'; then
  warn "Veritabanında zaten ürün var, örnek veri yeniden yüklenmedi."
  warn "Sıfırdan başlamak için: ./scripts/demo.sh --seed"
  RESEED=no
else
  RESEED=yes
fi

if [ "$RESEED" = "yes" ]; then
  pnpm --filter @stok/db seed || die "Seed başarısız."
fi

# ---------------------------------------------------------------------------
step "Hazır"
# ---------------------------------------------------------------------------
cat <<'INFO'

  Adres:     http://localhost:3000

  Yönetici:  admin@yilmaz.example          / admin123
  Çalışan:   ahmet@yilmazkirtasiye.example / calisan123

  Neyi deneyebilirsiniz ve neyi DENEYEMEZSİNİZ: README.md → "Demo"

INFO
printf "${BLUE}▶ Sunucu başlatılıyor (durdurmak için Ctrl+C)${OFF}\n\n"
exec pnpm --filter @stok/web dev
