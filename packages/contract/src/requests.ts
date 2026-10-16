/** Request IDs belong to one server. Fleet clients pair them with ServerId.
 * Values submitted for secrets are command inputs only, never query/event data. */
import { Schema } from 'effect'
import { Command, Query } from '@structure-ai/cqrs'
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import { AgentQuestion } from './sessions'
import { CapabilityUnavailable } from './errors'

const Text = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(16_384))
const Id = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256))
export const SecretAction = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('run'),
    command: Text,
    cwd: Text,
    envVar: Schema.String.pipe(Schema.pattern(/^[A-Z_][A-Z0-9_]*$/))
  }),
  Schema.Struct({
    type: Schema.Literal('env-file'),
    file: Text,
    key: Schema.String.pipe(Schema.pattern(/^[A-Za-z_][A-Za-z0-9_]*$/))
  })
)
export type SecretAction = typeof SecretAction.Type
export const PendingRequest = Schema.Struct({
  id: Id,
  sessionId: Id,
  kind: Schema.Literal('permission', 'clarification', 'secret'),
  description: Text,
  createdAt: Schema.Number,
  providerRequestId: Schema.optional(Id),
  options: Schema.optional(Schema.Array(Schema.Struct({ id: Text, label: Text }))),
  questions: Schema.optional(Schema.Array(AgentQuestion)),
  /** Native provider question labels whose inputs must be masked by clients. */
  secretQuestions: Schema.optional(Schema.Array(Text)),
  toolName: Schema.optional(Text),
  detail: Schema.optional(Text),
  input: Schema.optional(Schema.Unknown),
  action: Schema.optional(SecretAction)
})
export type PendingRequest = typeof PendingRequest.Type
export const RequestSnapshot = Schema.Struct({
  revision: Schema.Number,
  pending: Schema.Array(PendingRequest)
})
export type RequestSnapshot = typeof RequestSnapshot.Type
const Answers = Schema.Record({ key: Text, value: Schema.String.pipe(Schema.maxLength(16_384)) })
export const RequestResponse = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('permission'),
    optionId: Text,
    answers: Schema.optional(Answers)
  }),
  Schema.Struct({ type: Schema.Literal('clarification'), answers: Answers }),
  Schema.Struct({ type: Schema.Literal('secret'), value: Text }),
  Schema.Struct({ type: Schema.Literal('dismiss') })
)
export type RequestResponse = typeof RequestResponse.Type
export const ResolveRequestInput = Schema.Struct({
  requestId: Id,
  response: RequestResponse
}).annotations({
  message: () => ({ message: 'Invalid request response.', override: true })
})
export type ResolveRequestInput = typeof ResolveRequestInput.Type
export class RequestRejected extends Schema.TaggedError<RequestRejected>()('RequestRejected', {
  code: Schema.Literal('invalid', 'not_found', 'capacity', 'closed'),
  message: Schema.String
}) {}
export const ListPendingRequests = Query.define('ListPendingRequests', {
  payload: Schema.Struct({}),
  success: RequestSnapshot,
  failure: CapabilityUnavailable
})
export const ResolvePendingRequest = Command.define('ResolvePendingRequest', {
  payload: ResolveRequestInput,
  success: Schema.Struct({ accepted: Schema.Boolean }),
  failure: Schema.Union(RequestRejected, CapabilityUnavailable)
})
export const requestsGroup = ApiGroup.make('requests')
  .add(HttpCqrs.queryEndpoint('list', '/requests/pending', ListPendingRequests))
  .add(HttpCqrs.commandEndpoint('resolve', '/requests/resolve', ResolvePendingRequest))
