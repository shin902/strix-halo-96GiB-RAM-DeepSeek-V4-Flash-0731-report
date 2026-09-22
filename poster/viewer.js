const $ = selector => document.querySelector(selector);
const pages = Array.from({ length: 8 }, (_, i) => ({ name: `${String(i + 1).padStart(2, '0')}.html`, html: '' }));
const parse = html => new DOMParser().parseFromString(html, 'text/html');
const escape = value => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let selected = 0;
let loading = false;
const PAPER_WIDTH = 420;
const TRIM = 20;
const pxPerMm = 96 / 25.4;
// Keep relative images and styles relative to the original HTML, not the viewer.
function documentFor(page) {
  const doc = parse(page.html);
  doc.querySelectorAll('script,base,meta[http-equiv]').forEach(node => node.remove());
  const base = doc.createElement('base'); base.href = new URL(`pages/${page.name}`, location.href).href; doc.head.prepend(base);
  const style = doc.createElement('style'); style.textContent = 'html,body{margin:0!important;padding:0!important} .page{margin:0!important;box-shadow:none!important}'; doc.head.append(style);
  return '<!doctype html>' + doc.documentElement.outerHTML;
}
function fit(frame, thumbnail = false) {
  if (thumbnail) {
    const trimmed = $('#trimmed').checked;
    const scale = frame.parentElement.clientWidth / ((PAPER_WIDTH - (trimmed ? TRIM : 0)) * pxPerMm);
    const offset = trimmed && frame.dataset.side === 'left' ? -TRIM * pxPerMm * scale : 0;
    frame.style.transform = `translateX(${offset}px) scale(${scale})`;
    return;
  }
  const body = frame.contentDocument?.body; if (!body) return;
  const scale = frame.clientWidth / (420 * 96 / 25.4);
  body.style.width = '420mm'; body.style.transformOrigin = 'top left'; body.style.transform = `scale(${scale})`;
  frame.style.height = `${297 * 96 / 25.4 * scale}px`;
}
function renderBoard() {
  $('#board').replaceChildren();
  pages.forEach((page, i) => {
    const title = parse(page.html).querySelector('h1')?.textContent || page.name;
    const button = document.createElement('button'); button.className = `tile ${i % 2 === 0 ? 'trim-left' : 'trim-right'}`; button.setAttribute('aria-label', `${page.name}：${title}を拡大`);
    button.innerHTML = `<div class="sheet"><iframe title="${page.name}" sandbox="allow-same-origin" tabindex="-1" aria-hidden="true"></iframe></div><div class="caption"><span>${page.name} · ${escape(title)}</span><span>↗</span></div>`;
    const frame = button.querySelector('iframe'); frame.dataset.side = i % 2 === 0 ? 'left' : 'right'; frame.onload = () => fit(frame, true); frame.srcdoc = documentFor(page);
    button.onclick = () => openPage(i); $('#board').append(button);
  });
}
function openPage(i) {
  selected = i; $('#trim-info').textContent = `${i % 2 === 0 ? '左' : '右'}端を2cmカット → 仕上がり40 × 29.7cm（ここでは裁断前のA3を表示）`; $('#filename').textContent = `pages/${pages[i].name}`;
  $('#original').href = `pages/${pages[i].name}`;
  if (!$('#detail').open) $('#detail').showModal();
  $('#preview').srcdoc = documentFor(pages[i]);
}
$('#trimmed').onchange = () => {
  $('#panel').classList.toggle('trimmed', $('#trimmed').checked);
  document.querySelectorAll('.sheet iframe').forEach(frame => fit(frame, true));
};
$('#preview').onload = () => fit($('#preview'));
$('#close').onclick = () => $('#detail').close();
new ResizeObserver(() => document.querySelectorAll('.sheet iframe').forEach(frame => fit(frame, true))).observe($('#board'));
new ResizeObserver(() => { if ($('#detail').open) fit($('#preview')); }).observe($('.preview-wrap'));
async function load() {
  if (loading) return; loading = true; $('#reload').disabled = true; $('#status').textContent = '読み込み中…';
  try {
    const sources = await Promise.all(pages.map(async page => {
      const response = await fetch(`pages/${page.name}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`${page.name}を読み込めません`);
      return response.text();
    }));
    sources.forEach((html, i) => { pages[i].html = html; }); renderBoard();
    if ($('#detail').open) openPage(selected);
    $('#status').textContent = `${pages.length}枚を読込済み`;
  } catch (error) { $('#status').textContent = error.message; }
  finally { loading = false; $('#reload').disabled = false; }
}
$('#reload').onclick = load;
window.addEventListener('focus', load);
$('#print').onclick = () => {
  // Separate browsing contexts preserve each page's CSS and relative asset URLs.
  const frame = $('#print-frame');
  const sheets = pages.map(page => {
    const doc = parse(documentFor(page));
    const base = new URL(`pages/${page.name}`, location.href);
    doc.querySelectorAll('[src]').forEach(node => node.setAttribute('src', new URL(node.getAttribute('src'), base).href));
    doc.querySelectorAll('link[href]').forEach(node => node.setAttribute('href', new URL(node.getAttribute('href'), base).href));
    return `<section class="print-sheet"><template shadowrootmode="open"><style>:host{display:block;font-family:"Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;color:#202020}body{margin:0}</style>${[...doc.head.querySelectorAll('style,link[rel="stylesheet"]')].map(node => node.outerHTML).join('')}${doc.body.outerHTML}</template></section>`;
  }).join('');
  frame.onload = async () => {
    const roots = [...frame.contentDocument.querySelectorAll('.print-sheet')].map(sheet => sheet.shadowRoot);
    await Promise.all(roots.flatMap(root => [...root.querySelectorAll('img')].map(img => img.decode().catch(() => {}))));
    await frame.contentDocument.fonts.ready;
    frame.contentWindow.focus(); frame.contentWindow.print();
  };
  frame.srcdoc = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><base href="${new URL('pages/', location.href).href}"><title>DS4 Flash Poster</title><style>@page{size:A3 landscape;margin:0}html,body{margin:0}.print-sheet{width:420mm;height:297mm;overflow:hidden;break-after:page;print-color-adjust:exact;-webkit-print-color-adjust:exact}.print-sheet:last-child{break-after:auto}</style></head><body>${sheets}</body></html>`;
};
load();
