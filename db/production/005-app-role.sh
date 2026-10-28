#!/bin/sh
# ============================================================================
# Üretim/staging: `stok_app` rolünü GÜÇLÜ PAROLAYLA, 01-roles.sql'den ÖNCE yarat.
#
# 01-roles.sql rolü `IF NOT EXISTS` ile koruyor ve yoksa yerel geliştirme
# parolasıyla (`stok_app_dev`, depoda açık) yaratıyor. Bu dosya alfabetik
# sırada ondan önce koşuyor (00-extensions.sql < 005-app-role.sh <
# 01-roles.sql); rol burada yaratıldığı için 01-roles.sql yalnız yetkileri
# uygular. Runbook §1'deki "rolü önce kendin yarat" adımının konteyner hali.
#
# Yalnız VERİ DİZİNİ BOŞKEN koşar (postgres imajının initdb kuralı). Parola
# sonradan değişecekse: `ALTER ROLE stok_app PASSWORD ...` + .env.production.
#
# Parola URL-güvenli olmak zorunda: compose onu DATABASE_URL'in içine olduğu
# gibi yazıyor; `@`, `/`, `:` gibi bir karakter adresi bozar. Üret:
#   openssl rand -hex 32
# ============================================================================
set -eu

pw="${STOK_APP_DB_PASSWORD:-}"
if [ "${#pw}" -lt 32 ]; then
  echo "STOK_APP_DB_PASSWORD en az 32 karakter olmalı (openssl rand -hex 32)." >&2
  exit 1
fi
case "$pw" in
  *[!A-Za-z0-9_-]*)
    echo "STOK_APP_DB_PASSWORD yalnız harf, rakam, '_' ve '-' içermeli (bağlantı adresine yazılıyor)." >&2
    exit 1
    ;;
esac
if [ "$pw" = "stok_app_dev" ]; then
  echo "STOK_APP_DB_PASSWORD yerel geliştirme parolası olamaz." >&2
  exit 1
fi

# Parola psql değişkeni olarak geçiyor (`:'pw'` tırnaklar); SQL metnine kabukla
# gömülmüyor.
psql -v ON_ERROR_STOP=1 -v pw="$pw" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
CREATE ROLE stok_app LOGIN PASSWORD :'pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
EOSQL
