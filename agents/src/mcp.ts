import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Character, GatewayConfig } from './config.js';

export interface CharacterMcpAccess {
  url: string;
  tokenEnv?: string;
  resources: string[];
  tools: string[];
}

// The service credential stays in this process, never the model's environment/config.
export async function connectMarsMcp(access: Pick<CharacterMcpAccess, 'url' | 'tokenEnv'>): Promise<Client> {
  const token = access.tokenEnv ? process.env[access.tokenEnv]?.trim() : undefined;
  if (access.tokenEnv && !token) throw new Error('Missing MCP service credential');
  const client = new Client({ name: 'mars-character-gateway', version: '0.1.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(access.url), {
      requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      fetch: async (input, init) => {
        const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(init?.signal ? [init.signal] : [])]);
        const response = await fetch(input, { ...init, redirect: 'error', signal });
        // Mars uses bounded JSON/SSE responses. Buffer before the SDK can parse or
        // accumulate an arbitrarily large upstream message (including error bodies).
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        if (reader) {
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > 256 * 1024) throw new Error('MCP response exceeded its limit');
              chunks.push(value);
            }
          } finally { await reader.cancel(); }
        }
        return new Response(bytes ? Buffer.concat(chunks) : null, {
          status: response.status, statusText: response.statusText, headers: response.headers,
        });
      },
    }));
    return client;
  } catch {
    await client.close().catch(() => {});
    throw new Error('MCP connection failed; check access privately');
  }
}

export async function readAllowedResource(client: Client, uri: string): Promise<{ uri: string; text: string }> {
  const result = await client.readResource({ uri }, { timeout: 10_000 });
  if (result.contents.some(content => content.uri !== uri || !('text' in content))) throw new Error('Invalid MCP resource');
  const text = result.contents.map(content => 'text' in content ? content.text : '').join('\n');
  if (!text || Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('Invalid MCP resource');
  return { uri, text };
}

export async function readCharacterResources(config: GatewayConfig, character: Character): Promise<Array<{ uri: string; text: string }>> {
  if (character.resources.length === 0) return [];
  if (!config.mcp) throw new Error('Character resource access requires an MCP endpoint');
  const client = await connectMarsMcp({ url: config.mcp.url, tokenEnv: character.mcp_token_env ?? config.mcp.token_env });
  try {
    const records: Array<{ uri: string; text: string }> = [];
    let bytes = 0;
    for (const uri of character.resources) {
      const record = await readAllowedResource(client, uri);
      bytes += Buffer.byteLength(record.text, 'utf8');
      if (bytes > 64 * 1024) throw new Error();
      records.push(record);
    }
    return records;
  } catch {
    // SDK/provider errors may contain credentials or private data.
    throw new Error('MCP context could not be read; check the character access privately');
  } finally { await client.close(); }
}
