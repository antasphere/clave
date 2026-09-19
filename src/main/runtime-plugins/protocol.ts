import type { CustomScheme, Protocol, WebContents } from 'electron'
import type { RuntimePluginViews } from './views'

export const PLUGIN_SCHEME: CustomScheme = {
  scheme: 'clave-plugin',
  privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false }
}

export const PLUGIN_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "worker-src 'none'",
  'sandbox allow-scripts'
].join('; ')

// Executes before contribution scripts. Frame reloads cannot reuse an earlier port.
export const PLUGIN_BOOTSTRAP = `<script>
(() => {
  let port, readyResolve, failed = false;
  const pending = new Map();
  const reportFailure = () => {
    failed = true;
    if (port) port.postMessage({ type: 'clave:view-error' });
  };
  addEventListener('error', reportFailure);
  addEventListener('unhandledrejection', reportFailure);
  const ready = new Promise(resolve => { readyResolve = resolve; });
  window.clave = Object.freeze({
    ready,
    async request(method, params = {}) {
      await ready;
      if (pending.size >= 8) throw new Error('Request limit reached');
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Request timed out')); }, 35000);
        pending.set(id, { resolve, reject, timer });
        port.postMessage({ type: 'clave:request', id, method, params });
      });
    }
  });
  addEventListener('message', event => {
    if (port || event.source !== parent || event.data?.type !== 'clave:init' ||
        event.data.apiVersion !== 1 || event.ports.length !== 1) return;
    port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (data?.type !== 'clave:response') return;
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      clearTimeout(request.timer);
      if (typeof data.error === 'string') request.reject(new Error(data.error));
      else request.resolve(data.result);
    };
    port.start();
    if (failed) { reportFailure(); return; }
    readyResolve(Object.freeze({ entry: event.data.entry, capabilities: event.data.capabilities }));
  });
})();
</script>`

export function pluginProtocolResponse(
  url: string,
  views: Pick<RuntimePluginViews, 'html'>
): Response {
  const match = /^clave-plugin:\/\/view\/([a-f0-9]{64})$/.exec(url)
  const html = match ? views.html(match[1]) : undefined
  return new Response(
    html === undefined
      ? 'View unavailable'
      : '<!doctype html><meta charset="utf-8">' + PLUGIN_BOOTSTRAP + html,
    {
      status: html === undefined ? 404 : 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': PLUGIN_CSP,
        'Permissions-Policy':
          'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), fullscreen=(), payment=(), usb=(), serial=(), hid=(), display-capture=()',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      }
    }
  )
}

/** Parent calls with session.defaultSession.protocol after app.ready. */
export function installPluginProtocol(
  protocol: Pick<Protocol, 'handle'>,
  views: Pick<RuntimePluginViews, 'html'>
): void {
  protocol.handle('clave-plugin', (request) => pluginProtocolResponse(request.url, views))
}

function pluginURL(url: string | undefined): boolean {
  return !!url && /^clave-plugin:/i.test(url)
}

/**
 * Block before navigation, while the source frame still has its protected URL.
 * Remember frame identity so a navigation cannot shed its policy or use window.name.
 * Unrelated previews do not enter this set.
 */
export function attachPluginFramePolicy(contents: WebContents): () => void {
  const protectedFrames = new Map<string, Electron.WebFrameMain>()
  const key = (frame: Electron.WebFrameMain): string => `${frame.processId}:${frame.routingId}`
  const navigate = (
    event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>
  ): void => {
    for (const [id, frame] of protectedFrames) {
      if (frame.detached) protectedFrames.delete(id)
    }
    const frame = event.frame
    const protectedSource = frame && (pluginURL(frame.url) || protectedFrames.has(key(frame)))
    const protectedInitiator =
      event.initiator &&
      (pluginURL(event.initiator.url) || protectedFrames.has(key(event.initiator)))
    if (protectedSource || protectedInitiator) {
      event.preventDefault()
      return
    }
    if (pluginURL(event.url)) {
      if (event.isMainFrame || !frame || protectedFrames.size >= 16) event.preventDefault()
      else protectedFrames.set(key(frame), frame)
    }
  }
  contents.on('will-frame-navigate', navigate)
  const redirect = (
    event: Electron.Event,
    _url: string,
    _inPlace: boolean,
    _main: boolean,
    processId: number,
    routingId: number
  ): void => {
    if (protectedFrames.has(`${processId}:${routingId}`)) event.preventDefault()
  }
  contents.on('will-redirect', redirect)
  return () => {
    contents.removeListener('will-frame-navigate', navigate)
    contents.removeListener('will-redirect', redirect)
    protectedFrames.clear()
  }
}
