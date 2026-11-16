# markdown-render-speed-02-entry

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Richat1801/markdown-render-speed-02-entry/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Richat1801/markdown-render-speed-02-entry/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free, fast drop-in replacement for [marked](https://github.com/markedjs/marked) 18.1.3's default rendering (GFM on), built for the [markdown-render-speed-02 bounty](https://make.fun/bounty/markdown-render-speed-02) on [make.fun](https://make.fun).

`parse.js` exports `parse(markdown)`, which returns exactly the HTML that marked 18.1.3 renders with its default options — every CommonMark 0.31.2 and GFM 0.29 example, plus the generated documents — only faster. `main.ts` is the harness driver: it reads `/input/cases.json`, renders each case alone with `parse()`, and writes `/output/html.json`.

## Run

```sh
node main.ts
```

Grade it locally with the kit CLI:

```sh
makefun grade-local --kit <kit> --bot <this repository> --driver process
```

## License

MIT — see [LICENSE](LICENSE).
