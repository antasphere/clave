export interface Address {
  street: string
  city: string
  postalCode: string
  country: string
}

export const emptyAddress: Address = { street: '', city: '', postalCode: '', country: 'BE' }
