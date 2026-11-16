// Driver for the markdown-render-speed-02 entry.
//
// The harness runs `node /bot/main.ts` on Node 22. It reads the case
// list from the input directory, renders every case on its own with the
// parse() in ./parse.js, and writes the HTML strings, in the cases'
// order, to the output directory. Outside the grading container the
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR variables stand in for
// /input and /output. Nothing here reads the clock or the network, and
// the output is a pure function of the input file.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from './parse.js';

type CaseRow = { id: string; markdown: string };

async function runAll(): Promise<void> {
  const sourceDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const targetDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const encoded = await readFile(join(sourceDir, 'cases.json'), 'utf8');
  const rows = JSON.parse(encoded) as CaseRow[];
  const rendered: string[] = new Array(rows.length);
  for (let k = 0; k < rows.length; k += 1) {
    rendered[k] = parse(rows[k].markdown);
  }
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, 'html.json'), JSON.stringify(rendered));
}

runAll();
