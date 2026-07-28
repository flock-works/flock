import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { FlockError } from "../shared/errors.ts";

type Envelope = {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

export class SecretBox {
  private readonly key: Buffer;

  constructor(encodedKey: string) {
    const key = decodeKey(encodedKey);
    if (key.length !== 32) {
      throw new FlockError(
        "invalid_configuration",
        "FLOCK_HOSTED_AGENT_CREDENTIAL_KEY must encode exactly 32 bytes",
      );
    }
    this.key = key;
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: Envelope = {
      version: 1,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    return JSON.stringify(envelope);
  }

  open<Value>(sealed: string): Value {
    try {
      const envelope = JSON.parse(sealed) as Envelope;
      if (
        envelope.version !== 1 ||
        typeof envelope.iv !== "string" ||
        typeof envelope.tag !== "string" ||
        typeof envelope.ciphertext !== "string"
      ) {
        throw new Error("Invalid envelope");
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(envelope.iv, "base64url"),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString("utf8")) as Value;
    } catch (error) {
      throw new FlockError(
        "credential_decryption_failed",
        "A protected hosted-agent secret could not be decrypted",
        500,
        error,
      );
    }
  }
}

function decodeKey(value: string): Buffer {
  const trimmed = value.trim();
  if (/^[0-9a-f]{64}$/iu.test(trimmed)) return Buffer.from(trimmed, "hex");
  try {
    return Buffer.from(trimmed, "base64");
  } catch {
    return Buffer.alloc(0);
  }
}
