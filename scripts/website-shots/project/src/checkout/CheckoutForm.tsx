import { useState } from 'react'
import { validateEmail } from '../lib/validate'
import { emptyAddress, type Address } from './address'

export function CheckoutForm({ onSubmit }: { onSubmit: (a: Address) => void }) {
  const [shipping, setShipping] = useState<Address>(emptyAddress)
  const [email, setEmail] = useState('')

  function submit() {
    if (!validateEmail(email).ok) return
    onSubmit(shipping)
  }

  return <form onSubmit={submit}>{/* fields */}</form>
}
