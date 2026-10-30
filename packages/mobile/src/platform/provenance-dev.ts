import Constants from 'expo-constants'
import { NativeModules } from 'react-native'

/** A test receipt, never a product control or a credential-bearing request. */
export async function reportBundleProvenance(): Promise<void> {
  const extra = Constants.expoConfig?.extra
  const endpoint = extra?.mobileProofUrl
  if (typeof endpoint !== 'string' || !endpoint) return
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password)
    throw new Error('The mobile proof receipt must use literal loopback.')
  const source = NativeModules.SourceCode as
    | { scriptURL?: string; getConstants?: () => { scriptURL?: string } }
    | undefined
  const sourceUrl = source?.getConstants?.().scriptURL ?? source?.scriptURL
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    await fetch(url.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidate: extra?.mobileCandidate,
        worktree: extra?.mobileWorktree,
        sourceUrl
      }),
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }
}
