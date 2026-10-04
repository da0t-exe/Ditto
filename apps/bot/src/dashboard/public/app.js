'use strict';

/* Ditto dashboard: a single page talking to the bot's JSON API. No framework, no build step. */

const $app = document.getElementById('app');
const state = {
  token: read('ditto.token'),
  me: null,
  guildId: read('ditto.guild'),
  guild: null,
  tab: read('ditto.tab') || 'overview',
  live: null,
  tick: null,
  popover: false,
};

const TABS = [
  ['overview', '🏠 Overview'],
  ['captcha', '🔐 Captcha'],
  ['music', '🎵 Music'],
  ['voice', '🔊 Voice'],
  ['settings', '⚙️ Settings'],
  ['logs', '📜 Logs'],
];
const ACCENTS = ['#7c5cff', '#6366f1', '#4a90e2', '#06b6d4', '#10b981', '#f43f5e', '#f59e0b'];

// ---------- Small helpers ----------

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

/** h('div', { class: 'x', onclick }, 'text', child) — builds DOM without innerHTML, so names are never read as HTML. */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(message, error = false) {
  const t = h('div', { class: `toast${error ? ' error' : ''}` }, message);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), 3500);
}

function time(sec) {
  if (sec === null || sec === undefined || !isFinite(sec)) return '—';
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

function uptime(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min`;
  const hours = Math.floor(m / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}

// Material icons (Apache 2.0): drawn as SVG so they look the same everywhere.
const ICONS = {
  prev: 'M6 6h2v12H6zm3.5 6 8.5 6V6z',
  next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  stop: 'M6 6h12v12H6z',
};

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

const initials = (name) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

function avatar(url, name, cls = 'avatar') {
  return url ? h('img', { class: cls, src: url, alt: '' }) : h('div', { class: cls }, initials(name || '?'));
}

/**
 * The page is redrawn whenever something changes on the server. What is being typed
 * or picked in a control marked data-keep survives it: call before the redraw, then
 * call what it returns.
 */
function keepFields(root) {
  const saved = new Map();
  for (const el of root.querySelectorAll('[data-keep]')) {
    let at = null;
    try {
      at = el.selectionStart ?? null;
    } catch {
      /* not a text field */
    }
    saved.set(el.dataset.keep, { value: el.value, checked: el.checked, focused: document.activeElement === el, at });
  }
  return () => {
    for (const el of root.querySelectorAll('[data-keep]')) {
      const s = saved.get(el.dataset.keep);
      if (!s) continue;
      if (el.type === 'checkbox') el.checked = s.checked;
      else el.value = s.value;
      if (!s.focused) continue;
      el.focus();
      try {
        if (s.at !== null) el.setSelectionRange(s.at, s.at);
      } catch {
        /* not a text field */
      }
    }
  };
}

function inviteButton() {
  const url = state.me?.admin ? state.me.bot.invite : null;
  if (!url) return null;
  return h(
    'div',
    { style: 'margin-top:14px' },
    h('a', { class: 'btn primary', style: 'text-decoration:none', href: url, target: '_blank', rel: 'noopener noreferrer' }, '➕ Add Ditto to a server')
  );
}

// ---------- API ----------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token && !path.startsWith('/api/login')) {
    setToken(null);
    renderLogin('Your session has ended — please log in again.');
    throw new Error('Please log in');
  }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function setToken(token) {
  state.token = token;
  write('ditto.token', token);
}

// ---------- Theme ----------

function applyTheme() {
  const accent = read('ditto.accent') || ACCENTS[0];
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.dataset.theme = read('ditto.theme') || 'dark';
}

function themePopover() {
  const accent = read('ditto.accent') || ACCENTS[0];
  const theme = read('ditto.theme') || 'dark';
  const pick = (value) => {
    write('ditto.accent', value);
    applyTheme();
    renderShell();
  };
  return h(
    'div',
    { class: 'popover' },
    h('b', {}, 'Appearance'),
    h('div', { class: 'muted', style: 'font-size:12px' }, 'Match your panel theme: pick its accent colour.'),
    h(
      'div',
      { class: 'swatches' },
      ACCENTS.map((c) => h('button', { class: `swatch${c === accent ? ' on' : ''}`, style: `background:${c}`, title: c, onclick: () => pick(c) })),
      h('input', { type: 'color', value: accent, title: 'Custom colour', onchange: (e) => pick(e.target.value), style: 'width:28px;height:28px;border:0;padding:0;background:none' })
    ),
    h(
      'label',
      { class: 'toggle' },
      h('input', {
        type: 'checkbox',
        checked: theme === 'light',
        onchange: (e) => {
          write('ditto.theme', e.target.checked ? 'light' : 'dark');
          applyTheme();
        },
      }),
      'Light mode'
    )
  );
}

// ---------- Login ----------

function renderLogin(message) {
  stopLive();
  let useCode = false;
  const error = h('div', { class: 'muted', style: 'min-height:20px;color:var(--bad)' }, message || '');
  const input = h('input', { class: 'input', type: 'password', placeholder: 'Admin password', autocomplete: 'current-password', required: true });
  const label = h('label', {}, 'Password');
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        try {
          const { token } = useCode
            ? await api('POST', '/api/login/link', { code: input.value.trim() })
            : await api('POST', '/api/login', { password: input.value });
          setToken(token);
          await loadMe();
        } catch (err) {
          error.textContent = err.message;
        }
      },
    },
    label,
    input,
    error,
    h('button', { class: 'btn primary', type: 'submit' }, 'Log in')
  );
  const switcher = h('a', {
    href: '#',
    onclick: (e) => {
      e.preventDefault();
      useCode = !useCode;
      label.textContent = useCode ? 'Login code' : 'Password';
      input.type = useCode ? 'text' : 'password';
      input.placeholder = useCode ? 'Code from /dashboard' : 'Admin password';
      switcher.textContent = useCode ? 'Use the admin password instead' : 'Have a code from /dashboard? Use it';
    },
  });
  switcher.textContent = 'Have a code from /dashboard? Use it';
  $app.className = 'boot';
  $app.replaceChildren(
    h(
      'div',
      { class: 'login' },
      h('img', { src: '/ditto.png', alt: '' }),
      h('h1', {}, 'Ditto Dashboard'),
      h('p', {}, 'Staff can also type /dashboard in Discord for a one-click link.'),
      form,
      h('div', { class: 'switch' }, switcher)
    )
  );
  input.focus();
}

// ---------- Shell ----------

async function loadMe() {
  state.me = await api('GET', '/api/me');
  const ids = state.me.guilds.map((g) => g.id);
  if (!ids.includes(state.guildId)) state.guildId = ids[0] || null;
  renderShell();
  if (state.guildId) await openGuild(state.guildId);
  else renderMain();
}

function renderShell() {
  const me = state.me;
  const b = me.bot;
  $app.className = 'shell';
  const sidebar = h(
    'aside',
    { class: 'sidebar' },
    h('div', { class: 'brand' }, h('img', { src: b.avatar || '/ditto.png', alt: '' }), h('div', {}, h('b', {}, b.name), h('small', {}, `v${b.version}`))),
    h('div', { class: 'side-title' }, me.admin ? `Servers · ${me.guilds.length}` : 'Server'),
    h(
      'nav',
      { class: 'guilds' },
      me.guilds.map((g) =>
        h(
          'button',
          { class: `guild${g.id === state.guildId ? ' active' : ''}`, onclick: () => openGuild(g.id) },
          avatar(g.icon, g.name),
          h('span', { class: 'name' }, g.name),
          g.playing ? h('span', { class: 'dot', title: 'Playing music' }) : null
        )
      ),
      me.guilds.length ? null : h('div', { class: 'empty' }, 'Ditto is in no server you can manage.')
    ),
    state.popover ? themePopover() : null,
    h(
      'div',
      { class: 'side-footer' },
      me.user ? avatar(me.user.avatar, me.user.name) : h('div', { class: 'avatar' }, '🔑'),
      h('div', { class: 'who' }, me.user ? me.user.name : me.admin ? 'Admin' : 'Staff'),
      h('button', {
        class: 'btn icon',
        title: 'Appearance',
        onclick: () => {
          state.popover = !state.popover;
          renderShell();
        },
      }, '⚙'),
      h('button', {
        class: 'btn icon',
        title: 'Log out',
        onclick: async () => {
          await api('POST', '/api/logout').catch(() => {});
          setToken(null);
          renderLogin();
        },
      }, '⏻')
    )
  );
  const main = h('main', { id: 'main' });
  $app.replaceChildren(sidebar, main);
  renderMain();
}

async function openGuild(id) {
  state.guildId = id;
  write('ditto.guild', id);
  try {
    state.guild = await api('GET', `/api/guilds/${id}`);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  renderShell();
  startLive();
}

async function reloadGuild() {
  if (!state.guildId) return;
  state.guild = await api('GET', `/api/guilds/${state.guildId}`);
  renderMain();
}

function startLive() {
  stopLive();
  // What changes on its own (music, logs) is fetched every few seconds.
  state.live = setInterval(async () => {
    if (document.hidden || !state.guild) return;
    try {
      const live = await api('GET', `/api/guilds/${state.guild.id}/live`);
      // What the player shows, the last log line and the locks: a redraw only when one of them moved.
      const shown = (m, logs, locks) =>
        JSON.stringify([m?.current?.title, m?.paused, m?.queueLength, m?.volume, m?.loop, m?.filter, logs.length, logs[logs.length - 1]?.at, locks]);
      const changed = shown(live.music, live.logs, live.locks) !== shown(state.guild.music, state.guild.logs, state.guild.locks.length);
      state.guild.music = live.music;
      state.guild.logs = live.logs;
      if (live.bot) Object.assign(state.me.bot, live.bot); // ping, uptime and « music ready » stay current
      if (changed && live.locks !== state.guild.locks.length) return reloadGuild();
      if (changed && ['overview', 'music', 'logs'].includes(state.tab)) return renderMain();
      updateProgress();
      updateChips();
    } catch {
      /* next time */
    }
  }, 3000);
  // The progress bar moves every second between two fetches.
  state.tick = setInterval(() => {
    const m = state.guild?.music;
    if (m?.current && !m.paused && m.current.duration && m.position < m.current.duration) {
      m.position++;
      updateProgress();
    }
  }, 1000);
}

function stopLive() {
  clearInterval(state.live);
  clearInterval(state.tick);
}

/** The bot's state, at the top right of every page. */
function chips() {
  const b = state.me.bot;
  return [
    // The ping is unknown (-1) until Discord has answered a first heartbeat.
    h('span', { class: 'chip good' }, h('span', { class: 'dot' }), b.ping >= 0 ? `Online · ${b.ping} ms` : 'Online'),
    h('span', { class: `chip ${b.music ? 'good' : 'bad'}` }, b.music ? '🎵 Music ready' : '🎵 Music starting'),
    h('span', { class: 'chip' }, `⏱ ${uptime(b.uptime)}`),
    h('span', { class: 'chip' }, `🖼 ${b.photos} captcha photos`),
  ];
}

function updateChips() {
  document.getElementById('chips')?.replaceChildren(...chips());
}

function renderMain() {
  const main = document.getElementById('main');
  if (!main) return;
  const g = state.guild;
  if (!g) {
    const none = state.me && !state.me.guilds.length;
    return main.replaceChildren(h('div', { class: 'empty' }, none ? 'Ditto is not in any Discord server yet.' : 'Pick a server.', none ? inviteButton() : null));
  }
  const top = h(
    'div',
    { class: 'topbar' },
    avatar(g.icon, g.name),
    h('div', {}, h('h2', {}, g.name), h('div', { class: 'muted' }, `${g.members.toLocaleString()} members`)),
    h('div', { class: 'chips', id: 'chips' }, chips())
  );
  const tabs = h(
    'div',
    { class: 'tabs', role: 'tablist' },
    TABS.map(([id, label]) =>
      h(
        'button',
        {
          class: `tab${state.tab === id ? ' active' : ''}`,
          role: 'tab',
          onclick: () => {
            state.tab = id;
            write('ditto.tab', id);
            renderMain();
          },
        },
        label
      )
    )
  );
  const view = { overview, captcha, music, voice, settings, logs }[state.tab] || overview;
  const restore = keepFields(main);
  main.replaceChildren(top, tabs, view(g));
  restore();
}

// ---------- Discord text ----------

/** Renders **bold**, `code`, <#channel>, <@&role>, <@user> and <t:time> from log lines, safely. */
function discordText(text, g) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|<#\d+>|<@&\d+>|<@!?\d+>|<t:\d+(?::[a-zA-Z])?>)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(h('b', {}, tok.slice(2, -2)));
    else if (tok.startsWith('`')) out.push(h('code', {}, tok.slice(1, -1)));
    else if (tok.startsWith('<#')) {
      const id = tok.slice(2, -1);
      const c = [...g.options.textChannels, ...g.options.voiceChannels].find((x) => x.id === id);
      out.push(h('span', { class: 'mention' }, `#${c ? c.name : 'channel'}`));
    } else if (tok.startsWith('<@&')) {
      const r = g.options.roles.find((x) => x.id === tok.slice(3, -1));
      out.push(h('span', { class: 'mention' }, `@${r ? r.name : 'role'}`));
    } else if (tok.startsWith('<@')) out.push(h('span', { class: 'mention' }, '@member'));
    else out.push(new Date(Number(tok.slice(3).split(/[:>]/)[0]) * 1000).toLocaleString());
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---------- Settings controls ----------

async function save(field, values) {
  try {
    state.guild.config = await api('PATCH', `/api/guilds/${state.guild.id}/config`, { field, values });
    toast('Saved');
    await reloadGuild();
  } catch (err) {
    toast(err.message, true);
  }
}

function field(label, control, hint) {
  return h('div', { class: 'field' }, h('label', {}, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
}

function single(name, options, value, none = '— None —') {
  return h(
    'select',
    { class: 'input', onchange: (e) => save(name, e.target.value ? [e.target.value] : []) },
    h('option', { value: '' }, none),
    options.map((o) => h('option', { value: o.id, selected: o.id === value }, o.parent ? `${o.name} · ${o.parent}` : o.name))
  );
}

function multi(name, options, values) {
  const chosen = values.map((v) => options.find((o) => o.id === v)).filter(Boolean);
  const rest = options.filter((o) => !values.includes(o.id));
  return h(
    'div',
    { class: 'chips-input' },
    chosen.map((o) =>
      h('span', { class: 'item' }, o.name, h('button', { title: 'Remove', onclick: () => save(name, values.filter((v) => v !== o.id)) }, '✕'))
    ),
    h(
      'select',
      { onchange: (e) => e.target.value && save(name, [...values, e.target.value]) },
      h('option', { value: '' }, rest.length ? '+ Add…' : 'Nothing else to add'),
      rest.map((o) => h('option', { value: o.id }, o.parent ? `${o.name} · ${o.parent}` : o.name))
    )
  );
}

function choice(name, choices, value, label) {
  return h(
    'select',
    { class: 'input', onchange: (e) => save(name, [e.target.value]) },
    choices.map((n) => h('option', { value: String(n), selected: n === value }, label(n)))
  );
}

function toggleFeature(label, key, cfg) {
  return h(
    'label',
    { class: 'toggle' },
    h('input', {
      type: 'checkbox',
      checked: cfg[key],
      onchange: (e) => {
        const on = { voiceLog: cfg.voiceLog, autoAfk: cfg.autoAfk, [key]: e.target.checked };
        save('features', Object.keys(on).filter((k) => on[k]));
      },
    }),
    label
  );
}

async function action(name, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  try {
    const r = await api('POST', `/api/guilds/${state.guild.id}/actions/${name}`);
    if (name === 'quick-setup') toast(`Done: ${r.created.length} created, ${r.hidden} channel(s) hidden from newcomers`);
    else if (name === 'detect') toast(r.filled.length ? `Filled ${r.filled.length} setting(s)` : 'Nothing new found');
    else toast(r.posted ? 'Panel posted' : 'No verification channel yet', !r.posted);
    await reloadGuild();
  } catch (err) {
    toast(err.message, true);
  }
}

const QUICK_CONFIRM =
  'Quick setup will create what is missing (an Unverified role, #verify and #ditto-logs), hide every other channel from Unverified, and post the Verify panel.\n\nExisting members keep their access. Delete the Unverified role to undo it. Continue?';

// ---------- Tabs ----------

function checklist(g) {
  const c = g.config;
  const items = [
    [g.verification, 'Captcha', g.verification ? 'Newcomers verify before they see the server' : 'Not set up — Quick setup does it in one click'],
    [c.staffRoles.length > 0, 'Staff roles', c.staffRoles.length ? `${c.staffRoles.length} role(s)` : 'Only admins and the owner'],
    [!!c.logChannel, 'Log channel', c.logChannel ? 'Joins, captcha and moderation are logged' : 'No log channel'],
    [c.rooms.length > 0, 'Rooms', c.rooms.length ? `${c.rooms.length} room(s) reset when empty` : 'Optional'],
    [!!c.quarantineRole, 'Quarantine', c.quarantineRole ? `${c.quarantineBots.length} bot(s) watched` : 'Optional'],
  ];
  return h(
    'ul',
    { class: 'list' },
    items.map(([ok, name, sub]) =>
      h('li', {}, h('span', { class: `check${ok ? ' on' : ''}` }, ok ? '✓' : ''), h('div', { class: 'grow' }, h('b', {}, name), h('div', { class: 'muted' }, sub)))
    )
  );
}

function overview(g) {
  const t = g.captcha.totals;
  const m = g.music;
  return h(
    'div',
    { class: 'grid' },
    g.warnings.length ? h('div', { class: 'grid' }, g.warnings.map((w) => h('div', { class: 'warning' }, '⚠️ ', w))) : null,
    h(
      'div',
      { class: 'grid kpis' },
      kpi('Members', g.members.toLocaleString(), 'on the server'),
      kpi('Verified', t.pass, 'last 14 days'),
      kpi('Missed', t.fail, `${t.lockout} timed out`),
      kpi('Music', m?.current ? (m.paused ? 'Paused' : 'Playing') : 'Idle', m?.current ? `${m.current.title} — ${m.current.author}` : 'use the Music tab or /play')
    ),
    h(
      'div',
      { class: 'grid two' },
      h(
        'div',
        { class: 'card' },
        h('h3', {}, '✅ Setup'),
        checklist(g),
        h(
          'div',
          { class: 'row', style: 'margin-top:14px' },
          h('button', { class: 'btn primary', onclick: () => action('quick-setup', QUICK_CONFIRM) }, '⚡ Quick setup'),
          h('button', { class: 'btn', onclick: () => action('detect') }, '🔎 Auto-detect'),
          h('button', { class: 'btn', onclick: () => action('panel') }, '📌 Post the panel')
        )
      ),
      h('div', { class: 'card' }, h('h3', {}, '📜 Recent activity'), logList(g, 8))
    )
  );
}

function kpi(label, value, sub) {
  return h('div', { class: 'card kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value ellipsis' }, String(value)), h('div', { class: 'sub ellipsis' }, sub));
}

function chart(g) {
  const days = [];
  for (let k = 13; k >= 0; k--) days.push(new Date(Date.now() - k * 864e5).toISOString().slice(0, 10));
  const by = {};
  for (const r of g.captcha.days) by[`${r.day}:${r.event}`] = r.n;
  const series = [
    ['pass', 'var(--good)', 'Passed'],
    ['fail', 'var(--bad)', 'Missed'],
    ['lockout', 'var(--warn)', 'Timed out'],
  ];
  const max = Math.max(1, ...days.map((d) => series.reduce((s, [e]) => s + (by[`${d}:${e}`] || 0), 0)));
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'bars' },
      days.map((d) =>
        h(
          'div',
          { class: 'day', title: `${d}: ${series.map(([e, , l]) => `${l} ${by[`${d}:${e}`] || 0}`).join(', ')}` },
          series.map(([e, color]) => {
            const n = by[`${d}:${e}`] || 0;
            return n ? h('div', { class: 'seg', style: `height:${(n / max) * 100}%;background:${color}` }) : null;
          })
        )
      )
    ),
    h('div', { class: 'axis' }, h('span', {}, new Date(days[0]).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })), h('span', {}, 'today')),
    h('div', { class: 'legend' }, series.map(([, color, label]) => h('span', {}, h('i', { style: `background:${color}` }), label)))
  );
}

function captcha(g) {
  const t = g.captcha.totals;
  const c = g.config;
  const o = g.options;
  const names = { join: '👋 joined', pass: '✅ passed', fail: '❌ missed', lockout: '⛔ timed out', quarantine: '🙈 quarantined' };
  return h(
    'div',
    { class: 'grid' },
    h('div', { class: 'grid kpis' }, kpi('Joined', t.join, '14 days'), kpi('Passed', t.pass, '14 days'), kpi('Missed', t.fail, '14 days'), kpi('Quarantined', t.quarantine, '14 days')),
    h(
      'div',
      { class: 'grid two' },
      h('div', { class: 'card' }, h('h3', {}, '📈 Last 14 days'), chart(g)),
      h(
        'div',
        { class: 'card' },
        h('h3', {}, '🕒 Latest'),
        g.captcha.latest.length
          ? h(
              'ul',
              { class: 'list' },
              g.captcha.latest.slice(0, 8).map((e) =>
                h('li', {}, h('div', { class: 'grow ellipsis' }, h('b', {}, e.name || e.user_id), ' ', names[e.event] || e.event), h('span', { class: 'muted' }, new Date(e.at).toLocaleString()))
              )
            )
          : h('div', { class: 'empty' }, 'Nothing yet.')
      )
    ),
    h(
      'div',
      { class: 'card' },
      h('h3', {}, '🔐 Captcha settings', h('span', { class: 'right' }, h('button', { class: 'btn', onclick: () => action('panel') }, '📌 Post the panel'))),
      h(
        'div',
        { class: 'grid two' },
        h(
          'div',
          {},
          field('Pending role', single('pendingRole', o.roles, c.pendingRole), 'Held by newcomers until they pass; hide your channels from it.'),
          field('Member role (optional)', single('memberRole', o.roles, c.memberRole), 'Given after the captcha, if your channels are opened to a role.'),
          field('Verification channel', single('verifyChannel', o.textChannels, c.verifyChannel))
        ),
        h(
          'div',
          {},
          field('Attempts', choice('captchaAttempts', [3, 4, 5, 6], c.captchaAttempts, (n) => `${n} attempts`)),
          field('Pause after the last miss', choice('captchaTimeoutMinutes', [5, 10, 30, 60], c.captchaTimeoutMinutes, (n) => `${n} minutes`)),
          h('button', { class: 'btn primary', onclick: () => action('quick-setup', QUICK_CONFIRM) }, '⚡ Quick setup')
        )
      )
    )
  );
}

async function musicDo(name, body) {
  try {
    const r = await api('POST', `/api/guilds/${state.guild.id}/music/${name}`, body || {});
    if (name === 'play') toast(r.added > 1 ? `Added ${r.added} tracks` : r.position === 0 ? 'Playing' : `Added — #${r.position} in queue`);
    setTimeout(reloadGuild, name === 'play' ? 1500 : 300);
  } catch (err) {
    toast(err.message, true);
  }
}

function updateProgress() {
  const m = state.guild?.music;
  const bar = document.getElementById('progress-fill');
  const now = document.getElementById('progress-now');
  if (!m?.current || !bar || !now) return;
  const d = m.current.duration;
  bar.style.width = d ? `${Math.min(100, (m.position / d) * 100)}%` : '0%';
  now.textContent = time(m.position);
}

function addForm(g, playing) {
  const input = h('input', { class: 'input', placeholder: 'Song name or link — Ditto picks the best match', maxlength: 300, required: true, 'data-keep': `query:${g.id}` });
  const next = h('input', { type: 'checkbox', 'data-keep': `next:${g.id}` });
  const channel = playing
    ? null
    : h(
        'select',
        { class: 'input', 'data-keep': `channel:${g.id}` },
        h('option', { value: '' }, 'Voice channel…'),
        g.options.voiceChannels.map((c) => h('option', { value: c.id }, c.listeners ? `${c.name} · ${c.listeners} in voice` : c.name))
      );
  return h(
    'form',
    {
      class: 'row',
      onsubmit: (e) => {
        e.preventDefault();
        if (channel && !channel.value) return toast('Pick a voice channel', true);
        musicDo('play', { query: input.value, next: next.checked, channelId: channel?.value });
        input.value = '';
      },
    },
    h('div', { style: 'flex:1;min-width:220px' }, input),
    channel ? h('div', { style: 'min-width:200px' }, channel) : null,
    playing ? h('label', { class: 'toggle' }, next, 'Play next') : null,
    h('button', { class: 'btn primary', type: 'submit' }, playing ? '➕ Add' : '▶️ Play')
  );
}

function music(g) {
  const m = g.music;
  if (!m?.current) {
    return h(
      'div',
      { class: 'grid' },
      h('div', { class: 'card' }, h('h3', {}, '🎵 Nothing is playing'), h('p', { class: 'muted' }, 'Start the music from here: Ditto joins the voice channel you pick.'), addForm(g, false))
    );
  }
  const t = m.current;
  const seekable = t.duration && !t.live;
  const player = h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'player' },
      t.thumbnail ? h('img', { class: 'cover', src: t.thumbnail, alt: '' }) : h('div', { class: 'cover' }),
      h(
        'div',
        { style: 'min-width:0' },
        h('div', { class: 'muted' }, m.paused ? '⏸ Paused' : '🎶 Now playing', m.channel ? ` · 🔊 ${m.channel}` : ''),
        h('div', { class: 'title ellipsis' }, h('a', { href: t.link, target: '_blank', rel: 'noopener noreferrer' }, t.title)),
        h('div', { class: 'muted ellipsis' }, t.author, t.requester ? ` · requested by ${t.requester}` : ''),
        t.live
          ? h('div', { class: 'chip bad', style: 'margin-top:14px' }, '🔴 LIVE')
          : h(
              'div',
              {},
              h(
                'div',
                {
                  class: 'progress',
                  title: seekable ? 'Click to jump' : '',
                  onclick: (e) => {
                    if (!seekable) return;
                    const r = e.currentTarget.getBoundingClientRect();
                    const at = Math.floor(((e.clientX - r.left) / r.width) * t.duration);
                    musicDo('seek', { value: Math.max(0, Math.min(t.duration - 1, at)) });
                  },
                },
                h('span', { id: 'progress-fill', style: `width:${t.duration ? Math.min(100, (m.position / t.duration) * 100) : 0}%` })
              ),
              h('div', { class: 'times' }, h('span', { id: 'progress-now' }, time(m.position)), h('span', {}, time(t.duration)))
            ),
        h(
          'div',
          { class: 'row', style: 'margin-top:14px' },
          h('button', { class: 'btn icon', title: 'Previous', onclick: () => musicDo('previous') }, icon('prev')),
          h('button', { class: 'btn primary round', title: m.paused ? 'Resume' : 'Pause', onclick: () => musicDo(m.paused ? 'resume' : 'pause') }, icon(m.paused ? 'play' : 'pause')),
          h('button', { class: 'btn icon', title: 'Skip', onclick: () => musicDo('skip') }, icon('next')),
          h('button', { class: 'btn icon danger', title: 'Stop and leave', onclick: () => confirm('Stop the music and leave the channel?') && musicDo('stop') }, icon('stop')),
          h(
            'select',
            { class: 'input', style: 'width:auto', title: 'Loop', onchange: (e) => musicDo('loop', { value: e.target.value }) },
            [
              ['off', '🔁 Loop off'],
              ['track', '🔂 Loop track'],
              ['queue', '🔁 Loop queue'],
            ].map(([v, l]) => h('option', { value: v, selected: m.loop === v }, l))
          ),
          h(
            'select',
            { class: 'input', style: 'width:auto', title: 'Filter', onchange: (e) => musicDo('filter', { value: e.target.value }) },
            [
              ['none', '🎚 No filter'],
              ['bassboost', '🔊 Bass boost'],
              ['nightcore', '⚡ Nightcore'],
              ['vaporwave', '🌴 Vaporwave'],
              ['8d', '🎧 8D'],
              ['karaoke', '🎤 Karaoke'],
            ].map(([v, l]) => h('option', { value: v, selected: m.filter === v }, l))
          )
        ),
        h(
          'div',
          { class: 'row', style: 'margin-top:10px;max-width:360px' },
          '🔈',
          h('input', { type: 'range', min: 0, max: 100, value: m.volume, onchange: (e) => musicDo('volume', { value: Number(e.target.value) }) }),
          `${m.volume}%`
        )
      )
    )
  );
  const queue = h(
    'div',
    { class: 'card' },
    h(
      'h3',
      {},
      `📜 Queue · ${m.queueLength}`,
      h(
        'span',
        { class: 'right row' },
        h('button', { class: 'btn', disabled: m.queueLength < 2, onclick: () => musicDo('shuffle') }, '🔀 Shuffle'),
        h('button', { class: 'btn danger', disabled: !m.queueLength, onclick: () => confirm('Empty the queue?') && musicDo('clear') }, '🗑 Clear')
      )
    ),
    m.queue.length
      ? h(
          'ul',
          { class: 'list queue' },
          m.queue.map((q, k) =>
            h(
              'li',
              {},
              h('span', { class: 'pos' }, k + 1),
              q.thumbnail ? h('img', { src: q.thumbnail, alt: '' }) : null,
              h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, h('b', {}, q.title)), h('div', { class: 'muted ellipsis' }, q.author)),
              h('span', { class: 'muted' }, time(q.duration)),
              h('button', { class: 'btn icon', title: 'Remove', onclick: () => musicDo('remove', { value: k }) }, '✕')
            )
          )
        )
      : h('div', { class: 'empty' }, 'Nothing queued after this track.')
  );
  return h('div', { class: 'grid' }, player, h('div', { class: 'card' }, h('h3', {}, '➕ Add music'), addForm(g, true)), queue);
}

function voice(g) {
  const c = g.config;
  const o = g.options;
  return h(
    'div',
    { class: 'grid two' },
    h(
      'div',
      { class: 'card' },
      h('h3', {}, `🔒 Locked channels · ${g.locks.length}`),
      g.locks.length
        ? h(
            'ul',
            { class: 'list' },
            g.locks.map((l) =>
              h(
                'li',
                {},
                h('div', { class: 'grow' }, h('b', {}, `🔊 ${l.channel}`), h('div', { class: 'muted' }, `${l.members} tracked · ${l.expiresAt ? `until ${new Date(l.expiresAt).toLocaleTimeString()}` : 'no limit'}`)),
                h(
                  'button',
                  {
                    class: 'btn',
                    onclick: async () => {
                      try {
                        await api('DELETE', `/api/guilds/${g.id}/locks/${l.channelId}`);
                        toast('Unlocked');
                        await reloadGuild();
                      } catch (err) {
                        toast(err.message, true);
                      }
                    },
                  },
                  '🔓 Unlock'
                )
              )
            )
          )
        : h('div', { class: 'empty' }, 'No locked channel. Use /lock in Discord.')
    ),
    h(
      'div',
      { class: 'card' },
      h('h3', {}, '🔊 Voice settings'),
      field('Rooms', multi('rooms', o.voiceChannels.filter((v) => !v.stage), c.rooms), 'The first person in owns the room; it resets when it empties.'),
      field('Log channel', single('logChannel', o.textChannels, c.logChannel)),
      h('div', { class: 'grid', style: 'gap:10px;margin-bottom:14px' }, toggleFeature('Voice log: joins, leaves and moves', 'voiceLog', c), toggleFeature('Move deafened members to AFK', 'autoAfk', c)),
      field('AFK after', choice('afkIdleMinutes', [5, 10, 15, 30, 60], c.afkIdleMinutes, (n) => `${n} minutes deafened`))
    )
  );
}

function settings(g) {
  const c = g.config;
  const o = g.options;
  return h(
    'div',
    { class: 'grid two' },
    h(
      'div',
      { class: 'card' },
      h('h3', {}, '🔐 Verification'),
      field('Pending role', single('pendingRole', o.roles, c.pendingRole)),
      field('Member role (optional)', single('memberRole', o.roles, c.memberRole)),
      field('Verification channel', single('verifyChannel', o.textChannels, c.verifyChannel)),
      field('Attempts', choice('captchaAttempts', [3, 4, 5, 6], c.captchaAttempts, (n) => `${n} attempts`)),
      field('Pause after the last miss', choice('captchaTimeoutMinutes', [5, 10, 30, 60], c.captchaTimeoutMinutes, (n) => `${n} minutes`))
    ),
    h(
      'div',
      { class: 'card' },
      h('h3', {}, '🛡️ Staff & quarantine'),
      field('Staff roles', multi('staffRoles', o.roles, c.staffRoles), 'Can use every command and this dashboard.'),
      field('Quarantine role', single('quarantineRole', o.roles, c.quarantineRole), 'Given instead of the captcha to members brought in by the bots below.'),
      field('Watched bots', multi('quarantineBots', o.bots, c.quarantineBots))
    ),
    h(
      'div',
      { class: 'card' },
      h('h3', {}, '🔊 Voice & logs'),
      field('Log channel', single('logChannel', o.textChannels, c.logChannel)),
      field('Rooms', multi('rooms', o.voiceChannels.filter((v) => !v.stage), c.rooms)),
      h('div', { class: 'grid', style: 'gap:10px;margin-bottom:14px' }, toggleFeature('Voice log', 'voiceLog', c), toggleFeature('Auto AFK', 'autoAfk', c)),
      field('AFK after', choice('afkIdleMinutes', [5, 10, 15, 30, 60], c.afkIdleMinutes, (n) => `${n} minutes deafened`))
    ),
    h(
      'div',
      { class: 'card' },
      h('h3', {}, '🧰 Tools'),
      h('p', { class: 'muted' }, 'Auto-detect fills empty settings from your role and channel names. It never overwrites a choice.'),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => action('quick-setup', QUICK_CONFIRM) }, '⚡ Quick setup'),
        h('button', { class: 'btn', onclick: () => action('detect') }, '🔎 Auto-detect'),
        h('button', { class: 'btn', onclick: () => action('panel') }, '📌 Post the panel')
      )
    )
  );
}

function logList(g, limit) {
  const lines = [...g.logs].reverse().slice(0, limit);
  if (!lines.length) return h('div', { class: 'empty' }, 'Nothing logged since Ditto started.');
  return h(
    'div',
    { class: 'logs' },
    lines.map((l) => h('div', {}, h('time', {}, new Date(l.at).toLocaleTimeString()), h('span', {}, discordText(l.text, g))))
  );
}

function logs(g) {
  return h('div', { class: 'card' }, h('h3', {}, '📜 Activity', h('span', { class: 'right muted', style: 'font-weight:400;font-size:12px' }, 'live · since Ditto started')), logList(g, 200));
}

// ---------- Start ----------

document.addEventListener('click', (e) => {
  if (state.popover && !e.target.closest('.popover') && !e.target.closest('[title="Appearance"]')) {
    state.popover = false;
    if (state.me) renderShell();
  }
});

(async () => {
  applyTheme();
  const link = /^#login=(.+)$/.exec(location.hash);
  if (link) {
    history.replaceState(null, '', location.pathname);
    try {
      const { token } = await api('POST', '/api/login/link', { code: decodeURIComponent(link[1]) });
      setToken(token);
    } catch (err) {
      return renderLogin(err.message);
    }
  }
  if (!state.token) return renderLogin();
  try {
    await loadMe();
  } catch (err) {
    if (state.token) renderLogin(err.message);
  }
})();
