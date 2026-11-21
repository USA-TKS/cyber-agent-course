// 体験ページ 4〜7 の共通の道具（中継のサーバへの頼み方・エラーの見立て・料金・写真と声の下ごしらえ・カメラ・録音）
// 写真を縮める・声を整える・模様の図を描くのは、このブラウザの中でする。OpenAI へは中継のサーバ（worker/）を通して頼む。
// APIキーは中継のサーバの中にだけあり、このページには来ない。ページからは合言葉だけを送る
const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 中継のサーバ（手元で試すときは、手元で動かした Worker を使う）
const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8787/' : 'https://image-speech-api.advent-calendar.workers.dev/';
const MODEL_TEXT = 'gpt-6-luna';       // 写真を読む・会話する
const MODEL_STT = 'gpt-transcribe';    // 文字起こし
const MODEL_TTS = 'gpt-4o-mini-tts';   // 音声合成
// 料金（2026年10月時点の公式の料金表。https://developers.openai.com/api/docs/pricing）
const YEN = 150;                                              // 1ドル＝150円で計算
const PRICE_IN = 0.10, PRICE_CACHED = 0.01, PRICE_OUT = 0.50; // gpt-6-luna（100万トークンあたりのドル。入力・前と同じ部分の入力・出力）
const PRICE_STT = 0.0045;                                     // gpt-transcribe（1分あたりのドル）
const PRICE_TTS_IN = 0.60, PRICE_TTS_OUT = 12.00;             // gpt-4o-mini-tts（100万トークンあたりのドル。文字の入力・声の出力）
const SR = 16000;   // 文字起こしの声は、AIに送る形と同じ 1秒に 16,000 回・1チャンネル
const STT_RATES = [16000, 8000, 4000, 3000, 2000];
const TTS_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

// ---------- 料金（円） ----------
function yen(v) {   // 1円より小さい金額も読めるように、桁を変えて出す
    if (v === null || v === undefined) return '料金は分かりませんでした';
    return '約 ' + (v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)) + ' 円';
}
function costTag(v, what) { return `<span class="cost">${what ? what + ' ' : ''}${yen(v)}</span>`; }
// このブラウザで使った料金の合計（ページの上に出す）
const TOTAL_KEY = 'image-speech-demos:total-yen';
let totalMem = 0;
function totalYen() { try { return +localStorage.getItem(TOTAL_KEY) || 0; } catch (e) { return totalMem; } }
function showTotal(total) { const el = $('total'); if (el && typeof total === 'number') el.textContent = '使った料金の合計 ' + yen(total); }
function spend(v) {
    totalMem = totalYen() + v;
    try { localStorage.setItem(TOTAL_KEY, String(totalMem)); } catch (e) { /* 残せない環境では、このページの間だけ数える */ }
    showTotal(totalMem);
    return v;
}
const lunaYen = (u) => {
    const cached = (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
    return ((u.input_tokens - cached) * PRICE_IN + cached * PRICE_CACHED + u.output_tokens * PRICE_OUT) / 1e6 * YEN;
};
const sttYen = (seconds, times = 1) => seconds / 60 * PRICE_STT * YEN * times;
const ttsYen = (u) => ((u.input_tokens || 0) * PRICE_TTS_IN + (u.output_tokens || 0) * PRICE_TTS_OUT) / 1e6 * YEN;

// ---------- エラー：番号・何が起きたか・原因の見立て・直し方 ----------
class AppError extends Error {
    constructor(info) { super(info.title); this.info = info; }
}
const NOT_REACHED = new AppError({ code: null, title: 'サーバに届きませんでした', cause: 'ネットワークが切れた・ネットワークで止められている', fix: '少し待って、もう一度押す。直らなければ講師に' });
// 中継のサーバが止めたとき
const PROXY_HINT = {
    passcode: ['合言葉が違います', '合言葉の打ち間違い（前後の空白など）', 'ページの上の「合言葉」を入れ直す'],
    not_ready: ['サーバの準備ができていません', 'サーバに APIキーか合言葉がまだ入っていない', '講師に伝える'],
    origin: ['このページからは使えません', '体験ページではない場所で開いている', '体験ページの URL から開く'],
    rate: ['短い時間に頼みすぎました', '1分あたりの回数の上限をこえた', '30秒ほど待って、もう一度押す'],
    too_big: ['送るものが大きすぎます', '写真や声が大きい', '小さい写真にするか、短く話す'],
    upstream: ['サーバから OpenAI につながりませんでした', 'ネットワークの一時的な不調', '少し待って、もう一度押す'],
};
function explain(status, body) {
    const e = (body && body.error) || {};
    if (e.type === 'proxy') {
        const h = PROXY_HINT[e.code] || [e.message || 'サーバが受け付けませんでした', '', '講師に伝える'];
        return { code: status, title: h[0], cause: h[1], fix: h[2] };
    }
    const detail = e.message ? `${e.type || ''} ${e.code || ''} ${e.message}`.trim().slice(0, 800) : undefined;
    const out = (title, cause = '', fix = '') => ({ code: status, title, cause, fix, detail });
    if (status === 429 && e.code === 'insufficient_quota') return out('使える金額の上限に達しました', 'サーバのキーのプロジェクトの残高・上限を使い切った', '講師に伝える');
    const table = {
        400: ['送った中身を OpenAI が受け付けませんでした', '設定の値や、モデルとの組み合わせが合っていない', '「くわしく」を講師に見せる'],
        401: ['サーバの APIキーが正しくありません', 'サーバに入れたキーの間違い・無効になったキー', '講師に伝える'],
        403: ['このキーでは、このモデルや機能を使えません', 'キーのプロジェクトで、このモデルが許可されていない', '講師に伝える'],
        404: ['モデルが見つかりません', 'モデルの名前が違う・このキーでは使えないモデル', '講師に伝える'],
        429: ['短い時間に頼みすぎました', '1分あたりの回数やトークンの上限をこえた', '30秒ほど待って、もう一度押す'],
    };
    if (table[status]) return out(...table[status]);
    if (status >= 500) return out('OpenAI の中でエラーが起きました', 'OpenAI 側の一時的な不調', '少し待って、もう一度押す');
    return out(`思わぬエラー（${status}）`, '', '「くわしく」を講師に見せる');
}

// ---------- 合言葉（このタブを閉じるまで覚える） ----------
const PASS_KEY = 'image-speech-demos:passcode';
let passMem = '';
function passcode() { try { return sessionStorage.getItem(PASS_KEY) || ''; } catch (e) { return passMem; } }
function setPass(v) { passMem = v; try { sessionStorage.setItem(PASS_KEY, v); } catch (e) { /* このページの間だけ覚える */ } }
async function checkPass() {
    const el = $('passState');
    if (!el) return;
    if (!passcode()) { el.textContent = ''; el.className = 'passstate'; return; }
    el.textContent = '…'; el.className = 'passstate';
    try {
        const r = await fetch(API_BASE + 'check', { headers: { 'X-Passcode': passcode() } });
        el.textContent = r.ok ? 'OK' : r.status === 401 ? '違います' : 'サーバの準備中';
        el.className = 'passstate ' + (r.ok ? 'ok' : 'ng');
    } catch (e) { el.textContent = 'サーバに届きません'; el.className = 'passstate ng'; }
}

// ---------- 中継のサーバに頼む ----------
async function call(path, { json, form } = {}) {
    if (!passcode()) throw new AppError({ code: null, title: '合言葉が入っていません', cause: '', fix: 'ページの上の「合言葉」の欄に、講師から聞いた合言葉を入れる' });
    let r;
    try {
        r = await fetch(API_BASE + 'v1/' + path, {
            method: 'POST',
            headers: json ? { 'X-Passcode': passcode(), 'Content-Type': 'application/json' } : { 'X-Passcode': passcode() },
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
// 多くの音声認識AIが読む形：0.025秒ずつ、0.01秒ずらして、低い音〜高い音を80段（メル）に分けたマスの画像
function melPNG(x, rate, nMels = 80) {
    const n = Math.floor(rate * 0.025), hop = Math.floor(rate * 0.01), nfft = 512;
    if (x.length < n) { const p = new Float32Array(n); p.set(x); x = p; }
    const win = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
    const power = powerFrames(x, n, hop, nfft, win), frames = power.length;
    const toMel = (f) => 2595 * Math.log10(1 + f / 700), fromMel = (m) => 700 * (10 ** (m / 2595) - 1);
    const edges = Array.from({ length: nMels + 2 }, (_, i) => Math.floor((nfft + 1) * fromMel(toMel(rate / 2) * i / (nMels + 1)) / rate));
    const m = power.map((p) => Array.from({ length: nMels }, (_, i) => {   // 三角形の重みで、となりの段と少し重ねて足す
        const l = edges[i], c = edges[i + 1], r = Math.max(edges[i + 2], edges[i + 1] + 1);
        let s = 0;
        for (let k = l; k < c; k++) s += p[k] * (k - l) / Math.max(1, c - l);
        for (let k = c; k < r && k < p.length; k++) s += p[k] * (r - k) / Math.max(1, r - c);
        return Math.log10(Math.max(s, 1e-10));
    }));
    let hi = -Infinity;
    m.forEach((row) => row.forEach((v) => { if (v > hi) hi = v; }));
    let lo = Infinity;
    m.forEach((row) => row.forEach((v, i) => { row[i] = Math.max(v, hi - 8); if (row[i] < lo) lo = row[i]; }));
    const cv = document.createElement('canvas'); cv.width = frames * 2; cv.height = nMels * 2;
    const g = cv.getContext('2d');
    m.forEach((row, f) => row.forEach((v, i) => {
        const c = cmap((v - lo) / (hi - lo + 1e-9));
        g.fillStyle = `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;
        g.fillRect(f * 2, (nMels - 1 - i) * 2, 2, 2);   // 上が高い音
    }));
    return { url: cv.toDataURL('image/png'), frames };
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
const NEXT_PROMPT = 'あなたは、中学生・高校生の作品づくりを手伝う先輩です。'
    + '作品を見せたときにグループの人から出た意見のメモ（使ってどう思ったか／欲しい機能／開発の仕方）を読み、'
    + '次の1週間でやることの候補を3つ出してください。'
    + '意見の中から、作品をよくするのに大事なものを選び、1つの候補は何をするかが分かる短い1文にしてください。'
    + '否定はせず、中学生にも分かる日本語で、番号を付けて候補だけを3行で書いてください。';
const VOICE_STATE = { x: null, wav: null, origText: null };   // いま録音してある声と、その文字起こし
const elapsed = (t) => Math.round(performance.now() - t);
const loadImage = (url) => new Promise((ok, ng) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ng(new Error('画像が読めませんでした')); im.src = url; });
const outputText = (resp) => (resp.output || []).flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
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
// 文字を声にする。stream_format "sse" で頼むと声が少しずつ届き、最後の知らせ（speech.audio.done）に使ったトークン数が付く
async function* speak(args) {
    let r;
    try { r = await call('audio/speech', { json: { ...args, stream_format: 'sse' } }); }
    catch (e) {   // sse で頼めないときは、ふつうに頼む（料金は分からない）
        if (!e.info || e.info.code !== 400) throw e;
        return [await (await call('audio/speech', { json: args })).blob(), null];
    }
    if (!(r.headers.get('Content-Type') || '').includes('event-stream')) return [await r.blob(), null];
    const parts = [];
    let usage = null, n = 0, size = 0;
    for await (const ev of sse(r)) {
        if (ev.type === 'speech.audio.delta') {
            const b = Uint8Array.from(atob(ev.audio), (c) => c.charCodeAt(0));
            parts.push(b); size += b.length; n += 1;
            yield { type: 'audio_chunk', n, kb: size / 1024 };
        } else if (ev.type === 'speech.audio.done') usage = ev.usage || null;
    }
    return [new Blob(parts, { type: 'audio/mpeg' }), usage];
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
                yen_in: ((u.input_tokens - cached) * PRICE_IN + cached * PRICE_CACHED) / 1e6 * YEN,
                yen_out: u.output_tokens * PRICE_OUT / 1e6 * YEN, yen: spend(lunaYen(u)),
                response: { model: resp.model, status: resp.status, output_text: text, usage: u } };
    },

    // 録音した声を、AIに送る形（WAV・1秒に 16,000 回・1チャンネル）にする
    async voice(d) {
        const x = await decodeVoice(d.audio);
        if (!x.length) throw new Error('声が録音できていません。もう一度録音してください');
        const wav = wavBlob(SR, x), mel = melPNG(x, SR);
        Object.assign(VOICE_STATE, { x, wav, origText: null });
        return { seconds: x.length / SR, spec: specPNG(x, SR), rate: SR, kb: wav.size / 1024, mel: mel.url, frames: mel.frames };
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
        yield { type: 'result', orig_text: text0, changed_text: text1, calls: calls + 1, yen: spend(sttYen(x.length / SR, calls + 1)) };
    },

    // 実験B：ヒント（prompt・keywords・languages）を足す
    async *exp_b(d) {
        const x = needVoice();
        const kw = (d.keywords || []).filter((k) => typeof k === 'string' && k.trim()).slice(0, 20);
        const langs = (d.languages || []).filter((l) => l === 'ja' || l === 'en');
        const [plain, calls] = yield* origText('B0');
        const hinted = yield* transcribeStream('B1', VOICE_STATE.wav, { prompt: String(d.prompt || '').slice(0, 300), keywords: kw, languages: langs });
        yield { type: 'result', plain, hinted, calls: calls + 1, yen: spend(sttYen(x.length / SR, calls + 1)) };
    },

    // 3つのAIのリレー：声 → 文字（gpt-transcribe）→ 返事（gpt-6-luna）→ 声（gpt-4o-mini-tts）。区切りごとに知らせる
    async *chat(d) {
        const x = await decodeVoice(d.audio), wav = wavBlob(SR, x);
        let t = performance.now();
        const heard = await (await call('audio/transcriptions', { form: sttForm(wav, { languages: ['ja'] }) })).json();
        const userText = String(heard.text || '').trim();
        const stt = spend(sttYen(x.length / SR));
        if (!userText) throw new Error(`声が聞き取れませんでした。もう一度話してください（文字起こしの料金 約 ${stt.toFixed(3)} 円）`);
        yield { type: 'heard', text: userText, ms: elapsed(t), yen: stt, seconds: x.length / SR, kb: wav.size / 1024, chars: userText.length };
        const history = (d.history || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
            .map((m) => ({ role: m.role, content: String(m.content) })).slice(-20);
        const messages = [{ role: 'system', content: d.system || '' }, ...history, { role: 'user', content: userText }];
        yield { type: 'sent', request: { model: MODEL_TEXT, reasoning: { effort: 'low' }, input: messages } };
        t = performance.now();
        let reply = '', first = null, usage = null;
        for await (const ev of sse(await call('responses', { json: { model: MODEL_TEXT, reasoning: { effort: 'low' }, input: messages, stream: true } }))) {
            if (ev.type === 'response.output_text.delta') {
                if (first === null) first = elapsed(t);
                reply += ev.delta;
                yield { type: 'delta', text: ev.delta };
            } else if (ev.type === 'response.completed') usage = ev.response.usage;
        }
        const cached = (usage && usage.input_tokens_details && usage.input_tokens_details.cached_tokens) || 0;
        yield { type: 'reply', text: reply, ms: elapsed(t), first_ms: first, yen: usage ? spend(lunaYen(usage)) : 0,
                input_tokens: usage ? usage.input_tokens : 0, output_tokens: usage ? usage.output_tokens : 0, cached_tokens: cached, chars: reply.length };
        const args = { model: MODEL_TTS, voice: TTS_VOICES.includes(d.voice) ? d.voice : 'marin', input: reply,
                       speed: Math.max(0.5, Math.min(2, +d.speed || 1)), response_format: 'mp3' };
        if (d.instructions) args.instructions = d.instructions;
        t = performance.now();
        yield { type: 'tts_start' };
        const [audio, ttsUsage] = yield* speak(args);
        yield { type: 'audio', audio: await fileToDataURL(audio), ms: elapsed(t), kb: audio.size / 1024,
                yen: ttsUsage ? spend(ttsYen(ttsUsage)) : null, tts_usage: ttsUsage };
    },

    // 意見メモから、次にやることの候補を3つ出してもらう
    async next(d) {
        const memo = `作品名：${String(d.title || '').slice(0, 100)}\n使ってどう思ったか：${String(d.feel || '').slice(0, 1000)}\n`
            + `欲しい機能：${String(d.want || '').slice(0, 1000)}\n開発の仕方：${String(d.dev || '').slice(0, 1000)}`;
        const resp = await (await call('responses', { json: { model: MODEL_TEXT, reasoning: { effort: 'low' },
            input: [{ role: 'system', content: NEXT_PROMPT }, { role: 'user', content: memo }] } })).json();
        const text = outputText(resp);
        const lines = text.split('\n').map((l) => l.replace(/^\s*([0-9０-９]+[.)．、）]|[-・*])\s*/, '').trim()).filter(Boolean);
        return { ideas: lines.length ? lines.slice(0, 3) : [text], yen: spend(lunaYen(resp.usage)),
                 input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens };
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
        + (i.detail ? `<details class="errdetail"><summary>くわしく（講師に見せる）</summary><code>${esc(i.detail)}</code></details>` : '');
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

// ページを開いたとき：料金の合計と、合言葉の欄
showTotal(totalYen());
if ($('pass')) {
    $('pass').value = passcode();
    $('pass').addEventListener('change', () => { setPass($('pass').value.trim()); checkPass(); });
    checkPass();
}
