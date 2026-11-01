export const attachmentDraftKey = (machineId: string, sessionId: string): string =>
  `clave.attachment-draft:${machineId}:${sessionId}`
