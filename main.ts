// Driver for the markdown-render-speed-02 entry (node 22+, no deps).
// Reads the graded cases, renders each one on its own with the fast
// parse() in ./parse.js, and writes the HTML strings back out in the
// same order. Paths come from the harness contract: /input and /output
// inside the container, or MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR when
// grading locally outside one.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

async function loadCases(dir: string): Promise<Case[]> {
  const raw = await readFile(join(dir, 'cases.json'), 'utf8');
  const decoded: unknown = JSON.parse(raw);
  if (!Array.isArray(decoded)) throw new Error('cases.json is not an array');
  return decoded as Case[];
}

async function run(): Promise<void> {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const cases = await loadCases(inputDir);
  const rendered: string[] = new Array(cases.length);
  for (let k = 0; k < cases.length; k++) {
    rendered[k] = parse(cases[k].markdown);
  }
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'html.json'), JSON.stringify(rendered));
}

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
