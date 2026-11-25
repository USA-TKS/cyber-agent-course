// 体験ページ 4・5 の共通の道具（中継のサーバへの頼み方・エラーの見立て・写真と声の下ごしらえ・カメラ・録音）
// 写真を縮める・声を整える・模様の図を描くのは、このブラウザの中でする。OpenAI へは中継のサーバ（worker/）を通して頼む。
// APIキーは中継のサーバの中にだけあり、このページには来ない。管理者が管理用のページで Password を入れたときだけ、それを一緒に送る
const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 中継のサーバ（手元で試すときは、手元で動かした Worker を使う）
const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8787/' : 'https://image-speech-api.advent-calendar.workers.dev/';
const MODEL_TEXT = 'gpt-6-luna';       // 写真を読む・会話する
const MODEL_STT = 'gpt-transcribe';    // 文字起こし
const SR = 16000;   // 文字起こしの声は、AIに送る形と同じ 1秒に 16,000 回・1チャンネル
const STT_RATES = [16000, 8000, 4000, 3000, 2000];

// ---------- エラー：番号・何が起きたか・原因の見立て・直し方 ----------
class AppError extends Error {
    constructor(info) { super(info.title); this.info = info; }
}
const NOT_REACHED = new AppError({ code: null, title: 'サーバに届きませんでした', cause: 'ネットワークが切れた・ネットワークで止められている', fix: '少し待って、もう一度押す。直らなければ管理者に' });
// 中継のサーバが止めたとき
const PROXY_HINT = {
    password: ['Password が違います', 'Password の打ち間違い（前後の空白など）', 'Password を入れ直す'],
    closed: ['今は使えない時間です', '', '使用開始時間から使用終了時間までの間に、もう一度押す'],
    admin: ['管理者だけが使えます', '', '管理者の Password を入れる'],
    not_ready: ['サーバの準備ができていません', 'サーバに APIキーか管理者の Password がまだ入っていない', '管理者に伝える'],
    origin: ['このページからは使えません', '体験ページではない場所で開いている', '体験ページの URL から開く'],
    rate: ['短い時間に頼みすぎました', '1分あたりの回数の上限をこえた', '30秒ほど待って、もう一度押す'],
    too_big: ['送るものが大きすぎます', '写真や声が大きい', '小さい写真にするか、短く話す'],
    upstream: ['サーバから OpenAI につながりませんでした', 'ネットワークの一時的な不調', '少し待って、もう一度押す'],
};
function explain(status, body) {
    const e = (body && body.error) || {};
    if (e.type === 'proxy' && e.code === 'invalid') return { code: status, title: e.message, cause: '', fix: '' };   // 管理用のページで、設定の値が正しくないとき
    if (e.type === 'proxy') {
        const h = PROXY_HINT[e.code] || [e.message || 'サーバが受け付けませんでした', '', '管理者に伝える'];
        return { code: status, title: h[0], cause: e.code === 'closed' ? e.message : h[1], fix: h[2] };   // 時間外のときは、使用開始時間と使用終了時間を見せる
    }
    const detail = e.message ? `${e.type || ''} ${e.code || ''} ${e.message}`.trim().slice(0, 800) : undefined;
    const out = (title, cause = '', fix = '') => ({ code: status, title, cause, fix, detail });
    if (status === 429 && e.code === 'insufficient_quota') return out('OpenAI の使用の上限に達しました', 'サーバのキーのプロジェクトの上限に達した', '管理者に伝える');
    const table = {
        400: ['送った中身を OpenAI が受け付けませんでした', '設定の値や、モデルとの組み合わせが合っていない', '「くわしく」を管理者に見せる'],
        401: ['サーバの APIキーが正しくありません', 'サーバに入れたキーの間違い・無効になったキー', '管理者に伝える'],
        403: ['このキーでは、このモデルや機能を使えません', 'キーのプロジェクトで、このモデルが許可されていない', '管理者に伝える'],
        404: ['モデルが見つかりません', 'モデルの名前が違う・このキーでは使えないモデル', '管理者に伝える'],
        429: ['短い時間に頼みすぎました', '1分あたりの回数やトークンの上限をこえた', '30秒ほど待って、もう一度押す'],
    };
    if (table[status]) return out(...table[status]);
    if (status >= 500) return out('OpenAI の中でエラーが起きました', 'OpenAI 側の一時的な不調', '少し待って、もう一度押す');
    return out(`思わぬエラー（${status}）`, '', '「くわしく」を管理者に見せる');
}

// ---------- 管理者の Password（管理用のページで入れる。このタブを閉じるまで覚え、体験 4・5 でも使う） ----------
const PASS_KEY = 'image-speech-demos:admin-password';
let passMem = '';
function password() { try { return sessionStorage.getItem(PASS_KEY) || ''; } catch (e) { return passMem; } }
function setPassword(v) { passMem = v; try { sessionStorage.setItem(PASS_KEY, v); } catch (e) { /* このページの間だけ覚える */ } }
const withPassword = (h) => (password() ? { ...h, 'X-Password': password() } : h);

// ---------- 中継のサーバに頼む ----------
async function call(path, { json, form } = {}) {
    let r;
    try {
        r = await fetch(API_BASE + 'v1/' + path, {
            method: 'POST',
            headers: withPassword(json ? { 'Content-Type': 'application/json' } : {}),
            body: json ? JSON.stringify(json) : form,
        });
    } catch (e) { throw NOT_REACHED; }
    if (!r.ok) {
        let b = null;
        try { b = await r.json(); } catch (e) { /* 中身が JSON でないときは番号だけで見立てる */ }
        throw new AppError(explain(r.status, b));
    }
    return r;
}
// 少しずつ届く答え（server-sent events）を、1つずつ取り出す
async function* sse(r) {
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
        let chunk;
        try { chunk = await reader.read(); } catch (e) { throw NOT_REACHED; }
        if (chunk.value) buf += dec.decode(chunk.value, { stream: true });
        let m;
        while ((m = /\r?\n\r?\n/.exec(buf))) {
            const block = buf.slice(0, m.index);
            buf = buf.slice(m.index + m[0].length);
            const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
            if (!data) continue;
            if (data === '[DONE]') return;
            const ev = JSON.parse(data);
            if (ev.type === 'error' || ev.type === 'response.failed') {
                throw new AppError(explain(500, { error: ev.error || (ev.response && ev.response.error) || { message: data } }));
            }
            yield ev;
        }
        if (chunk.done) return;
    }
}

// ---------- 声の下ごしらえ（ノートブックでは Colab の Python がしていたこと） ----------
// 録音（webm など）を、1秒に 16,000 回・1チャンネルの音の列にする
async function decodeVoice(dataURL) {
    const bytes = await (await fetch(dataURL)).arrayBuffer();
    let buf;
    try { buf = await new OfflineAudioContext(1, 1, SR).decodeAudioData(bytes); }
    catch (e) { throw new Error('録音した声が読めませんでした。もう一度録音してください'); }
    const x = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) buf.getChannelData(c).forEach((v, i) => { x[i] += v / buf.numberOfChannels; });
    return buf.sampleRate === SR ? x : resampleTo(x, buf.sampleRate, SR);
}
// 測る回数を src から dst に変える（下げるときは、dst の半分より上の高さを消してから間引く）
function resampleTo(x, src, dst) {
    if (src === dst) return x.slice();
    const step = src / dst, fc = Math.min(1, dst / src), half = Math.ceil(16 / fc);
    const y = new Float32Array(Math.ceil(x.length * dst / src));
    for (let i = 0; i < y.length; i++) {
        const t = i * step;
        let s = 0;
        for (let k = Math.max(0, Math.ceil(t - half)), end = Math.min(x.length - 1, Math.floor(t + half)); k <= end; k++) {
            const d = t - k, u = d * fc;
            s += x[k] * (u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u)) * (0.5 + 0.5 * Math.cos(Math.PI * d / (half + 1)));
        }
        y[i] = s * fc;
    }
    return y;
}
// 1秒に rate 回だけ測った音にして、聞いたり送ったりするために元の測る回数の形に戻す
function measureAndBack(x, src, rate) {
    if (rate >= src) return x;
    const y = resampleTo(resampleTo(x, src, rate), rate, src), out = new Float32Array(x.length);
    out.set(y.subarray(0, x.length));
    return out;
}
// 声の大きさの percent % の大きさのザーッという音を足す（毎回同じ音になるように、決まった乱数を使う）
function addNoise(x, percent) {
    if (percent <= 0) return x;
    let sum = 0;
    for (const v of x) sum += v * v;
    const sd = (Math.sqrt(sum / x.length) || 1e-3) * percent / 100, y = new Float32Array(x.length);
    let seed = 1;
    const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let i = 0; i < x.length; i++) y[i] = x[i] + sd * Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
    return y;
}
// WAV のファイルにする（大きすぎる音は、こわれないように全体を小さくする）
function wavBlob(rate, x) {
    let peak = 0;
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    const g = peak > 1 ? 1 / peak : 1, buf = new ArrayBuffer(44 + x.length * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, x.length * 2, true);
    for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x[i] * g * 32767))), true);
    return new Blob([buf], { type: 'audio/wav' });
}

// ---------- 模様の図（スペクトログラム・メル） ----------
const CMAP_STOPS = [[255, 255, 255], [255, 231, 106], [245, 124, 0], [120, 40, 0], [30, 30, 30]];
function cmap(v) {   // v: 0〜1 を、白 → 黄 → オレンジ → 茶 → 黒 にする
    v = Math.max(0, Math.min(1, v)) * (CMAP_STOPS.length - 1);
    const i = Math.min(CMAP_STOPS.length - 2, Math.floor(v)), t = v - i, a = CMAP_STOPS[i], b = CMAP_STOPS[i + 1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function fft(re, im) {   // 長さが 2 のべき乗の列を、その場で高さごとの成分にする
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let j = 0; j < len / 2; j++) {
                const a = i + j, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
                const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
            }
        }
    }
}
// 短い時間ずつ切って、高さごとの強さ（2乗）を並べる
function powerFrames(x, n, hop, nfft, win) {
    const frames = [];
    for (let s = 0; s + n <= x.length; s += hop) {
        const re = new Float64Array(nfft), im = new Float64Array(nfft);
        for (let i = 0; i < n; i++) re[i] = x[s + i] * win[i];
        fft(re, im);
        const p = new Float64Array(nfft / 2 + 1);
        for (let k = 0; k < p.length; k++) p[k] = re[k] * re[k] + im[k] * im[k];
        frames.push(p);
    }
    return frames;
}
// スペクトログラム（横＝時間、たて＝音の高さ、濃さ＝強さ）の画像。cut があれば、消える高さ（cut の半分より上）を灰色にする
function specPNG(x, rate, cut = null, maxHz = 8000) {
    const n = 2 ** Math.round(Math.log2(rate * 0.025)), hop = n / 4;
    const win = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
    const frames = powerFrames(x.length >= n ? x : Float32Array.from({ length: n }, (_, i) => x[i] || 0), n, hop, n, win);
    let top = -Infinity;
    const db = frames.map((p) => p.map((v) => { const d = 10 * Math.log10(v + 1e-12); if (d > top) top = d; return d; }));
    const W = 660, H = 240, L = 58, R = 12, T = 10, B = 40, pw = W - L - R, ph = H - T - B;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    const img = g.createImageData(pw, ph), seconds = x.length / rate;
    for (let py = 0; py < ph; py++) {
        const k = Math.min(n / 2, Math.round((1 - (py + 0.5) / ph) * maxHz / (rate / n)));
        for (let px = 0; px < pw; px++) {
            const f = Math.min(db.length - 1, Math.max(0, Math.round(((px + 0.5) / pw * seconds * rate - n / 2) / hop)));
            const c = cmap(1 - (top - db[f][k]) / 70), o = (py * pw + px) * 4;
            img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
        }
    }
    g.putImageData(img, L, T);
    const yOf = (hz) => T + ph * (1 - hz / maxHz);
    if (cut && cut / 2 < maxHz) {
        g.fillStyle = 'rgba(230, 230, 225, 0.85)'; g.fillRect(L, T, pw, yOf(cut / 2) - T);
        g.strokeStyle = '#d35400'; g.lineWidth = 2; g.beginPath(); g.moveTo(L, yOf(cut / 2)); g.lineTo(L + pw, yOf(cut / 2)); g.stroke();
    }
    // 目盛り
    g.strokeStyle = '#1e1e1e'; g.lineWidth = 1; g.strokeRect(L + 0.5, T + 0.5, pw - 1, ph - 1);
    g.fillStyle = '#1e1e1e'; g.font = '13px sans-serif';
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let hz = 0; hz <= maxHz; hz += 2000) { g.fillText(String(hz), L - 6, yOf(hz)); g.fillRect(L - 4, Math.round(yOf(hz)), 4, 1); }
    g.textAlign = 'center'; g.textBaseline = 'top';
    const stepS = seconds > 4 ? 2 : seconds > 1.5 ? 1 : 0.5;
    for (let s = 0; s <= seconds + 1e-9; s += stepS) { const px = L + pw * s / seconds; g.fillText(String(s), px, T + ph + 5); g.fillRect(Math.round(px), T + ph, 1, 4); }
    g.fillText('s', L + pw / 2, T + ph + 22);
    g.save(); g.translate(14, T + ph / 2); g.rotate(-Math.PI / 2); g.textBaseline = 'middle'; g.fillText('Hz', 0, 0); g.restore();
    return cv.toDataURL('image/png');
}

// ---------- アプリの頼みごと（ノートブックの Python と同じ名前・同じ形で返す） ----------
const OBJ_SCHEMA = {   // JSON で受け取るときの形（物の名前・数・位置）。位置は、画像の幅と高さをそれぞれ 1 としたときの [左, 上, 右, 下]
    type: 'object',
    properties: { objects: { type: 'array', items: {
        type: 'object',
        properties: { name: { type: 'string', description: '物の名前（日本語）' },
                      count: { type: 'integer', description: 'その物の数' },
                      box: { type: 'array', items: { type: 'number' }, description: '位置。画像の幅と高さを 1 とした [左, 上, 右, 下]' } },
        required: ['name', 'count', 'box'], additionalProperties: false } } },
    required: ['objects'], additionalProperties: false,
};
const VOICE_STATE = { x: null, wav: null, origText: null };   // いま録音してある声と、その文字起こし
const elapsed = (t) => Math.round(performance.now() - t);
const loadImage = (url) => new Promise((ok, ng) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ng(new Error('画像が読めませんでした')); im.src = url; });
function needVoice() {
    if (!VOICE_STATE.x) throw new Error('先に録音してください');
    return VOICE_STATE.x;
}
function sttForm(wav, { prompt, keywords, languages } = {}) {
    const f = new FormData();
    f.append('file', wav, 'voice.wav');
    f.append('model', MODEL_STT);
    if (prompt) f.append('prompt', prompt);
    (keywords || []).forEach((k) => f.append('keywords[]', k));
    (languages || []).forEach((l) => f.append('languages[]', l));
    return f;
}
// 文字起こし。できたところから少しずつ届く（transcript.text.delta）。届いたかけらを1つずつ渡し、最後に全文を返す
async function* transcribeStream(key, wav, opt) {
    const f = sttForm(wav, opt);
    f.append('stream', 'true');
    let text = '';
    yield { type: 'start', key };
    for await (const ev of sse(await call('audio/transcriptions', { form: f }))) {
        if (ev.type === 'transcript.text.delta') { text += ev.delta; yield { type: 'delta', key, text: ev.delta }; }
        else if (ev.type === 'transcript.text.done') text = ev.text;
    }
    return text;
}
// 元の声の文字起こし（同じ声なら1回だけ API を使い、2回目からは前の結果を使う）
async function* origText(key) {
    if (VOICE_STATE.origText === null) {
        VOICE_STATE.origText = yield* transcribeStream(key, VOICE_STATE.wav);
        return [VOICE_STATE.origText, 1];
    }
    yield { type: 'text', key, text: VOICE_STATE.origText };
    return [VOICE_STATE.origText, 0];
}

const TASKS = {
    // 写真に質問する。AIに届く大きさ（2026年10月時点の公式ドキュメント）：low は 512 以内、high は 2048 以内で 32×32 のマスが 2,500 まで。
    // 届く形が見えるように、こちらでその大きさに縮めてから送る
    async *ask_image(d) {
        const im = await loadImage(d.image);
        const detail = d.detail === 'high' ? 'high' : 'low', mode = d.mode === 'json' ? 'json' : 'text';
        let s = Math.min(1, (detail === 'low' ? 512 : 2048) / Math.max(im.naturalWidth, im.naturalHeight));
        if (detail === 'high') s = Math.min(s, Math.sqrt(2500 * 32 * 32 / (im.naturalWidth * im.naturalHeight)));
        const w = Math.max(1, Math.round(im.naturalWidth * s)), h = Math.max(1, Math.round(im.naturalHeight * s));
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const g = cv.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(im, 0, 0, w, h);
        const url = cv.toDataURL('image/jpeg', 0.9);
        const request = { model: MODEL_TEXT, reasoning: { effort: 'low' }, input: [{ role: 'user', content: [
            { type: 'input_text', text: String(d.question || '').slice(0, 1000) },
            { type: 'input_image', image_url: url, detail },
        ] }] };
        if (mode === 'json') request.text = { format: { type: 'json_schema', name: 'objects', strict: true, schema: OBJ_SCHEMA } };   // 決めた形の JSON で返してもらう
        const shown = JSON.parse(JSON.stringify(request));   // 見せる用：写真の文字は先頭だけ
        shown.input[0].content[1].image_url = `${url.slice(0, 40)}…（写真を文字にしたもの。全部で ${url.length.toLocaleString()} 文字）`;
        yield { type: 'sent', detail, mode, sent: [w, h], patches: [Math.ceil(w / 32), Math.ceil(h / 32)], image: url, request: shown, chars: url.length };
        const t = performance.now();
        let text = '', first = null, resp = null;
        for await (const ev of sse(await call('responses', { json: { ...request, stream: true } }))) {
            if (ev.type === 'response.output_text.delta') {
                if (first === null) first = elapsed(t);
                text += ev.delta;
                yield { type: 'delta', text: ev.delta };
            } else if (ev.type === 'response.completed') resp = ev.response;
        }
        if (!resp) throw new AppError({ code: null, title: 'OpenAI からの答えが途中で切れました', cause: 'ネットワークの一時的な不調', fix: '少し待って、もう一度押す' });
        const u = resp.usage;
        const cached = (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
        const reasoning = (u.output_tokens_details && u.output_tokens_details.reasoning_tokens) || 0;
        let data = null;
        if (mode === 'json') { try { data = JSON.parse(text); } catch (e) { data = null; } }
        yield { type: 'done', text, data, ms: elapsed(t), first_ms: first,
                input_tokens: u.input_tokens, cached_tokens: cached, output_tokens: u.output_tokens, reasoning_tokens: reasoning,
                response: { model: resp.model, status: resp.status, output_text: text, usage: u } };
    },

    // 録音した声を、AIに送る形（WAV・1秒に 16,000 回・1チャンネル）にする
    async voice(d) {
        const x = await decodeVoice(d.audio);
        if (!x.length) throw new Error('声が録音できていません。もう一度録音してください');
        Object.assign(VOICE_STATE, { x, wav: wavBlob(SR, x), origText: null });
        return { seconds: x.length / SR };
    },

    // 実験A：ノイズを足す・測る回数を下げる
    async *exp_a(d) {
        const x = needVoice();
        const noise = Math.max(0, Math.min(300, parseInt(d.noise, 10) || 0)), target = +d.rate || SR;
        if (!STT_RATES.includes(target)) throw new Error('サンプリングレートの値が正しくありません');
        const changed = addNoise(measureAndBack(x, SR, target), noise), wav = wavBlob(SR, changed);
        yield { type: 'info', orig_spec: specPNG(x, SR), changed_spec: specPNG(changed, SR, target), changed_audio: await fileToDataURL(wav) };
        const [text0, calls] = yield* origText('A0');
        const text1 = yield* transcribeStream('A1', wav);
        yield { type: 'result', orig_text: text0, changed_text: text1, calls: calls + 1 };
    },

    // 実験B：ヒント（prompt・keywords・languages）を足す
    async *exp_b(d) {
        needVoice();
        const kw = (d.keywords || []).filter((k) => typeof k === 'string' && k.trim()).slice(0, 20);
        const langs = (d.languages || []).filter((l) => l === 'ja' || l === 'en');
        const [plain, calls] = yield* origText('B0');
        const hinted = yield* transcribeStream('B1', VOICE_STATE.wav, { prompt: String(d.prompt || '').slice(0, 300), keywords: kw, languages: langs });
        yield { type: 'result', plain, hinted, calls: calls + 1 };
    },
};
// ページから頼む（1回で返す頼みごと／少しずつ返す頼みごと）
async function api(name, body) { return TASKS[name](body || {}); }
async function apiStream(name, body, onEvent) { for await (const ev of TASKS[name](body || {})) onEvent(ev); }

// ---------- 表示の道具 ----------
// 送った中身・返ってきた中身を、読める形の JSON にする
function jsonBlock(title, obj, open) {
    const d = document.createElement('details');
    d.className = 'json'; d.open = !!open;
    d.innerHTML = '<summary></summary><pre></pre>';
    d.querySelector('summary').textContent = title;
    d.querySelector('pre').textContent = JSON.stringify(obj, null, 2);
    return d;
}
// エラーを出す：番号・何が起きたか・原因の見立て・直し方（くわしくは開くと見える）
function showError(el, e) {
    const i = e && e.info ? e.info : { title: e && e.message ? e.message : String(e) };
    el.className = 'status err';
    el.innerHTML = `<b>エラー${i.code ? ' ' + esc(i.code) : ''}：${esc(i.title)}</b>`
        + (i.cause ? `<br>原因の見立て：${esc(i.cause)}` : '')
        + (i.fix ? `<br>直し方：${esc(i.fix)}` : '')
        + (i.detail ? `<details class="errdetail"><summary>くわしく（管理者に見せる）</summary><code>${esc(i.detail)}</code></details>` : '');
}

// カメラ
async function startCamera(video) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    video.srcObject = stream;
    await video.play();
    return stream;
}
function stopStream(stream) { if (stream) stream.getTracks().forEach((t) => t.stop()); }
function snapshot(video) {
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    return c.toDataURL('image/jpeg', 0.9);
}
function fileToDataURL(file) {
    return new Promise((ok, ng) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = ng; fr.readAsDataURL(file); });
}

// 録音：await start() で始め、stop() で data URL を受け取る。maxSec 秒で自動で止まり、done が解決する
class Recorder {
    async start(maxSec, onTick) {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        this.rec = new MediaRecorder(this.stream);
        this.chunks = [];
        this.rec.ondataavailable = (e) => this.chunks.push(e.data);
        this.done = new Promise((r) => (this.rec.onstop = r));
        this.rec.start();
        this.t0 = Date.now();
        this.timer = setInterval(() => {
            const left = Math.max(0, maxSec - Math.floor((Date.now() - this.t0) / 1000));
            if (onTick) onTick(left);
            if (left <= 0) this.rec.state === 'recording' && this.rec.stop();
        }, 200);
    }
    async stop() {
        if (this.rec && this.rec.state === 'recording') this.rec.stop();
        await this.done;
        clearInterval(this.timer);
        stopStream(this.stream);
        return fileToDataURL(new Blob(this.chunks, { type: this.rec.mimeType }));
    }
}

