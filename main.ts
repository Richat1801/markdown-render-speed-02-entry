// Driver for the markdown-render-speed-02 entry.
//
// Reads the scored cases, renders each one with the local parse()
// (./parse.js, a dependency-free drop-in for marked 18.1.3), and writes
// the rendered HTML strings, in the cases' order, as a JSON array.
//
// Input : <input dir>/cases.json — [{ "id": string, "markdown": string }, ...]
// Output: <output dir>/html.json — [ "<html>", ... ], one per case, same order.
//
// The harness mounts the case set at /input and expects /output; when it
// runs the entry outside a container it points at the same two directories
// through MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR instead. Those two paths
// are the only environment the driver consults, and only to locate its
// input and output. Nothing else varies run to run: no network, no clock,
// no randomness — the same cases always produce the same html.json.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from './parse.js';

const sourceDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const targetDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const rawCases = await readFile(join(sourceDir, 'cases.json'), 'utf8');
const workload = JSON.parse(rawCases) as Array<{ id: string; markdown: string }>;

const rendered: string[] = new Array(workload.length);
for (let slot = 0; slot < workload.length; slot += 1) {
  rendered[slot] = parse(workload[slot].markdown);
}

await mkdir(targetDir, { recursive: true });
await writeFile(join(targetDir, 'html.json'), JSON.stringify(rendered));
