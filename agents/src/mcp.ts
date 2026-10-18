import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Character, GatewayConfig } from './config.js';

export async function readCharacterResources(config: GatewayConfig, character: Character): Promise<Array<{ uri: string; text: string }>> {
  if (character.resources.length === 0) return [];
  if (!config.mcp) throw new Error('Character resource access requires an MCP endpoint');
  const tokenEnv = character.mcp_token_env ?? config.mcp.token_env;
  const token = tokenEnv ? process.env[tokenEnv]?.trim() : undefined;
  if (tokenEnv && !token) throw new Error(`Missing MCP credential environment: ${tokenEnv}`);
  const client = new Client({ name: `character-${character.id}`, version: '0.1.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(config.mcp.url), {
      requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) }),
    }));
    const records: Array<{ uri: string; text: string }> = [];
    for (const uri of character.resources) {
      const result = await client.readResource({ uri });
      const text = result.contents.map(content => 'text' in content ? content.text : '').join('\n');
      if (!text || Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error();
      records.push({ uri, text });
    }
    return records;
  } catch {
    // SDK/provider error strings can contain bearer tokens, URIs or private data.
    throw new Error('MCP context could not be read; check the character access privately');
  } finally {
    await client.close();
  }
}
