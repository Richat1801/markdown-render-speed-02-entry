// Driver for the markdown-render-speed-02 entry.
// Loads every scored case, renders each one with the local parse()
// (a fast drop-in for marked), and writes the HTML results back out
// in the same order the cases came in.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from './parse.js';

interface ScoredCase {
  id: string;
  markdown: string;
}

async function loadSuite(dir: string): Promise<ScoredCase[]> {
  const raw = await readFile(join(dir, 'cases.json'), 'utf8');
  return JSON.parse(raw) as ScoredCase[];
}

async function renderAll(suite: ScoredCase[]): Promise<string[]> {
  const rendered: string[] = new Array(suite.length);
  for (let i = 0; i < suite.length; i += 1) {
    rendered[i] = parse(suite[i].markdown);
  }
  return rendered;
}

async function main(): Promise<void> {
  const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const suite = await loadSuite(inDir);
  const rendered = await renderAll(suite);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'html.json'), JSON.stringify(rendered), 'utf8');
}

await main();
