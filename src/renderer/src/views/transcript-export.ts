import { create } from 'zustand'

/** Produce the session's whole conversation as Markdown: what the view holds,
 *  with every older page of the past read first. */
export type TranscriptExporter = () => Promise<string>

interface ExportState {
  exporters: Record<string, TranscriptExporter>
}

/**
 * Who can write a session's transcript. The conversation lives in the view
 * that reduced it (the chat view keeps its entries privately, with the pages
 * of the past it has read), not in the host, so the pane header's menu asks
 * the view through this registry rather than reducing the log a second time.
 * A view registers while it is mounted; the header offers the transcript
 * actions only while someone is registered for the session.
 */
export const useTranscriptExport = create<ExportState>(() => ({ exporters: {} }))

/** Register `exporter` for `sessionId`; the returned function withdraws it,
 *  and only it, so a remount that registered first is never undone. */
export function registerTranscriptExporter(
  sessionId: string,
  exporter: TranscriptExporter
): () => void {
  useTranscriptExport.setState((state) => ({
    exporters: { ...state.exporters, [sessionId]: exporter }
  }))
  return () =>
    useTranscriptExport.setState((state) => {
      if (state.exporters[sessionId] !== exporter) return state
      const exporters = { ...state.exporters }
      delete exporters[sessionId]
      return { exporters }
    })
}
