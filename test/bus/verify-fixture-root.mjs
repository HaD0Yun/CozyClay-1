// SSR fixtures must resolve /src/... against the repo, not the caller's cwd (#860).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixtures = ['history-owners', 'stage-fixture', 'objects-fixture', 'project-fixture', 'shots-hook', 'cast-fixture', 'motion-fixture'];
const cwd = fileURLToPath(new URL('../../mcp/', import.meta.url));
const script = fixtures.map(name => `await import(${JSON.stringify(new URL(`./${name}.mjs`, import.meta.url).href)});`).join('\n');
const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd, encoding: 'utf8', timeout: 120_000 });
assert.equal(run.status, 0, `fixtures failed to load from ${cwd}:\n${run.stderr}`);
console.log(`PASS verify-fixture-root: ${fixtures.length} SSR fixtures load from mcp/`);
