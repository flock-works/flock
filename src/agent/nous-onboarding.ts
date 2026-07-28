import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type {
  AuthEvent,
  CredentialStore,
  Model,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import {
  fetchNousModels,
  loginNousPortal,
  NOUS_PROVIDER_ID,
  type NousProviderOptions,
} from "../shared/nous-provider.ts";
import { FlockError } from "../shared/errors.ts";
import { PiCredentialStore } from "./pi-credentials.ts";

export type EnrollmentOnboarding = {
  enrollment: {
    name: string;
    expiresAt: string;
  };
  nous: {
    enabled: boolean;
    clientId?: string;
    portalUrl: string;
    inferenceUrl: string;
  };
};

export type OnboardingTerminal = {
  interactive: boolean;
  write(message: string): void;
  question(prompt: string): Promise<string>;
  close?(): void;
};

type OnboardingDependencies = {
  fetchFn?: typeof fetch;
  credentials?: CredentialStore;
  terminal?: OnboardingTerminal;
  login?: (
    interaction: Parameters<typeof loginNousPortal>[0],
    options: NousProviderOptions,
  ) => Promise<OAuthCredential>;
  loadModels?: (
    credential: OAuthCredential,
    options: NousProviderOptions,
  ) => Promise<Model<"openai-completions">[]>;
};

export async function onboardNousModel(
  input: {
    hubUrl: URL;
    enrollmentToken: string;
  },
  dependencies: OnboardingDependencies = {},
): Promise<string | undefined> {
  const ownedTerminal = dependencies.terminal ? undefined : createTerminal();
  const terminal = dependencies.terminal ?? ownedTerminal!;
  if (!terminal.interactive) {
    ownedTerminal?.close?.();
    return undefined;
  }

  try {
    let onboarding: EnrollmentOnboarding;
    try {
      onboarding = await loadEnrollmentOnboarding(
        input.hubUrl,
        input.enrollmentToken,
        dependencies.fetchFn,
      );
    } catch (error) {
      if (error instanceof FlockError && error.status === 404) {
        terminal.write(
          "\nThis hub does not support interactive Nous onboarding yet. "
          + "Continuing with local provider detection.\n",
        );
        return undefined;
      }
      throw error;
    }
    if (!onboarding.nous.enabled || !onboarding.nous.clientId) {
      terminal.write(
        "\nNous Portal onboarding is not configured on this hub. "
        + "Ask an administrator to set FLOCK_NOUS_CLIENT_ID.\n",
      );
      return undefined;
    }

    const options: NousProviderOptions = {
      clientId: onboarding.nous.clientId,
      portalUrl: onboarding.nous.portalUrl,
      inferenceUrl: onboarding.nous.inferenceUrl,
    };
    const login = dependencies.login ?? loginNousPortal;
    terminal.write(`\nSet up ${onboarding.enrollment.name}\n`);
    terminal.write("Connecting to Nous Portal…\n");
    const credential = await login(
      {
        notify: (event) => renderAuthEvent(event, terminal),
        prompt: async () => "",
      },
      options,
    );

    const credentials = dependencies.credentials ?? new PiCredentialStore();
    await credentials.modify(NOUS_PROVIDER_ID, async () => credential);
    terminal.write("Nous Portal connected. Loading models…\n");
    const models = await (dependencies.loadModels ?? fetchNousModels)(credential, options);
    if (models.length === 0) {
      throw new FlockError(
        "nous_models_empty",
        "Nous Portal returned no models for this account",
      );
    }
    const selected = await selectNousModel(models, terminal);
    terminal.write(`Selected ${selected.name} (${selected.id}).\n\n`);
    return `${NOUS_PROVIDER_ID}/${selected.id}`;
  } finally {
    ownedTerminal?.close?.();
  }
}

export async function loadEnrollmentOnboarding(
  hubUrl: URL,
  enrollmentToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<EnrollmentOnboarding> {
  const response = await fetchFn(new URL("/api/v1/agents/onboarding", hubUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enrollmentToken }),
  });
  const body = await response.json() as EnrollmentOnboarding & {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new FlockError(
      "agent_onboarding_failed",
      body.error?.message ?? `Hub returned HTTP ${response.status}`,
      response.status,
    );
  }
  return body;
}

export async function selectNousModel(
  models: readonly Model<"openai-completions">[],
  terminal: OnboardingTerminal,
): Promise<Model<"openai-completions">> {
  const catalog = [...models].sort((left, right) => left.name.localeCompare(right.name));
  let visible = catalog;
  while (true) {
    const page = visible.slice(0, 20);
    terminal.write("\nAvailable Nous models:\n");
    for (const [index, model] of page.entries()) {
      terminal.write(`  ${index + 1}. ${model.name} (${model.id})\n`);
    }
    if (visible.length > page.length) {
      terminal.write(`  …and ${visible.length - page.length} more. Type a search term to narrow the list.\n`);
    }
    const answer = (await terminal.question(
      "Choose a model by number or ID, or type a search term: ",
    )).trim();
    const numeric = Number(answer);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= page.length) {
      return page[numeric - 1]!;
    }
    const exact = catalog.find((model) => model.id === answer);
    if (exact) return exact;
    const query = answer.toLowerCase();
    const matches = catalog.filter(
      (model) =>
        model.id.toLowerCase().includes(query)
        || model.name.toLowerCase().includes(query),
    );
    if (query && matches.length > 0) {
      visible = matches;
      continue;
    }
    visible = catalog;
    terminal.write("No matching model. Try again.\n");
  }
}

function createTerminal(): OnboardingTerminal {
  const readline = createInterface({ input: stdin, output: stdout });
  return {
    interactive: Boolean(stdin.isTTY && stdout.isTTY),
    write: (message) => stdout.write(message),
    question: (prompt) => readline.question(prompt),
    close: () => readline.close(),
  };
}

function renderAuthEvent(event: AuthEvent, terminal: OnboardingTerminal): void {
  if (event.type === "device_code") {
    terminal.write(`\nOpen this URL:\n  ${event.verificationUri}\n`);
    terminal.write(`Enter code: ${event.userCode}\n`);
    terminal.write("Waiting for authorization…\n");
    return;
  }
  if (event.type === "auth_url") {
    terminal.write(`\nOpen this URL:\n  ${event.url}\n`);
    if (event.instructions) terminal.write(`${event.instructions}\n`);
    return;
  }
  if (event.type === "info") {
    terminal.write(`${event.message}\n`);
    for (const link of event.links ?? []) {
      terminal.write(`  ${link.label ? `${link.label}: ` : ""}${link.url}\n`);
    }
    return;
  }
  terminal.write(`${event.message}\n`);
}
