# markdown-render-speed-02-entry

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Richat1801/markdown-render-speed-02-entry/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Richat1801/markdown-render-speed-02-entry/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A from-scratch CommonMark + GFM renderer in a single dependency-free file (`parse.js`), byte-identical to marked 18.1.3 on the practice set (720/720 cases) and faster than marked itself. `main.ts` reads `/input/cases.json` and writes `/output/html.json`.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

`main.ts` is a plain Node 22 driver (no build step): it reads the cases, renders each one alone with `parse()` from `parse.js`, and writes the HTML strings in order. Without the environment variables it defaults to `/input` and `/output`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
