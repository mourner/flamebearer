import zlib from 'node:zlib';
import path from 'node:path';

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

export function parseTrace(data) {
    const events = data.traceEvents || data;

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
            if (cpuProfile?.nodes) for (const n of cpuProfile.nodes) p.nodes.set(n.id, n);
            if (cpuProfile?.samples) for (const s of cpuProfile.samples) p.samples.push(s);
            if (timeDeltas) for (const d of timeDeltas) p.timeDeltas.push(d);

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
            t.longTasks = findLongTasks(events, t);
            t.breakdown = computeBreakdown(events, t.busy + t.idle);
        }
        threads.push(t);
    }
    return {source: 'chrome', threads};
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

function buildThread({nodes, samples, timeDeltas, startTime}, name) {
    const selfByFrame = new Map();
    const sampleTimes = new Array(samples.length);
    const sampleFrames = new Array(samples.length);
    let busy = 0;
    let idle = 0;
    let t = startTime;

    for (let i = 0; i < samples.length; i++) {
        const dt = timeDeltas[i] || 0;
        t += dt;
        sampleTimes[i] = t;

        const node = nodes.get(samples[i]);
        if (!node) continue;
        sampleFrames[i] = node.callFrame;

        const fname = node.callFrame.functionName;
        if (fname === '(idle)' || fname === '(program)') {
            idle += dt;
        } else {
            busy += dt;
            const key = frameKey(node.callFrame);
            const entry = selfByFrame.get(key);
            if (entry) entry.time += dt;
            else selfByFrame.set(key, {frame: node.callFrame, time: dt});
        }
    }

    const top = [...selfByFrame.values()].sort((a, b) => b.time - a.time);
    return {name, samples: samples.length, busy, idle, top, sampleTimes, sampleFrames, startTime};
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
        if (!f) continue;
        const name = f.functionName;
        if (name === '(idle)' || name === '(program)') continue;
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

export function formatFrame(f, shorten, paint) {
    const name = f.functionName || '(anonymous)';
    if (!f.url) return name;
    const loc = f.lineNumber >= 0 ? `:${f.lineNumber + 1}` : '';
    return `${name}  ${paint(`${shorten ? shorten(f.url) : f.url}${loc}`, 'dim')}`;
}

const ANSI = {bold: '1', dim: '2', red: '31', boldRed: '1;31'};
function makePainter(on) {
    return on ? (s, style) => `\x1b[${ANSI[style]}m${s}\x1b[0m` : s => s;
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
    const byOrigin = new Map();
    for (const [url, count] of urlCounts) {
        const origin = parseOrigin(url);
        if (!origin) continue;
        const list = byOrigin.get(origin);
        if (list) list.push({url, count});
        else byOrigin.set(origin, [{url, count}]);
    }

    let dominant = null;
    let dominantWeight = 0;
    const prefixes = new Map();

    for (const [origin, list] of byOrigin) {
        const candidates = new Map();
        let total = 0;
        for (const {url, count} of list) {
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
        if (total > dominantWeight) {
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
        const path = prefix && url.startsWith(prefix) ? url.slice(prefix.length) : url.slice(origin.length);
        return origin === dominant ? path : `[${originTag(origin)}] ${path}`;
    }

    return {shorten, sources};
}

export function formatReport(trace, {top = 20, color = false} = {}) {
    const paint = makePainter(color);
    const hotThreshold = 5;

    const urlCounts = new Map();
    for (const t of trace.threads) {
        for (let i = 0; i < Math.min(top, t.top.length); i++) {
            const {url} = t.top[i].frame;
            if (url) urlCounts.set(url, (urlCounts.get(url) || 0) + 1);
        }
        if (t.longTasks) for (const lt of t.longTasks) {
            if (lt.dominant?.url) urlCounts.set(lt.dominant.url, (urlCounts.get(lt.dominant.url) || 0) + 1);
        }
    }
    const {shorten, sources} = buildShortener(urlCounts);

    const out = [];
    if (sources.length) {
        out.push(paint('Sources:', 'bold'));
        const rows = sources.map(({tag, prefix}) => [tag ? `[${tag}]` : '', paint(prefix, 'dim')]);
        for (const line of table(rows, ['left', 'left'])) out.push(line);
    }

    for (const t of trace.threads) {
        const busyMs = t.busy / 1000;
        const idleMs = t.idle / 1000;
        const totalUs = t.busy + t.idle;

        out.push('');
        out.push(paint(`=== ${t.name} ===`, 'bold'));
        out.push(`samples: ${t.samples}  busy: ${busyMs.toFixed(1)} ms  idle: ${idleMs.toFixed(1)} ms`);

        const fmtPct = (p) => {
            const s = `${p.toFixed(1)}%`;
            return p >= hotThreshold ? paint(s, 'boldRed') : s;
        };
        const fmtMs = us => `${(us / 1000).toFixed(1)} ms`;

        if (t.breakdown?.length) {
            const parts = t.breakdown
                .filter(b => b.pct >= 1)
                .map(b => `${b.category} ${b.category === 'scripting' ? `${b.pct.toFixed(1)}%` : fmtPct(b.pct)}`);
            if (parts.length) out.push(parts.join('  '));
        }

        out.push('');
        out.push(paint('Top CPU (self time):', 'bold'));
        const topRows = [];
        for (let i = 0; i < Math.min(top, t.top.length); i++) {
            const {frame, time} = t.top[i];
            const pct = totalUs > 0 ? 100 * time / totalUs : 0;
            topRows.push([fmtMs(time), fmtPct(pct), formatFrame(frame, shorten, paint)]);
        }
        for (const line of table(topRows, ['right', 'right', 'left'])) out.push(line);

        if (t.longTasks?.length) {
            out.push('');
            out.push(paint(`Long tasks (>50ms): ${t.longTasks.length}`, 'bold'));
            const rows = t.longTasks.map(({ts, dur, dominant}) => [
                `t=${((ts - t.startTime) / 1000).toFixed(0)}ms`,
                `${(dur / 1000).toFixed(0)} ms`,
                dominant ? formatFrame(dominant, shorten, paint) : '—'
            ]);
            for (const line of table(rows, ['right', 'right', 'left'])) out.push(line);
        }
    }

    return out.join('\n');
}

function parseOrigin(url) {
    if (!url) return null;
    const m = url.match(/^[a-z][a-z-]*:\/\/[^/]*/);
    return m ? m[0] : null;
}

function originTag(origin) {
    const ext = origin.match(/^chrome-extension:\/\/([a-p]{6})/);
    if (ext) return `ext:${ext[1]}`;
    return origin.replace(/^https?:\/\//, '');
}
