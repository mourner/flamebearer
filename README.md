# 🔥 flamebearer

A CLI that summarizes performance traces for AI agents and humans. Reads Chrome DevTools Performance recordings (`.json` / `.json.gz`) and Node `.cpuprofile` files, and prints a compact, structured text report — top CPU offenders per thread, long tasks, category breakdown — designed to fit in an LLM's context window in one shot.

No HTML, no GUI: [Speedscope](https://www.speedscope.app/) already nails that.

## Usage

```bash
npm install -g flamebearer

# Chrome DevTools trace
flamebearer profile.json.gz

# Node CPU profile (single, multiple, or a folder with profiles)
node --cpu-prof app.js
flamebearer CPU.*.cpuprofile
```

## Note on v1

This project used to be about generating an HTML flamegraph for Node traces, but then lay dormant since 2018. In 2026, it was revived with a new purpose: to be a useful CLI tool in the age of AI.

## Thanks

- [Brendan Gregg](http://brendangregg.com/) for creating the [flamegraph concept](https://queue.acm.org/detail.cfm?id=2927301) and maintaining the [reference implementation](http://brendangregg.com/flamegraphs.html).
- [David Mark Clements](https://github.com/davidmarkclements) for creating [0x](https://github.com/davidmarkclements/0x) which originally inspired this project.
- [Bernard Cornwell](http://www.bernardcornwell.net/books/) for the amazing books this project took its name from.
