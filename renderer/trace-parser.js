/*
 * Agent trace detection and normalization.
 *
 * The viewer still keeps the original parsed JSONL lines as the source of
 * truth. This module only adds a presentation model for the formats that the
 * Hugging Face trace viewer understands:
 *
 *   - Session Trace Simple Format (STS)
 *   - Pi Agent sessions
 *   - Codex rollouts
 *   - Claude Code sessions
 *   - Hermes Agent session exports
 *
 * It is deliberately dependency-free so it can run in the renderer and in
 * the small Node-based test suite.
 */
(function exposeTraceParser(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.traceParser = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTraceParser() {
  const PI_MESSAGE_ROLES = new Set([
    'user', 'assistant', 'toolResult', 'bashExecution', 'custom', 'customMessage',
    'custom_message', 'branchSummary', 'compactionSummary'
  ]);

  const CODEX_CALL_TYPES = new Set([
    'function_call', 'custom_tool_call', 'local_shell_call', 'computer_call',
    'web_search_call', 'tool_call'
  ]);

  const CODEX_RESULT_TYPES = new Set([
    'function_call_output', 'custom_tool_call_output', 'local_shell_call_output',
    'computer_call_output', 'web_search_call_output', 'tool_call_output'
  ]);

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  // Codex rollouts say in session_meta whether a thread was started by the
  // user or spawned as a subagent. `thread_source` is the only trustworthy
  // signal for that: model names, file names and agent roles all vary between
  // runs, so nothing else is inferred here.
  //
  //   type TraceType = 'main' | 'subagent' | 'unknown'
  const CODEX_SUBAGENT_FIELDS = [
    ['parent_thread_id', 'parentThreadId'],
    ['agent_role', 'agentRole'],
    ['agent_path', 'agentPath'],
    ['agent_nickname', 'agentNickname']
  ];

  function getTraceType(threadSource) {
    if (threadSource === 'user') return 'main';
    if (threadSource === 'subagent') return 'subagent';
    return 'unknown';
  }

  function nonEmptyString(value) {
    return value == null || value === '' ? null : String(value);
  }

  // The normalized identity of a Codex rollout, used both for the open trace
  // and for files the explorer has only probed.
  function codexTraceInfo(payload) {
    const p = isObject(payload) ? payload : {};
    return {
      id: nonEmptyString(p.id) || nonEmptyString(p.session_id),
      type: getTraceType(p.thread_source),
      threadSource: typeof p.thread_source === 'string' ? p.thread_source : null,
      parentThreadId: nonEmptyString(p.parent_thread_id),
      agentRole: nonEmptyString(p.agent_role),
      agentPath: nonEmptyString(p.agent_path),
      agentNickname: nonEmptyString(p.agent_nickname)
    };
  }

  // Links subagents to the trace that spawned them, using only the ids in
  // session_meta: a subagent belongs to the trace whose id equals its
  // parent_thread_id. Filenames, models, roles and timestamps are ignored.
  //
  // Entries are { key, id, type, parentThreadId }; `key` is whatever the
  // caller uses to address a trace (a file path, here). Returns every node in
  // input order, plus the roots — traces with no resolved parent, which covers
  // mains, unknowns, and subagents whose parent is not loaded. A subagent that
  // could not be linked keeps its parent id in `unresolvedParentId` so the UI
  // can still show it.
  function linkTraces(entries) {
    const nodes = (Array.isArray(entries) ? entries : [])
      .filter(isObject)
      .map((entry) => ({
        key: entry.key,
        id: nonEmptyString(entry.id),
        type: entry.type || 'unknown',
        parentThreadId: nonEmptyString(entry.parentThreadId),
        entry,
        parent: null,
        children: [],
        unresolvedParentId: null
      }));

    const byId = new Map();
    for (const node of nodes) {
      // First writer wins, so a duplicated id cannot silently re-parent a tree.
      if (node.id && !byId.has(node.id)) byId.set(node.id, node);
    }

    for (const node of nodes) {
      if (node.type !== 'subagent' || !node.parentThreadId) continue;
      const parent = byId.get(node.parentThreadId);
      // A parent that is missing, is the node itself, or already sits below it
      // would produce a cycle rather than a tree.
      if (!parent || parent === node || hasAncestor(parent, node)) {
        node.unresolvedParentId = node.parentThreadId;
        continue;
      }
      node.parent = parent;
      parent.children.push(node);
    }

    return { nodes, byId, roots: nodes.filter((node) => !node.parent) };
  }

  function hasAncestor(node, candidate) {
    let current = node.parent;
    while (current) {
      if (current === candidate) return true;
      current = current.parent;
    }
    return false;
  }

  function codexSubagentInfo(payload) {
    const info = {};
    let found = false;
    for (const [key, alias] of CODEX_SUBAGENT_FIELDS) {
      const value = isObject(payload) ? payload[key] : undefined;
      if (value == null || value === '') continue;
      info[alias] = String(value);
      found = true;
    }
    return found ? info : null;
  }

  function hasOwn(value, key) {
    return isObject(value) && Object.prototype.hasOwnProperty.call(value, key);
  }

  function asRecords(lines) {
    if (!Array.isArray(lines)) return [];
    return lines.map((line, i) => {
      // Parsed lines from main.js have { index, raw, value }. Accept plain
      // values too, which makes this module convenient to test and reuse.
      if (isObject(line) && hasOwn(line, 'value') &&
          (hasOwn(line, 'raw') || hasOwn(line, 'index') || hasOwn(line, 'parseError'))) {
        return {
          value: line.parseError ? null : line.value,
          raw: line.raw || '',
          index: Number.isFinite(line.index) ? line.index : i,
          parseError: line.parseError || null
        };
      }
      return { value: line, raw: '', index: i, parseError: null };
    }).filter((record) => record.value !== null && isObject(record.value));
  }

  function pathLooksLike(filePath, fragment) {
    return typeof filePath === 'string' && filePath.toLowerCase().includes(fragment);
  }

  function traceDescriptor(format, harness, extra) {
    return Object.assign({ format, harness }, extra || {});
  }

  function detect(lines, filePath) {
    const records = asRecords(lines);
    const values = records.map((record) => record.value);
    if (!values.length) return null;

    const first = values[0];

    // STS-Format has an intentionally strict signature: a session header
    // with a harness and id, followed by message envelopes.
    if (first.type === 'session' && typeof first.harness === 'string' &&
        first.harness.length > 0 && first.id != null) {
      return traceDescriptor('sts', first.harness, { header: first });
    }

    // Codex rollouts have a distinctive session_meta envelope. Checking for
    // an id/cwd prevents an unrelated log line named session_meta from
    // changing the view.
    const codexHeader = values.find((value) =>
      value.type === 'session_meta' && isObject(value.payload) &&
      (value.payload.id || value.payload.session_id || value.payload.cwd)
    );
    if (codexHeader) {
      return traceDescriptor('codex', 'Codex', { header: codexHeader });
    }

    // Pi's header is also type=session, but it has no harness field. Version
    // and cwd are part of the native format; the message-role fallback also
    // covers older sessions.
    const hasPiMessage = values.some((value) =>
      value.type === 'message' && isObject(value.message) &&
      PI_MESSAGE_ROLES.has(value.message.role)
    );
    if (first.type === 'session' &&
        (first.version != null || first.cwd || first.provider || first.modelId || hasPiMessage)) {
      return traceDescriptor('pi', 'Pi', { header: first });
    }
    if (pathLooksLike(filePath, '/.pi/agent/sessions') &&
        (first.type === 'session' || hasPiMessage)) {
      return traceDescriptor('pi', 'Pi', { header: first.type === 'session' ? first : null });
    }

    // Claude Code has no session header. Its stable envelope signals are the
    // top-level user/assistant records and UUID/session metadata. Requiring a
    // Claude-specific record or path avoids treating ordinary {type:user}
    // application logs as traces.
    const hasClaudeAssistant = values.some((value) =>
      value.type === 'assistant' && isObject(value.message) && value.message.role === 'assistant'
    );
    const hasClaudeUser = values.some((value) =>
      value.type === 'user' && isObject(value.message) && value.message.role === 'user'
    );
    const hasClaudeContentSignal = values.some((value) => {
      if (value.type !== 'assistant' || !isObject(value.message)) return false;
      if (value.message.model || value.message.usage) return true;
      return Array.isArray(value.message.content) && value.message.content.some((block) =>
        isObject(block) && ['thinking', 'tool_use', 'tool_result'].includes(String(block.type || '').toLowerCase())
      );
    });
    const hasClaudeSignal = values.some((value) =>
      value.type === 'file-history-snapshot' ||
      value.type === 'queue-operation' ||
      value.type === 'ai-title' ||
      value.type === 'attachment' ||
      value.type === 'last-prompt' ||
      value.parentUuid != null || value.sessionId != null || value.session_id != null
    );
    // Hermes exports share Claude Code's envelope, so only a Hermes-specific
    // marker separates them: the version stamp, or the export directory.
    // Matching on the shared shape (sessionId + parentUuid) would claim every
    // Claude Code session, which is what it used to do.
    const hasHermesSignal = values.some((value) => value.version === 'hermes-agent');
    if ((hasHermesSignal || pathLooksLike(filePath, '/.hermes/')) &&
        (hasClaudeAssistant || hasClaudeUser)) {
      return traceDescriptor('hermes', 'Hermes', { header: null });
    }
    if (hasClaudeAssistant && (hasClaudeUser || hasClaudeSignal) &&
        (hasClaudeSignal || hasClaudeContentSignal || pathLooksLike(filePath, '/.claude/'))) {
      return traceDescriptor('claude', 'Claude Code', { header: null });
    }
    if (pathLooksLike(filePath, '/.claude/') && (hasClaudeAssistant || hasClaudeUser || hasClaudeSignal)) {
      return traceDescriptor('claude', 'Claude Code', { header: null });
    }

    return null;
  }

  function firstRecord(records, predicate) {
    return records.find((record) => predicate(record.value)) || null;
  }

  function asTimestamp(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      const millis = value < 100000000000 ? value * 1000 : value;
      const date = new Date(millis);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    if (typeof value === 'string') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toISOString();
    }
    return null;
  }

  function pickNumber(object, keys) {
    if (!isObject(object)) return null;
    for (const key of keys) {
      const value = object[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  }

  function normalizeUsage(usage) {
    if (!isObject(usage)) return null;
    const input = pickNumber(usage, [
      'input', 'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'
    ]);
    const output = pickNumber(usage, [
      'output', 'output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens'
    ]);
    const cacheRead = pickNumber(usage, [
      'cacheRead', 'cache_read', 'cache_read_input_tokens', 'cacheReadInputTokens'
    ]);
    const cacheWrite = pickNumber(usage, [
      'cacheWrite', 'cache_write', 'cache_creation_input_tokens', 'cacheCreationInputTokens'
    ]);
    const reasoning = pickNumber(usage, ['reasoning', 'reasoning_tokens', 'reasoningTokens']);
    const totalTokens = pickNumber(usage, [
      'totalTokens', 'total_tokens', 'total', 'tokens'
    ]) ?? ((input != null || output != null) ? (input || 0) + (output || 0) : null);
    const cost = isObject(usage.cost) ? usage.cost : null;
    if ([input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost].every((v) => v == null)) {
      return null;
    }
    return { input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost };
  }

  function parseJsonString(value) {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch (e) { return value; }
  }

  function contentText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
    if (isObject(value)) {
      if (typeof value.text === 'string') return value.text;
      if (typeof value.thinking === 'string') return value.thinking;
      if (typeof value.content === 'string') return value.content;
      if (Array.isArray(value.content)) return contentText(value.content);
    }
    return '';
  }

  function normalizedContentBlocks(content, sourceLine) {
    if (content == null || content === '') return [];
    if (typeof content === 'string' || typeof content === 'number' || typeof content === 'boolean') {
      return [{ kind: 'text', text: String(content), sourceLine }];
    }
    if (!Array.isArray(content)) {
      const text = contentText(content);
      return text ? [{ kind: 'text', text, sourceLine }] : [];
    }

    const blocks = [];
    for (const raw of content) {
      if (raw == null) continue;
      if (typeof raw === 'string') {
        blocks.push({ kind: 'text', text: raw, sourceLine });
        continue;
      }
      const type = String(raw.type || '').toLowerCase();
      if (type === 'text' || type === 'input_text' || type === 'output_text' || type === 'message') {
        const text = typeof raw.text === 'string' ? raw.text : contentText(raw.content);
        if (text) blocks.push({ kind: 'text', text, sourceLine });
      } else if (type === 'thinking' || type === 'reasoning' || type === 'summary_text') {
        const text = raw.thinking || raw.text || raw.summary || contentText(raw.content);
        if (text) blocks.push({ kind: 'thinking', text: String(text), sourceLine });
      } else if (type === 'redacted_thinking') {
        blocks.push({ kind: 'thinking', text: 'Reasoning unavailable (redacted)', sourceLine, redacted: true });
      } else if (type === 'toolcall' || type === 'tool_call' || type === 'tool_use' || type === 'function_call' || type === 'custom_tool_call' || type === 'local_shell_call' || type === 'server_tool_use' || type === 'web_search_tool_use' || type === 'mcp_tool_use') {
        const id = raw.id || raw.call_id || raw.callId || null;
        const input = raw.arguments !== undefined ? parseJsonString(raw.arguments)
          : (raw.input !== undefined ? parseJsonString(raw.input)
            : (raw.parameters !== undefined ? raw.parameters : (raw.command !== undefined ? { command: raw.command } : null)));
        blocks.push({
          kind: 'tool-call',
          id: id == null ? null : String(id),
          name: raw.name || raw.toolName || raw.function?.name || raw.type || 'tool',
          input,
          sourceLine
        });
      } else if (type === 'toolresult' || type === 'tool_result' || type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'local_shell_call_output' || type === 'web_search_tool_result' || type === 'mcp_tool_result') {
        const id = raw.toolCallId || raw.tool_use_id || raw.call_id || raw.callId || null;
        const output = raw.output !== undefined ? raw.output : (raw.content !== undefined ? raw.content : raw.result);
        blocks.push({
          kind: 'tool-result',
          id: id == null ? null : String(id),
          output,
          toolName: raw.toolName || raw.name || null,
          error: raw.isError === true || raw.is_error === true || raw.status === 'error',
          sourceLine
        });
      } else if (type === 'image' || type === 'input_image' || type === 'output_image') {
        blocks.push({
          kind: 'image',
          data: raw.data || raw.source?.data || null,
          mimeType: raw.mimeType || raw.mime_type || raw.source?.media_type || 'image/png',
          sourceLine
        });
      } else {
        const text = contentText(raw);
        if (text) blocks.push({ kind: 'text', text, sourceLine });
      }
    }
    return blocks;
  }

  function createTrace(descriptor, header) {
    const harness = descriptor.harness || 'Agent';
    return {
      kind: 'agent-trace',
      format: descriptor.format,
      harness,
      label: harness,
      title: `${harness} trace`,
      id: header && (header.id || header.session_id || header.sessionId || header.thread_id) || null,
      cwd: header && (header.cwd || header.working_directory) || null,
      model: header && (header.modelId || header.model || header.model_provider) || null,
      header: header || null,
      items: [],
      stats: { messages: 0, toolCalls: 0, toolResults: 0, errors: 0, inputTokens: 0, outputTokens: 0 }
    };
  }

  function makeItem(kind, record, options) {
    const opts = options || {};
    return {
      kind,
      role: opts.role || kind,
      id: opts.id || null,
      sourceLine: record ? record.index : null,
      sourceLines: record ? [record.index] : [],
      timestamp: asTimestamp(opts.timestamp !== undefined ? opts.timestamp : record && record.value && record.value.timestamp),
      model: opts.model || null,
      provider: opts.provider || null,
      effort: opts.effort || null,
      usage: normalizeUsage(opts.usage),
      label: opts.label || null,
      metadata: opts.metadata || {},
      blocks: []
    };
  }

  function addItem(trace, item) {
    if (!item) return item;
    trace.items.push(item);
    return item;
  }

  function addBlock(item, block) {
    if (!item || !block) return;
    item.blocks.push(block);
    if (block.sourceLine != null && !item.sourceLines.includes(block.sourceLine)) item.sourceLines.push(block.sourceLine);
  }

  function addText(item, text, sourceLine, kind) {
    if (text == null || text === '') return;
    addBlock(item, { kind: kind || 'text', text: String(text), sourceLine });
  }

  function createRegistry() {
    return { calls: new Map(), waiting: new Map() };
  }

  function toolResultPayload(block) {
    return {
      output: block.output,
      toolName: block.toolName || null,
      error: !!block.error,
      sourceLine: block.sourceLine
    };
  }

  function attachToolResult(registry, block) {
    if (!block || block.id == null) return false;
    const id = String(block.id);
    const call = registry.calls.get(id);
    if (call) {
      call.result = toolResultPayload(block);
      if (!Array.isArray(call.sourceLines)) call.sourceLines = call.sourceLine == null ? [] : [call.sourceLine];
      if (block.sourceLine != null && !call.sourceLines.includes(block.sourceLine)) call.sourceLines.push(block.sourceLine);
      registry.calls.delete(id);
      return true;
    }
    registry.waiting.set(id, block);
    return false;
  }

  function registerToolCall(registry, block) {
    if (!block || block.id == null) return;
    const id = String(block.id);
    const waiting = registry.waiting.get(id);
    if (waiting) {
      block.result = toolResultPayload(waiting);
      if (!Array.isArray(block.sourceLines)) block.sourceLines = block.sourceLine == null ? [] : [block.sourceLine];
      if (waiting.sourceLine != null && !block.sourceLines.includes(waiting.sourceLine)) block.sourceLines.push(waiting.sourceLine);
      registry.waiting.delete(id);
    } else {
      registry.calls.set(id, block);
    }
  }

  function appendNormalizedBlocks(item, blocks, registry) {
    for (const block of blocks || []) {
      if (block.kind === 'tool-result') {
        if (!attachToolResult(registry, block)) addBlock(item, block);
      } else {
        addBlock(item, block);
        if (block.kind === 'tool-call') registerToolCall(registry, block);
      }
    }
  }

  function usageToItem(item, usage) {
    const normalized = normalizeUsage(usage);
    if (normalized) item.usage = normalized;
  }

  function displayTextForBlock(block) {
    if (!block) return '';
    if (block.kind === 'tool-call') return `${block.name || 'tool'} ${stringifyValue(block.input)}`;
    if (block.kind === 'tool-result') return stringifyValue(block.output);
    if (block.kind === 'image') return '[image]';
    return block.text || '';
  }

  function stringifyValue(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }

  function finishTrace(trace) {
    let toolCalls = 0;
    let toolResults = 0;
    let errors = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    for (const item of trace.items) {
      item.sourceLines = Array.from(new Set(item.sourceLines.filter((line) => line != null))).sort((a, b) => a - b);
      item.searchText = [item.kind, item.role, item.model, item.provider, item.effort, item.label]
        .concat(item.blocks.reduce((parts, block) => {
          parts.push(displayTextForBlock(block));
          if (block.result) parts.push(stringifyValue(block.result.output));
          return parts;
        }, [])).filter(Boolean).join('\n').toLowerCase();
      for (const block of item.blocks) {
        if (block.kind === 'tool-call') toolCalls++;
        if (block.kind === 'tool-result') toolResults++;
        if (block.kind === 'tool-call' && block.result) toolResults++;
        if (block.error || block.result?.error) errors++;
      }
      if (item.usage) {
        inputTokens += item.usage.input || 0;
        outputTokens += item.usage.output || 0;
      }
    }
    trace.stats = {
      messages: trace.items.filter((item) => item.kind === 'user' || item.kind === 'assistant').length,
      toolCalls,
      toolResults,
      errors,
      inputTokens,
      outputTokens
    };
    return trace;
  }

  function traceTitleFromHeader(trace, header) {
    if (!header) return;
    const title = header.name || header.aiTitle || header.title;
    if (typeof title === 'string' && title.trim()) trace.title = title.trim();
    if (header.cwd) trace.cwd = header.cwd;
    if (header.modelId || header.model) trace.model = header.modelId || header.model;
  }

  function normalizeSts(records, descriptor) {
    const headerRecord = firstRecord(records, (value) => value.type === 'session');
    const header = headerRecord ? headerRecord.value : descriptor.header;
    const trace = createTrace(descriptor, header);
    traceTitleFromHeader(trace, header);
    const registry = createRegistry();

    for (const record of records) {
      const value = record.value;
      if (value === header) continue;
      if (value.type !== 'message' || !isObject(value.message)) continue;
      const message = value.message;
      const role = message.role || 'assistant';
      if (role === 'tool') {
        const result = {
          kind: 'tool-result',
          id: message.toolCallId || message.tool_call_id || null,
          output: message.content,
          toolName: message.toolName || null,
          error: message.isError === true,
          sourceLine: record.index
        };
        if (!attachToolResult(registry, result)) {
          const item = makeItem('tool', record, { role: 'tool', timestamp: message.timestamp || value.timestamp, label: 'Tool result' });
          addBlock(item, result);
          addItem(trace, item);
        }
        continue;
      }

      const itemKind = role === 'user' ? 'user' : (role === 'system' ? 'event' : 'assistant');
      const item = makeItem(itemKind, record, {
        role,
        timestamp: message.timestamp || value.timestamp,
        model: message.model || header?.model,
        provider: message.provider,
        usage: message.usage
      });
      if (message.reasoningContent) addText(item, message.reasoningContent, record.index, 'thinking');
      appendNormalizedBlocks(item, normalizedContentBlocks(message.content, record.index), registry);
      for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
        const block = normalizedContentBlocks([{ type: 'toolCall', id: call.id, name: call.function?.name || call.name, arguments: call.function?.arguments ?? call.arguments }], record.index)[0];
        if (block) {
          addBlock(item, block);
          registerToolCall(registry, block);
        }
      }
      addItem(trace, item);
    }
    return finishTrace(trace);
  }

  function piActiveRecords(records) {
    const entries = records.filter((record) => record.value.type !== 'session');
    const hasTreeLinks = entries.some((record) => hasOwn(record.value, 'parentId'));
    if (!hasTreeLinks) return records;
    const byId = new Map();
    for (const record of entries) if (record.value.id) byId.set(String(record.value.id), record);
    let leaf = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].value.id) { leaf = entries[i]; break; }
    }
    if (!leaf) return records;
    const activeIds = new Set();
    let current = leaf;
    while (current) {
      const id = current.value.id;
      if (id) activeIds.add(String(id));
      const parentId = current.value.parentId;
      if (!parentId) break;
      current = byId.get(String(parentId)) || null;
    }
    return records.filter((record) => record.value.type === 'session' || (record.value.id && activeIds.has(String(record.value.id))));
  }

  function normalizePi(records, descriptor) {
    const allHeader = firstRecord(records, (value) => value.type === 'session');
    const header = allHeader ? allHeader.value : descriptor.header;
    const trace = createTrace(descriptor, header);
    traceTitleFromHeader(trace, header);
    const registry = createRegistry();
    const activeRecords = piActiveRecords(records);
    let currentModel = header && (header.modelId || header.model) || null;
    let currentProvider = header && header.provider || null;

    for (const record of activeRecords) {
      const value = record.value;
      if (value.type === 'session') continue;
      if (value.type === 'session_info') {
        if (value.name) trace.title = String(value.name);
        continue;
      }
      if (value.type === 'model_change') {
        currentModel = value.modelId || currentModel;
        currentProvider = value.provider || currentProvider;
        continue;
      }
      if (value.type === 'thinking_level_change') continue;

      if (value.type === 'message' && isObject(value.message)) {
        const message = value.message;
        const role = message.role || 'assistant';
        if (role === 'bashExecution') {
          const item = makeItem('tool', record, { role: 'tool', label: 'bash', timestamp: message.timestamp || value.timestamp });
          const call = {
            kind: 'tool-call', id: `bash-${record.index}`, name: 'bash',
            input: { command: message.command || '' }, sourceLine: record.index,
            result: { output: message.output || '', error: message.exitCode != null && message.exitCode !== 0, sourceLine: record.index }
          };
          addBlock(item, call);
          addItem(trace, item);
          continue;
        }
        if (role === 'toolResult') {
          const result = {
            kind: 'tool-result',
            id: message.toolCallId || null,
            output: message.content,
            toolName: message.toolName || null,
            error: message.isError === true,
            sourceLine: record.index
          };
          if (!attachToolResult(registry, result)) {
            const item = makeItem('tool', record, { role: 'tool', label: message.toolName || 'Tool result' });
            addBlock(item, result);
            addItem(trace, item);
          }
          continue;
        }
        const kind = role === 'user' ? 'user'
          : (['system', 'custom', 'customMessage', 'custom_message', 'branchSummary', 'compactionSummary'].includes(role) ? 'event' : 'assistant');
        const item = makeItem(kind, record, {
          role,
          label: kind === 'event' ? (message.customType || role) : null,
          model: message.model || currentModel,
          provider: message.provider || currentProvider,
          usage: message.usage,
          timestamp: message.timestamp || value.timestamp
        });
        appendNormalizedBlocks(item, normalizedContentBlocks(message.content, record.index), registry);
        addItem(trace, item);
        continue;
      }

      if (value.type === 'bashExecution') {
        const item = makeItem('tool', record, { role: 'tool', label: 'bash' });
        const call = {
          kind: 'tool-call', id: `bash-${record.index}`, name: 'bash',
          input: { command: value.command || '' }, sourceLine: record.index,
          result: { output: value.output || '', error: value.exitCode != null && value.exitCode !== 0, sourceLine: record.index }
        };
        call.metadata = { exitCode: value.exitCode, cancelled: !!value.cancelled, truncated: !!value.truncated };
        addBlock(item, call);
        addItem(trace, item);
        continue;
      }

      if (value.type === 'compaction' || value.type === 'branch_summary') {
        const isCompaction = value.type === 'compaction';
        const item = makeItem('event', record, {
          role: 'system',
          label: isCompaction ? 'Context compacted' : 'Branch summary',
          metadata: { tokensBefore: value.tokensBefore, fromId: value.fromId }
        });
        addText(item, value.summary || '', record.index);
        addItem(trace, item);
        continue;
      }

      if (value.type === 'custom_message' && value.display !== false) {
        const item = makeItem('event', record, { role: 'custom', label: value.customType || 'Custom message' });
        appendNormalizedBlocks(item, normalizedContentBlocks(value.content, record.index), registry);
        addItem(trace, item);
      }
    }
    trace.model = currentModel || trace.model;
    return finishTrace(trace);
  }

  function codexPayload(record) {
    return isObject(record.value.payload) ? record.value.payload : {};
  }

  // Reasoning effort comes from the agent's own turn_context, and from
  // collaboration_mode.settings first: a subagent rollout can carry inherited
  // root state in the top-level `effort`, so that is only the fallback.
  // world_state and every other record is ignored on purpose — nothing here
  // is inferred from the model name, the filename or the parent trace.
  function codexEffort(payload) {
    if (!isObject(payload)) return null;
    const settings = isObject(payload.collaboration_mode) ? payload.collaboration_mode.settings : null;
    const own = isObject(settings) ? nonEmptyString(settings.reasoning_effort) : null;
    if (own) return own;
    return nonEmptyString(payload.effort) || nonEmptyString(payload.reasoning_effort);
  }

  function codexReasoningText(summary) {
    if (typeof summary === 'string') return summary;
    if (!Array.isArray(summary)) return contentText(summary);
    return summary.map((part) => {
      if (typeof part === 'string') return part;
      return part && (part.text || part.summary_text || part.summary || contentText(part.content));
    }).filter(Boolean).join('\n');
  }

  function addCodexTextItem(trace, record, text, options) {
    if (!text) return null;
    const opts = options || {};
    const item = makeItem(opts.kind || 'assistant', record, {
      role: opts.role || 'assistant',
      model: opts.model,
      provider: opts.provider,
      effort: opts.effort,
      timestamp: opts.timestamp || record.value.timestamp,
      label: opts.label,
      metadata: opts.metadata
    });
    addText(item, text, record.index, opts.blockKind || 'text');
    addItem(trace, item);
    return item;
  }

  function normalizeCodex(records, descriptor) {
    const headerRecord = firstRecord(records, (value) => value.type === 'session_meta');
    const headerPayload = headerRecord ? headerRecord.value.payload || {} : {};
    const trace = createTrace(descriptor, headerPayload);
    traceTitleFromHeader(trace, headerPayload);
    const codexInfo = codexTraceInfo(headerPayload);
    trace.threadSource = codexInfo.threadSource;
    trace.traceType = codexInfo.type;
    trace.parentThreadId = codexInfo.parentThreadId;
    trace.subagent = trace.traceType === 'subagent' ? codexSubagentInfo(headerPayload) : null;
    const registry = createRegistry();
    let currentModel = headerPayload.model || null;
    let currentProvider = headerPayload.model_provider || null;
    let currentEffort = null;
    let currentTurnId = null;
    let currentAssistant = null;
    // The trace-level effort is the last turn_context value seen; `efforts`
    // keeps every distinct value in order, since a session can change gears.
    trace.reasoningEffort = null;
    trace.efforts = [];

    function newUser(record, text) {
      const previous = trace.items[trace.items.length - 1];
      const previousText = previous && previous.kind === 'user'
        ? previous.blocks.filter((block) => block.kind === 'text').map((block) => block.text).join('\n').trim().toLowerCase()
        : '';
      if (previous && previous.kind === 'user' && previousText === String(text || '').trim().toLowerCase()) {
        if (!previous.sourceLines.includes(record.index)) previous.sourceLines.push(record.index);
        return previous;
      }
      currentAssistant = null;
      return addCodexTextItem(trace, record, text, { kind: 'user', role: 'user', model: null, provider: null });
    }

    function assistantFor(record, forceNew) {
      if (!forceNew && currentAssistant) return currentAssistant;
      currentAssistant = makeItem('assistant', record, { role: 'assistant', model: currentModel, provider: currentProvider, effort: currentEffort });
      addItem(trace, currentAssistant);
      return currentAssistant;
    }

    for (const record of records) {
      const value = record.value;
      const payload = codexPayload(record);
      const type = payload.type;

      if (value.type === 'session_meta') continue;
      if (value.type === 'turn_context') {
        currentModel = payload.model || currentModel;
        currentProvider = payload.model_provider || currentProvider;
        const effort = codexEffort(payload);
        if (effort) {
          currentEffort = effort;
          trace.reasoningEffort = effort;
          if (!trace.efforts.includes(effort)) trace.efforts.push(effort);
        }
        // Consecutive assistant output merges into one card, which would hide
        // a mid-session change of model or effort behind the first turn's
        // values. Start a new card when either actually changes; a session
        // that keeps one setting renders exactly as it did before.
        if (currentAssistant &&
            (currentAssistant.model !== currentModel || currentAssistant.effort !== currentEffort)) {
          currentAssistant = null;
        }
        if (payload.cwd) trace.cwd = payload.cwd;
        continue;
      }
      if (value.type === 'event_msg') {
        if (type === 'task_started') {
          currentTurnId = payload.turn_id || currentTurnId;
          continue;
        }
        if (type === 'user_message') {
          newUser(record, payload.message || payload.text || '');
          continue;
        }
        if (type === 'agent_message') {
          const text = payload.message || payload.text || '';
          const last = trace.items[trace.items.length - 1];
          const lastText = last && last.kind === 'assistant'
            ? last.blocks.filter((block) => block.kind === 'text').map((block) => block.text).join('\n').trim().toLowerCase()
            : '';
          if (last && last.kind === 'assistant' && lastText === String(text).trim().toLowerCase()) continue;
          currentAssistant = addCodexTextItem(trace, record, text, { kind: 'assistant', role: 'assistant', model: currentModel, provider: currentProvider, effort: currentEffort });
          continue;
        }
        if (type === 'token_count') {
          const info = payload.info || {};
          const usage = info.last_token_usage || info.total_token_usage || info;
          if (currentAssistant) usageToItem(currentAssistant, usage);
          continue;
        }
        if (type === 'task_complete' && currentAssistant) {
          currentAssistant.metadata.durationMs = payload.duration_ms;
          continue;
        }
        if (type === 'turn_aborted' || type === 'error') {
          const item = makeItem('event', record, { role: 'system', label: type === 'error' ? 'Error' : 'Turn aborted', metadata: payload });
          addText(item, payload.message || payload.reason || '', record.index);
          addItem(trace, item);
          continue;
        }
        // item_completed and other lifecycle records duplicate response_item
        // entries, so they are intentionally not rendered as a second card.
        continue;
      }

      if (value.type === 'response_item') {
        if (type === 'message') {
          const role = payload.role || 'assistant';
          if (role === 'developer' || role === 'system') continue;
          if (role === 'user') {
            const text = contentText(payload.content);
            if (text) newUser(record, text);
            continue;
          }
          if (role === 'assistant') {
            const blocks = normalizedContentBlocks(payload.content, record.index);
            const hasVisibleText = blocks.some((block) => block.kind === 'text');
            const forceNew = !!(currentAssistant && hasVisibleText && currentAssistant.blocks.some((block) => block.kind === 'tool-call'));
            const item = assistantFor(record, forceNew);
            appendNormalizedBlocks(item, blocks, registry);
            continue;
          }
        }

        if (type === 'reasoning') {
          const text = codexReasoningText(payload.summary);
          if (text) {
            const item = assistantFor(record, false);
            addText(item, text, record.index, 'thinking');
          }
          continue;
        }

        if (CODEX_CALL_TYPES.has(type)) {
          const item = assistantFor(record, false);
          const input = payload.arguments !== undefined ? parseJsonString(payload.arguments)
            : (payload.input !== undefined ? parseJsonString(payload.input)
              : (payload.command !== undefined ? { command: payload.command } : payload.action));
          const call = {
            kind: 'tool-call',
            id: payload.call_id || payload.callId || payload.id || null,
            name: payload.name || (type === 'local_shell_call' ? 'shell' : type.replace(/_call$/, '')),
            input,
            sourceLine: record.index
          };
          addBlock(item, call);
          registerToolCall(registry, call);
          continue;
        }

        if (CODEX_RESULT_TYPES.has(type)) {
          const result = {
            kind: 'tool-result',
            id: payload.call_id || payload.callId || payload.id || null,
            output: payload.output !== undefined ? payload.output : payload.result,
            error: payload.status === 'error',
            sourceLine: record.index
          };
          if (!attachToolResult(registry, result)) {
            const item = makeItem('tool', record, { role: 'tool', label: 'Tool result' });
            addBlock(item, result);
            addItem(trace, item);
          }
          continue;
        }
      }

      if (value.type === 'compacted') {
        const item = makeItem('event', record, { role: 'system', label: 'Context compacted' });
        addText(item, payload.message || value.message || '', record.index);
        addItem(trace, item);
      }
    }
    trace.model = currentModel || trace.model;
    trace.provider = currentProvider || null;
    return finishTrace(trace);
  }

  function normalizeClaude(records, descriptor) {
    const trace = createTrace(descriptor, null);
    const registry = createRegistry();
    let currentModel = null;
    let currentCwd = null;
    let sessionId = null;
    let aiTitle = null;

    for (const record of records) {
      const value = record.value;
      sessionId = sessionId || value.sessionId || value.session_id || null;
      currentCwd = currentCwd || value.cwd || null;
      if (value.type === 'ai-title') {
        aiTitle = value.aiTitle || aiTitle;
        continue;
      }
      if (value.type === 'assistant' && isObject(value.message)) {
        const message = value.message;
        currentModel = message.model || currentModel;
        const item = makeItem('assistant', record, {
          role: 'assistant', model: message.model || currentModel,
          usage: message.usage, timestamp: value.timestamp
        });
        appendNormalizedBlocks(item, normalizedContentBlocks(message.content, record.index), registry);
        addItem(trace, item);
        continue;
      }
      if (value.type === 'user' && isObject(value.message)) {
        const message = value.message;
        const blocks = normalizedContentBlocks(message.content, record.index);
        let visible = [];
        let hasToolResultBlock = false;
        for (const block of blocks) {
          if (block.kind === 'tool-result') {
            hasToolResultBlock = true;
            if (!attachToolResult(registry, block)) visible.push(block);
          } else visible.push(block);
        }
        // Some Claude versions put the tool result on the envelope rather
        // than in message.content.
        if (value.toolUseResult && value.sourceToolAssistantUUID && !hasToolResultBlock) {
          const result = {
            kind: 'tool-result', id: value.toolUseResult.toolCallId || value.toolUseId || null,
            output: value.toolUseResult, sourceLine: record.index
          };
          if (!attachToolResult(registry, result)) visible.push(result);
        }
        if (visible.length) {
          const item = makeItem('user', record, { role: 'user', timestamp: value.timestamp });
          visible.forEach((block) => addBlock(item, block));
          addItem(trace, item);
        }
        continue;
      }
      if (value.type === 'result' && (value.result || value.subtype)) {
        const item = makeItem('assistant', record, { role: 'assistant', model: currentModel, label: 'Result', usage: value.usage });
        addText(item, value.result || '', record.index);
        item.metadata.costUsd = value.total_cost_usd;
        addItem(trace, item);
        continue;
      }
      if (value.type === 'system' && value.content && value.subtype !== 'turn_duration') {
        const item = makeItem('event', record, { role: 'system', label: value.subtype || 'System' });
        addText(item, value.content, record.index);
        addItem(trace, item);
      }
      if (value.type === 'summary' && value.summary) {
        const item = makeItem('event', record, { role: 'system', label: 'Summary' });
        addText(item, value.summary, record.index);
        addItem(trace, item);
      }
    }
    trace.id = sessionId;
    trace.cwd = currentCwd;
    if (aiTitle) trace.title = aiTitle;
    return finishTrace(trace);
  }

  function normalize(lines, descriptorOrPath) {
    const records = asRecords(lines);
    if (!records.length) return null;
    const descriptor = typeof descriptorOrPath === 'string'
      ? detect(lines, descriptorOrPath)
      : (descriptorOrPath && descriptorOrPath.format ? descriptorOrPath : detect(lines));
    if (!descriptor) return null;
    if (descriptor.format === 'sts') return normalizeSts(records, descriptor);
    if (descriptor.format === 'pi') return normalizePi(records, descriptor);
    if (descriptor.format === 'codex') return normalizeCodex(records, descriptor);
    if (descriptor.format === 'claude') return normalizeClaude(records, descriptor);
    if (descriptor.format === 'hermes') return normalizeClaude(records, descriptor);
    return null;
  }

  function parse(lines, filePath) {
    const descriptor = detect(lines, filePath);
    return descriptor ? normalize(lines, descriptor) : null;
  }

  return {
    detect,
    normalize,
    parse,
    getTraceType,
    codexTraceInfo,
    linkTraces,
    normalizeUsage,
    normalizedContentBlocks,
    asTimestamp
  };
});
