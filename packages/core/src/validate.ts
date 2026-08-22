import { AppError, type ErrorCode } from '@stok/shared'
import type { z } from 'zod'

/**
 * zod doğrulama hatasını hata sözleşmesine (D-2.2) çeviren TEK yer.
 *
 * Her serviste ayrı yazılsaydı biri `issues` alanını unutur, diğeri
 * Türkçe metni sunucudan döndürür ve istemci iki farklı biçimle uğraşırdı.
 */
export interface ValidationIssue {
  path: string
  message: string
}

export function issuesOf(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
}

export function validationError(
  issues: ValidationIssue[],
  code: ErrorCode = 'VALIDATION_FAILED',
): AppError {
  return new AppError(code, issues.map((i) => `${i.path}: ${i.message}`).join('; '), { issues })
}

/** Şemayı uygular; hata varsa `VALIDATION_FAILED` fırlatır. */
export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw)
  if (parsed.success) return parsed.data
  throw validationError(issuesOf(parsed.error))
}
