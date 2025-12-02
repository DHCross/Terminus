/**
 * Secret storage key schema with namespaced identifiers
 */
export interface SecretKeySchema {
  // GitHub authentication
  GITHUB_PERSONAL_TOKEN: "agentvoice.github.token";

  // Future extensibility
  [key: string]: string;
}

/**
 * Const implementation for type safety and consistency
 */
export const SECRET_KEYS: SecretKeySchema = {
  GITHUB_PERSONAL_TOKEN: "agentvoice.github.token",
} as const;

/**
 * Legacy credential keys for migration purposes
 */
export const LEGACY_KEYS = {
  GITHUB_OLD: "agentvoice.github.pat",
} as const;

/**
 * Validation timeout constants
 */
export const VALIDATION_TIMEOUTS = {
  NETWORK_VALIDATION_MS: 5000,
  CREDENTIAL_RETRIEVAL_MS: 2000,
} as const;

/**
 * Validation endpoints for credential testing
 */
export const VALIDATION_ENDPOINTS = {
  GITHUB_API: "https://api.github.com/user",
} as const;
