import { useState, type FormEvent, type ReactNode } from 'react'
import { CalendarDaysIcon, CheckCircleIcon } from '@heroicons/react/24/outline'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@clave/ui/components'

const BOOKING_URL = 'https://meet.codika.io/book/luca/clave-interview'

interface TalkToUsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once the user has booked or sent — lets the caller collapse the prompt. */
  onEngaged: () => void
}

export function TalkToUsDialog({ open, onOpenChange, onEngaged }: TalkToUsDialogProps): ReactNode {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  function book(): void {
    window.electronAPI?.openExternal(BOOKING_URL)
    onEngaged()
    onOpenChange(false)
  }

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (sending) return
    setSending(true)
    setError(null)
    try {
      const result = await window.electronAPI.feedbackSubmit({
        email: email.trim(),
        message: message.trim() || undefined
      })
      if (result.ok) {
        setSent(true)
        onEngaged()
      } else {
        setError(result.error)
      }
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[440px] p-6">
        {sent ? (
          <div className="flex flex-col items-center text-center py-4">
            <CheckCircleIcon className="w-10 h-10 text-accent" />
            <DialogTitle className="mt-3">Thank you</DialogTitle>
            <DialogDescription className="mt-1.5">
              We&apos;ll be in touch soon. Genuinely, thank you for helping us.
            </DialogDescription>
            <button onClick={() => onOpenChange(false)} className="btn-primary mt-5">
              Close
            </button>
          </div>
        ) : (
          <>
            <DialogTitle>Help us make Clave better</DialogTitle>
            <DialogDescription className="mt-1.5">
              Clave has no accounts, so we have no idea who you are or how you use it. That makes it
              hard to build the right things. If you use Clave, we&apos;d love to hear from you.
            </DialogDescription>

            <button onClick={book} className="btn-primary w-full mt-5">
              <CalendarDaysIcon className="w-4 h-4" />
              Book a 30 min call
            </button>

            <div className="flex items-center gap-3 my-4">
              <div className="flex-1 h-px bg-border" />
              <span className="text-[11px] text-text-tertiary">or</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            <form onSubmit={send}>
              <label
                htmlFor="feedback-email"
                className="text-[11px] font-medium text-text-secondary"
              >
                Leave us your email
              </label>
              <input
                id="feedback-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="input-field mt-1.5"
              />

              <label
                htmlFor="feedback-message"
                className="text-[11px] font-medium text-text-secondary block mt-3"
              >
                Anything you want to tell us{' '}
                <span className="text-text-tertiary font-normal">(optional)</span>
              </label>
              <textarea
                id="feedback-message"
                rows={3}
                maxLength={2000}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What works, what doesn't, what's missing…"
                className="textarea-field mt-1.5"
              />

              {error && <p className="text-[11px] text-red-400 mt-2">{error}</p>}

              <button type="submit" disabled={sending} className="btn-primary w-full mt-4">
                {sending ? 'Sending…' : 'Send'}
              </button>
            </form>

            <p className="text-[11px] text-text-tertiary leading-relaxed mt-4">
              We send your email, your message, the app version, and your platform. Nothing is
              linked to your anonymous usage ping — we still can&apos;t tell which install is yours.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
