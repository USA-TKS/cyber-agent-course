// 体験ページの公開の状態（管理用のページで決める）。公開前の体験は「間もなく公開！」にする
// 管理者の Password を入れたタブ（管理用のページで入れたタブ）では、公開前のものも見られる（公開前に確かめるため）
// 公開の状態が分からないとき（サーバに届かないなど）は、全部を見せる
const PUBLISH_API = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://127.0.0.1:8787/' : 'https://image-speech-api.advent-calendar.workers.dev/';

function isAdminViewer() {
    try { return !!sessionStorage.getItem('image-speech-demos:admin-password'); } catch (e) { return false; }
}

// 公開している体験の番号の一覧。分からないときは null
async function fetchPublished() {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 3000);
    try {
        const r = await fetch(PUBLISH_API + 'published', { signal: ctl.signal, cache: 'no-store' });
        if (!r.ok) return null;
        const j = await r.json();
        return Array.isArray(j.published) ? j.published.map(Number) : null;
    } catch (e) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// スライド：公開前の体験のスライドを外す。外したものがあれば、最後の「間もなく公開！」のスライドを残す
async function gateSlides() {
    const soon = document.querySelector('.slide[data-soon]');
    const list = isAdminViewer() ? null : await fetchPublished();
    let hidden = 0;
    if (list) {
        document.querySelectorAll('.slide[data-group]').forEach((s) => {
            if (!list.includes(+s.dataset.group)) { s.remove(); hidden += 1; }
        });
    }
    if (!hidden && soon) soon.remove();
}

// 体験ページ：<script src="publish.js" data-demo="番号"> で読み込むと、公開前なら「間もなく公開！」を全面に出す
(() => {
    const me = document.currentScript, id = me && +me.dataset.demo;
    if (!id || isAdminViewer()) return;
    const root = document.documentElement;
    root.style.visibility = 'hidden';   // 調べ終わるまで、中身を出さない
    fetchPublished().then((list) => {
        if (list && !list.includes(id)) {
            const show = () => {
                const d = document.createElement('div');
                d.setAttribute('style', 'position:fixed; inset:0; z-index:100000; display:grid; place-items:center; background:#fff; color:#1e1e1e; font-family:"Zen Maru Gothic", sans-serif; text-align:center;');
                d.innerHTML = '<div><p style="font-size:44px; font-weight:900;">間もなく公開！</p>'
                    + '<a href="./" style="display:inline-block; margin-top:24px; padding:8px 22px; border-radius:999px; border:2px solid #1e1e1e; color:#1e1e1e; font-size:18px; font-weight:900; text-decoration:none;">← 一覧に戻る</a></div>';
                document.body.appendChild(d);
            };
            if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
        }
        root.style.visibility = '';
    });
})();
