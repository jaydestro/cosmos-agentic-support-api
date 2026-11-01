const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const COSMOS_ACCOUNT_HOST = /^([a-z0-9-]{3,44})\.documents\.azure\.(?:com|us|cn)$/;

/** Accepts `URL.hostname` in either bracketed or bare IPv6 form. */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname === '::1' ? '[::1]' : hostname);
}

/** The account name of an Azure Cosmos DB account endpoint host, or `null` for any other host. */
export function cosmosAccountName(hostname: string): string | null {
  return COSMOS_ACCOUNT_HOST.exec(hostname)?.[1] ?? null;
}

export const isCosmosAccountHostname = (hostname: string): boolean => cosmosAccountName(hostname) !== null;

const AZURE_OPENAI_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com)$/;

/**
 * An Azure OpenAI or Foundry resource host in the public cloud. The model client sends a bearer token
 * to the configured host, so only hosts that Azure owns are accepted outside a loopback test server.
 */
export const isAzureOpenAiHostname = (hostname: string): boolean => AZURE_OPENAI_HOST.test(hostname);
