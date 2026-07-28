const packageSpec = "@flock-works/flock@latest";

export function buildAgentInstallCommand(hubOrigin: string, enrollmentToken: string): string {
  return [
    "npx",
    "--yes",
    packageSpec,
    "agent",
    "install",
    "--hub",
    quoteShellArgument(hubOrigin),
    "--enrollment",
    quoteShellArgument(enrollmentToken),
    "--workspace",
    quoteShellArgument("."),
  ].join(" ");
}

function quoteShellArgument(value: string): string {
  if (value.includes('"') || /[\r\n]/u.test(value)) {
    throw new Error("Install command arguments cannot contain quotes or newlines");
  }
  return `"${value}"`;
}
