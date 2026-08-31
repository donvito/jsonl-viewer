const assert = require('assert');
const traceParser = require('./renderer/trace-parser.js');

const sts = [
  { type: 'session', harness: 'demo-agent', id: 'sts-1', name: 'STS example' },
  { type: 'message', message: { role: 'user', content: 'Inspect this project' } },
  { type: 'message', message: {
    role: 'assistant',
    reasoningContent: 'I should inspect the files first.',
    content: 'I will check the project.',
    toolCalls: [{ id: 'call-1', function: { name: 'shell', arguments: '{"command":"ls"}' } }]
  } },
  { type: 'message', message: { role: 'tool', toolCallId: 'call-1', content: 'README.md' } },
  { type: 'message', message: { role: 'assistant', content: 'The project is a JSONL viewer.' } }
];

const pi = [
  { type: 'session', version: 3, id: 'pi-1', timestamp: '2026-01-01T00:00:00Z', cwd: '/tmp/project' },
  { type: 'model_change', id: 'm-1', parentId: null, provider: 'openai', modelId: 'gpt-test' },
  { type: 'message', id: 'u-1', parentId: 'm-1', timestamp: 1000, message: { role: 'user', content: [{ type: 'text', text: 'Run tests' }] } },
  { type: 'message', id: 'a-1', parentId: 'u-1', timestamp: 2000, message: {
    role: 'assistant', provider: 'openai', model: 'gpt-test',
    content: [{ type: 'thinking', thinking: 'Check the test command.' }, { type: 'toolCall', id: 'pi-call', name: 'bash', arguments: { command: 'npm test' } }],
    usage: { input: 12, output: 4 }
  } },
  { type: 'message', id: 'r-1', parentId: 'a-1', timestamp: 3000, message: {
    role: 'toolResult', toolCallId: 'pi-call', toolName: 'bash', content: [{ type: 'text', text: 'passed' }], isError: false
  } },
  { type: 'message', id: 'a-2', parentId: 'r-1', timestamp: 4000, message: {
    role: 'assistant', provider: 'openai', model: 'gpt-test', content: [{ type: 'text', text: 'All tests pass.' }]
  } }
];

const codex = [
  { type: 'session_meta', payload: { id: 'codex-1', cwd: '/tmp/project', model_provider: 'openai' } },
  { type: 'response_item', timestamp: '2026-01-01T00:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the bug' }] } },
  { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Locate the failing code.' }] } },
  { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'codex-call', name: 'exec', input: '{"cmd":"npm test"}' } },
  { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'codex-call', output: 'passed' } },
  { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 18, output_tokens: 7 } } } },
  { type: 'event_msg', payload: { type: 'agent_message', message: 'Fixed.' } }
];

const claude = [
  { type: 'user', sessionId: 'claude-1', cwd: '/tmp/project', uuid: 'u-1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'Inspect the code' } },
  { type: 'assistant', sessionId: 'claude-1', uuid: 'a-1', timestamp: '2026-01-01T00:00:02Z', message: {
    role: 'assistant', model: 'claude-test', content: [{ type: 'thinking', thinking: 'Read the relevant file.' }, { type: 'tool_use', id: 'claude-call', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 22, output_tokens: 8 }
  } },
  { type: 'user', sessionId: 'claude-1', uuid: 'r-1', timestamp: '2026-01-01T00:00:03Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'claude-call', content: 'README.md', is_error: false }] } },
  { type: 'assistant', sessionId: 'claude-1', uuid: 'a-2', timestamp: '2026-01-01T00:00:04Z', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Here is the result.' }] } },
  { type: 'ai-title', sessionId: 'claude-1', aiTitle: 'Inspect the code' }
];

const hermes = [
  { parentUuid: null, isSidechain: false, userType: 'external', cwd: '/tmp/project', sessionId: 'hermes-1', version: 'hermes-agent', uuid: 'h-u-1', timestamp: '2026-01-01T00:00:01Z', type: 'user', message: { role: 'user', content: 'Inspect the code' } },
  { parentUuid: 'h-u-1', isSidechain: false, userType: 'external', cwd: '/tmp/project', sessionId: 'hermes-1', version: 'hermes-agent', uuid: 'h-a-1', timestamp: '2026-01-01T00:00:02Z', type: 'assistant', message: {
    role: 'assistant', model: 'hermes-test', content: [{ type: 'thinking', thinking: 'Read the relevant file.' }, { type: 'tool_use', id: 'hermes-call', name: 'terminal', input: { command: 'ls' } }], usage: { input_tokens: 22, output_tokens: 8 }
  } },
  { parentUuid: 'h-a-1', isSidechain: false, userType: 'external', cwd: '/tmp/project', sessionId: 'hermes-1', version: 'hermes-agent', uuid: 'h-r-1', timestamp: '2026-01-01T00:00:03Z', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'hermes-call', content: 'README.md', is_error: false }] } },
  { parentUuid: 'h-r-1', isSidechain: false, userType: 'external', cwd: '/tmp/project', sessionId: 'hermes-1', version: 'hermes-agent', uuid: 'h-a-2', timestamp: '2026-01-01T00:00:04Z', type: 'assistant', message: { role: 'assistant', model: 'hermes-test', content: [{ type: 'text', text: 'Here is the result.' }] } }
];

function kinds(trace) {
  return trace.items.flatMap((item) => item.blocks.map((block) => block.kind));
}

function run(name, lines, expectedFormat, filePath) {
  assert.strictEqual(traceParser.detect(lines, filePath).format, expectedFormat, `${name} detection`);
  const trace = traceParser.parse(lines, filePath);
  assert(trace, `${name} should normalize`);
  assert.strictEqual(trace.format, expectedFormat);
  return trace;
}

const stsTrace = run('STS', sts, 'sts');
assert(stsTrace.items.some((item) => item.blocks.some((block) => block.kind === 'thinking')));
assert(stsTrace.items.some((item) => item.blocks.some((block) => block.result?.output === 'README.md')));

const piTrace = run('Pi', pi, 'pi');
assert.strictEqual(piTrace.stats.toolCalls, 1);
assert.strictEqual(piTrace.stats.toolResults, 1);
assert(kinds(piTrace).includes('thinking'));

const codexTrace = run('Codex', codex, 'codex');
assert.strictEqual(codexTrace.stats.toolCalls, 1);
assert.strictEqual(codexTrace.stats.toolResults, 1);
assert.strictEqual(codexTrace.stats.inputTokens, 18);

const claudeTrace = run('Claude Code', claude, 'claude');
assert.strictEqual(claudeTrace.stats.toolCalls, 1);
assert.strictEqual(claudeTrace.stats.toolResults, 1);
assert.strictEqual(claudeTrace.title, 'Inspect the code');

const hermesTrace = run('Hermes', hermes, 'hermes', '/Users/test/.hermes/session-exports/traces/hermes-1.jsonl');
assert.strictEqual(hermesTrace.stats.toolCalls, 1);
assert.strictEqual(hermesTrace.stats.toolResults, 1);
assert.strictEqual(hermesTrace.harness, 'Hermes');

assert.strictEqual(traceParser.detect([{ type: 'user', message: 'ordinary application log' }]), null);
console.log('All trace assertions passed ✅');
