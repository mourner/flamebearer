# 🔥 flamebearer

A JavaScript CPU trace analysis tool for agents and humans. Designed for performance optimization loops.

Reads Chrome DevTools Performance recordings (`.json` / `.json.gz`) and Node `.cpuprofile` files,
and prints a compact, structured text summary — top CPU offenders, hot source lines, long tasks, with a way to drill down further.
No HTML, no GUI: [Speedscope](https://www.speedscope.app/) already nails that.

## Usage

```bash
npm install -g flamebearer

flamebearer-node bench.js    # profile a script

flamebearer profile.json.gz  # summarize a Chrome DevTools trace
flamebearer CPU.*.cpuprofile # summarize node --cpu-prof trace (one or more files or a folder)
```

With no flags, you get a one-page summary per thread — the answer to “what should I look at in this trace”.

<details>
<summary><b>Sample output</b></summary>

```
Sources:
 file:///Users/mourner/projects/supercluster/

=== CPU.20260521.160113.74872.0.001 ===
samples: 4277  busy: 5309.5 ms (99.9%)  idle: 6.2 ms

Heaviest stacks: (% of thread busy)
  83.6%  run → (anonymous) → load
  63.2%    _cluster → withinInto
  10.0%      sqDist
  18.1%    _createTree → finish → sort
  16.4%      sort → sort → sort
  13.6%        sort

Top CPU (self time):
 2511.9 ms  47.3%  withinInto  node_modules/kdbush/index.js:207
  815.5 ms  15.3%  (garbage collector)
  778.6 ms  14.6%  select  node_modules/kdbush/index.js:289
  531.6 ms  10.0%  sqDist  node_modules/kdbush/index.js:358
  316.8 ms   6.0%  _cluster  index.js:304
  109.2 ms   2.1%  swap  node_modules/kdbush/index.js:346
   48.3 ms   0.9%  (anonymous)  bench.js:1
   36.9 ms   0.7%  compileForInternalLoader  node:internal/bootstrap/realm:383
   35.7 ms   0.7%  swapItem  node_modules/kdbush/index.js:335
   29.9 ms   0.6%  latY  index.js:451
   27.1 ms   0.5%  load  index.js:44

Hot lines (self time): (per source line; includes inlined code)
 711.3 ms  13.4%  node_modules/kdbush/index.js:241  withinInto
 710.1 ms  13.4%  node_modules/kdbush/index.js:227  withinInto
 373.0 ms   7.0%  node_modules/kdbush/index.js:315  select
 331.0 ms   6.2%  node_modules/kdbush/index.js:226  withinInto
 311.1 ms   5.9%  node_modules/kdbush/index.js:314  select
 310.6 ms   5.8%  node_modules/kdbush/index.js:360  sqDist
 279.2 ms   5.3%  node_modules/kdbush/index.js:244  withinInto
 109.8 ms   2.1%  node_modules/kdbush/index.js:359  sqDist
 109.8 ms   2.1%  node_modules/kdbush/index.js:361  sqDist
  84.4 ms   1.6%  index.js:379  _cluster
```

</details>

### Drilling down

```bash
flamebearer trace.json --stacks load            # summary for a specific function
flamebearer trace.json --thread main --top 30   # restrict threads, more rows
flamebearer trace.json --from 1200 --to 1800    # slice a time range (ms)

flamebearer-node bench.js arg1 -- --stacks load # pass drilldown flags to the Node wrapper
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
