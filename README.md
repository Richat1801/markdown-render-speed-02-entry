# markdown-render-speed-02 — a faster drop-in for marked

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Richat1801/markdown-render-speed-02-entry/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Richat1801/markdown-render-speed-02-entry/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A faster drop-in replacement for [marked](https://github.com/markedjs/marked)
18.1.3, built for the [make.fun bounty](https://make.fun/bounty/markdown-render-speed-02).
`parse.js` renders exactly the HTML `marked.parse` returns with marked's
default options (GFM on, breaks off), for every input, while using less
CPU. `main.ts` is the program the harness runs: it reads every case from
`/input/cases.json`, renders each one alone with `parse`, and writes the
HTML strings, in order, to `/output/html.json`.

## Layout

- `parse.js` — dependency-free ES module exporting `parse(markdown)`.
  A single-pass block parser plus an inline parser, written from scratch
  against marked's observable output (CommonMark 0.31.2 and GFM 0.29).
  It keeps nothing from one call to the next.
- `main.ts` — the driver described above; Node 22 built-ins only.

## Run locally

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

## License

MIT — see [LICENSE](LICENSE).
