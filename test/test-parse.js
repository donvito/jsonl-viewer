// Standalone test mirroring main.js file:read parsing logic
const fs = require('fs');
const path = require('path');

function readFile(filePath, maxLines = 5000) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(filePath);
    const name = path.basename(filePath);
    const parsedLines = [];
    const errors = [];
    let totalLines = 0;
    let leftover = '';
    let truncated = false;
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    stream.on('data', (chunk) => {
      leftover += chunk;
      let idx;
      while ((idx = leftover.indexOf('\n')) !== -1) {
        const raw = leftover.slice(0, idx).replace(/\r$/, '');
        leftover = leftover.slice(idx + 1);
        totalLines++;
        if (parsedLines.length < maxLines) {
          const trimmed = raw.trim();
          if (trimmed === '') continue;
          try {
            parsedLines.push({ index: totalLines - 1, raw: trimmed, value: JSON.parse(trimmed) });
          } catch (err) {
            parsedLines.push({ index: totalLines - 1, raw: trimmed, value: null, parseError: err.message });
            errors.push({ index: totalLines - 1, message: err.message });
          }
        } else { truncated = true; }
      }
    });
    stream.on('end', () => {
      if (leftover.trim() !== '') {
        totalLines++;
        const trimmed = leftover.trim();
        if (parsedLines.length < maxLines) {
          try { parsedLines.push({ index: totalLines - 1, raw: trimmed, value: JSON.parse(trimmed) }); }
          catch (err) { parsedLines.push({ index: totalLines - 1, raw: trimmed, value: null, parseError: err.message }); errors.push({ index: totalLines - 1, message: err.message }); }
        } else { truncated = true; }
      }
      resolve({ path: filePath, name, sizeBytes: stat.size, totalLines, parsedLines, errors, truncated });
    });
    stream.on('error', reject);
  });
}

(async () => {
  const file = path.join(__dirname, 'sample.jsonl');
  const data = await readFile(file);
  console.log('File:', data.name);
  console.log('Size:', data.sizeBytes, 'bytes');
  console.log('Total lines:', data.totalLines);
  console.log('Parsed entries:', data.parsedLines.length);
  console.log('Errors:', data.errors.length, '->', JSON.stringify(data.errors));
  console.log('Truncated:', data.truncated);
  console.log('---');
  data.parsedLines.forEach((l) => {
    if (l.parseError) {
      console.log(`#${l.index + 1} PARSE ERROR: ${l.parseError} | raw: ${l.raw}`);
    } else {
      console.log(`#${l.index + 1} ok -> ${JSON.stringify(l.value).slice(0, 80)}`);
    }
  });

  // Assertions
  const assert = (cond, msg) => { if (!cond) { console.error('ASSERT FAIL:', msg); process.exit(1); } };
  assert(data.totalLines === 11, 'expected 11 lines');
  assert(data.errors.length === 1, 'expected 1 parse error');
  assert(data.errors[0].index === 8, 'error should be on line 9 (0-indexed 8)');
  assert(data.parsedLines[0].value.id === 1, 'first entry id=1');
  assert(data.parsedLines[4].value.error.details === null, 'null nested value preserved');
  assert(!data.truncated, 'should not be truncated');
  console.log('\nAll assertions passed ✅');
})();
