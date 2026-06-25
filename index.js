import zlib from 'node:zlib';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {TraceMap, originalPositionFor} from '@jridgewell/trace-mapping';

export function parseInput(buf, filename) {
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    const data = JSON.parse(buf.toString('utf8'));
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.cpuprofile' || (data.nodes && data.samples && !data.traceEvents)) {
        const name = path.basename(filename).replace(/\.cpuprofile$/, '');
        return {source: 'cpuprofile', threads: [parseCpuProfile(data, name)]};
    }
    return parseTrace(data);
}

export function mergeTraces(traces) {
    return {
        source: traces.length === 1 ? traces[0].source : 'mixed',
        threads: traces.flatMap(t => t.threads),
        embeddedMaps: new Map(traces.flatMap(t => [...t.embeddedMaps ?? []]))
    };
}

export function parseTrace(data) {
    const events = data.traceEvents || data;
    const embeddedMaps = new Map();
    for (const sm of data.metadata?.sourceMaps ?? []) {
        if (sm.url && sm.sourceMap?.mappings) {
            embeddedMaps.set(sm.url, new TraceMap(sm.sourceMap, sm.sourceMapUrl ?? sm.url));
        }
    }

    const threadNames = new Map();
    const profiles = new Map();
    const mainEventsByThread = new Map();

    for (const e of events) {
        if (e.name === 'thread_name') {
            threadNames.set(`${e.pid}:${e.tid}`, e.args.name);

        } else if (e.name === 'Profile') {
            profiles.set(e.id, {
                key: `${e.pid}:${e.tid}`,
                startTime: e.args.data.startTime,
                nodes: new Map(),
                samples: [],
                timeDeltas: []
            });

        } else if (e.name === 'ProfileChunk') {
            const p = profiles.get(e.id);
            if (!p) continue;
            const {cpuProfile, timeDeltas} = e.args.data;
            for (const n of cpuProfile?.nodes ?? []) p.nodes.set(n.id, n);
            for (const s of cpuProfile?.samples ?? []) p.samples.push(s);
            for (const d of timeDeltas ?? []) p.timeDeltas.push(d);

        } else if (e.ph === 'X' && e.dur > 0) {
            const key = `${e.pid}:${e.tid}`;
            const list = mainEventsByThread.get(key);
            if (list) list.push(e);
            else mainEventsByThread.set(key, [e]);
        }
    }

    const threads = [];
    for (const p of profiles.values()) {
        const t = buildThread({
            nodes: p.nodes,
            samples: p.samples,
            timeDeltas: p.timeDeltas,
            startTime: p.startTime
        }, threadNames.get(p.key) || p.key);

        const events = mainEventsByThread.get(p.key);
        if (events) {
            t.events = events;
            t.longTasks = findLongTasks(events, t);
            t.breakdown = computeBreakdown(events, t.busy + t.idle);
        }
        threads.push(t);
    }
    return {source: 'chrome', threads, embeddedMaps};
}

export function parseCpuProfile(data, name) {
    const nodes = new Map();
    for (const n of data.nodes) nodes.set(n.id, n);
    return buildThread({
        nodes,
        samples: data.samples,
        timeDeltas: data.timeDeltas,
        startTime: data.startTime
    }, name);
}

const IDLE_SAMPLE_NAMES = new Set(['(idle)', '(program)']);

function buildThread({nodes, samples, timeDeltas, startTime}, name) {
    const sampleTimes = new Array(samples.length);
    const sampleFrames = new Array(samples.length);
    const nodeSelfTime = new Map();
    let t = startTime;
    for (let i = 0; i < samples.length; i++) {
        const dt = timeDeltas[i] ?? 0;
        t += dt;
        sampleTimes[i] = t;
        const id = samples[i];
        const node = nodes.get(id);
        if (node) sampleFrames[i] = node.callFrame;
        nodeSelfTime.set(id, (nodeSelfTime.get(id) ?? 0) + dt);
    }
    const nodeParent = new Map();
    const nodeChildren = new Map();
    for (const n of nodes.values()) {
        if (n.parent != null) nodeParent.set(n.id, n.parent);
        else if (n.children) for (const c of n.children) nodeParent.set(c, n.id);
    }
    for (const [id, parent] of nodeParent) {
        const list = nodeChildren.get(parent);
        if (list) list.push(id);
        else nodeChildren.set(parent, [id]);
    }
    return {name, sampleTimes, sampleFrames, sampleIds: samples, startTime,
        nodes, nodeParent, nodeChildren, nodeSelfTime,
        ...aggregate(sampleTimes, sampleFrames, startTime, -Infinity, Infinity)};
}

function aggregate(sampleTimes, sampleFrames, startTime, fromUs, toUs) {
    const selfByFrame = new Map();
    let busy = 0, idle = 0, samples = 0;
    let prev = startTime;
    for (let i = 0; i < sampleTimes.length; i++) {
        const ts = sampleTimes[i];
        const dt = ts - prev;
        prev = ts;
        if (ts < fromUs) continue;
        if (ts > toUs) break;
        samples++;
        const f = sampleFrames[i];
        if (!f) continue;
        if (IDLE_SAMPLE_NAMES.has(f.functionName)) {
            idle += dt;
        } else {
            busy += dt;
            const key = frameKey(f);
            const entry = selfByFrame.get(key);
            if (entry) entry.time += dt;
            else selfByFrame.set(key, {frame: f, time: dt});
        }
    }
    const top = [...selfByFrame.values()].sort((a, b) => b.time - a.time);
    return {samples, busy, idle, top};
}

function frameKey(f) {
    return `${f.functionName}|${f.url || ''}|${f.lineNumber || 0}|${f.columnNumber || 0}`;
}

function findLongTasks(events, thread, thresholdUs = 50000) {
    const tasks = [];
    for (const e of events) {
        if (e.name !== 'RunTask' || e.dur < thresholdUs) continue;
        const dominant = dominantFrame(thread, e.ts, e.ts + e.dur);
        tasks.push({ts: e.ts, dur: e.dur, dominant});
    }
    tasks.sort((a, b) => b.dur - a.dur);
    return tasks;
}

function dominantFrame(thread, fromUs, toUs) {
    const {sampleTimes, sampleFrames} = thread;
    const byFrame = new Map();
    let bestFrame = null;
    let bestCount = 0;
    for (let i = 0; i < sampleTimes.length; i++) {
        const ts = sampleTimes[i];
        if (ts < fromUs) continue;
        if (ts > toUs) break;
        const f = sampleFrames[i];
        if (!f || IDLE_SAMPLE_NAMES.has(f.functionName)) continue;
        const key = frameKey(f);
        const count = (byFrame.get(key) || 0) + 1;
        byFrame.set(key, count);
        if (count > bestCount) {
            bestCount = count;
            bestFrame = f;
        }
    }
    return bestFrame;
}

const CATEGORY_RULES = [
    [/^V8\.GC|^MajorGC$|^MinorGC$|CppGC|BlinkGC/, 'gc'],
    [/^V8\.Compile|^v8\.compile|^V8\.OptimizeCode|^V8\.DeoptimizeCode|^V8\.DeserializeContext|^ParseScript|^ParseHTML|^ParseAuthorStyleSheet/, 'compile'],
    [/^DecodedDataDocumentParser|^FrameLoader::|^RenderFrameImpl::|^LocalWindowProxy::|^AgentSchedulingGroup::|^InstallConditionalFeatures|^StubScriptCatchup|^XHR(Load|Ready)|^ResourceLoad|^ResourceSendRequest|^ResourceReceiveResponse|^ResourceFinish/, 'loading'],
    [/^Layout$|^UpdateLayoutTree|^RecalculateStyles|^InvalidateLayout|^HitTest|^UpdateLayer$|^UpdateLayerTree|^ScheduleStyleRecalculation|^LocalFrameView::|^Commit$|^PrePaint$|^IntersectionObserverController|^PageAnimator::serviceScriptedAnimations/, 'rendering'],
    [/^Paint|^RasterTask|^CompositeLayers|^Decode Image|^DrawFrame|^GPUTask|^Draw /, 'painting'],
    [/^EvaluateScript|^FunctionCall|^v8\.callFunction|^v8\.evaluateModule|^v8\.run|^EventDispatch|^TimerFire|^FireAnimationFrame|^RunMicrotasks|^V8\.Execute|^V8\.HandleInterrupts|^V8\.BytecodeBudget|^V8\.StackGuard|^V8\.InvokeApi|^HandlePostMessage|^v8\.newInstance|^v8::Debugger|^UserTiming::|^RunTask$/, 'scripting']
];

function categorize(name) {
    for (const [re, cat] of CATEGORY_RULES) if (re.test(name)) return cat;
    return 'other';
}

function computeBreakdown(events, totalUs) {
    const sorted = [...events].sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const buckets = new Map();
    const stack = [];

    const close = (f) => {
        const self = f.dur - f.childDur;
        const cat = categorize(f.name);
        buckets.set(cat, (buckets.get(cat) || 0) + self);
    };

    for (const e of sorted) {
        while (stack.length && stack[stack.length - 1].end <= e.ts) close(stack.pop());
        const parent = stack[stack.length - 1];
        if (parent) parent.childDur += e.dur;
        stack.push({end: e.ts + e.dur, dur: e.dur, childDur: 0, name: e.name});
    }
    while (stack.length) close(stack.pop());

    return [...buckets.entries()]
        .map(([category, time]) => ({category, time, pct: totalUs > 0 ? 100 * time / totalUs : 0}))
        .sort((a, b) => b.time - a.time);
}

export function filterTrace(trace, {from, to, threads} = {}) {
    let selected = trace.threads;
    if (threads?.length) {
        const needles = threads.map(s => s.toLowerCase());
        selected = selected.filter(t => needles.some(n => t.name.toLowerCase().includes(n)));
    }
    if (from == null && to == null) return {...trace, threads: selected};

    const sliced = selected.map((t) => {
        const fromUs = from != null ? t.startTime + from * 1000 : -Infinity;
        const toUs = to != null ? t.startTime + to * 1000 : Infinity;
        return sliceThread(t, fromUs, toUs);
    });
    return {...trace, threads: sliced};
}

function sliceThread(t, fromUs, toUs) {
    const agg = aggregate(t.sampleTimes, t.sampleFrames, t.startTime, fromUs, toUs);
    const longTasks = t.longTasks?.filter(lt => lt.ts >= fromUs && lt.ts + lt.dur <= toUs);
    const breakdown = t.events ?
        computeBreakdown(t.events.filter(e => e.ts >= fromUs && e.ts + e.dur <= toUs), agg.busy + agg.idle) :
        t.breakdown;
    return {...t, ...agg, longTasks, breakdown};
}

export function resolveSourceMaps(trace, {load = loadSiblingMap} = {}) {
    const cache = new Map();
    const seen = new WeakSet();
    const embedded = trace.embeddedMaps;

    const remap = (frame) => {
        if (!frame || seen.has(frame) || !frame.url || frame.lineNumber < 0) return;
        seen.add(frame);

        let map = cache.get(frame.url);
        if (map === undefined) {
            map = embedded?.get(frame.url) || load(frame.url);
            cache.set(frame.url, map);
        }
        if (!map) return;

        const pos = originalPositionFor(map, {line: frame.lineNumber + 1, column: frame.columnNumber || 0});
        if (!pos.source || pos.line == null) return;

        frame.url = pos.source;
        frame.lineNumber = pos.line - 1;
        frame.columnNumber = pos.column || 0;
        if (pos.name && (!frame.functionName || frame.functionName === '(anonymous)')) {
            frame.functionName = pos.name;
        }
    };

    // positionTicks give self-time sample counts per generated-code line. They reference the
    // node's (pre-remap) script url, so resolve them against the same map before remap()
    // rewrites callFrame.url to the original source. Lines are 1-based, like the map expects.
    const remapLineTicks = (node) => {
        const ticks = node.positionTicks;
        if (!ticks) return;
        const url = node.callFrame?.url;
        let map;
        if (url) {
            map = cache.get(url);
            if (map === undefined) { map = embedded?.get(url) || load(url); cache.set(url, map); }
        }
        node.lineTicks = ticks.map(({line, ticks: count}) => {
            if (map) {
                const pos = originalPositionFor(map, {line, column: 0});
                if (pos.source && pos.line != null) return {url: pos.source, line: pos.line, ticks: count};
            }
            return {url, line, ticks: count};
        });
    };

    for (const t of trace.threads) {
        if (t.nodes) for (const n of t.nodes.values()) { remapLineTicks(n); remap(n.callFrame); }
        else {
            for (const e of t.top) remap(e.frame);
            if (t.longTasks) for (const lt of t.longTasks) remap(lt.dominant);
        }
    }
}

function totalsCache(thread) {
    const {nodeChildren, nodeSelfTime} = thread;
    const cache = new Map();
    const totalOf = (id) => {
        const c = cache.get(id);
        if (c !== undefined) return c;
        let t = nodeSelfTime.get(id) ?? 0;
        for (const k of nodeChildren.get(id) ?? []) t += totalOf(k);
        cache.set(id, t);
        return t;
    };
    return totalOf;
}

// Aggregate (frame, time) pairs into a map keyed by frame identity, optionally tracking
// the contributing node ids (needed when callers want to recurse from this frontier).
function addFrame(map, frame, time, id) {
    const key = frameKey(frame);
    const e = map.get(key);
    if (e) {
        e.time += time;
        if (e.ids) e.ids.push(id);
    } else {
        map.set(key, id !== undefined ? {frame, time, ids: [id]} : {frame, time});
    }
}

// Per-line self-time for a node: prefer sourcemap-resolved lineTicks (set by resolveSourceMaps),
// fall back to raw positionTicks against the generated url when source maps are off/absent.
function nodeLineTicks(node) {
    if (node.lineTicks) return node.lineTicks;
    if (!node.positionTicks) return null;
    const url = node.callFrame?.url;
    return node.positionTicks.map(({line, ticks}) => ({url, line, ticks}));
}

// Distribute each node's self time across its source lines in proportion to positionTicks,
// then aggregate by (url, line) across all matching nodes. Surfaces hot lines even when the
// real work is inlined into the function (the inlined ticks land on the outer function's node).
export function buildHotLines(thread, ids) {
    const {nodes, nodeSelfTime} = thread;
    const byLine = new Map();
    for (const id of ids) {
        const node = nodes.get(id);
        const lines = nodeLineTicks(node);
        if (!lines) continue;
        const selfUs = nodeSelfTime.get(id) ?? 0;
        let totalTicks = 0;
        for (const l of lines) totalTicks += l.ticks;
        if (!totalTicks || !selfUs) continue;
        const fnName = node.callFrame?.functionName || '(anonymous)';
        for (const {url, line, ticks} of lines) {
            const key = `${url}|${line}`;
            const time = selfUs * ticks / totalTicks;
            let e = byLine.get(key);
            if (!e) byLine.set(key, e = {url, line, time, fns: new Set()});
            else e.time += time;
            e.fns.add(fnName);
        }
    }
    // A source line "owns" by the function whose declaration most closely precedes it. When a
    // node of a *different* function carries ticks for that line, the owning function's code was
    // inlined into that node — flag which functions it was inlined into.
    const owners = functionOwners(thread);
    for (const e of byLine.values()) {
        // Without a url we can't locate the owning function, so don't speculate about inlining.
        e.owner = e.url ? lineOwner(owners, e.url, e.line) : null;
        e.inlinedInto = e.url ? [...e.fns].filter(n => n !== e.owner && n !== '(anonymous)') : [];
    }
    return [...byLine.values()];
}

// Per-url sorted list of function declaration lines, cached on the thread. Powers lineOwner.
function functionOwners(thread) {
    if (thread._fnOwners) return thread._fnOwners;
    const byUrl = new Map();
    for (const n of thread.nodes.values()) {
        const f = n.callFrame;
        if (!f?.url || !(f.lineNumber >= 0)) continue;
        const name = f.functionName || '(anonymous)';
        if (name === '(anonymous)') continue;
        let arr = byUrl.get(f.url);
        if (!arr) byUrl.set(f.url, arr = []);
        arr.push({line: f.lineNumber + 1, name});
    }
    for (const arr of byUrl.values()) arr.sort((a, b) => a.line - b.line);
    return (thread._fnOwners = byUrl);
}

// The function whose declaration most closely precedes a source line (its natural owner).
function lineOwner(owners, url, line) {
    const arr = owners.get(url);
    if (!arr) return null;
    let owner = null;
    for (const {line: dl, name} of arr) {
        if (dl <= line) owner = name; else break;
    }
    return owner;
}

const SYSTEM_NAMES = new Set(['(idle)', '(program)', '(root)', '(no symbol)', '(garbage collector)']);

// Hot-tree builder: at each level, aggregate children of the frontier by frame identity,
// keep branches above `cutoffUs`, recurse. Capped by depth, per-level branch count, and
// a total node budget. Used by both --stacks hot-path and the default heaviest-stacks tree.
function buildHotTree(thread, frontier, cutoffUs, totalOf, {maxDepth = 6, maxBranch = 3, budget = 8} = {}) {
    const {nodes, nodeChildren, nodeSelfTime} = thread;
    const state = {budget};
    const build = (front, depth) => {
        if (depth >= maxDepth || state.budget <= 0) return [];
        const byFrame = new Map();
        for (const id of front) {
            for (const c of nodeChildren.get(id) ?? []) {
                const child = nodes.get(c);
                if (!child?.callFrame || SYSTEM_NAMES.has(child.callFrame.functionName)) continue;
                addFrame(byFrame, child.callFrame, totalOf(c), c);
            }
        }
        const branches = [...byFrame.values()]
            .filter(e => e.time >= cutoffUs)
            .sort((a, b) => b.time - a.time)
            .slice(0, maxBranch);
        const result = [];
        for (const e of branches) {
            if (state.budget <= 0) break;
            state.budget--;
            const self = e.ids.reduce((s, id) => s + (nodeSelfTime.get(id) ?? 0), 0);
            result.push({frame: e.frame, time: e.time, self, children: build(e.ids, depth + 1)});
        }
        return result;
    };
    return build(frontier, 0);
}

// System parents: nodes whose own frame is system but which have non-system children —
// the V8 (root)/(program) wrappers that sit above real entry points. Used as the frontier
// for topPaths so the tree starts at user-visible code, not at the synthetic wrappers.
function systemParents(thread) {
    const {nodes, nodeParent} = thread;
    const set = new Set();
    for (const n of nodes.values()) {
        const name = n.callFrame?.functionName;
        if (!name || SYSTEM_NAMES.has(name)) continue;
        const pid = nodeParent.get(n.id);
        if (pid == null) continue;
        const parentName = nodes.get(pid)?.callFrame?.functionName;
        if (parentName && SYSTEM_NAMES.has(parentName)) set.add(pid);
    }
    return [...set];
}

export function topPaths(thread, {cutoffPct = 5, maxDepth = 10, maxBranch = 3, budget = 15} = {}) {
    if (!thread.nodes || !thread.busy) return [];
    const cutoff = thread.busy * cutoffPct / 100;
    return buildHotTree(thread, systemParents(thread), cutoff, totalsCache(thread), {maxDepth, maxBranch, budget});
}

// Levenshtein edit distance, capped early — names are short so a full DP table is cheap.
function editDistance(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({length: n + 1}, (_, j) => j);
    let cur = new Array(n + 1);
    for (let i = 1; i <= m; i++) {
        cur[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, cur] = [cur, prev];
    }
    return prev[n];
}

// Nearest displayed function names to a missed --stacks query, ranked by relevance: substring
// hits first (the common near-miss), then by edit distance, tie-broken by self time so hot
// functions win. Powers the no-match hint so an agent's mistyped name answers in one round-trip.
export function suggestNames(trace, pattern, limit = 3) {
    const needle = pattern.toLowerCase();
    const byName = new Map();
    for (const t of trace.threads) {
        if (!t.nodes) continue;
        for (const n of t.nodes.values()) {
            const f = n.callFrame;
            if (!f) continue;
            const name = f.functionName || '(anonymous)';
            if (SYSTEM_NAMES.has(name) || name === '(anonymous)') continue;
            const self = (t.nodeSelfTime?.get(n.id) ?? 0);
            byName.set(name, (byName.get(name) ?? 0) + self);
        }
    }
    const scored = [];
    for (const [name, self] of byName) {
        const lower = name.toLowerCase();
        const dist = editDistance(needle, lower);
        const substring = lower.includes(needle) || needle.includes(lower);
        // skip names that are neither a substring relation nor reasonably close
        if (!substring && dist > Math.max(2, Math.ceil(needle.length / 2))) continue;
        scored.push({name, self, substring, dist});
    }
    scored.sort((a, b) => (b.substring - a.substring) || (a.dist - b.dist) || (b.self - a.self));
    return scored.slice(0, limit).map(s => s.name);
}

export function findStacks(thread, pattern) {
    const {nodes, nodeParent, nodeChildren, nodeSelfTime} = thread;
    if (!nodes) return [];
    const needle = pattern.toLowerCase();
    const totalOf = totalsCache(thread);

    // V8 attributes all GC samples to one (garbage collector) node under (root), losing the
    // JS context — so call-tree parents are useless. Reconstruct callers from temporal
    // adjacency: each GC sample is attributed to the leaf of the preceding non-GC sample
    // (this is what Speedscope's sandwich view does for GC).
    if (needle === '(garbage collector)') return findGCStacks(thread);

    // Exact match on functionName (case-insensitive); use --grep for substring/regex search.
    // Empty functionName matches "(anonymous)" — V8 stores it as "" but we display it as
    // "(anonymous)", so users target the displayed name. Group by full frame identity, so
    // same name in different files (or each distinct anonymous site) = separate groups.
    const groups = new Map();
    for (const n of nodes.values()) {
        const name = (n.callFrame?.functionName || '(anonymous)').toLowerCase();
        if (name !== needle) continue;
        const key = frameKey(n.callFrame);
        let g = groups.get(key);
        if (!g) {
            g = {frame: n.callFrame, self: 0, total: 0, sites: 0,
                callers: new Map(), callees: new Map(), matchingIds: [], hotPath: [], hotLines: []};
            groups.set(key, g);
        }
        const nTotal = totalOf(n.id);
        g.self += nodeSelfTime.get(n.id) ?? 0;
        g.total += nTotal;
        g.sites++;
        g.matchingIds.push(n.id);

        const parent = nodes.get(nodeParent.get(n.id));
        if (parent?.callFrame) addFrame(g.callers, parent.callFrame, nTotal);
        for (const c of nodeChildren.get(n.id) ?? []) {
            const child = nodes.get(c);
            if (child?.callFrame) addFrame(g.callees, child.callFrame, totalOf(c));
        }
    }

    const noiseUs = thread.busy * 0.01;
    const sortDesc = m => [...m.values()].filter(e => e.time >= noiseUs).sort((a, b) => b.time - a.time);
    for (const g of groups.values()) {
        g.hotPath = buildHotTree(thread, g.matchingIds, g.total * 0.05, totalOf);
        g.hotLines = buildHotLines(thread, g.matchingIds)
            .filter(e => e.time >= g.self * 0.02)
            .sort((a, b) => b.time - a.time);
        g.callers = sortDesc(g.callers);
        g.callees = sortDesc(g.callees);
        delete g.matchingIds;
    }
    return [...groups.values()].filter(g => g.total >= noiseUs).sort((a, b) => b.total - a.total);
}

function findGCStacks(thread) {
    const {nodes, nodeSelfTime, sampleIds, sampleFrames, sampleTimes, startTime} = thread;
    let gcNode = null;
    for (const n of nodes.values()) {
        if (n.callFrame?.functionName === '(garbage collector)') { gcNode = n; break; }
    }
    if (!gcNode) return [];

    const gcId = gcNode.id;
    const callers = new Map();
    let lastJsFrame = null;
    let prev = startTime;
    for (let i = 0; i < sampleIds.length; i++) {
        const ts = sampleTimes[i];
        const dt = ts - prev;
        prev = ts;
        if (sampleIds[i] === gcId) {
            if (lastJsFrame) addFrame(callers, lastJsFrame, dt);
        } else {
            const f = sampleFrames[i];
            if (f && !SYSTEM_NAMES.has(f.functionName)) lastJsFrame = f;
        }
    }
    const total = nodeSelfTime.get(gcId) ?? 0;
    // Floor against GC's own total, not thread busy: each caller is naturally a small
    // fraction of a small total, and we want to see who's contributing to GC pressure.
    const noiseUs = total * 0.03;
    const callersList = [...callers.values()].filter(e => e.time >= noiseUs).sort((a, b) => b.time - a.time);
    return [{
        frame: gcNode.callFrame,
        self: total, total, sites: 1,
        callers: callersList, callees: [], hotPath: []
    }];
}

function loadSiblingMap(url) {
    if (!url.startsWith('file://')) return null;
    let filePath;
    try { filePath = fileURLToPath(url); } catch { return null; }

    const mapPath = `${filePath}.map`;
    if (fs.existsSync(mapPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
            return new TraceMap(raw, pathToFileURL(mapPath).href);
        } catch { /* fall through to inline */ }
    }

    if (!fs.existsSync(filePath)) return null;
    try {
        const src = fs.readFileSync(filePath, 'utf8');
        const i = src.lastIndexOf('sourceMappingURL=');
        if (i < 0) return null;
        const m = src.slice(i).match(/^sourceMappingURL=data:application\/json(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=]+)/);
        if (!m) return null;
        const raw = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
        return new TraceMap(raw, pathToFileURL(filePath).href);
    } catch { return null; }
}

const IDLE_NAMES = new Set(['(idle)', '(program)', '(root)', '(no symbol)']);

export function frameKind(f) {
    if (f.functionName === '(garbage collector)') return 'gc';
    if (IDLE_NAMES.has(f.functionName)) return 'system';
    const url = f.url;
    if (!url) return 'native';
    if (url.startsWith('node:')) return 'node';
    if (url.includes('/node_modules/')) return 'deps';
    if (url.startsWith('chrome-extension://')) return 'ext';
    return 'user';
}

const KIND_COLORS = {user: 'green', deps: 'cyan', node: 'blue', ext: 'magenta', native: 'yellow', gc: 'yellow', system: 'dim'};

export function formatFrame(f, shorten, paint, bold = false) {
    const name = f.functionName || '(anonymous)';
    const color = KIND_COLORS[frameKind(f)];
    const style = !bold ? color : color === 'dim' ? 'bold' : `bold+${color}`;
    const coloredName = paint(name, style);
    if (!f.url) return coloredName;
    const loc = f.lineNumber >= 0 ? `:${f.lineNumber + 1}` : '';
    return `${coloredName}  ${paint(`${shorten ? shorten(f.url) : f.url}${loc}`, 'dim')}`;
}

const ANSI = {bold: '1', dim: '2', red: '31', green: '32', yellow: '33', blue: '34', magenta: '35', cyan: '36'};
function makePainter(on) {
    return on ? (s, style) => `\x1b[${style.split('+').map(k => ANSI[k]).join(';')}m${s}\x1b[0m` : s => s;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const vlen = s => s.replace(ANSI_RE, '').length;
function pad(s, w, align) {
    const n = w - vlen(s);
    if (n <= 0) return s;
    const sp = ' '.repeat(n);
    return align === 'left' ? s + sp : sp + s;
}
function table(rows, aligns, {gap = '  ', indent = ' '} = {}) {
    if (!rows.length) return [];
    const widths = rows[0].map(() => 0);
    for (const r of rows) for (let i = 0; i < r.length; i++) widths[i] = Math.max(widths[i], vlen(r[i]));
    return rows.map(r => indent + r.map((c, i) => {
        if (i === r.length - 1 && aligns[i] === 'left') return c;
        return pad(c, widths[i], aligns[i]);
    }).join(gap));
}

export function buildShortener(urlCounts, threshold = 0.8) {
    const byOrigin = Map.groupBy(urlCounts, ([url]) => parseOrigin(url));
    byOrigin.delete(null);

    let dominant = null;
    let dominantWeight = 0;
    const prefixes = new Map();

    for (const [origin, list] of byOrigin) {
        const candidates = new Map();
        let total = 0;
        for (const [url, count] of list) {
            total += count;
            let i = url.indexOf('/', origin.length);
            while (i !== -1) {
                const prefix = url.slice(0, i + 1);
                candidates.set(prefix, (candidates.get(prefix) || 0) + count);
                i = url.indexOf('/', i + 1);
            }
        }
        const min = total * threshold;
        let best = `${origin}/`;
        for (const [prefix, w] of candidates) {
            if (w >= min && prefix.length > best.length) best = prefix;
        }
        prefixes.set(origin, best);
        if (total > dominantWeight && !origin.startsWith('blob:')) {
            dominantWeight = total;
            dominant = origin;
        }
    }

    const sources = [];
    for (const [origin, prefix] of prefixes) {
        sources.push({tag: origin === dominant ? '' : originTag(origin), prefix});
    }

    function shorten(url) {
        const origin = parseOrigin(url);
        if (!origin) return url;
        const prefix = prefixes.get(origin);
        const isBlob = origin.startsWith('blob:');
        const path = isBlob ? '' :
            prefix && url.startsWith(prefix) ? url.slice(prefix.length) : url.slice(origin.length);
        return origin === dominant ? path : `[${originTag(origin)}]${path && ` ${path}`}`;
    }

    return {shorten, sources};
}

export function loadInputs(paths) {
    const files = [];
    for (const p of paths) {
        if (fs.statSync(p).isDirectory()) {
            for (const name of fs.readdirSync(p).sort()) {
                if (name.endsWith('.cpuprofile')) files.push(path.join(p, name));
            }
        } else {
            files.push(p);
        }
    }
    return files.map(f => parseInput(fs.readFileSync(f), f));
}

// Render a hot tree as breadcrumbs: function names only (the agent can `--stacks <name>` for
// file/line), with `parent → child` chain collapse when one child dominates (≥80% of parent).
function renderHotTree(out, entries, denomUs, paint, indent, depth = 0) {
    for (const node of entries) {
        const chain = [node];
        let cur = node;
        while (chain.length < 3 && cur.children.length === 1 && cur.children[0].time >= 0.8 * cur.time) {
            cur = cur.children[0];
            chain.push(cur);
        }
        const pct = denomUs > 0 ? 100 * node.time / denomUs : 0;
        const pctStr = `${pct.toFixed(1)}%`.padStart(6);
        const names = chain.map(c => paint(c.frame.functionName || '(anonymous)', KIND_COLORS[frameKind(c.frame)]))
            .join(paint(' → ', 'dim'));
        out.push(`${indent}${pctStr}  ${'  '.repeat(depth)}${names}`);
        renderHotTree(out, cur.children, denomUs, paint, indent, depth + 1);
    }
}

const BREAKDOWN_KEEP = new Set(['compile', 'loading']);
const IDLE_THREAD_BUSY_US = 10_000;
const IDLE_THREAD_BUSY_FRAC = 0.01;

// Append `#1`, `#2`, ... to threads whose name collides — Chrome gives every worker the
// same `thread_name` ("DedicatedWorker thread"), so without this `--thread` can't target one
// specifically and the report headers are indistinguishable.
function disambiguateThreadNames(threads) {
    const counts = new Map();
    for (const t of threads) counts.set(t.name, (counts.get(t.name) || 0) + 1);
    const seen = new Map();
    for (const t of threads) {
        if (counts.get(t.name) > 1) {
            const n = (seen.get(t.name) || 0) + 1;
            seen.set(t.name, n);
            t.name = `${t.name} #${n}`;
        }
    }
}

const TOP_CPU_FLOOR_PCT = 0.5;
// Default-view hot lines are an at-a-glance headline, not the full list — the long 0.5%-floor
// tail mostly echoes Top CPU for non-inlined code. Drill in with --stacks for the complete set.
const HOT_LINES_TOP = 10;

// A hot-line label: the line is the primary key, the function(s) V8 charged the samples to
// follow as a colored hint (like Top CPU, the hint floats after the location, not column-aligned).
// An inlined line ran inside a function it isn't declared in, so it's marked "(inlined)" — the
// named function is the inlining host (we can't name the source function; it may never be sampled
// as its own node).
function hotLineLabel(e, shorten, paint) {
    const loc = paint(`${e.url ? (shorten ? shorten(e.url) : e.url) : '(unknown)'}:${e.line}`, 'dim');
    const names = [...e.fns].filter(n => n && n !== '(anonymous)');
    const shown = names.slice(0, 3);
    let hint = shown.map(n => paint(n, KIND_COLORS[frameKind({functionName: n, url: e.url})])).join(', ');
    if (names.length > shown.length) hint += `, +${names.length - shown.length}`;
    if (e.inlinedInto.length) hint += `${hint ? ' ' : ''}${paint('(inlined)', 'dim')}`;
    return hint ? `${loc}  ${hint}` : loc;
}

export function formatReport(input, {top = 20, color = false, sourceMaps = true, from, to, threads, stacks} = {}) {
    let trace = Array.isArray(input) ? mergeTraces(input) : input;
    disambiguateThreadNames(trace.threads);
    if (from != null || to != null || threads?.length) trace = filterTrace(trace, {from, to, threads});
    if (sourceMaps) resolveSourceMaps(trace);
    const paint = makePainter(color);
    const hotThreshold = 5;
    const fmtPct = (p) => {
        const s = `${p.toFixed(1)}%`;
        return p >= hotThreshold ? paint(s, 'bold+red') : s;
    };
    const fmtMs = us => `${(us / 1000).toFixed(1)} ms`;

    const stackResults = stacks ? trace.threads.map(t => findStacks(t, stacks)) : null;
    const heaviestResults = stacks ? null : trace.threads.map(t => topPaths(t));
    // Thread-wide hot source lines: the one lens that survives inlining (inlined ticks land on
    // the outer function's node, so they surface here even when the call tree hides them).
    // Empty for trace inputs, which carry no positionTicks.
    const hotLinesResults = stacks ? null : trace.threads.map((t) => {
        if (!t.nodes) return [];
        return buildHotLines(t, [...t.nodes.keys()])
            .filter(e => e.time >= t.busy * TOP_CPU_FLOOR_PCT / 100)
            .sort((a, b) => b.time - a.time);
    });
    const urlCounts = new Map();
    const countUrl = (url) => { if (url) urlCounts.set(url, (urlCounts.get(url) || 0) + 1); };
    for (let i = 0; i < trace.threads.length; i++) {
        const t = trace.threads[i];
        if (stacks) {
            for (const g of stackResults[i]) {
                countUrl(g.frame.url);
                for (const e of g.callers.slice(0, top)) countUrl(e.frame.url);
                for (const e of g.callees.slice(0, top)) countUrl(e.frame.url);
                for (const e of g.hotLines.slice(0, top)) countUrl(e.url);
            }
        } else {
            for (let j = 0; j < Math.min(top, t.top.length); j++) countUrl(t.top[j].frame.url);
            for (const e of hotLinesResults[i].slice(0, HOT_LINES_TOP)) countUrl(e.url);
            if (t.longTasks) for (const lt of t.longTasks) countUrl(lt.dominant?.url);
        }
    }
    const {shorten, sources} = buildShortener(urlCounts);

    const out = [];
    if (sources.length) {
        out.push(paint('Sources:', 'bold'));
        const hasTags = sources.some(s => s.tag);
        const rows = hasTags ?
            sources.map(({tag, prefix}) => [tag ? `[${tag}]` : '', paint(prefix, 'dim')]) :
            sources.map(({prefix}) => [paint(prefix, 'dim')]);
        for (const line of table(rows, hasTags ? ['left', 'left'] : ['left'])) out.push(line);
    }

    if (stacks && !stackResults.some(g => g.length)) {
        // Principle 7: a silent empty report reads as "function isn't hot." Say it's a miss,
        // and answer the likely near-miss in the same round-trip.
        const suggestions = suggestNames(trace, stacks);
        out.push(suggestions.length ?
            `no exact match for "${stacks}"; closest: ${suggestions.join(', ')}` :
            `no exact match for "${stacks}"`);
        return out.join('\n');
    }

    for (let ti = 0; ti < trace.threads.length; ti++) {
        const t = trace.threads[ti];
        const totalUs = t.busy + t.idle;

        if (stacks) {
            const groups = stackResults[ti];
            if (!groups.length) continue;
            out.push('');
            out.push(paint(`=== ${t.name} ===`, 'bold'));
            for (const g of groups) {
                const totalPct = totalUs > 0 ? 100 * g.total / totalUs : 0;
                const selfPct = totalUs > 0 ? 100 * g.self / totalUs : 0;
                out.push('');
                out.push(`${paint('Stacks:', 'bold')} ${formatFrame(g.frame, shorten, paint, true)}`);
                out.push(paint(`  ${g.sites} site${g.sites > 1 ? 's' : ''}; total ${fmtMs(g.total)} ${totalPct.toFixed(1)}%, self ${fmtMs(g.self)} ${selfPct.toFixed(1)}%`, 'dim'));
                if (g.hotPath?.length) {
                    out.push(`${paint('  Hot paths:', 'bold')} ${paint('(% of fn total)', 'dim')}`);
                    renderHotTree(out, g.hotPath, g.total, paint, '    ');
                }
                if (g.hotLines?.length) {
                    out.push(`${paint('  Hot lines:', 'bold')} ${paint('(self time by source line; includes inlined code)', 'dim')}`);
                    const shown = g.hotLines.slice(0, top);
                    const rows = shown.map(e => [
                        fmtMs(e.time),
                        fmtPct(totalUs > 0 ? 100 * e.time / totalUs : 0),
                        hotLineLabel(e, shorten, paint)
                    ]);
                    for (const l of table(rows, ['right', 'right', 'left'], {indent: '   '})) out.push(l);
                }
                const section = (label, entries) => {
                    if (!entries.length) return;
                    const shown = entries.slice(0, top);
                    const more = entries.length - shown.length;
                    out.push(paint(`  ${label}:`, 'bold'));
                    const rows = shown.map(({frame, time}) => [
                        fmtMs(time),
                        fmtPct(totalUs > 0 ? 100 * time / totalUs : 0),
                        formatFrame(frame, shorten, paint)
                    ]);
                    for (const line of table(rows, ['right', 'right', 'left'], {indent: '   '})) out.push(line);
                    if (more > 0) out.push(paint(`   … ${more} more`, 'dim'));
                };
                section('Callers', g.callers);
                section('Callees', g.callees);
            }
            continue;
        }

        const busyMs = t.busy / 1000;
        const idleMs = t.idle / 1000;

        out.push('');
        out.push(paint(`=== ${t.name} ===`, 'bold'));

        const breakdownParts = t.breakdown
            ?.filter(b => BREAKDOWN_KEEP.has(b.category) && b.pct >= 1)
            .map(b => `${b.category} ${b.pct.toFixed(1)}%`) || [];
        const busyPct = totalUs > 0 ? 100 * t.busy / totalUs : 0;
        const statsLine = `samples: ${t.samples}  busy: ${busyMs.toFixed(1)} ms (${busyPct.toFixed(1)}%)  idle: ${idleMs.toFixed(1)} ms`;
        out.push(breakdownParts.length ? `${statsLine}  (${breakdownParts.join('  ')})` : statsLine);

        if (t.busy < IDLE_THREAD_BUSY_US || t.busy < IDLE_THREAD_BUSY_FRAC * totalUs) {
            out.push(paint('(thread idle — nothing to report)', 'dim'));
            continue;
        }

        const heaviest = heaviestResults[ti];
        if (heaviest?.length) {
            out.push('');
            out.push(`${paint('Heaviest stacks:', 'bold')} ${paint('(% of thread busy)', 'dim')}`);
            renderHotTree(out, heaviest, t.busy, paint, ' ');
        }

        out.push('');
        out.push(paint('Top CPU (self time):', 'bold'));
        const topRows = [];
        for (let i = 0; i < t.top.length && topRows.length < top; i++) {
            const {frame, time} = t.top[i];
            const pct = totalUs > 0 ? 100 * time / totalUs : 0;
            if (pct < TOP_CPU_FLOOR_PCT) break;
            topRows.push([fmtMs(time), fmtPct(pct), formatFrame(frame, shorten, paint)]);
        }
        for (const line of table(topRows, ['right', 'right', 'left'])) out.push(line);

        const hotLines = hotLinesResults[ti];
        if (hotLines.length) {
            out.push('');
            out.push(`${paint('Hot lines (self time):', 'bold')} ${paint('(per source line; includes inlined code)', 'dim')}`);
            const rows = hotLines.slice(0, HOT_LINES_TOP).map(e => [
                fmtMs(e.time),
                fmtPct(totalUs > 0 ? 100 * e.time / totalUs : 0),
                hotLineLabel(e, shorten, paint)
            ]);
            for (const l of table(rows, ['right', 'right', 'left'])) out.push(l);
        }

        if (t.longTasks?.length) {
            out.push('');
            out.push(paint('Long tasks:', 'bold'));
            const rows = t.longTasks.map(({ts, dur, dominant}) => [
                `t=${Math.max(0, (ts - t.startTime) / 1000).toFixed(0)}ms`,
                `${(dur / 1000).toFixed(0)} ms`,
                dominant ? formatFrame(dominant, shorten, paint) : '—'
            ]);
            for (const line of table(rows, ['right', 'right', 'left'])) out.push(line);
        }

    }

    return out.join('\n');
}

function parseOrigin(url) {
    return url?.match(/^(?:blob:)?[a-z][a-z-]*:\/\/[^/]*/)?.[0] ?? null;
}

function originTag(origin) {
    const ext = origin.match(/^chrome-extension:\/\/([a-p]{6})/)?.[1];
    if (ext) return `ext:${ext}`;
    if (origin.startsWith('blob:')) return 'blob';
    return origin.replace(/^https?:\/\//, '');
}
