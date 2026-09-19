import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function fileUrl(absolutePath: string): string {
  return 'file://' + absolutePath.split('/').map(encodeURIComponent).join('/')
}

export function shortenPath(fullPath: string): string {
  // Replace /Users/<name> with ~
  return fullPath.replace(/^\/Users\/[^/]+/, '~')
}

export function safePort(url: string): number | null {
  try {
    const p = Number(new URL(url).port)
    return p || null
  } catch {
    return null
  }
}
