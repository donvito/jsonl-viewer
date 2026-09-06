/*
 * JSONL reading for the main process.
 *
 * Two entry points, both returning lines tagged with their absolute line
 * index: a full read for opening a file, and a tail read that consumes only
 * the bytes appended since a previous read. The tail read is what makes a
 * session file an agent is still writing cheap to follow — see the streaming
 * notes in renderer.js.
 *
 * Dependency-free apart from node builtins so the test suite can exercise it
 * without launching Electron.
 */
const fs = require('fs');
const path = require('path');

// ---- Line parsing shared by the full read and the streaming tail read ----
// Parsed lines carry their absolute line index so a tail read can splice
// cleanly onto what the renderer already holds.
function parseJsonlLine(raw, index) {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    return { index, raw: trimmed, value: JSON.parse(trimmed) };
  } catch (err) {
    return { index, raw: trimmed, value: null, parseError: err.message };
  }
}

function readJsonlFile(filePath, maxLines = 5000) {
  return new Promise((resolve, reject) => {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      reject(err);
      return;
    }
    const name = path.basename(filePath);

    const parsedLines = [];
    const errors = [];
    let totalLines = 0;
    let leftover = '';
    let truncated = false;
    // Byte offset and line index just past the last line we actually parsed.
    // A follow-up tail read resumes from here, so they stop advancing once
    // maxLines is hit and never cover a trailing line without a newline.
    let readOffset = 0;
    let readIndex = 0;

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });

    stream.on('data', (chunk) => {
      leftover += chunk;
      let idx;
      while ((idx = leftover.indexOf('\n')) !== -1) {
        const consumed = leftover.slice(0, idx + 1);
        leftover = leftover.slice(idx + 1);
        const raw = consumed.slice(0, -1).replace(/\r$/, '');
        const index = totalLines;
        totalLines++;
        if (parsedLines.length >= maxLines) {
          truncated = true;
          continue;
        }
        readOffset += Buffer.byteLength(consumed, 'utf8');
        readIndex = index + 1;
        const line = parseJsonlLine(raw, index);
        if (!line) continue;
        parsedLines.push(line);
        if (line.parseError) errors.push({ index, message: line.parseError });
      }
    });

    stream.on('end', () => {
      // Handle trailing line without newline. A live agent session is often
      // mid-write here, so readOffset/readIndex deliberately stay behind it:
      // the next tail read re-reads the line once it is complete.
      if (leftover.trim() !== '') {
        const index = totalLines;
        totalLines++;
        if (parsedLines.length < maxLines) {
          const line = parseJsonlLine(leftover, index);
          if (line) {
            parsedLines.push(line);
            if (line.parseError) errors.push({ index, message: line.parseError });
          }
        } else {
          truncated = true;
        }
      }
      resolve({
        path: filePath,
        name,
        sizeBytes: stat.size,
        totalLines,
        parsedLines,
        errors,
        truncated,
        maxLines,
        readOffset,
        readIndex
      });
    });

    stream.on('error', (err) => reject(err));
  });
}

// ---- Streaming tail read ----
// Reads only the bytes appended since `fromByte`, returning lines numbered
// from `fromIndex`. Returns reset:true when the file shrank (truncated,
// rotated, or rewritten), which tells the renderer to do a full reload.
function readJsonlTail(filePath, fromByte, fromIndex, maxLines = 20000) {
  return new Promise((resolve, reject) => {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      reject(err);
      return;
    }
    const start = Number.isFinite(fromByte) && fromByte > 0 ? fromByte : 0;
    const baseIndex = Number.isFinite(fromIndex) && fromIndex > 0 ? fromIndex : 0;
    const done = (extra) => resolve(Object.assign({
      path: filePath,
      sizeBytes: stat.size,
      lines: [],
      errors: [],
      readOffset: start,
      readIndex: baseIndex,
      totalLines: baseIndex,
      truncated: false,
      reset: false
    }, extra));

    if (stat.size < start) {
      done({ reset: true, readOffset: 0, readIndex: 0, totalLines: 0 });
      return;
    }
    if (stat.size === start) {
      done({});
      return;
    }

    const lines = [];
    const errors = [];
    let leftover = '';
    let readOffset = start;
    let index = baseIndex;
    let truncated = false;

    const stream = fs.createReadStream(filePath, { encoding: 'utf8', start });

    stream.on('data', (chunk) => {
      leftover += chunk;
      let idx;
      while ((idx = leftover.indexOf('\n')) !== -1) {
        const consumed = leftover.slice(0, idx + 1);
        leftover = leftover.slice(idx + 1);
        if (lines.length >= maxLines) {
          truncated = true;
          continue;
        }
        const raw = consumed.slice(0, -1).replace(/\r$/, '');
        readOffset += Buffer.byteLength(consumed, 'utf8');
        const lineIndex = index++;
        const line = parseJsonlLine(raw, lineIndex);
        if (!line) continue;
        lines.push(line);
        if (line.parseError) errors.push({ index: lineIndex, message: line.parseError });
      }
      if (truncated) stream.destroy();
    });

    const finish = (includePartial) => {
      let totalLines = index;
      // The tail of a file being written to is usually a half-written line.
      // Include it for display but leave readOffset/readIndex pointing at its
      // start so the next read replaces it with the finished line.
      if (includePartial && leftover.trim() !== '' && !truncated) {
        const line = parseJsonlLine(leftover, index);
        if (line) {
          lines.push(line);
          if (line.parseError) errors.push({ index, message: line.parseError });
        }
        totalLines = index + 1;
      }
      resolve({
        path: filePath,
        sizeBytes: stat.size,
        lines,
        errors,
        readOffset,
        readIndex: index,
        totalLines,
        truncated,
        reset: false
      });
    };

    stream.on('end', () => finish(true));
    stream.on('close', () => { if (truncated) finish(false); });
    stream.on('error', (err) => reject(err));
  });
}

module.exports = { parseJsonlLine, readJsonlFile, readJsonlTail };
