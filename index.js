import zlib from 'node:zlib';

export function parseTrace(buf) {
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    const data = JSON.parse(buf.toString('utf8'));
    const events = data.traceEvents || data;

    const threadNames = new Map();
    const profiles = new Map();

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
            if (cpuProfile.nodes) for (const n of cpuProfile.nodes) p.nodes.set(n.id, n);
            if (cpuProfile.samples) for (const s of cpuProfile.samples) p.samples.push(s);
            if (timeDeltas) for (const d of timeDeltas) p.timeDeltas.push(d);
        }
    }

    const threads = [];
    for (const p of profiles.values()) {
        threads.push(buildThread(p, threadNames.get(p.key) || p.key));
    }
    return {threads};
}

function buildThread(p, name) {
    const {nodes, samples, timeDeltas} = p;
    const selfByFrame = new Map();
    let busy = 0;
    let idle = 0;

    for (let i = 0; i < samples.length; i++) {
        const node = nodes.get(samples[i]);
        const dt = timeDeltas[i] || 0;
        if (!node) continue;

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
    return {name, samples: samples.length, busy, idle, top};
}

function frameKey(f) {
    return `${f.functionName}|${f.url || ''}|${f.lineNumber || 0}|${f.columnNumber || 0}`;
}

export function formatFrame(f, shorten) {
    const name = f.functionName || '(anonymous)';
    if (!f.url) return name;
    const loc = f.lineNumber >= 0 ? `:${f.lineNumber + 1}` : '';
    return `${name}  ${shorten ? shorten(f.url) : f.url}${loc}`;
}

export function buildShortener(urls) {
    const byOrigin = new Map();
    for (const url of urls) {
        const origin = parseOrigin(url);
        if (!origin) continue;
        const list = byOrigin.get(origin);
        if (list) list.push(url);
        else byOrigin.set(origin, [url]);
    }

    let dominant = null;
    let dominantCount = 0;
    const prefixes = new Map();

    for (const [origin, list] of byOrigin) {
        let prefix = list[0];
        for (let i = 1; i < list.length && prefix.length > origin.length; i++) {
            prefix = commonPrefix(prefix, list[i]);
        }
        prefix = prefix.slice(0, prefix.lastIndexOf('/') + 1);
        prefixes.set(origin, prefix);
        if (list.length > dominantCount) {
            dominantCount = list.length;
            dominant = origin;
        }
    }

    const sources = [];
    for (const [origin, prefix] of prefixes) {
        const host = origin.replace(/^https?:\/\//, '');
        sources.push({tag: origin === dominant ? '' : host, prefix});
    }

    function shorten(url) {
        const origin = parseOrigin(url);
        const prefix = origin && prefixes.get(origin);
        if (!prefix) return url;
        const rest = url.slice(prefix.length);
        return origin === dominant ? rest : `[${origin.replace(/^https?:\/\//, '')}] ${rest}`;
    }

    return {shorten, sources};
}

function parseOrigin(url) {
    if (!url) return null;
    const m = url.match(/^[a-z]+:\/\/[^/]+/);
    return m ? m[0] : null;
}

function commonPrefix(a, b) {
    const len = Math.min(a.length, b.length);
    let i = 0;
    while (i < len && a[i] === b[i]) i++;
    return a.slice(0, i);
}
