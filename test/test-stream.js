/*
 * Streaming tail-read tests.
 *
 * Exercises src/jsonl-read.js the way the renderer uses it while an agent is
 * writing a session file: open, then repeatedly read only what was appended,
 * including a half-written last line, and recover when the file is rewritten.
 *
 * Run: node test/test-stream.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJsonlFile, readJsonlTail } = require('../src/jsonl-read.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-stream-'));
const file = path.join(dir, 'session.jsonl');
const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });

const line = (obj) => JSON.stringify(obj) + '\n';

// A reader mirroring what the renderer keeps: the lines it holds plus how far
// into the file it has consumed.
function makeReader(lines, read) {
  return {
    lines: lines.slice(),
    offset: read.readOffset,
    index: read.readIndex,
    async pull() {
      const res = await readJsonlTail(file, this.offset, this.index);
      if (res.reset) return res;
      if (res.lines.length) {
        const from = res.lines[0].index;
        this.lines = this.lines.filter((l) => l.index < from).concat(res.lines);
      }
      this.offset = res.readOffset;
      this.index = res.readIndex;
      return res;
    }
  };
}

async function main() {
  fs.writeFileSync(file, line({ type: 'session', id: 's1' }) + line({ type: 'message', n: 1 }));
  const first = await readJsonlFile(file);
  assert.strictEqual(first.parsedLines.length, 2, 'initial read sees both lines');
  assert.strictEqual(first.readIndex, 2, 'readIndex is past both lines');
  assert.strictEqual(first.readOffset, fs.statSync(file).size, 'readOffset is the whole file');

  const reader = makeReader(first.parsedLines, first);

  // Nothing appended yet.
  let res = await reader.pull();
  assert.strictEqual(res.lines.length, 0, 'no new lines when the file is unchanged');
  assert.strictEqual(reader.lines.length, 2, 'held lines are untouched');

  // Two appended lines arrive without re-reading the start of the file.
  fs.appendFileSync(file, line({ type: 'message', n: 2 }) + line({ type: 'message', n: 3 }));
  res = await reader.pull();
  assert.strictEqual(res.lines.length, 2, 'tail read returns only the appended lines');
  assert.deepStrictEqual(res.lines.map((l) => l.index), [2, 3], 'appended lines keep absolute indexes');
  assert.strictEqual(reader.lines.length, 4);
  assert.strictEqual(res.totalLines, 4);

  // A half-written line: shown now, replaced once it is complete.
  const partial = '{"type":"message","n":4,"text":"half';
  fs.appendFileSync(file, partial);
  res = await reader.pull();
  assert.strictEqual(res.lines.length, 1, 'the partial line is returned for display');
  assert.ok(res.lines[0].parseError, 'the partial line is flagged as unparseable');
  assert.strictEqual(res.readIndex, 4, 'readIndex stays before the partial line');
  assert.strictEqual(reader.lines.length, 5);

  fs.appendFileSync(file, '","done":true}\n');
  res = await reader.pull();
  assert.strictEqual(res.lines.length, 1, 'the finished line comes back once');
  assert.strictEqual(res.lines[0].index, 4, 'it reuses the partial line\'s index');
  assert.ok(!res.lines[0].parseError, 'the finished line parses');
  assert.strictEqual(reader.lines.length, 5, 'the partial line was replaced, not duplicated');
  assert.strictEqual(reader.lines[4].value.done, true);
  assert.deepStrictEqual(reader.lines.map((l) => l.index), [0, 1, 2, 3, 4]);

  // Multi-byte content: byte offsets must not drift from character counts.
  fs.appendFileSync(file, line({ type: 'message', text: 'café → 日本語 🎉' }));
  res = await reader.pull();
  assert.strictEqual(res.lines.length, 1);
  assert.strictEqual(res.lines[0].value.text, 'café → 日本語 🎉');
  assert.strictEqual(reader.offset, fs.statSync(file).size, 'offset tracks bytes, not characters');

  fs.appendFileSync(file, line({ type: 'message', n: 6 }));
  res = await reader.pull();
  assert.strictEqual(res.lines.length, 1, 'reads stay aligned after multi-byte content');
  assert.strictEqual(res.lines[0].value.n, 6);

  // Blank lines are consumed but not shown, and do not shift later indexes.
  fs.appendFileSync(file, '\n' + line({ type: 'message', n: 7 }));
  res = await reader.pull();
  assert.strictEqual(res.lines.length, 1, 'the blank line is skipped');
  assert.strictEqual(res.lines[0].index, 8, 'the blank line still occupies its index');

  // A rewritten (shorter) file asks the caller for a full reload.
  fs.writeFileSync(file, line({ type: 'session', id: 's2' }));
  res = await readJsonlTail(file, reader.offset, reader.index);
  assert.strictEqual(res.reset, true, 'a shrunken file reports reset');
  assert.strictEqual(res.readOffset, 0);

  // Reading from a fresh full read of the rewritten file works again.
  const second = await readJsonlFile(file);
  const reader2 = makeReader(second.parsedLines, second);
  fs.appendFileSync(file, line({ type: 'message', n: 1 }));
  res = await reader2.pull();
  assert.strictEqual(res.lines.length, 1);
  assert.strictEqual(reader2.lines.length, 2);

  // A file that ends without a newline: the full read shows the line but
  // leaves the offset before it, so a later append replaces it cleanly.
  const noNewline = path.join(dir, 'tail.jsonl');
  fs.writeFileSync(noNewline, line({ a: 1 }) + '{"a":2}');
  const third = await readJsonlFile(noNewline);
  assert.strictEqual(third.parsedLines.length, 2);
  assert.strictEqual(third.readIndex, 1, 'the newline-less last line is not consumed');
  const res3 = await readJsonlTail(noNewline, third.readOffset, third.readIndex);
  assert.strictEqual(res3.lines.length, 1);
  assert.strictEqual(res3.lines[0].index, 1, 'it is offered again under the same index');

  console.log('test-stream: all assertions passed');
}

main().then(cleanup, (err) => {
  cleanup();
  console.error(err);
  process.exit(1);
});
