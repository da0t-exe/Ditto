/**
 * The /play command without Discord: its suggestions, what it answers to each kind of
 * input, how long a track takes to start, and the queue commands around it. The real
 * command runs against the real YouTube Music, yt-dlp and Lavalink; only Discord is a
 * stand-in. Downloads Java, Lavalink and yt-dlp on the first run.
 *
 * Lavalink plays without a voice connection, but the position does not move then:
 * progress and seeking need a real voice channel.
 *   DATA_DIR=<folder> npx tsx src/scripts/play-lab.ts
 */
import { EventEmitter } from 'node:events';
import { ChannelType, Collection, Events, PermissionsBitField } from 'discord.js';

if (!process.env.DATA_DIR) throw new Error('Set DATA_DIR to a folder for Java, Lavalink and yt-dlp.');
const { musicFeature } = await import('../features/music/index.js');

// ---------- The stand-in for Discord ----------

const G = '111111111111111111';
const client: any = new EventEmitter();
client.user = { id: '100000000000000001', username: 'Ditto' };

/** Text of a reply or a message, whatever it is laid out with. */
function textOf(payload: any): string {
  const texts: string[] = [];
  const walk = (c: any) => {
    const j = typeof c?.toJSON === 'function' ? c.toJSON() : c;
    if (!j) return;
    if (typeof j.content === 'string') texts.push(j.content);
    if (typeof j.description === 'string') texts.push(j.description);
    for (const x of j.components ?? []) walk(x);
    if (j.accessory) walk(j.accessory);
  };
  for (const e of payload.embeds ?? []) walk(e);
  for (const c of payload.components ?? []) walk(c);
  if (payload.content) texts.push(payload.content);
  return texts.join(' | ').replace(/\s+/g, ' ');
}

/** What Ditto posted in the music channel: the player message appears when a track really starts. */
const posted: { at: number; text: string }[] = [];
let ids = 500000000000000000n;
const text: any = {
  id: '300000000000000001',
  name: 'music',
  type: ChannelType.GuildText,
  isTextBased: () => true,
  isVoiceBased: () => false,
  messages: { fetch: async () => new Collection() },
  send: async (payload: any) => {
    posted.push({ at: Date.now(), text: textOf(payload) });
    const m: any = { id: String(ids++), edit: async () => m, delete: async () => {} };
    return m;
  },
};
const listener: any = { id: '400000000000000001', user: { id: '400000000000000001', bot: false, username: 'sam' } };
const voice: any = {
  id: '300000000000000002',
  name: 'Lounge',
  type: ChannelType.GuildVoice,
  isTextBased: () => false,
  isVoiceBased: () => true,
  members: new Collection([[listener.id, listener]]),
  toString: () => '<#300000000000000002>',
};
const guild: any = {
  id: G,
  name: 'Lab',
  ownerId: '400000000000000009',
  shard: { send: () => {} },
  channels: { cache: new Collection([[text.id, text], [voice.id, voice]]) },
  members: { cache: new Collection([[listener.id, listener]]), me: { voice: { channelId: null } } },
};
Object.assign(listener, {
  guild,
  permissions: new PermissionsBitField(),
  roles: { cache: new Collection() },
  voice: { channel: voice, channelId: voice.id },
});
client.guilds = { cache: new Collection([[G, guild]]) };

musicFeature.init!(client);
client.emit(Events.ClientReady, client);

const command = (name: string) => musicFeature.commands!.find((c) => c.data.name === name)!;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs a slash command the way Discord would: what was answered, when, and when the track started. */
async function slash(name: string, options: Record<string, unknown> = {}) {
  const t0 = Date.now();
  const answers: string[] = [];
  const i: any = {
    guildId: G,
    guild,
    member: listener,
    user: listener.user,
    channelId: text.id,
    deferred: false,
    replied: false,
    isButton: () => false,
    options: {
      getString: (k: string) => (options[k] ?? null) as string | null,
      getBoolean: (k: string) => (options[k] ?? null) as boolean | null,
      getInteger: (k: string) => (options[k] ?? null) as number | null,
    },
    deferReply: async () => void (i.deferred = true),
    reply: async (p: any) => void ((i.replied = true), answers.push(textOf(p))),
    editReply: async (p: any) => void answers.push(textOf(p)),
    followUp: async (p: any) => void answers.push(textOf(p)),
  };
  const before = posted.length;
  await command(name).run(i);
  const answered = Date.now() - t0;
  let started: number | null = null;
  if (name === 'play' && answers.join(' ').includes('▶️')) {
    for (let k = 0; k < 60 && posted.length === before; k++) await wait(250);
    const playing = posted.slice(before).find((p) => p.text.includes('NOW PLAYING'));
    if (playing) started = playing.at - t0;
  }
  return { answer: answers.join(' / '), answered, started };
}

/** What /play suggests for what has been typed so far. */
async function typing(typed: string) {
  const t0 = Date.now();
  let choices: { name: string; value: string }[] = [];
  const i: any = { user: listener.user, options: { getFocused: () => typed }, respond: async (c: typeof choices) => void (choices = c) };
  await command('play').autocomplete!(i);
  return { choices, ms: Date.now() - t0 };
}

// ---------- The checks ----------

let failed = 0;
function check(label: string, ok: boolean, detail: string) {
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${label.padEnd(38)} ${detail}`);
}
const seconds = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`);

/** One /play: the answer has to match, and a track that starts has to really start. */
async function play(label: string, query: string, expected: RegExp, more: Record<string, unknown> = {}) {
  const r = await slash('play', { query, ...more });
  const starts = r.answer.includes('▶️');
  check(label, expected.test(r.answer) && (!starts || r.started !== null), `${seconds(r.answered)}${starts ? `, playing after ${seconds(r.started)}` : ''} — ${r.answer.slice(0, 110)}`);
  return r;
}
async function stop() {
  await slash('stop');
  await wait(1500);
}

// Lavalink takes a moment to start.
for (let k = 0; k < 240; k++) {
  const r = await slash('play', { query: 'x' }).catch(() => null);
  if (r && !r.answer.includes('still starting')) break;
  await wait(500);
}
await stop();
posted.length = 0;

console.log('\nSuggestions while typing');
for (const [typed, wanted] of [
  ['d', 0],
  ['daft punk around', 5],
  ['stromae alors', 5],
  ['https://youtu.be/dQw4w9WgXcQ', 0],
] as const) {
  const s = await typing(typed);
  check(`« ${typed} »`, wanted ? s.choices.length >= wanted && s.ms < 2500 : s.choices.length === 0, `${s.choices.length} in ${s.ms} ms${s.choices[0] ? ` — ${s.choices[0].name}` : ''}`);
}
const again = await typing('daft punk around');
check('« daft punk around », typed again', again.ms < 50 && again.choices.every((c) => /^ytm:[\w-]{11}$/.test(c.value) && c.name.length <= 100), `${again.ms} ms`);

console.log('\n/play, one after the other');
await play('a suggestion that was picked', again.choices[0].value, /▶️ \[Around the World/);
await play('words, sent without picking', 'stromae alors on danse', /➕ \[Alors [Oo]n [Dd]anse.*#1/);
await play('YouTube Music link with its radio', 'https://music.youtube.com/watch?v=lYBUbBu4W08&list=RDAMVMlYBUbBu4W08', /➕ \[Never Gonna Give You Up\].*#2/);
await play('YouTube link shared from a mix', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1', /➕ \[Rick Astley.*#3/);
await play('SoundCloud link, play next', 'https://soundcloud.com/forss/flickermood', /➕ \[Flickermood\].*#1/, { next: true });
await play('link wrapped in < >', '<https://youtu.be/jNQXAC9IVRw>', /➕ \[Me at the zoo\].*#5/);
await play('a playlist', 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', /Added \d+ tracks from \*\*/);
await play('a video that is gone', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', /❌ Nothing plays at that link/);
await play('a site that does not exist', 'https://this-site-does-not-exist-ditto.example/a', /❌ I could not find/);
await play('a page with nothing to play', 'https://example.com/', /❌ I found nothing to play/);
await play('a private address', 'http://192.168.1.1/a.mp3', /❌ That link points to a private address/);

console.log('\nThe queue');
const queue = await slash('queue');
check('/queue', /\*\*Now\*\* · \[Around the World.*`1\.` \[Flickermood\].*`2\.` \[Alors/.test(queue.answer), queue.answer.slice(0, 120));
const before = posted.length;
const skipped = await slash('skip');
for (let k = 0; k < 40 && posted.length === before; k++) await wait(250);
const next = posted.slice(before).find((p) => p.text.includes('NOW PLAYING'))?.text ?? 'nothing started';
check('/skip starts the next track', skipped.answer.includes('Skipped') && next.includes('Flickermood'), next.slice(0, 90));
const stopped = await slash('stop');
check('/stop', stopped.answer.includes('Stopped'), stopped.answer);
await wait(1500);
const nothing = await slash('skip');
check('/skip with nothing playing', nothing.answer.includes('Nothing is playing'), nothing.answer);

console.log('\nFrom nothing to sound');
{
  const timed = async (label: string, query: string, limit: number) => {
    const r = await slash('play', { query });
    check(label, r.started !== null && r.started < limit, `playing after ${seconds(r.started)}`);
    await stop();
  };
  // Typed, a look at the list, then the first suggestion: it was got ready meanwhile.
  const list = (await typing('daft punk get lucky')).choices;
  await wait(5000);
  await timed('first suggestion, after a look', list[0].value, 2500);
  await timed('a suggestion picked at once', (await typing('stromae papaoutai')).choices[0].value, 10_000);
  await timed('a YouTube link', 'https://youtu.be/dQw4w9WgXcQ?si=abc', 12_000);
  await timed('a SoundCloud link', 'https://soundcloud.com/forss/flickermood', 3000);
  await timed('a Bandcamp link', 'https://c418.bandcamp.com/track/sweden', 4000);
  await timed('an audio file', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', 3000);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
