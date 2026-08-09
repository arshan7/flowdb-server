import crypto from "node:crypto";

// AES-256-GCM for Connected sources' own connection strings at rest
// (tablespace_sources.connection_string_encrypted) - the one real secret
// this app stores server-side. GCM's own auth tag means a corrupted or
// tampered ciphertext fails to decrypt loudly instead of silently
// returning garbage that gets fed straight into a live DB connection
// attempt.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, the size GCM is designed for

function getKey() {
  const raw = process.env.CONNECTION_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "CONNECTION_ENCRYPTION_KEY isn't set - required to store a source's connection string. See .env.example.",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("CONNECTION_ENCRYPTION_KEY must decode to exactly 32 bytes (base64-encoded).");
  }
  return key;
}

// Single self-contained string ("iv:authTag:ciphertext", each base64) -
// everything decrypt() needs travels with the ciphertext itself, so the
// one connection_string_encrypted column is the whole story, no
// companion columns to keep in sync.
export function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decrypt(payload) {
  const key = getKey();
  const [ivB64, authTagB64, ciphertextB64] = payload.split(":");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted payload.");
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
