import { describe, expect, it } from 'vitest'
import type { Permission } from '../../../../plugins/chat-view/src/reducer'
import {
  approvalRunSummary,
  decisionWord,
  describeApproval,
  refused,
  settledApproval,
  type PermissionEntry
} from '../../../../plugins/chat-view/src/approvals'

/* How a receipt reads, decided without a DOM and fed with the frames the
   providers send. The Codex frames are the ones the lane's verifier captured
   from codex 0.166.0 on 3 November 2026 (the approval of an MCP tool names the
   tool in its message alone) and the one recorded in
   src/main/sessions/fixtures/codex-app-server/live.ndjson (a command). */

const request = (over: Partial<Permission> & { id: string }): Permission => ({
  type: 'permission_request',
  description: '',
  options: ['accept', 'acceptForSession', 'decline', 'cancel'].map((o) => ({ id: o, label: o })),
  ...over
})
const entry = (request_: Permission, answer?: string): PermissionEntry => ({
  kind: 'permission',
  request: request_,
  ...(answer !== undefined ? { answer } : {}),
  at: 0
})
/** The approval of an MCP tool as codex 0.166.0 sends it. */
const mcpApproval = (server: string, tool: string): Permission =>
  request({
    id: '0',
    description: `Allow the ${server} MCP server to run tool "${tool}"?`,
    toolName: 'mcpServer/elicitation/request',
    input: {
      threadId: 't',
      turnId: 'u',
      serverName: server,
      mode: 'form',
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        tool_description: 'Send a message to another agent tab',
        tool_params: { text: 'bye' },
        tool_params_display: [{ name: 'text', value: 'bye', display_name: 'text' }]
      },
      message: `Allow the ${server} MCP server to run tool "${tool}"?`,
      requestedSchema: { type: 'object', properties: {} }
    },
    options: ['accept', 'decline', 'cancel'].map((o) => ({ id: o, label: o }))
  })
/** A command approval as the recorded app-server sent it. */
const commandApproval = request({
  id: '1',
  description: 'Allow creating /tmp/clave-2536-approval-check to test the client approval flow?',
  toolName: 'item/commandExecution/requestApproval',
  input: {
    kind: 'command',
    threadId: 'thread-recorded',
    turnId: 'turn-approval',
    itemId: 'exec-11503848-7074-4eed-ab24-2b62e093dcbb',
    reason: 'Allow creating /tmp/clave-2536-approval-check to test the client approval flow?',
    command: 'mkdir -p /tmp/clave-2536-approval-check',
    cwd: '/tmp'
  }
})

describe('describeApproval', () => {
  it('names the tool from the message, where codex 0.166.0 puts it, and the Clave server as Clave', () => {
    expect(describeApproval(mcpApproval('clave_f5d8a4fb794a', 'clave_send_to_session'))).toEqual({
      label: 'Use clave_send_to_session',
      target: 'Clave'
    })
    expect(describeApproval(mcpApproval('clave', 'clave_list'))).toEqual({
      label: 'Use clave_list',
      target: 'Clave'
    })
    expect(describeApproval(mcpApproval('probe', 'ending_tool'))).toEqual({
      label: 'Use ending_tool',
      target: 'probe'
    })
  })
  it('prefers a frame that names the tool under its own key, and falls back to the message when neither does', () => {
    const named = mcpApproval('probe', 'ending_tool')
    named.input = { ...(named.input as object), _meta: { tool_name: 'other_tool' } }
    expect(describeApproval(named)?.label).toBe('Use other_tool')
    const unnamed = mcpApproval('probe', 'x')
    unnamed.input = { ...(unnamed.input as object), message: 'Allow this?' }
    expect(describeApproval(unnamed)).toEqual({ label: 'Use a tool', target: 'probe' })
  })
  it('reads a command approval as the command, and the other Codex requests by their kind', () => {
    expect(describeApproval(commandApproval)).toEqual({
      label: 'Run a command',
      target: 'mkdir -p /tmp/clave-2536-approval-check'
    })
    expect(
      describeApproval(
        request({
          id: '2',
          toolName: 'item/commandExecution/requestApproval',
          input: { command: ['npm', 'test'], cwd: '/x' }
        })
      )?.target
    ).toBe('npm test')
    expect(
      describeApproval(
        request({
          id: '3',
          toolName: 'item/fileChange/requestApproval',
          input: { reason: 'Edit outside the workspace', grantRoot: '/etc' }
        })
      )
    ).toEqual({ label: 'Edit files', target: 'Edit outside the workspace' })
    expect(
      describeApproval(
        request({
          id: '4',
          toolName: 'item/permissions/requestApproval',
          input: { permissions: { network: true }, reason: null }
        })
      )
    ).toEqual({ label: 'Extra permissions', target: 'network' })
  })
  it("leaves a provider's named tool to the view: undefined for Claude's Write", () => {
    expect(
      describeApproval(request({ id: '5', toolName: 'Write', input: { file_path: '/a.txt' } }))
    ).toBeUndefined()
  })
})

describe('decisionWord and refused', () => {
  it("turns Codex's raw ids into words and keeps a provider's own labels", () => {
    const codex = mcpApproval('clave', 'clave_list')
    expect(decisionWord(codex, 'accept')).toBe('Allowed')
    expect(decisionWord(commandApproval, 'acceptForSession')).toBe('Allowed for the session')
    expect(decisionWord(codex, 'decline')).toBe('Declined')
    expect(decisionWord(codex, 'cancel')).toBe('Cancelled')
    const claude = request({
      id: '6',
      toolName: 'Write',
      options: [
        { id: 'allow-once', label: 'Allow once' },
        { id: 'allow-always', label: 'Always allow' },
        { id: 'deny', label: 'Deny' }
      ]
    })
    expect(decisionWord(claude, 'allow-once')).toBe('Allow once')
    expect(decisionWord(claude, 'deny')).toBe('Deny')
    expect(decisionWord(codex, 'something-else')).toBe('something-else')
  })
  it('reads a refusal from the id, or from the label when the ids carry no words', () => {
    const codex = mcpApproval('clave', 'clave_list')
    expect(refused(codex, 'decline')).toBe(true)
    expect(refused(codex, 'cancel')).toBe(true)
    expect(refused(codex, 'accept')).toBe(false)
    const extra = request({
      id: '7',
      toolName: 'item/permissions/requestApproval',
      options: [
        { id: '{"permissions":{},"scope":"turn"}', label: 'Deny extra permissions' },
        { id: '{"permissions":{"network":true},"scope":"turn"}', label: 'Allow for this turn' }
      ]
    })
    expect(refused(extra, extra.options[0].id)).toBe(true)
    expect(refused(extra, extra.options[1].id)).toBe(false)
  })
  it('settles an allowed, answered, non-question approval and nothing else', () => {
    const codex = mcpApproval('clave', 'clave_list')
    expect(settledApproval(entry(codex, 'accept'))).toBe(true)
    expect(settledApproval(entry(codex, 'decline'))).toBe(false)
    expect(settledApproval(entry(codex))).toBe(false)
    expect(settledApproval({ ...entry(codex), answeredElsewhere: true })).toBe(false)
    const question = request({
      id: '8',
      toolName: 'AskUserQuestion',
      questions: [{ question: 'Which?', options: [{ label: 'A' }] }],
      options: [
        { id: 'answer', label: 'Submit' },
        { id: 'deny', label: 'Skip' }
      ]
    })
    expect(settledApproval(entry(question, 'answer'))).toBe(false)
  })
})

describe('approvalRunSummary', () => {
  it('counts the requests and says what they were, each label once with its count', () => {
    const run = [
      entry(commandApproval, 'accept'),
      entry(mcpApproval('clave_f5d8a4fb794a', 'clave_send_to_session'), 'accept'),
      entry(mcpApproval('clave_f5d8a4fb794a', 'clave_send_to_session'), 'acceptForSession'),
      entry(commandApproval, 'accept')
    ]
    expect(approvalRunSummary(run)).toEqual({
      head: 'Allowed 4 requests',
      detail: 'Run a command ×2 · Use clave_send_to_session ×2'
    })
    expect(approvalRunSummary(run.slice(0, 1)).head).toBe('Allowed 1 request')
  })
})
