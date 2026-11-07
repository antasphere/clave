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
  /** The provider's own id of a native request; a hosted request (one an
   *  agent tool created, `clave_request_input`) carries an id the server
   *  minted under the `clave:` prefix, so it rides the same road as a native
   *  question into every session view. */
  providerRequestId: Schema.optional(Id),
  options: Schema.optional(Schema.Array(Schema.Struct({ id: Text, label: Text }))),
  questions: Schema.optional(Schema.Array(AgentQuestion)),
  /** Canonical question keys (id, or legacy text) whose inputs must be masked. */
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
/** The reader's answers by the question's key: one string, or the labels of
 *  a hosted multi-select as an array. */
const Answers = Schema.Record({
  key: Text,
  value: Schema.Union(
    Schema.String.pipe(Schema.maxLength(16_384)),
    Schema.Array(Schema.String.pipe(Schema.maxLength(16_384))).pipe(Schema.maxItems(100))
  )
})
export type Answers = typeof Answers.Type
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
/** What an agent tool asks the server to put to the person (PRDCT-4157):
 *  the caller's session, the words above the fields, the questions with their
 *  kinds, and how the card lays them out. The server mints the request's
 *  identity, its options and its tool name. */
export const HostedRequestInput = Schema.Struct({
  sessionId: Id,
  description: Text,
  questions: Schema.Array(AgentQuestion).pipe(Schema.minItems(1), Schema.maxItems(20)),
  layout: Schema.optional(Schema.Literal('form', 'steps'))
})
export type HostedRequestInput = typeof HostedRequestInput.Type
/** Where a request stands, for the agent that created it: its status and,
 *  once the person answered, the answers. A secret's value is never here. */
export const RequestResultView = Schema.Struct({
  requestId: Id,
  status: Schema.Literal('pending', 'running', 'completed', 'failed', 'dismissed', 'cancelled'),
  answers: Schema.optional(Answers)
})
export type RequestResultView = typeof RequestResultView.Type
export const CreatePendingRequest = Command.define('CreatePendingRequest', {
  payload: HostedRequestInput,
  success: PendingRequest,
  failure: Schema.Union(RequestRejected, CapabilityUnavailable)
})
/** A read, carried as a command: its payload has a number (`waitMs`) and
 *  the caller may hold the call open for seconds, neither of which a query's
 *  URL carries. */
export const ReadPendingRequestResult = Command.define('ReadPendingRequestResult', {
  payload: Schema.Struct({
    requestId: Id,
    sessionId: Id,
    /** How long the server may hold the answer waiting for the person, in
     *  milliseconds; 0 answers at once. Bounded by the server. */
    waitMs: Schema.optional(Schema.Number)
  }),
  success: RequestResultView,
  failure: Schema.Union(RequestRejected, CapabilityUnavailable)
})
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
  .add(HttpCqrs.commandEndpoint('create', '/requests/create', CreatePendingRequest))
  .add(HttpCqrs.commandEndpoint('result', '/requests/result', ReadPendingRequestResult))
  .add(
    HttpCqrs.commandEndpoint('resolve', '/requests/resolve', ResolvePendingRequest).setPayload(
      // Reapply after encodedSchema, which rebuilds refined fields and parents.
      Schema.encodedSchema(ResolvePendingRequest.payload).annotations({
        message: () => ({ message: 'Invalid request response.', override: true })
      })
    )
  )
