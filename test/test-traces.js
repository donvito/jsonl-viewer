const assert = require('assert');
const traceParser = require('../renderer/trace-parser.js');

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

// Regression: Claude Code records carry sessionId + parentUuid too, so that
// shape alone must not make a session look like a Hermes export.
const claudeWithParentUuid = [
  { type: 'user', sessionId: 'claude-2', parentUuid: null, cwd: '/tmp/project', uuid: 'cu-1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'Inspect the code' } },
  { type: 'assistant', sessionId: 'claude-2', parentUuid: 'cu-1', uuid: 'ca-1', timestamp: '2026-01-01T00:00:02Z', message: {
    role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 5, output_tokens: 2 }
  } }
];
const claudeParented = run('Claude Code with parentUuid', claudeWithParentUuid, 'claude',
  '/Users/test/.claude/projects/-Users-test-repo/f9f32b93.jsonl');
assert.strictEqual(claudeParented.harness, 'Claude Code');
// Same records without the path hint must still not be claimed by Hermes.
assert.strictEqual(traceParser.detect(claudeWithParentUuid).format, 'claude');

// Codex main vs subagent classification comes from session_meta.thread_source.
function codexWithMeta(meta) {
  return [Object.assign({}, codex[0], { payload: Object.assign({}, codex[0].payload, meta) })]
    .concat(codex.slice(1));
}

assert.strictEqual(traceParser.getTraceType('user'), 'main');
assert.strictEqual(traceParser.getTraceType('subagent'), 'subagent');
assert.strictEqual(traceParser.getTraceType('cron'), 'unknown');
assert.strictEqual(traceParser.getTraceType(undefined), 'unknown');

const mainTrace = run('Codex main', codexWithMeta({ thread_source: 'user', model: 'gpt-6-astra' }), 'codex');
assert.strictEqual(mainTrace.traceType, 'main');
assert.strictEqual(mainTrace.subagent, null);
assert.strictEqual(mainTrace.model, 'gpt-6-astra');

const subagentTrace = run('Codex subagent', codexWithMeta({
  thread_source: 'subagent',
  model: 'gpt-5.6-luna',
  parent_thread_id: '01a079f2-0000-0000-0000-000000000000',
  agent_role: 'explorer',
  agent_path: '/root/trace_refresh',
  agent_nickname: 'Luna'
}), 'codex');
assert.strictEqual(subagentTrace.traceType, 'subagent');
assert.deepStrictEqual(subagentTrace.subagent, {
  parentThreadId: '01a079f2-0000-0000-0000-000000000000',
  agentRole: 'explorer',
  agentPath: '/root/trace_refresh',
  agentNickname: 'Luna'
});

// A subagent trace without the optional fields still classifies, and only the
// fields that are present are surfaced.
const sparseSubagent = run('Codex sparse subagent', codexWithMeta({ thread_source: 'subagent', agent_role: 'explorer' }), 'codex');
assert.deepStrictEqual(sparseSubagent.subagent, { agentRole: 'explorer' });

// Missing or unrecognised values must not be guessed from anything else.
assert.strictEqual(codexTrace.traceType, 'unknown');
assert.strictEqual(codexTrace.subagent, null);
const oddSource = run('Codex unknown source', codexWithMeta({ thread_source: 'compacted', agent_role: 'explorer' }), 'codex');
assert.strictEqual(oddSource.traceType, 'unknown');
assert.strictEqual(oddSource.subagent, null);

// ---- main/subagent linking ----
// A subagent belongs to the trace whose id equals its parent_thread_id.
// Nothing else — filename, model, role, timestamp — takes part.
const info = (key, id, type, parentThreadId) => ({ key, id, type, parentThreadId });
const childKeys = (node) => node.children.map((c) => c.key);
const nodeFor = (linked, key) => linked.nodes.find((n) => n.key === key);

// session_meta normalization feeds the linker.
const metaMain = traceParser.codexTraceInfo({ id: 'p1', thread_source: 'user' });
assert.deepStrictEqual(metaMain, {
  id: 'p1', type: 'main', threadSource: 'user',
  parentThreadId: null, agentRole: null, agentPath: null, agentNickname: null
});
const metaSub = traceParser.codexTraceInfo({
  id: 'c1', thread_source: 'subagent', parent_thread_id: 'p1',
  agent_role: 'explorer', agent_path: '/root/x', agent_nickname: 'Luna'
});
assert.deepStrictEqual(metaSub, {
  id: 'c1', type: 'subagent', threadSource: 'subagent', parentThreadId: 'p1',
  agentRole: 'explorer', agentPath: '/root/x', agentNickname: 'Luna'
});

// main with one child
let linked = traceParser.linkTraces([
  info('main.jsonl', 'p1', 'main'),
  info('kid.jsonl', 'c1', 'subagent', 'p1')
]);
assert.deepStrictEqual(childKeys(nodeFor(linked, 'main.jsonl')), ['kid.jsonl']);
assert.strictEqual(nodeFor(linked, 'kid.jsonl').parent.key, 'main.jsonl');
assert.deepStrictEqual(linked.roots.map((n) => n.key), ['main.jsonl']);

// main with multiple children, and a grandchild one level down
linked = traceParser.linkTraces([
  info('main.jsonl', 'p1', 'main'),
  info('a.jsonl', 'c1', 'subagent', 'p1'),
  info('b.jsonl', 'c2', 'subagent', 'p1'),
  info('c.jsonl', 'c3', 'subagent', 'c2')
]);
assert.deepStrictEqual(childKeys(nodeFor(linked, 'main.jsonl')), ['a.jsonl', 'b.jsonl']);
assert.deepStrictEqual(childKeys(nodeFor(linked, 'b.jsonl')), ['c.jsonl']);
assert.deepStrictEqual(linked.roots.map((n) => n.key), ['main.jsonl']);

// subagent whose parent is not loaded stays visible as a root, and keeps the
// parent id so the UI can show it as unresolved
linked = traceParser.linkTraces([info('orphan.jsonl', 'c1', 'subagent', 'missing-parent')]);
const orphan = nodeFor(linked, 'orphan.jsonl');
assert.strictEqual(orphan.parent, null);
assert.strictEqual(orphan.unresolvedParentId, 'missing-parent');
assert.deepStrictEqual(linked.roots.map((n) => n.key), ['orphan.jsonl']);

// unrelated traces are all roots and gain no children
linked = traceParser.linkTraces([
  info('one.jsonl', 'p1', 'main'),
  info('two.jsonl', 'p2', 'main')
]);
assert.deepStrictEqual(linked.roots.map((n) => n.key), ['one.jsonl', 'two.jsonl']);
assert.deepStrictEqual(linked.nodes.map((n) => n.children.length), [0, 0]);

// unknown thread_source never links, in either direction
linked = traceParser.linkTraces([
  info('main.jsonl', 'p1', 'main'),
  info('guardian.jsonl', 'g1', 'unknown', 'p1'),
  info('kid.jsonl', 'c1', 'subagent', 'g1')
]);
assert.deepStrictEqual(childKeys(nodeFor(linked, 'main.jsonl')), []);
assert.strictEqual(nodeFor(linked, 'guardian.jsonl').parent, null);
// An unknown trace is still a valid parent by id — only its own type is unknown.
assert.deepStrictEqual(childKeys(nodeFor(linked, 'guardian.jsonl')), ['kid.jsonl']);

// A cycle must not hang or vanish: both stay reachable as roots.
linked = traceParser.linkTraces([
  info('a.jsonl', 'a', 'subagent', 'b'),
  info('b.jsonl', 'b', 'subagent', 'a')
]);
assert.strictEqual(linked.roots.length, 1);
assert.strictEqual(nodeFor(linked, 'b.jsonl').unresolvedParentId, 'a');

// A duplicated id must not re-parent anything.
linked = traceParser.linkTraces([
  info('first.jsonl', 'dup', 'main'),
  info('second.jsonl', 'dup', 'main'),
  info('kid.jsonl', 'c1', 'subagent', 'dup')
]);
assert.deepStrictEqual(childKeys(nodeFor(linked, 'first.jsonl')), ['kid.jsonl']);
assert.deepStrictEqual(childKeys(nodeFor(linked, 'second.jsonl')), []);

assert.strictEqual(traceParser.detect([{ type: 'user', message: 'ordinary application log' }]), null);
console.log('All trace assertions passed ✅');
