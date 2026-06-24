# 🔥 flamebearer

A CLI that summarizes performance traces for AI agents and humans, designed for JavaScript performance optimization loops.

Reads Chrome DevTools Performance recordings (`.json` / `.json.gz`) and Node `.cpuprofile` files,
and prints a compact, structured text summary — top CPU offenders, hot source lines, long tasks, with a way to drill down further.

No HTML, no GUI: [Speedscope](https://www.speedscope.app/) already nails that.

## Usage

```bash
npm install -g flamebearer

# Profile a Node script in one step (wraps `node --cpu-prof`)
flamebearer-node bench.js
flamebearer-node bench.js arg1 arg2 -- --top 30 --thread main

# Summarize a Chrome DevTools trace (.json / .json.gz)
flamebearer profile.json.gz

# Summarize a Node CPU profile (one or more files or a folder)
node --cpu-prof app.js
flamebearer CPU.*.cpuprofile
```

With no flags you get a one-page summary per thread — the answer to "what
should I look at in this trace" most of the time.

### Drilling down

```bash
flamebearer trace.json --stacks parseConfig   # callers, callees, hot paths, and hot lines for one function
flamebearer trace.json --thread main --top 30 # restrict threads, more rows
flamebearer trace.json --from 1200 --to 1800  # slice a time range (ms)
```

Run `flamebearer --help` for the full flag list.

### Source maps

Minified frames are de-minified automatically when source maps are available
(sibling `.map` files, inline maps, or maps embedded in a Chrome trace). Pass
`--no-sourcemap` to skip it.

## Note on v1

This project used to be about generating an HTML flamegraph for Node traces, but then lay dormant since 2018. In 2026, it was revived with a new purpose: to be a useful CLI tool in the age of AI.

## Thanks

- [Brendan Gregg](http://brendangregg.com/) for creating the [flamegraph concept](https://queue.acm.org/detail.cfm?id=2927301) and maintaining the [reference implementation](http://brendangregg.com/flamegraphs.html).
- [David Mark Clements](https://github.com/davidmarkclements) for creating [0x](https://github.com/davidmarkclements/0x) which originally inspired this project.
- [Bernard Cornwell](http://www.bernardcornwell.net/books/) for the amazing books this project took its name from.
