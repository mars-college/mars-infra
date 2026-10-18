#!/usr/bin/env node
// Fixture only: no Claude, Discord, model credentials, or network access.
if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
} else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const payload = JSON.parse(input);
  if (process.env.DISCORD_BOT_TOKEN || process.env.MARS_MCP_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
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
  } else {
    const context = payload.context ?? [];
    const record = context.find(item => /dinner|plates|Copper Finch/.test(item.text));
    const fact = record?.text.match(/[^\n]*(?:weekly dinner|clean plates|Copper Finch)[^\n]*/i)?.[0];
    console.log(JSON.stringify({ is_error: false,
      result: fact ? `[SYNTHETIC CLI] ${fact} Source: ${record.source}` : '[SYNTHETIC CLI] No relevant fact in this character context.' }));
  }
}
