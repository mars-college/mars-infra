#!/usr/bin/env node
// Fixture only: no Claude/Discord/model API access. Optional MCP is loopback-only.
if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
  console.log(JSON.stringify({ loggedIn: true,
    authMethod: process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'oauth_token' : 'claude.ai', apiProvider: 'firstParty' }));
} else {
  const args = process.argv.slice(2);
  const value = flag => args[args.indexOf(flag) + 1];
  const mcp = JSON.parse(value('--mcp-config') ?? '{}').mcpServers;
  const mars = mcp?.mars;
  const allowed = args.includes('--allowedTools')
    ? args.slice(args.indexOf('--allowedTools') + 1).filter((name, index, rest) => !rest.slice(0, index + 1).some(arg => arg.startsWith('--')))
    : [];
  if ((!mars && !args.includes('--safe-mode')) || (mars && (args.includes('--safe-mode') ||
      !args.includes('--restricted') || value('--setting-sources') !== '' ||
      !args.includes('--disable-slash-commands') || value('--settings') !== '{"disableAllHooks":true}')) ||
      !args.includes('--tools') || value('--tools') !== '' ||
      !args.includes('--strict-mcp-config') || !mcp || Object.keys(mcp).some(name => name !== 'mars') ||
      !args.includes('--no-session-persistence') || value('--max-turns') !== (mars ? '8' : '1') ||
      (mars && (mars.type !== 'http' || !mars.url.startsWith('http://127.0.0.1:') ||
        !mars.headers?.Authorization?.startsWith('Bearer ') || !allowed.length ||
        allowed.some(name => !/^mcp__mars__(list_resources|read_resource|cuelight_nodes|cuelight_play)$/.test(name)))) ||
      (!mars && allowed.length)) {
    console.error('fixture detected missing model-subprocess restrictions');
    process.exit(1);
  }
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const payload = JSON.parse(input);
  if (process.env.DISCORD_BOT_TOKEN || process.env.MARS_MCP_TOKEN || process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_BASE_URL || process.env.CLAUDE_CODE_USE_BEDROCK || process.env.AWS_SECRET_ACCESS_KEY) {
    console.error('fixture detected inherited secret');
    process.exit(1);
  }
  if (payload.question === '[fixture timeout]') {
    setInterval(() => {}, 1000);
  } else if (payload.question === '[fixture error]') {
    console.error('synthetic-private-error-do-not-reflect');
    process.exit(1);
  } else if (payload.question === '[fixture large]') {
    console.log('x'.repeat(300000));
  } else if (payload.question === '[fixture mcp]') {
    if (!mars) throw new Error('Expected restricted MCP server');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'synthetic-cli', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(mars.url), { requestInit: { headers: mars.headers } }));
      const listed = await client.callTool({ name: 'list_resources', arguments: {} });
      const read = await client.callTool({ name: 'read_resource', arguments: { uri: payload.uri } });
      console.log(JSON.stringify({ result: JSON.stringify({ listed, read, allowed }) }));
    } finally { await client.close(); }
  } else {
    const context = payload.context ?? [];
    const record = context.find(item => /dinner|plates|Copper Finch/.test(item.text));
    const fact = record?.text.match(/[^\n]*(?:weekly dinner|clean plates|Copper Finch)[^\n]*/i)?.[0];
    console.log(JSON.stringify({ is_error: false,
      result: fact ? `[SYNTHETIC CLI] ${fact} Source: ${record.source}` : '[SYNTHETIC CLI] No relevant fact in this character context.' }));
  }
}
