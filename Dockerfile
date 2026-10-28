# syntax=docker/dockerfile:1.7
# ============================================================================
# Stok — üretim imajı (S1, Lightsail staging). Kullanım: docs/uretim-runbook.md
# "Lightsail + Docker Compose" bölümü ve compose.production.yml.
#
# İKİ HEDEF VAR, BİLEREK:
#
#   runtime  `next start`. Yalnız üretim bağımlılıkları; drizzle-kit, tsx,
#            TypeScript yok. Uygulama sahip rolünün parolasını hiç görmez.
#   tools    migration (`drizzle-kit migrate`), `db:init` ve `tenant:create`.
#            Geliştirme bağımlılıklarını içerir; yalnız elle, tek seferlik
#            `docker compose run` ile çalışır.
#
# Migration'ı runtime'ın açılış komutuna koymak daha az adım olurdu, ama o
# zaman her açılışta RLS'i atlayan rolün parolası uygulama konteynerinde
# bulunurdu (runbook §3: MIGRATION_DATABASE_URL runtime'a konmaz) ve aynı
# anda açılan iki konteyner aynı migration'ı iki kez denerdi.
#
# Node sürümü .nvmrc (22) ile aynı ana sürüm; yama sürümü sabit, böylece
# aynı Dockerfile bugün ve üç ay sonra aynı imajı üretir.
# ============================================================================

FROM node:22.23.4-bookworm-slim AS base
# COREPACK_HOME sabit: pnpm imaja derlemede (root olarak) indiriliyor; varsayılan
# yer root'un ev dizini olunca `node` kullanıcısıyla çalışan `tools` pnpm'i
# yeniden indirmeye kalkıyor ve internete çıkışı olmayan `internal` ağında
# düşüyordu (S1 doğrulaması, 2026-10-28).
ENV PNPM_HOME=/pnpm \
    COREPACK_HOME=/corepack \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm sürümü package.json `packageManager` alanından geliyor; ikinci bir
# sürüm yazılmıyor ki ikisi ayrışmasın.
RUN corepack enable
WORKDIR /app

# --- Bağımlılık bildirimleri: kaynak değişince kurulum katmanı bozulmasın ---
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN corepack install

# --- Bütün bağımlılıklar ve derleme ---
FROM manifests AS build
RUN --mount=type=cache,id=stok-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
# `next build` hiçbir yere bağlanmıyor ve gizli değer istemiyor
# (next.config.ts: yapılandırma kontrolü derleme aşamasında koşmuyor).
# `.next/cache` (~100 MB) yalnız bir sonraki derlemeyi hızlandırır; çalışma anında
# kullanılmıyor, runtime imajına taşınmasın.
RUN pnpm --filter @stok/web run build && rm -rf apps/web/.next/cache

# --- tools: migration ve yönetim komutları (tek seferlik) ---
FROM build AS tools
RUN chown -R node:node /app /corepack
USER node
# Varsayılan komut bilerek zararsız: `run tools` tek başına bir şey yazmasın,
# komut her seferinde açıkça verilsin (runbook).
CMD ["node", "-e", "console.log('Komut verin: pnpm --filter @stok/db run init | migrate | tenant:create')"]

# --- Yalnız üretim bağımlılıkları ---
FROM manifests AS prod-deps
RUN --mount=type=cache,id=stok-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# --- runtime ---
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps --chown=node:node /app /app
# Kaynak, next.config.ts'in ve sunucu yapılandırma kontrolünün (src/server/config.ts)
# çalışma anında yüklenmesi için gerekiyor; derleme çıktısı ayrıca kopyalanıyor.
COPY --chown=node:node apps/web apps/web
COPY --chown=node:node packages packages
COPY --from=build --chown=node:node /app/apps/web/.next apps/web/.next
USER node
WORKDIR /app/apps/web
EXPOSE 3000
# Konteyner içinde bütün arayüzlerde dinliyor; dışarıya açılıp açılmayacağına
# compose karar veriyor (portu yayınlanmıyor, yalnız Docker ağından erişilir).
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
