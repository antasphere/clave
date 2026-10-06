import type { Address } from '../checkout/address'

export interface ValidationResult {
  ok: boolean
  errors?: { field: string; message: string }[]
}

const POSTAL_FORMATS: Record<string, RegExp> = {
  BE: /^\d{4}$/,
  FR: /^\d{5}$/,
  NL: /^\d{4}\s?[A-Z]{2}$/i,
}

export function validateAddress(a: Address): ValidationResult {
  const errors: { field: string; message: string }[] = []
  const fail = (field: string, message: string) =>
    errors.push({ field, message })
  if (a.street.trim().length < 3) fail('street', 'Enter a street')
  if (!a.city.trim()) fail('city', 'Enter a city')
  const format = POSTAL_FORMATS[a.country]
  if (!format) fail('country', 'We do not ship there yet')
  else if (!format.test(a.postalCode.trim()))
    fail('postalCode', 'Check the code')
  return errors.length ? { ok: false, errors } : { ok: true }
}

export function validateEmail(value: string): ValidationResult {
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  const errors = [{ field: 'email', message: 'Check the email' }]
  return ok ? { ok } : { ok, errors }
}
