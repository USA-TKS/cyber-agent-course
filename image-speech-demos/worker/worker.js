// 体験ページ（image-speech-demos）の 4〜7 が OpenAI の API を使うための中継。
// 講師の APIキー（OPENAI_API_KEY）と講師の合言葉（ADMIN_PASSCODE）は、この Worker の秘密情報にだけ置く（ページには渡さない）。
// 講師の合言葉はいつでも使える。講師以外は「みんなの合言葉」で、講師が許可していて、決めた時間の中のときだけ使える。
// みんなの合言葉・使える時間・許可は KV（SETTINGS）に置き、管理用のページ（admin.html）から講師が変える。
// 通すのは、決めた3つの窓口と3つのモデルだけ。写真や声は記録しない（Workers Logs も使わない）。

const ROUTES = {
    'responses': { model: 'gpt-6-luna', kind: 'json' },           // 写真を読む・会話する・候補を出す
    'audio/transcriptions': { model: 'gpt-transcribe', kind: 'form' },   // 文字起こし
    'audio/speech': { model: 'gpt-4o-mini-tts', kind: 'json' },   // 声にする
};
const MAX_BYTES = 8 * 1024 * 1024;   // 1回に送れる大きさ（写真は high でも 2〜3 MB、声は 15 秒で 0.5 MB ほど）
const MAX_OUTPUT_TOKENS = 4000;      // 1回の答えの長さの上限（料金が増えすぎないように）
const JST = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export default {
    async fetch(req, env) {
        const origin = req.headers.get('Origin') || '';
        const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
        const cors = allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : { 'Vary': 'Origin' };
        const fail = (status, code, message) => Response.json({ error: { type: 'proxy', code, message } }, { status, headers: cors });

        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, PUT',
                'Access-Control-Allow-Headers': 'Content-Type, X-Passcode', 'Access-Control-Max-Age': '86400' } });
        }
        if (!cors['Access-Control-Allow-Origin']) return fail(403, 'origin', '体験ページ以外からは使えません');
        if (!env.OPENAI_API_KEY || !env.ADMIN_PASSCODE) return fail(503, 'not_ready', 'サーバに APIキーか講師の合言葉がまだ入っていません');
        if (env.LIMITER) {
            const { success } = await env.LIMITER.limit({ key: req.headers.get('CF-Connecting-IP') || 'all' });
            if (!success) return fail(429, 'rate', '短い時間に頼みすぎました');
        }

        // だれが使っているか：講師（admin）・講師以外（user）・時間外（closed）・合言葉が違う（null）
        const who = await roleOf(req.headers.get('X-Passcode') || '', env);
        if (!who) return fail(401, 'passcode', '合言葉が違います');
        if (who.closed) return fail(403, 'closed', who.closed);

        const url = new URL(req.url);
        if (req.method === 'GET' && url.pathname === '/check') return Response.json({ ok: true, role: who.role }, { headers: cors });
        if (url.pathname === '/admin/settings') {
            if (who.role !== 'admin') return fail(403, 'admin', '講師の合言葉でだけ使えます');
            if (!env.SETTINGS) return fail(503, 'not_ready', 'サーバに設定の置き場所（KV）がありません');
            if (req.method === 'GET') return Response.json(await loadSettings(env), { headers: cors });
            if (req.method === 'PUT') return saveSettings(req, env, cors, fail);
            return fail(404, 'not_found', 'この窓口はありません');
        }

        const path = url.pathname.replace(/^\/v1\//, '');
        const route = ROUTES[path];
        if (!route || req.method !== 'POST') return fail(404, 'not_found', 'この窓口はありません');
        if ((+req.headers.get('Content-Length') || 0) > MAX_BYTES) return fail(413, 'too_big', '送るものが大きすぎます');

        const headers = { Authorization: `Bearer ${env.OPENAI_API_KEY}` };
        let body;
        if (route.kind === 'json') {
            const text = await req.text();
            if (text.length > MAX_BYTES) return fail(413, 'too_big', '送るものが大きすぎます');
            let j;
            try { j = JSON.parse(text); } catch (e) { return fail(400, 'bad_json', '送った中身が JSON ではありません'); }
            if (j.model !== route.model) return fail(400, 'model', `このサーバで使えるモデルは ${route.model} だけです`);
            if (path === 'responses') {
                if ('tools' in j || 'background' in j) return fail(400, 'option', 'tools と background は使えません');
                j.max_output_tokens = Math.min(+j.max_output_tokens || MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
                j.store = false;   // 写真や会話を OpenAI に残さない
            }
            if (path === 'audio/speech' && (typeof j.input !== 'string' || j.input.length > 2000)) return fail(400, 'too_long', '声にする文が長すぎます');
            body = JSON.stringify(j);
            headers['Content-Type'] = 'application/json';
        } else {
            let form;
            try { form = await req.formData(); } catch (e) { return fail(400, 'bad_form', '送った中身が読めません'); }
            if (form.get('model') !== route.model) return fail(400, 'model', `このサーバで使えるモデルは ${route.model} だけです`);
            const file = form.get('file');
            if (!file || typeof file === 'string' || file.size > MAX_BYTES) return fail(400, 'file', '声のファイルがないか、大きすぎます');
            body = form;
        }

        let r;
        try {
            r = await fetch((env.OPENAI_BASE || 'https://api.openai.com/v1/') + path, { method: 'POST', headers, body });
        } catch (e) {
            return fail(502, 'upstream', 'サーバから OpenAI につながりませんでした');
        }
        const out = new Headers(cors);
        for (const h of ['Content-Type', 'x-request-id']) if (r.headers.get(h)) out.set(h, r.headers.get(h));
        out.set('Cache-Control', 'no-store');
        return new Response(r.body, { status: r.status, headers: out });
    },
};

// みんなの合言葉・使える時間（開始と終了。ISO の文字列）・許可（enabled）。まだ決めていなければ、講師以外は使えない
async function loadSettings(env) {
    const s = env.SETTINGS ? await env.SETTINGS.get('access', 'json') : null;
    return { passcode: '', start: '', end: '', enabled: false, updated: '', ...(s || {}) };
}

async function roleOf(given, env) {
    if (!given) return null;
    if (await same(given, env.ADMIN_PASSCODE)) return { role: 'admin' };
    const s = await loadSettings(env);
    if (!s.passcode || !(await same(given, s.passcode))) return null;
    const now = Date.now(), start = Date.parse(s.start), end = Date.parse(s.end);
    if (!s.enabled) return { closed: '講師が止めています' };
    if (!(now >= start && now < end)) {
        return { closed: isNaN(start) || isNaN(end) ? '使える時間がまだ決まっていません' : `使える時間は ${JST.format(start)}〜${JST.format(end)}（日本時間）です` };
    }
    return { role: 'user' };
}

async function saveSettings(req, env, cors, fail) {
    let b;
    try { b = await req.json(); } catch (e) { return fail(400, 'bad_json', '送った中身が JSON ではありません'); }
    const passcode = String(b.passcode ?? '').trim();
    if (passcode && (passcode.length < 4 || passcode.length > 64)) return fail(400, 'invalid', 'みんなの合言葉は 4〜64 文字にしてください');
    if (passcode && (await same(passcode, env.ADMIN_PASSCODE))) return fail(400, 'invalid', 'みんなの合言葉は、講師の合言葉と別のものにしてください');
    const start = b.start ? Date.parse(b.start) : NaN, end = b.end ? Date.parse(b.end) : NaN;
    if ((b.start && isNaN(start)) || (b.end && isNaN(end))) return fail(400, 'invalid', '時間の書き方が正しくありません');
    if (!isNaN(start) && !isNaN(end) && end <= start) return fail(400, 'invalid', '終わりは、始まりより後にしてください');
    const s = { passcode, start: isNaN(start) ? '' : new Date(start).toISOString(), end: isNaN(end) ? '' : new Date(end).toISOString(),
                enabled: !!b.enabled, updated: new Date().toISOString() };
    await env.SETTINGS.put('access', JSON.stringify(s));
    return Response.json(s, { headers: cors });
}

// 合言葉を、かかる時間で中身が分からない比べ方で比べる
async function same(a, b) {
    const enc = new TextEncoder();
    const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
    return crypto.subtle.timingSafeEqual(x, y);
}
