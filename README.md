> [!WARNING]
> This project is deprecated. For a fast, modern flame graph explorer, check out [Speedscope](https://www.speedscope.app/).

# 🔥 flamebearer

A blazing fast [flame graph](http://www.brendangregg.com/flamegraphs.html) tool for Node and V8.
Used to visualize and explore performance profiling results.
Designed to produce fast, lightweight flame graphs that remain responsive even on really big input.

## [Example graph](https://mapbox.github.io/flamebearer/examples/rollup.html)

## Usage

Use the [online version](https://mapbox.github.io/flamebearer/), or the command line tool:

```bash
# install flamebearer (Node v8.5+ required)
$ npm install -g flamebearer

# profile your app
$ node --prof app.js

# generate flamegraph.html from a V8 log and open it in the browser
$ node --prof-process --preprocess -j isolate*.log | flamebearer
```

## Thanks

- [Brendan Gregg](http://brendangregg.com/) for creating the [concept](https://queue.acm.org/detail.cfm?id=2927301) and maintaining the [reference implementation](http://brendangregg.com/flamegraphs.html).
- [David Mark Clements](https://github.com/davidmarkclements) for creating [0x](https://github.com/davidmarkclements/0x) which inspired this project.
- [Bernard Cornwell](http://www.bernardcornwell.net/books/) for the amazing books this project took its name from.
