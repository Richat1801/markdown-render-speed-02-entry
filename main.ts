// Entry driver for markdown-render-speed-02.
//
// Reads the graded cases, renders each one on its own through the fast
// parse() in ./parse.js, and writes the HTML strings out in case order.
// The harness invokes this file as `node main.ts` (Node 22 strips the
// types natively); outside the grading container the input and output
// directories can be overridden with MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR, which default to /input and /output.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from './parse.js';

interface RenderCase {
  id: string;
  markdown: string;
}

async function runDriver(): Promise<void> {
  const sourceDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const targetDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

  const encoded = await readFile(join(sourceDir, 'cases.json'), 'utf8');
  const suite = JSON.parse(encoded) as RenderCase[];

  const renderedHtml: string[] = new Array<string>(suite.length);
  for (let index = 0; index < suite.length; index++) {
    renderedHtml[index] = parse(suite[index].markdown);
  }

  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, 'html.json'), JSON.stringify(renderedHtml));
}

runDriver().catch((failure: unknown) => {
  console.error(failure);
  process.exitCode = 1;
});
