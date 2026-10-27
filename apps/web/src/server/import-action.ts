import 'server-only'
import type { Actor } from '@stok/core'
import { type Db, appDb } from '@stok/db'
import { AppError, errorText, isRetryable } from '@stok/shared'
import { logUnexpected } from './safe-log'
import { currentActor } from './session'

/**
 * Toplu aktarım eylemlerinin (ürün T171, envanter T219) ortak sözleşmesi.
 * `'use server'` dosyasının DIŞINDA: oradan dışa açılan her işlev
 * istemciden çağrılabilen bir uç olurdu.
 */
export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string; retryable: boolean }

/**
 * Yetki ve hata sözleşmesi tek yerde. Hata metni kullanıcıya gidiyor;
 * `retryable` istemcinin kendiliğinden tekrar deneyip denemeyeceğini söylüyor
 * (ör. aynı aktarım başka bir istekte işleniyor). Beklenmeyen hata günlüğe
 * içeriksiz yazılıyor: satırlar alış fiyatı taşıyor (T204, INV-10).
 */
export async function guarded<T>(scope: string, fn: (actor: Actor, db: Db) => Promise<T>): Promise<ActionResult<T>> {
  const actor = await currentActor()
  if (!actor) return { ok: false, error: errorText('TOKEN_INVALID', {}), retryable: false }
  try {
    return { ok: true, value: await fn(actor, appDb()) }
  } catch (err) {
    if (err instanceof AppError) {
      return { ok: false, error: errorText(err.code, err.details), retryable: isRetryable(err.code) }
    }
    logUnexpected(scope, err)
    return { ok: false, error: errorText('SERVER_ERROR', {}), retryable: true }
  }
}
