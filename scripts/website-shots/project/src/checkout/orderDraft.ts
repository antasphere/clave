import type { Address } from './address'

export interface OrderDraft {
  items: string[]
  shipping: Address | null
}

export const newDraft = (): OrderDraft => ({
  items: [],
  shipping: null,
})
