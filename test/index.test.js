import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseInput, parseTrace, parseCpuProfile, buildShortener, formatReport} from '../index.js';

const tinyCpuProfile = {
    nodes: [
        {id: 1, callFrame: {functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1}},
        {id: 2, callFrame: {functionName: '(idle)', url: '', lineNumber: -1, columnNumber: -1}},
        {id: 3, callFrame: {functionName: 'foo', url: 'file:///app/a.js', lineNumber: 10, columnNumber: 0}},
        {id: 4, callFrame: {functionName: 'bar', url: 'file:///app/b.js', lineNumber: 20, columnNumber: 0}}
    ],
    samples: [3, 3, 4, 2, 3],
    timeDeltas: [1000, 2000, 3000, 500, 1000],
    startTime: 0,
    endTime: 7500
};

test('parseInput dispatches by payload shape', () => {
    const cpuBuf = Buffer.from(JSON.stringify(tinyCpuProfile));
    const r = parseInput(cpuBuf, 'foo.cpuprofile');
    assert.equal(r.source, 'cpuprofile');
    assert.equal(r.threads.length, 1);
    assert.equal(r.threads[0].name, 'foo');

    const traceBuf = Buffer.from(JSON.stringify({traceEvents: []}));
    const r2 = parseInput(traceBuf, 'x.json');
    assert.equal(r2.source, 'chrome');
});

test('parseCpuProfile aggregates self time and splits idle', () => {
    const t = parseCpuProfile(tinyCpuProfile, 'name');
    assert.equal(t.name, 'name');
    assert.equal(t.idle, 500); // sample 4 is (idle), dt 500
    assert.equal(t.busy, 1000 + 2000 + 3000 + 1000);
    const foo = t.top.find(e => e.frame.functionName === 'foo');
    const bar = t.top.find(e => e.frame.functionName === 'bar');
    assert.equal(foo.time, 1000 + 2000 + 1000);
    assert.equal(bar.time, 3000);
    assert.equal(t.top[0].frame.functionName, 'foo'); // sorted desc
});

test('parseTrace links Profile + ProfileChunk and finds long tasks', () => {
    const events = [
        {name: 'thread_name', pid: 1, tid: 2, args: {name: 'Main'}},
        {name: 'Profile', id: '0xp', pid: 1, tid: 2, args: {data: {startTime: 0}}},
        {name: 'ProfileChunk', id: '0xp', pid: 1, tid: 2, args: {data: {
            cpuProfile: {
                nodes: [
                    {id: 1, callFrame: {functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1}},
                    {id: 2, callFrame: {functionName: 'hot', url: 'a.js', lineNumber: 0, columnNumber: 0}}
                ],
                samples: [2, 2, 2]
            },
            timeDeltas: [10000, 20000, 30000]
        }}},
        {ph: 'X', name: 'RunTask', pid: 1, tid: 2, ts: 0, dur: 60000, cat: 'devtools.timeline'},
        {ph: 'X', name: 'V8.GC_SCAVENGER', pid: 1, tid: 2, ts: 5000, dur: 1000, cat: 'v8'}
    ];
    const r = parseTrace({traceEvents: events});
    assert.equal(r.threads.length, 1);
    const t = r.threads[0];
    assert.equal(t.name, 'Main');
    assert.equal(t.longTasks.length, 1);
    assert.equal(t.longTasks[0].dominant.functionName, 'hot');
    const gc = t.breakdown.find(b => b.category === 'gc');
    assert.ok(gc && gc.time === 1000);
});

test('buildShortener picks dominant origin and tags others', () => {
    const counts = new Map([
        ['https://main.example.com/a/x.js', 5],
        ['https://main.example.com/a/y.js', 5],
        ['https://other.example.com/z.js', 1]
    ]);
    const {shorten, sources} = buildShortener(counts);
    assert.equal(shorten('https://main.example.com/a/x.js'), 'x.js');
    assert.equal(shorten('https://other.example.com/z.js'), '[other.example.com] z.js');
    assert.ok(sources.some(s => s.tag === '' && s.prefix === 'https://main.example.com/a/'));
    assert.ok(sources.some(s => s.tag === 'other.example.com'));
});

test('buildShortener handles file:// (empty host)', () => {
    const counts = new Map([
        ['file:///Users/x/proj/a.js', 3],
        ['file:///Users/x/proj/b.js', 3]
    ]);
    const {shorten} = buildShortener(counts);
    assert.equal(shorten('file:///Users/x/proj/a.js'), 'a.js');
});

test('buildShortener tags chrome-extension with truncated id', () => {
    const counts = new Map([
        ['https://page.example.com/a.js', 10],
        ['chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/inline/injected.js', 2]
    ]);
    const {shorten} = buildShortener(counts);
    assert.match(shorten('chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/inline/injected.js'), /^\[ext:aeblfd\]/);
});

test('formatReport runs on both fixture types and includes key sections', () => {
    const cpuBuf = fs.readFileSync('test/fixtures/CPU.20260521.185552.92535.0.001.cpuprofile');
    const traceBuf = fs.readFileSync('test/fixtures/Trace-20260521T190407.json.gz');

    const cpuReport = formatReport(parseInput(cpuBuf, 'test/fixtures/CPU.20260521.185552.92535.0.001.cpuprofile'));
    assert.match(cpuReport, /Top CPU \(self time\):/);

    const traceReport = formatReport(parseInput(traceBuf, 'test/fixtures/Trace-20260521T190407.json.gz'));
    assert.match(traceReport, /=== CrRendererMain ===/);
    assert.match(traceReport, /Top CPU \(self time\):/);
});
