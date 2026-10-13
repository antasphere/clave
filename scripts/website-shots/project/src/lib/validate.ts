export interface ValidationResult {
  ok: boolean
  errors?: { field: string; message: string }[]
}

export function validateEmail(value: string): ValidationResult {
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  const errors = [{ field: 'email', message: 'Invalid' }]
  return ok ? { ok } : { ok, errors }
}
