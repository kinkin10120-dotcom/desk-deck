'use strict';
const $ = (s) => document.querySelector(s);

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

// ---- 토큰: 주소의 ?t= 로 들어오면 저장하고 주소에서 지움 ----
let token = lsGet('deck.token') || '';
{
  const u = new URL(location.href);
  const t = u.searchParams.get('t');
  if (t) { token = t.trim(); lsSet('deck.token', token); history.replaceState(null, '', location.pathname); }
}

const LAYOUTS = [[3, 2, '6키 (3×2)'], [5, 3, '15키 (5×3)'], [6, 4, '24키 (6×4)'], [8, 4, '32키 (8×4)']];
// 페이지마다 칸 수를 따로 둘 수 있음 (없으면 전체 기본값). 저장은 '가로 기준'으로.
const baseCols = () => (config && curPage().cols) || config.cols;
const baseRows = () => (config && curPage().rows) || config.rows;
// 화면 방향에 맞춰 돌림: 가로면 긴 쪽이 열, 세로면 긴 쪽이 행 (예: 6×4 ↔ 4×6) → 어느 방향이든 꽉 참
const isPortrait = () => window.innerHeight > window.innerWidth;
const pageCols = () => (isPortrait() ? Math.min(baseCols(), baseRows()) : Math.max(baseCols(), baseRows()));
const pageRows = () => (isPortrait() ? Math.max(baseCols(), baseRows()) : Math.min(baseCols(), baseRows()));
let lastPortrait = null;
window.addEventListener('resize', () => {
  if (!config) return;
  const p = isPortrait();
  if (p !== lastPortrait) { lastPortrait = p; renderGrid(); }
});

let config = null;
let pageIdx = 0;
let navStack = [];
let editing = false;
let moveFrom = null;
let editIdx = null;

const HINTS = {
  power: '<b>lock</b> 화면 잠금 · <b>monitoroff</b> 화면 끄기 · <b>sleep</b> 절전 · <b>restart</b> 10초 후 재시작 · <b>shutdown</b> 10초 후 끄기 · <b>cancel</b> 재시작/끄기 취소<br>절전·재시작·끄기는 누를 때 확인 창이 뜹니다.',
  window: '누르면 그 프로그램 창을 맨 앞으로 가져옵니다. 같은 창이 여러 개면 누를 때마다 다음 창으로, 꺼져 있으면 실행합니다.<br>'
    + '프로그램 이름(예: <b>excel</b>, <b>Inventor</b>, <b>chrome</b>) 또는 창 제목에 들어간 글자(예: <b>YouTube</b>). '
    + '여러 이름은 쉼표로, 창이 없을 때 열 것은 <b>|</b> 뒤에: <b>YouTube|https://www.youtube.com</b>',
  key: '예: ctrl+c · win+shift+s · e · f6 · ctrl+k ctrl+c (공백으로 구분하면 차례대로 입력)<br>키 이름: ctrl shift alt win · a–z 0–9 f1–f24 · enter esc tab space backspace delete home end pageup pagedown · up down left right · volumeup volumedown volumemute playpause next prev · hangul hanja printscreen · ] / . , -',
  text: '적은 글자를 PC의 현재 커서 위치에 그대로 타이핑합니다. 줄바꿈은 Enter로 입력됩니다.<br><b>{date}</b> → 오늘 날짜, <b>{time}</b> → 현재 시각',
  open: '예: notepad · calc · https://www.youtube.com · C:\\업무\\부품.ipt · explorer shell:Downloads',
  macro: '한 줄에 하나씩 차례대로 실행:<br><b>key</b> ctrl+c · <b>text</b> 안녕하세요 · <b>open</b> notepad · <b>wait</b> 500 (ms) · <b>lock</b><br>text 줄의 \\n 은 Enter, # 으로 시작하면 주석',
  page: '누르면 선택한 페이지로 이동합니다 (실제 스트림 덱의 폴더처럼).',
  back: '직전에 보던 페이지로 돌아갑니다. 기록이 없으면 첫 페이지로 갑니다.',
  lock: 'Windows 화면을 잠급니다 (Win+L 과 같음).',
};

// ---------------- 서버 통신 ----------------
const API_BASE = (window.DECK_API || '').replace(/\/$/, '');
const HOSTED = !!API_BASE; // 공개 호스팅에서 열린 화면인지

async function api(path, body) {
  path = API_BASE + path;
  const opts = { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Deck-Token': token } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let res;
  try { res = await fetch(path, { ...opts, signal: ctrl.signal }); }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'PC가 8초 동안 응답하지 않습니다' : 'PC 서버에 연결할 수 없습니다'); }
  finally { clearTimeout(timer); }
  if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

function setOnline(on) { $('#status').classList.toggle('on', on); }

let saveTimer = null;
function persist() {
  lsSet('deck.config', JSON.stringify(config));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await api('/api/config', config); setOnline(true); }
    catch (e) { if (e.message !== 'unauthorized') toast('PC에 저장하지 못했습니다: ' + e.message, true); }
  }, 300);
}

function defaults() {
  const pages = JSON.parse(JSON.stringify(DEFAULT_PAGES));
  pages.forEach((p) => { if (AUTO_RULES[p.name]) p.auto = AUTO_RULES[p.name]; });
  return { version: CONFIG_VERSION, cols: 5, rows: 3, pages };
}

// 폴더 페이지 빈 칸을 PC 의 최근 폴더로 채우기
async function fillRecentFolders(pages) {
  const page = pages.find((p) => p.name === '폴더');
  if (!page) return;
  let rec;
  try { rec = await api('/api/recent'); } catch { return; }
  const used = new Set(page.buttons.filter(Boolean).map((b) => b.value));
  const n = config ? config.cols * config.rows : 15;
  for (const path of rec.folders || []) {
    if (used.has(path)) continue;
    if (/[\\/](Downloads|Desktop|Documents|다운로드|바탕 화면|문서)$/i.test(path.replace(/[\\/]+$/, ''))) continue;
    let slot = -1;
    for (let i = 0; i < n; i++) if (!page.buttons[i]) { slot = i; break; }
    if (slot < 0) break;
    const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
    page.buttons[slot] = { label: name, icon: 'i:folder', color: COLORS.app, type: 'open', value: path };
    used.add(path);
  }
}

// ---- 앱별 자동 페이지 전환 ----
function ruleMatches(rule, fg) {
  const p = (fg.process || '').toLowerCase(), t = (fg.title || '').toLowerCase();
  return (rule || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).some((n) => p === n || t.includes(n));
}
let lastAutoMatch = null, autoBusy = false;
async function autoSwitchTick() {
  if (!config || editing || autoBusy || document.hidden || lsGet('deck.autoSwitch') === 'off' || $('#editor').open) return;
  if (!config.pages.some((p) => p.auto)) return;
  autoBusy = true;
  try {
    const fg = await api('/api/foreground');
    const match = config.pages.find((p) => p.auto && ruleMatches(p.auto, fg));
    const key = match ? match.name : '';
    if (key === lastAutoMatch) return;
    lastAutoMatch = key;
    const cur = curPage();
    if (match) { if (!(cur.auto && ruleMatches(cur.auto, fg))) goPage(config.pages.indexOf(match)); }
    else if (cur.auto) goPage(0);
  } catch { /* 연결 문제는 상태 점으로 표시됨 */ } finally { autoBusy = false; }
}
setInterval(autoSwitchTick, 1000);

// ---------------- 렌더링 ----------------
const curPage = () => config.pages[pageIdx];

function goPage(i, push = true) {
  if (i === pageIdx || i < 0 || i >= config.pages.length) return;
  if (push) navStack.push(pageIdx);
  pageIdx = i;
  moveFrom = null;
  lsSet('deck.page', i);
  render();
}

function goBack() {
  goPage(navStack.length ? navStack.pop() : 0, false);
}

const THEMES = [['tint', '틴트'], ['neon', '네온'], ['keycap', '키캡'], ['glass', '글래스']];
const PRESS = [['cap', '키캡처럼 쑥'], ['shrink', '살짝 작아짐']];
function applyTheme() {
  const t = (config && config.theme) || 'glass';
  THEMES.forEach(([k]) => document.body.classList.toggle('theme-' + k, k === t));
  const p = (config && config.press) || 'cap';
  document.body.classList.toggle('press-cap', p === 'cap');
  const sel = $('#themeSel');
  if (sel) sel.value = t;
  const ps = $('#pressSel');
  if (ps) ps.value = p;
}

function render() {
  if (!config) return;
  applyTheme();
  document.body.classList.toggle('editing', editing);
  $('#pageName').textContent = curPage().name;
  $('#layoutSel').value = `${Math.max(baseCols(), baseRows())}x${Math.min(baseCols(), baseRows())}`;
  lastPortrait = isPortrait();
  $('#autoToggleBtn').textContent = '자동 전환: ' + (lsGet('deck.autoSwitch') === 'off' ? '꺼짐' : '켜짐');
  $('#autoRuleBtn').textContent = '자동 전환 앱' + (curPage().auto ? ` (${curPage().auto})` : '');
  renderDots();
  renderGrid();
}

function renderDots() {
  return; // 페이지 점은 표시하지 않음 (폴더·뒤로·좌우 밀기로 이동)
  const nav = $('#dots');
  nav.innerHTML = '';
  config.pages.forEach((p, i) => {
    const d = document.createElement('button');
    d.className = 'dot' + (i === pageIdx ? ' active' : '');
    d.title = p.name;
    d.setAttribute('aria-label', p.name);
    d.onclick = () => goPage(i);
    nav.append(d);
  });
}

function isTextIcon(s) { return /^[\x21-\x7E\u2190-\u21FF\u25A0-\u25FF\uAC00-\uD7A3\u4E00-\u9FFF]{1,5}$/.test(s); }

// \uC544\uC774\uCF58 \uC694\uC18C \uB9CC\uB4E4\uAE30: "i:\uC774\uB984" \u2192 \uB2E8\uC0C9 \uC120 \uC544\uC774\uCF58, \uC9E7\uC740 \uAE00\uC790 \u2192 \uAE00\uC790, \uADF8 \uC678(\uC774\uBAA8\uC9C0) \u2192 \uD751\uBC31 \uCC98\uB9AC
function iconEl(icon) {
  const span = document.createElement('span');
  span.className = 'k-icon';
  if (icon && icon.startsWith('b:') && typeof BRANDS !== 'undefined' && BRANDS[icon.slice(2)]) {
    span.classList.add('svg', 'brand');
    span.innerHTML = brandSvg(icon.slice(2));
  } else if (icon && icon.startsWith('i:') && ICONS[icon.slice(2)]) {
    span.classList.add('svg');
    span.innerHTML = svgIcon(icon.slice(2));
  } else if (isTextIcon(icon || '')) {
    span.classList.add('txt', icon.length <= 2 ? 'l' : icon.length === 3 ? 'm' : 's');
    span.textContent = icon;
  } else {
    span.classList.add('emoji');
    span.textContent = icon || '';
  }
  return span;
}
function brandSvg(slug) {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${BRANDS[slug]}"/></svg>`;
}
function svgIcon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

function renderGrid() {
  const grid = $('#grid');
  grid.style.setProperty('--cols', pageCols());
  grid.style.setProperty('--rows', pageRows());
  layoutKeys();
  grid.innerHTML = '';
  const page = curPage();
  const n = pageCols() * pageRows();
  for (let i = 0; i < n; i++) {
    const b = page.buttons[i] || null;
    const el = document.createElement('button');
    el.className = 'key' + (b ? '' : ' empty') + (moveFrom === i ? ' moving' : '');
    const face = document.createElement('div');
    face.className = 'face';
    if (b) {
      const icon = b.icon || '';
      el.style.setProperty('--c', b.color || '#9ca3af');
      if (b.color) {
        const dot = document.createElement('span');
        dot.className = 'k-dot';
        dot.style.background = b.color;
        face.append(dot);
      }
      face.append(iconEl(icon));
      if (b.label) {
        const lb = document.createElement('span');
        lb.className = 'k-label';
        lb.textContent = b.label;
        face.append(lb);
      } else face.classList.add('no-label');
      if (b.type === 'page') {
        const bd = document.createElement('span');
        bd.className = 'k-badge';
        bd.innerHTML = svgIcon('chevron-right');
        face.append(bd);
      }
      if (b.type === 'back') el.classList.add('back');
      el.setAttribute('aria-label', b.label || icon);
    } else {
      face.innerHTML = `<span class="k-plus">${svgIcon('plus')}</span>`;
    }
    el.append(face);
    el.onclick = () => onKey(i, el);
    grid.append(el);
  }
}

// 버튼 크기는 CSS 그리드가 화면에 꽉 차게 자동으로 맞춤 (예전 고정 크기 계산은 사용 안 함)
function layoutKeys() {}

// 좌우로 밀어서 페이지 넘기기
{
  let sx = null, sy = 0;
  const st = $('#stage');
  st.addEventListener('pointerdown', (e) => { sx = e.clientX; sy = e.clientY; });
  st.addEventListener('pointerup', (e) => {
    if (sx === null || !config) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    sx = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      const j = pageIdx + (dx < 0 ? 1 : -1);
      if (j >= 0 && j < config.pages.length) goPage(j);
    }
  });
  st.addEventListener('pointercancel', () => { sx = null; });
}

async function onKey(i, el) {
  const page = curPage();
  if (editing) {
    if (moveFrom !== null) {
      const a = page.buttons[moveFrom] || null;
      page.buttons[moveFrom] = page.buttons[i] || null;
      page.buttons[i] = a;
      moveFrom = null;
      persist(); render();
      return;
    }
    openEditor(i);
    return;
  }
  const b = page.buttons[i];
  if (!b) return;
  if (navigator.vibrate) navigator.vibrate(12);
  if (b.type === 'page') {
    const j = config.pages.findIndex((p) => p.name === b.value);
    if (j < 0) toast(`'${b.value}' 페이지가 없습니다`, true);
    else goPage(j);
    return;
  }
  if (b.type === 'back') { goBack(); return; }
  const risky = b.confirm || (b.type === 'power' && ['sleep', 'restart', 'shutdown'].includes(b.value));
  if (risky && !confirm(`PC '${b.label}'을(를) 실행할까요?`)) return;

  // 같은 버튼이 아직 실행 중이면 무시 (연타로 PC에 명령이 줄 서는 것 방지)
  const flightKey = pageIdx + ':' + i;
  if (inFlight.has(flightKey)) return;
  inFlight.add(flightKey);
  el.classList.remove('fire', 'ok', 'err');
  void el.offsetWidth;
  el.classList.add('fire');
  try {
    await api('/api/run', { type: b.type, value: b.value, label: b.label });
    setOnline(true);
    el.classList.add('ok');
    setTimeout(() => el.classList.remove('ok'), 300);
  } catch (e) {
    el.classList.add('err');
    setTimeout(() => el.classList.remove('err'), 800);
    if (e.message !== 'unauthorized') toast(e.message, true);
  } finally {
    inFlight.delete(flightKey);
  }
}
const inFlight = new Set();

let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ---------------- 편집 ----------------
const PRESET_GROUPS = DEFAULT_PAGES.concat([EXTRA_PRESETS]);

function fillPresetSelect() {
  const sel = $('#presetSel');
  sel.innerHTML = '<option value="">— 선택 안 함 —</option>';
  PRESET_GROUPS.forEach((pg, gi) => {
    const og = document.createElement('optgroup');
    og.label = pg.name;
    pg.buttons.forEach((b, bi) => {
      if (!b || b.type === 'back') return;
      const o = document.createElement('option');
      o.value = gi + ':' + bi;
      o.textContent = b.label + (b.type === 'key' ? `  (${b.value})` : '');
      og.append(o);
    });
    sel.append(og);
  });
  sel.onchange = () => {
    if (!sel.value) return;
    const [gi, bi] = sel.value.split(':').map(Number);
    setEditor(PRESET_GROUPS[gi].buttons[bi]);
  };
}

function fillSwatches() {
  const box = $('#swatches');
  box.innerHTML = '';
  SWATCHES.forEach((c) => {
    const s = document.createElement('button');
    s.type = 'button'; s.className = 'swatch' + (c ? '' : ' none'); s.dataset.c = c;
    if (c) s.style.background = c; else s.title = '없음';
    s.onclick = () => selectColor(c);
    box.append(s);
  });
  const custom = document.createElement('input');
  custom.type = 'color'; custom.id = 'fColor'; custom.title = '직접 고르기';
  custom.oninput = () => selectColor(custom.value);
  box.append(custom);
}

let editColor = '';
function selectColor(c) {
  editColor = c || '';
  if (editColor) $('#fColor').value = editColor;
  document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('sel', s.dataset.c.toLowerCase() === editColor.toLowerCase()));
}

// 아이콘 고르기
function fillIconPicker() {
  const box = $('#iconPicker');
  box.innerHTML = '';
  // 앱 로고 먼저
  Object.keys(BRANDS).forEach((slug) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = slug;
    b.innerHTML = brandSvg(slug);
    b.onclick = () => { $('#fIcon').value = 'b:' + slug; updateIconPreview(); box.hidden = true; };
    box.append(b);
  });
  Object.keys(ICONS).sort().forEach((name) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = name;
    b.innerHTML = svgIcon(name);
    b.onclick = () => { $('#fIcon').value = 'i:' + name; updateIconPreview(); box.hidden = true; };
    box.append(b);
  });
  $('#pickIconBtn').onclick = () => { box.hidden = !box.hidden; };
  $('#fIcon').oninput = updateIconPreview;
}
function updateIconPreview() {
  const p = $('#iconPreview');
  p.innerHTML = '';
  p.append(iconEl($('#fIcon').value.trim()));
}

function fillPageSelect(selected) {
  const sel = $('#fPage');
  sel.innerHTML = '';
  config.pages.forEach((p) => sel.add(new Option(p.name, p.name)));
  if (selected && config.pages.some((p) => p.name === selected)) sel.value = selected;
}

function setEditor(b) {
  $('#fIcon').value = b.icon || '';
  $('#iconPicker').hidden = true;
  updateIconPreview();
  $('#fLabel').value = b.label || '';
  selectColor(b.color || '');
  $('#fType').value = b.type || 'key';
  $('#fLine').value = ['key', 'open', 'window', 'power'].includes(b.type) ? (b.value || '') : '';
  $('#fArea').value = (b.type === 'text' || b.type === 'macro') ? (b.value || '') : '';
  fillPageSelect(b.type === 'page' ? b.value : '');
  updateTypeUI();
}

function readEditor() {
  const type = $('#fType').value;
  let value = '';
  if (type === 'text' || type === 'macro') value = $('#fArea').value;
  else if (['key', 'open', 'window', 'power'].includes(type)) value = $('#fLine').value.trim();
  else if (type === 'page') value = $('#fPage').value;
  return { label: $('#fLabel').value.trim(), icon: $('#fIcon').value.trim(), color: editColor, type, value };
}

function updateTypeUI() {
  const t = $('#fType').value;
  $('#chips').hidden = t !== 'key';
  $('#fLine').hidden = !['key', 'open', 'window', 'power'].includes(t);
  $('#pickWinBtn').hidden = t !== 'window';
  $('#winList').hidden = true;
  $('#fArea').hidden = !(t === 'text' || t === 'macro');
  $('#fPage').hidden = t !== 'page';
  $('#testBtn').hidden = t === 'page' || t === 'back';
  $('#fLine').placeholder = t === 'key' ? 'ctrl+shift+s' : t === 'window' ? 'excel' : t === 'power' ? 'sleep' : 'notepad 또는 https://...';
  $('#fArea').placeholder = t === 'macro' ? 'open notepad\nwait 1000\ntext 안녕하세요' : '입력할 문구';
  $('#hint').innerHTML = HINTS[t];
}

function openEditor(i) {
  editIdx = i;
  const existing = curPage().buttons[i];
  $('#editorTitle').textContent = existing ? '버튼 편집' : '새 버튼';
  $('#presetSel').value = '';
  setEditor(existing || { label: '', icon: '', color: '', type: 'key', value: '' });
  $('#delBtn').hidden = !existing;
  $('#moveBtn').hidden = !existing;
  $('#editor').showModal();
}

// 프로그램 이름 → 어울리는 아이콘/이름
const APP_HINTS = {
  inventor: ['Inventor', 'b:autodesk'], excel: ['Excel', 'b:microsoftexcel'], chrome: ['Chrome', 'b:googlechrome'], msedge: ['Edge', 'i:globe'],
  weixin: ['WeChat', 'b:wechat'], wechat: ['WeChat', 'b:wechat'], kakaotalk: ['카카오톡', 'b:kakaotalk'],
  explorer: ['탐색기', 'i:folder-open'], claude: ['Claude', 'b:claude'], winword: ['Word', 'b:microsoftword'], powerpnt: ['PowerPoint', 'b:microsoftpowerpoint'],
  outlook: ['Outlook', 'i:mail'], olk: ['Outlook', 'i:mail'], notepad: ['메모장', 'i:notepad-text'], calculatorapp: ['계산기', 'i:calculator'],
  'ms-teams': ['Teams', 'i:users'], teams: ['Teams', 'i:users'], acad: ['AutoCAD', 'b:autocad'], parsecd: ['Parsec', 'i:monitor'],
  blender: ['Blender', 'b:blender'], illustrator: ['Illustrator', 'b:adobeillustrator'], photoshop: ['Photoshop', 'b:adobephotoshop'],
  anycubicphotonworkshop: ['Anycubic', 'b:anycubic'], keyshot: ['KeyShot', 'i:camera'],
};

async function pickWindow() {
  const box = $('#winList');
  box.hidden = false;
  box.textContent = '불러오는 중…';
  let list;
  try { list = await api('/api/windows'); } catch (e) { box.textContent = e.message; return; }
  box.innerHTML = '';
  list.forEach((w) => {
    const b = document.createElement('button');
    b.type = 'button';
    const p = document.createElement('span'); p.className = 'proc'; p.textContent = w.process;
    const t = document.createElement('span'); t.className = 'ttl'; t.textContent = w.title;
    b.append(p, t);
    b.onclick = () => {
      const hint = APP_HINTS[(w.process || '').toLowerCase()];
      $('#fLine').value = w.process;
      if (!$('#fLabel').value.trim()) $('#fLabel').value = hint ? hint[0] : w.process;
      if (!$('#fIcon').value.trim()) { $('#fIcon').value = hint ? hint[1] : 'i:app-window'; updateIconPreview(); }
      box.hidden = true;
    };
    box.append(b);
  });
  if (!list.length) box.textContent = '열린 창이 없습니다';
}

function setupEditor() {
  fillPresetSelect();
  fillSwatches();
  fillIconPicker();
  $('#pickWinBtn').onclick = pickWindow;
  $('#fType').onchange = updateTypeUI;
  document.querySelectorAll('#chips button').forEach((c) => {
    c.onclick = () => {
      const f = $('#fLine');
      f.value = c.dataset.k === '' ? '' : f.value + c.dataset.k;
      f.focus();
    };
  });
  $('#cancelBtn').onclick = () => $('#editor').close();
  $('#saveBtn').onclick = () => {
    const b = readEditor();
    if (!b.label && !b.icon) { toast('이름이나 아이콘을 입력하세요', true); return; }
    if (!['lock', 'back'].includes(b.type) && !b.value.trim()) { toast('동작 내용을 입력하세요', true); return; }
    curPage().buttons[editIdx] = b;
    persist(); render();
    $('#editor').close();
  };
  $('#delBtn').onclick = () => {
    curPage().buttons[editIdx] = null;
    persist(); render();
    $('#editor').close();
  };
  $('#moveBtn').onclick = () => {
    moveFrom = editIdx;
    $('#editor').close();
    render();
    toast('옮길 칸을 누르세요 (버튼이 있으면 서로 바뀝니다)');
  };
  $('#testBtn').onclick = async () => {
    try { await api('/api/run', readEditor()); toast('PC에서 실행했습니다'); }
    catch (e) { if (e.message !== 'unauthorized') toast(e.message, true); }
  };
}

function setupEditBar() {
  THEMES.forEach(([k, name]) => $('#themeSel').add(new Option(name, k)));
  $('#themeSel').onchange = (e) => { config.theme = e.target.value; persist(); render(); };
  PRESS.forEach(([k, name]) => $('#pressSel').add(new Option(name, k)));
  $('#pressSel').onchange = (e) => { config.press = e.target.value; persist(); render(); };
  LAYOUTS.forEach(([c, r, name]) => $('#layoutSel').add(new Option(name, `${c}x${r}`)));
  $('#layoutSel').onchange = (e) => {
    // 지금 보고 있는 페이지의 칸 수만 바꿈
    const [c, r] = e.target.value.split('x').map(Number);
    curPage().cols = c; curPage().rows = r;
    persist(); render();
  };

  const actions = {
    addPage() {
      const name = prompt('새 페이지 이름', '페이지 ' + (config.pages.length + 1));
      if (!name || !name.trim()) return;
      if (config.pages.some((p) => p.name === name.trim())) { toast('같은 이름의 페이지가 있습니다', true); return; }
      config.pages.push({ name: name.trim(), buttons: [BACK()] });
      navStack.push(pageIdx);
      pageIdx = config.pages.length - 1;
      toast('홈 페이지에 폴더 키를 추가하면 이 페이지로 이동할 수 있어요');
    },
    renamePage() {
      const old = curPage().name;
      const name = (prompt('페이지 이름', old) || '').trim();
      if (!name || name === old) return;
      if (config.pages.some((p) => p.name === name)) { toast('같은 이름의 페이지가 있습니다', true); return; }
      curPage().name = name;
      // 이 페이지를 가리키던 폴더 키도 함께 변경
      config.pages.forEach((p) => p.buttons.forEach((b) => { if (b && b.type === 'page' && b.value === old) b.value = name; }));
    },
    movePageLeft() { swapPage(-1); },
    movePageRight() { swapPage(1); },
    deletePage() {
      if (config.pages.length <= 1) { toast('마지막 페이지는 삭제할 수 없습니다', true); return; }
      if (!confirm(`'${curPage().name}' 페이지를 삭제할까요?`)) return;
      config.pages.splice(pageIdx, 1);
      navStack = [];
      pageIdx = Math.max(0, pageIdx - 1);
    },
    reset() {
      if (!confirm('모든 페이지를 추천 구성으로 되돌릴까요? 지금 구성은 사라집니다.')) return;
      config = defaults();
      navStack = [];
      pageIdx = 0;
    },
    autoRule() {
      const cur = curPage();
      const v = prompt('PC에서 어떤 프로그램이 앞에 오면 이 페이지를 자동으로 띄울까요?\n프로그램 이름(예: excel, Inventor) 또는 창 제목 일부(예: YouTube). 여러 개는 쉼표로.\n비우면 자동 전환을 끕니다.', cur.auto || '');
      if (v === null) return;
      if (v.trim()) cur.auto = v.trim(); else delete cur.auto;
      lastAutoMatch = null;
    },
    autoToggle() {
      lsSet('deck.autoSwitch', lsGet('deck.autoSwitch') === 'off' ? 'on' : 'off');
      lastAutoMatch = null;
    },
    done() { editing = false; moveFrom = null; },
  };
  document.querySelectorAll('#editBar [data-act]').forEach((b) => {
    b.onclick = () => {
      actions[b.dataset.act]();
      if (b.dataset.act !== 'done') persist();
      lsSet('deck.page', pageIdx);
      render();
    };
  });
}

function swapPage(d) {
  const j = pageIdx + d;
  if (j < 0 || j >= config.pages.length) return;
  [config.pages[pageIdx], config.pages[j]] = [config.pages[j], config.pages[pageIdx]];
  navStack = [];
  pageIdx = j;
}

// ---------------- 로그인 / 시작 ----------------
function showLogin() {
  setOnline(false);
  $('#tokenInput').value = token;
  $('#login').hidden = false;
}

$('#loginForm').onsubmit = (e) => {
  e.preventDefault();
  token = $('#tokenInput').value.trim();
  lsSet('deck.token', token);
  $('#login').hidden = true;
  init();
};

$('#editBtn').onclick = () => { editing = !editing; moveFrom = null; updateInstallInfo(); render(); };
$('#fullBtn').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => toast('전체 화면을 지원하지 않습니다', true));
};

// 예전 구성을 버튼 배치는 그대로 두고 새 형식으로 올림
const OLD_COLOR_TO_ACCENT = {
  '#d97706': COLORS.inv, '#ea580c': COLORS.inv, '#b45309': COLORS.inv, '#0284c7': COLORS.inv,
  '#4f46e5': COLORS.view, '#15803d': COLORS.xl, '#dc2626': COLORS.yt, '#7c3aed': COLORS.pc,
  '#16a34a': COLORS.text, '#db2777': COLORS.meet, '#0d9488': COLORS.media,
  '#475569': '', '#2563eb': '', '#374151': '', '#1f2937': '',
};
function migrate(c) {
  c.pages.forEach((p) => p.buttons.forEach((b) => {
    if (!b) return;
    if (c.version <= 4 && b.type === 'macro' && /text Inventor/.test(b.value)) { b.type = 'open'; b.value = 'Inventor'; }
    if (c.version <= 5) {
      const mapped = EMOJI_TO_ICON[b.icon];
      if (mapped && ICONS[mapped]) b.icon = 'i:' + mapped;
      if (b.color && b.color.toLowerCase() in OLD_COLOR_TO_ACCENT) b.color = OLD_COLOR_TO_ACCENT[b.color.toLowerCase()];
    }
  }));
  if (c.version === 7) {
    // v8: 홈에 업무 시작/문구/폴더, 문구·폴더 페이지 추가 (다른 페이지는 그대로)
    const fresh = JSON.parse(JSON.stringify(DEFAULT_PAGES));
    const i = c.pages.findIndex((p) => p.name === '홈');
    if (i >= 0) c.pages[i] = fresh.find((p) => p.name === '홈');
    let at = c.pages.findIndex((p) => p.name === '단축키') + 1 || 1;
    for (const name of ['문구', '폴더']) {
      if (!c.pages.some((p) => p.name === name)) c.pages.splice(at++, 0, fresh.find((p) => p.name === name));
    }
  }
  if (c.version <= 6) {
    // v7: 홈을 '창으로 가기' 버튼 위주로 바꾸고, 기존 단축키 페이지들은 '단축키' 폴더 안으로 (다른 페이지는 그대로)
    const fresh = JSON.parse(JSON.stringify(DEFAULT_PAGES));
    const home = fresh.find((p) => p.name === '홈');
    const shortcuts = fresh.find((p) => p.name === '단축키');
    const i = c.pages.findIndex((p) => p.name === '홈');
    if (i >= 0) c.pages[i] = home; else c.pages.unshift(home);
    if (!c.pages.some((p) => p.name === '단축키')) c.pages.splice(c.pages.indexOf(home) + 1, 0, shortcuts);
    for (const name of ['문구', '폴더']) {
      if (!c.pages.some((p) => p.name === name)) c.pages.splice(c.pages.indexOf(shortcuts) + 1, 0, fresh.find((p) => p.name === name));
    }
  }
  if (c.version <= 9) {
    // v10: 전원 페이지 추가 + 단축키 페이지 빈 칸에 전원 폴더
    const freshPower = JSON.parse(JSON.stringify(DEFAULT_PAGES.find((p) => p.name === '전원')));
    if (!c.pages.some((p) => p.name === '전원')) {
      const at = c.pages.findIndex((p) => p.name === '단축키');
      c.pages.splice(at >= 0 ? at + 1 : c.pages.length, 0, freshPower);
    }
    const sc = c.pages.find((p) => p.name === '단축키');
    if (sc && !sc.buttons.some((b) => b && b.type === 'page' && b.value === '전원')) {
      for (let i = 0; i < 15; i++) if (!sc.buttons[i]) { sc.buttons[i] = { label: '전원', icon: 'i:power', color: COLORS.yt, type: 'page', value: '전원' }; break; }
    }
  }
  if (c.version <= 8) {
    // v9: 홈 = 작업 표시줄 고정 앱 24키 (다른 페이지는 그대로)
    const freshHome = JSON.parse(JSON.stringify(DEFAULT_PAGES.find((p) => p.name === '홈')));
    const i = c.pages.findIndex((p) => p.name === '홈');
    if (i >= 0) c.pages[i] = freshHome; else c.pages.unshift(freshHome);
  }
  if (c.version <= 10) {
    // v11: 앱 버튼 아이콘을 실제 로고(단색)로 (배치·동작은 그대로)
    c.pages.forEach((p) => p.buttons.forEach((b) => {
      if (b && ['window', 'open', 'page'].includes(b.type) && LABEL_BRAND[b.label] && BRANDS[LABEL_BRAND[b.label]]) b.icon = 'b:' + LABEL_BRAND[b.label];
    }));
  }
  c.pages.forEach((p) => { if (p.auto === undefined && AUTO_RULES[p.name]) p.auto = AUTO_RULES[p.name]; });
  c.version = CONFIG_VERSION;
}

// 화면 꺼짐 방지 (앱으로 설치되어 보안 주소로 인정될 때 동작)
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', keepAwake);
keepAwake();

// 바로가기(일반 탭)로 열었을 때도 앱처럼: 화면을 처음 터치하면 자동으로 전체 화면 + 화면 꺼짐 방지
document.addEventListener('pointerdown', () => {
  keepAwake();
  if (document.fullscreenElement || editing) return;
  if (matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches) return;
  if (lsGet('deck.autoFullscreen') === 'off') return;
  document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
}, { capture: true });

// ---- 앱 설치 ----
let swState = '확인 중';
let deferredInstall = null;
if (!('serviceWorker' in navigator)) swState = '지원 안 됨 (보안 주소 아님)';
else navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
  .then((reg) => {
    swState = '등록됨'; updateInstallInfo();
    reg.update().catch(() => {});
    // 새 버전이 설치되면 한 번 자동 새로고침 → 바뀐 화면이 바로 보이게
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
  })
  .catch((e) => { swState = '실패: ' + e.message; updateInstallInfo(); });

let bipAt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  bipAt = new Date().toISOString();
  sendDiag('beforeinstallprompt');
  $('#installBtn').hidden = false;
  updateInstallInfo();
});
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  $('#installBtn').hidden = true;
  toast('앱이 설치되었습니다. 홈 화면의 Desk Deck 아이콘으로 여세요');
});
$('#installBtn').onclick = async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice.catch(() => {});
  deferredInstall = null;
  $('#installBtn').hidden = true;
};

// 설치 진단: 태블릿 Chrome 이 본 상태를 PC 구성 파일(config.json 의 _diag)에 남김 → PC 쪽에서 원인 확인용
async function sendDiag(reason) {
  if (!config || !token) return;
  const probe = async (u) => { try { const r = await fetch(u, { cache: 'no-store' }); const b = await r.blob(); return `${r.status} ${b.type} ${b.size}B`; } catch (e) { return 'ERR ' + e.message; } };
  let manifest = null;
  try { manifest = await (await fetch('manifest.json', { cache: 'no-store' })).json(); } catch (e) { manifest = 'ERR ' + e.message; }
  let quota = null;
  try { quota = Math.round(((await navigator.storage.estimate()).quota || 0) / 1048576) + 'MB'; } catch {}
  const reg = navigator.serviceWorker ? await navigator.serviceWorker.getRegistration().catch(() => null) : null;
  const d = {
    at: new Date().toISOString(), reason, ua: navigator.userAgent,
    brands: navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand + ' ' + b.version).join(', ') : null,
    origin: location.origin, secure: window.isSecureContext,
    displayMode: ['fullscreen', 'standalone', 'minimal-ui', 'browser'].find((m) => matchMedia(`(display-mode: ${m})`).matches),
    swRegistered: !!reg, swActive: !!(reg && reg.active), swControlling: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    beforeInstallPrompt: bipAt, manifestLink: document.querySelector('link[rel=manifest]') && document.querySelector('link[rel=manifest]').href,
    manifest, icon192: await probe('icon-192.png'), icon512: await probe('icon-512.png'), storageQuota: quota,
    screen: `${screen.width}x${screen.height} dpr${devicePixelRatio}`,
  };
  config._diag = config._diag || {};
  config._diag[location.origin] = d;
  persist();
}

function isInstalledApp() {
  return matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
}

// 편집 모드 아래에 설치 상태 표시 (왜 설치가 안 되는지 바로 보이게)
let serverInfo = null;
async function loadServerInfo() {
  try { serverInfo = await api('/api/info'); } catch { serverInfo = null; }
  updateInstallInfo();
}

function updateInstallInfo() {
  const el = $('#installInfo');
  if (isInstalledApp()) { el.textContent = '앱으로 실행 중입니다.'; return; }
  if (HOSTED) {
    el.innerHTML = deferredInstall ? '<b>설치 가능 — 오른쪽 위 "앱 설치" 버튼을 누르세요</b>'
      : 'Chrome ⋮ 메뉴 → <b>앱 설치</b>를 누르세요.';
    return;
  }
  // 공개 인증서가 있는 도메인 주소가 있으면 그 주소로 안내 (인증서 설치 불필요)
  if (serverInfo && serverInfo.domain && serverInfo.publicCert
      && (location.hostname !== serverInfo.domain || (location.port || '443') !== String(serverInfo.httpsPort))) {
    const hostPort = serverInfo.domain + (serverInfo.httpsPort === 443 ? '' : ':' + serverInfo.httpsPort);
    const url = `https://${hostPort}/?t=${encodeURIComponent(token)}`;
    el.innerHTML = '<span class="warn">앱 설치는 아래 주소에서 하세요.</span> '
      + `<a href="${url}"><b>${hostPort} 열기</b></a> → Chrome ⋮ 메뉴 → <b>앱 설치</b>`;
    return;
  }
  if (!window.isSecureContext) {
    const host = location.hostname;
    const httpsUrl = `https://${host}:8443/?t=${encodeURIComponent(token)}`;
    el.innerHTML = '<span class="warn">지금 주소(http)는 보안 주소가 아니라 앱 설치가 안 됩니다. 아래 순서로 보안 주소(https)로 여세요. (처음 한 번만)</span><br>'
      + `① <a href="/ca.crt" download="DeskDeck-CA.crt"><b>인증서 받기</b></a> (다운로드 폴더에 저장됨)<br>`
      + '② 태블릿 <b>설정 → 보안(및 개인정보 보호) → 기타 보안 설정 / 암호화 및 사용자 인증 정보 → 인증서 설치 → CA 인증서 → 그래도 설치</b> → 다운로드한 <b>DeskDeck-CA.crt</b> 선택<br>'
      + `③ <a href="${httpsUrl}"><b>보안 주소로 열기</b></a> (${location.hostname}:8443) → 오른쪽 위 <b>앱 설치</b>`;
    return;
  }
  el.innerHTML = `보안 주소: OK · 서비스 워커: ${swState} · `
    + (deferredInstall ? '<b>설치 가능 — 오른쪽 위 "앱 설치" 버튼을 누르세요</b>'
      : '설치 버튼이 안 보이면 Chrome ⋮ 메뉴 → <b>앱 설치</b> 또는 <b>홈 화면에 추가 → 설치</b>');
}
updateInstallInfo();

async function init() {
  if (!token) { showLogin(); return; }
  try {
    const c = await api('/api/config');
    if (c && Array.isArray(c.pages) && c.pages.length && c.version >= 4 && c.version < CONFIG_VERSION) {
      const needFolders = c.version <= 7;
      migrate(c);
      config = c;
      if (needFolders) await fillRecentFolders(config.pages);
      persist();
      lsSet('deck.page', 0);
      toast('홈 화면이 창 전환 버튼으로 바뀌었습니다');
    } else if (c && Array.isArray(c.pages) && c.pages.length && c.version === CONFIG_VERSION) config = c;
    else {
      config = defaults();
      await fillRecentFolders(config.pages);
      persist();
      lsSet('deck.page', 0);
      if (c) toast('새 추천 구성으로 바뀌었습니다');
    }
    setOnline(true);
  } catch (e) {
    if (e.message === 'unauthorized') return;
    const cached = lsGet('deck.config');
    config = cached ? JSON.parse(cached) : defaults();
    setOnline(false);
    toast(e.message, true);
  }
  pageIdx = Math.min(+(lsGet('deck.page') || 0), config.pages.length - 1);
  render();
  setTimeout(() => sendDiag('load+8s'), 8000);
  loadServerInfo();
}

setupEditor();
setupEditBar();
init();

setInterval(async () => {
  if (!token || !$('#login').hidden) return;
  try { await api('/api/ping'); setOnline(true); } catch { setOnline(false); }
}, 5000);
