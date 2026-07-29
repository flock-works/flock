import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { FlockError } from "./errors.ts";

export const PROTOCOL_VERSION = 1;

const Id = Type.String({ minLength: 3, maxLength: 160 });
const IsoDate = Type.String({ format: "date-time" });

export const AgentCapabilitiesSchema = Type.Object(
  {
    tools: Type.Array(Type.String()),
    platform: Type.String(),
    workspace: Type.String(),
    model: Type.String(),
    thinkingLevel: Type.String(),
  },
  { additionalProperties: false },
);

export const AgentHelloSchema = Type.Object(
  {
    type: Type.Literal("hello"),
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    agentId: Id,
    projectId: Id,
    resumeCursor: Type.Integer({ minimum: 0 }),
    capabilities: AgentCapabilitiesSchema,
  },
  { additionalProperties: false },
);

export const AgentHeartbeatSchema = Type.Object(
  {
    type: Type.Literal("heartbeat"),
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    agentId: Id,
    leaseId: Type.Optional(Id),
    leaseEpoch: Type.Optional(Type.Integer({ minimum: 0 })),
    sentAt: IsoDate,
  },
  { additionalProperties: false },
);

export const AgentJobAcceptSchema = Type.Object(
  {
    type: Type.Literal("job.accept"),
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    jobId: Id,
    leaseId: Id,
    leaseEpoch: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const AgentEntryAppendSchema = Type.Object(
  {
    type: Type.Literal("entry.append"),
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    requestId: Id,
    jobId: Id,
    leaseId: Id,
    leaseEpoch: Type.Integer({ minimum: 1 }),
    idempotencyKey: Id,
    entry: Type.Object(
      {
        type: Type.String(),
        id: Id,
        parentId: Type.Union([Id, Type.Null()]),
        timestamp: IsoDate,
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: false },
);

export const AgentRunEventSchema = Type.Object(
  {
    type: Type.Literal("run.event"),
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    jobId: Id,
    leaseId: Id,
    leaseEpoch: Type.Integer({ minimum: 1 }),
    eventSeq: Type.Integer({ minimum: 1 }),
    event: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const AgentJobFinishedSchema = Type.Object(
  {
    type: Type.Literal("job.finished"),
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    jobId: Id,
    leaseId: Id,
    leaseEpoch: Type.Integer({ minimum: 1 }),
    leafId: Id,
    outcome: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("aborted")]),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentClientMessageSchema = Type.Union([
  AgentHelloSchema,
  AgentHeartbeatSchema,
  AgentJobAcceptSchema,
  AgentEntryAppendSchema,
  AgentRunEventSchema,
  AgentJobFinishedSchema,
]);

export const SessionEntryEnvelopeSchema = Type.Object(
  {
    seq: Type.Integer({ minimum: 1 }),
    entry: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const SessionSnapshotSchema = Type.Object(
  {
    type: Type.Literal("session.snapshot"),
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    projectId: Id,
    sessionId: Id,
    header: Type.Unknown(),
    entries: Type.Array(SessionEntryEnvelopeSchema),
    cursor: Type.Integer({ minimum: 0 }),
    selectedLeafId: Type.Union([Id, Type.Null()]),
  },
  { additionalProperties: false },
);

export const SessionEntriesSchema = Type.Object(
  {
    type: Type.Literal("session.entries"),
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    projectId: Id,
    entries: Type.Array(SessionEntryEnvelopeSchema),
    cursor: Type.Integer({ minimum: 0 }),
    selectedLeafId: Type.Union([Id, Type.Null()]),
  },
  { additionalProperties: false },
);

export const JobStartSchema = Type.Object(
  {
    type: Type.Literal("job.start"),
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    jobId: Id,
    dispatchId: Id,
    projectId: Id,
    leaseId: Id,
    leaseEpoch: Type.Integer({ minimum: 1 }),
    leaseExpiresAt: IsoDate,
    baseEntryId: Id,
    prompt: Type.String({ minLength: 1 }),
    recovery: Type.Boolean(),
    originalAgentId: Id,
  },
  { additionalProperties: false },
);

export const JobAbortSchema = Type.Object(
  {
    type: Type.Literal("job.abort"),
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    jobId: Id,
    leaseEpoch: Type.Integer({ minimum: 1 }),
    reason: Type.String(),
  },
  { additionalProperties: false },
);

export const EntryAckSchema = Type.Object(
  {
    type: Type.Literal("entry.ack"),
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    requestId: Id,
    jobId: Id,
    entryId: Id,
    seq: Type.Integer({ minimum: 1 }),
    duplicate: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ProtocolErrorSchema = Type.Object(
  {
    type: Type.Literal("error"),
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    requestId: Type.Optional(Id),
    code: Type.String(),
    message: Type.String(),
  },
  { additionalProperties: false },
);

export const HubAgentMessageSchema = Type.Union([
  SessionSnapshotSchema,
  SessionEntriesSchema,
  JobStartSchema,
  JobAbortSchema,
  EntryAckSchema,
  ProtocolErrorSchema,
]);

export type AgentCapabilities = Static<typeof AgentCapabilitiesSchema>;
export type AgentHello = Static<typeof AgentHelloSchema>;
export type AgentClientMessage = Static<typeof AgentClientMessageSchema>;
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;
export type SessionEntriesMessage = Static<typeof SessionEntriesSchema>;
export type JobStart = Static<typeof JobStartSchema>;
export type HubAgentMessage = Static<typeof HubAgentMessageSchema>;

export type BrowserEvent =
  | { type: "presence"; cursor: number; projectId: string; agentId: string; status: string; lastSeenAt: string }
  | { type: "job"; cursor: number; projectId: string; jobId: string; status: string; agentId: string | null; leafId: string | null }
  | { type: "entry"; cursor: number; projectId: string; seq: number; entry: unknown }
  | { type: "run.event"; cursor: number; projectId: string; jobId: string; eventSeq: number; event: unknown };

export type BrowserEventInput = BrowserEvent extends infer Event
  ? Event extends BrowserEvent
    ? Omit<Event, "cursor">
    : never
  : never;

export function parseAgentClientMessage(value: unknown): AgentClientMessage {
  if (!Check(AgentClientMessageSchema, value)) {
    throw new FlockError("invalid_protocol_message", "Message does not match the Flock agent protocol", 400);
  }
  return value;
}

export function parseHubAgentMessage(value: unknown): HubAgentMessage {
  if (!Check(HubAgentMessageSchema, value)) {
    throw new FlockError("invalid_protocol_message", "Message does not match the Flock hub protocol", 400);
  }
  return value;
}
