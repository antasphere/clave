export interface LineItem {
  sku: string
  name: string
  unitPrice: number
  quantity: number
}

export function subtotal(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
}

export function shippingFor(total: number): number {
  return total >= 120 ? 0 : 6.9
}
