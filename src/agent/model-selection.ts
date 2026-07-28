import type { CredentialStore } from "@earendil-works/pi-ai";
import { createFlockModels } from "../shared/nous-provider.ts";
import { PiCredentialStore } from "./pi-credentials.ts";

export const FALLBACK_AGENT_MODEL = "anthropic/claude-sonnet-4-6";

const automaticModelCandidates = [
  FALLBACK_AGENT_MODEL,
  "openai-codex/gpt-5.4",
  "openai/gpt-5.4",
  "github-copilot/gpt-5.4",
  "openrouter/anthropic/claude-sonnet-4.6",
] as const;

export async function resolveAgentModel(
  requestedModel: string | undefined,
  credentials: CredentialStore = new PiCredentialStore(),
): Promise<string> {
  if (requestedModel) return requestedModel;

  const models = createFlockModels({ credentials });
  const storedProviders = new Set(
    (await credentials.list()).map((credential) => credential.providerId),
  );

  for (const reference of automaticModelCandidates) {
    const { provider, modelId } = splitModelReference(reference);
    if (storedProviders.has(provider) && models.getModel(provider, modelId)) {
      return reference;
    }
  }

  for (const reference of automaticModelCandidates) {
    const { provider, modelId } = splitModelReference(reference);
    if (!models.getModel(provider, modelId)) continue;
    try {
      if (await models.getAuth(provider)) return reference;
    } catch {
      // A broken ambient credential should not prevent another configured
      // provider from being selected automatically.
    }
  }

  return FALLBACK_AGENT_MODEL;
}

function splitModelReference(reference: string): { provider: string; modelId: string } {
  const separator = reference.indexOf("/");
  return {
    provider: reference.slice(0, separator),
    modelId: reference.slice(separator + 1),
  };
}
