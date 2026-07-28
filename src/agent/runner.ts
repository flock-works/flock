import { resolve, relative, isAbsolute } from "node:path";
import {
  AgentHarness,
  NodeExecutionEnv,
  Session,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessEvent,
  type ExecutionToolContext,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core/node";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  AssistantMessage,
  Models,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { FlockError, toError } from "../shared/errors.ts";
import type { AgentConfig } from "./config.ts";
import type { ActiveLease, JobResult } from "./client.ts";
import { LeasedSessionStorage } from "./leased-session.ts";
import { PiCredentialStore } from "./pi-credentials.ts";
import type { SessionMirror } from "./session-mirror.ts";

export class PiAgentRunner {
  private readonly config: AgentConfig;
  private readonly mirror: SessionMirror;
  private readonly models: Models;

  constructor(
    config: AgentConfig,
    mirror: SessionMirror,
    models: Models = builtinModels({ credentials: new PiCredentialStore() }),
  ) {
    this.config = config;
    this.mirror = mirror;
    this.models = models;
  }

  async execute(lease: ActiveLease): Promise<JobResult> {
    const header = this.mirror.header;
    if (!header) throw new FlockError("mirror_uninitialized", "Agent has not received the project session");
    const branch = this.mirror.branch(lease.job.baseEntryId);
    const storage = new LeasedSessionStorage({
      metadata: { id: header.id, createdAt: header.timestamp },
      branch,
      appendRemote: lease.append,
    });
    const session = new Session(storage);

    if (lease.job.recovery) {
      const recovered = await this.prepareRecovery(storage);
      if (recovered.finishedLeafId) {
        return { outcome: "completed", leafId: recovered.finishedLeafId };
      }
    }
    await this.appendTurnMarker(storage, lease);

    const { provider, modelId } = parseModelReference(this.config.model);
    const model = this.models.getModel(provider, modelId);
    if (!model) {
      throw new FlockError("model_not_found", `Model ${this.config.model} is not available in pi-ai`);
    }
    const environment = new NodeExecutionEnv({ cwd: this.config.workspace });
    const tools = [
      createReadTool<ExecutionToolContext>(),
      createWriteTool<ExecutionToolContext>(),
      createEditTool<ExecutionToolContext>(),
      createBashTool<ExecutionToolContext>(),
    ];
    const harness = new AgentHarness<ExecutionToolContext>({
      session,
      models: this.models,
      model,
      thinkingLevel: this.config.thinkingLevel,
      tools,
      activeToolNames: tools.map((tool) => tool.name),
      toolContext: { env: environment },
      systemPrompt: [
        `You are ${this.config.name}, a lightweight long-running Flock agent.`,
        `Work independently in ${this.config.workspace}.`,
        "Use read, write, edit, and bash when useful. Keep the final response concise and report what changed.",
        "The shared conversation is a Pi v3 session tree. Never attempt to select a branch; a human or the hub does that.",
      ].join("\n"),
    });
    harness.on("tool_call", (event) => {
      if (!["read", "write", "edit"].includes(event.toolName)) return undefined;
      const path = event.input.path;
      if (typeof path !== "string" || insideWorkspace(this.config.workspace, path)) return undefined;
      return { block: true, reason: `Path is outside the configured workspace: ${path}` };
    });
    harness.subscribe((event) => lease.publish(safeEvent(event)));
    const onAbort = () => void harness.abort();
    lease.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const prompt = lease.job.recovery
        ? [
            "Resume this interrupted task from the shared session state.",
            "Any unfinished tool calls were converted to error results and must not be replayed automatically.",
            `Original request: ${lease.job.prompt}`,
          ].join("\n")
        : lease.job.prompt;
      const final = await harness.prompt(prompt);
      const leafId = await storage.getLeafId();
      if (!leafId) throw new FlockError("empty_agent_run", "Pi completed without writing a session entry");
      if (final.stopReason === "aborted" || lease.signal.aborted) {
        return { outcome: "aborted", leafId, error: final.errorMessage ?? "Agent run was aborted" };
      }
      if (final.stopReason === "error") {
        return { outcome: "failed", leafId, error: final.errorMessage ?? "Provider returned an error" };
      }
      return { outcome: "completed", leafId };
    } catch (error) {
      const leafId = (await storage.getLeafId()) ?? lease.job.baseEntryId;
      return {
        outcome: lease.signal.aborted ? "aborted" : "failed",
        leafId,
        error: toError(error).message,
      };
    } finally {
      lease.signal.removeEventListener("abort", onAbort);
      await environment.cleanup();
    }
  }

  private async appendTurnMarker(storage: LeasedSessionStorage, lease: ActiveLease): Promise<void> {
    const parentId = await storage.getLeafId();
    const entry: SessionTreeEntry = {
      type: "custom",
      id: await storage.createEntryId(),
      parentId,
      timestamp: new Date().toISOString(),
      customType: lease.job.recovery ? "flock.recovery" : "flock.agent_turn",
      data: {
        schemaVersion: 1,
        jobId: lease.job.jobId,
        dispatchId: lease.job.dispatchId,
        agentId: this.config.agentId,
        originalAgentId: lease.job.originalAgentId,
        recovery: lease.job.recovery,
      },
    };
    await storage.appendEntry(entry);
  }

  private async prepareRecovery(
    storage: LeasedSessionStorage,
  ): Promise<{ finishedLeafId?: string }> {
    const entries = await storage.getEntries();
    const messageEntries = entries.filter(
      (entry): entry is Extract<SessionTreeEntry, { type: "message" }> => entry.type === "message",
    );
    const last = messageEntries.at(-1);
    if (!last) return {};
    if (last.message.role === "assistant") {
      const missing = missingToolCalls(last.message, []);
      if (missing.length === 0 && ["stop", "length"].includes(last.message.stopReason)) {
        return { finishedLeafId: last.id };
      }
    }

    const lastAssistantIndex = messageEntries.findLastIndex((entry) => entry.message.role === "assistant");
    if (lastAssistantIndex < 0) return {};
    const assistantEntry = messageEntries[lastAssistantIndex]!;
    if (assistantEntry.message.role !== "assistant") return {};
    const followingResults = messageEntries
      .slice(lastAssistantIndex + 1)
      .flatMap((entry) => (entry.message.role === "toolResult" ? [entry.message] : []));
    for (const call of missingToolCalls(assistantEntry.message, followingResults)) {
      const recoveryResult: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [
          {
            type: "text",
            text: "Tool execution status was unknown after agent recovery. Flock did not replay this tool call.",
          },
        ],
        isError: true,
        timestamp: Date.now(),
      };
      await storage.appendEntry({
        type: "message",
        id: await storage.createEntryId(),
        parentId: await storage.getLeafId(),
        timestamp: new Date().toISOString(),
        message: recoveryResult,
      });
    }
    return {};
  }
}

function missingToolCalls(
  assistant: AssistantMessage,
  results: readonly ToolResultMessage[],
): ToolCall[] {
  const completed = new Set(results.map((result) => result.toolCallId));
  return assistant.content.filter(
    (content): content is ToolCall => content.type === "toolCall" && !completed.has(content.id),
  );
}

function parseModelReference(reference: string): { provider: string; modelId: string } {
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) {
    throw new FlockError("invalid_model", "Model must use provider/model-id syntax");
  }
  return { provider: reference.slice(0, separator), modelId: reference.slice(separator + 1) };
}

function insideWorkspace(workspace: string, requestedPath: string): boolean {
  const absolute = resolve(workspace, requestedPath);
  const difference = relative(workspace, absolute);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

function safeEvent(event: AgentHarnessEvent): unknown {
  if (event.type === "message_update") {
    return {
      type: event.type,
      message: event.message,
      assistantMessageEvent: event.assistantMessageEvent,
    };
  }
  if ("signal" in event) {
    const { signal: _signal, ...rest } = event;
    return rest;
  }
  return event;
}
