import { exportMovements } from '@stok/core'
import { appDb } from '@stok/db'
import type { NextRequest } from 'next/server'
import { errorResponse } from '@/server/http'
import { requireActor } from '@/server/session'
import { fileResponse, movementQuery } from '../shared'

/** Hareket raporu indirme. Gerekçeler için bkz. ../stok/route.ts */
export async function GET(request: NextRequest) {
  try {
    const actor = await requireActor()
    const result = await exportMovements(actor, movementQuery(request.nextUrl.searchParams), {
      db: appDb(),
    })
    return fileResponse(result)
  } catch (err) {
    return errorResponse(err)
  }
}
