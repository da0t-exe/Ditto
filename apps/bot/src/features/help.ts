import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { isPrivileged } from '../core/perms.js';
import type { Feature } from '../core/types.js';
import { card, COLOR, V2 } from '../core/ui.js';
import { env } from '../env.js';

const MUSIC =
  '### 🎵 Music\n' +
  '`/play` a song name or a link — Ditto picks the best match · `/skip` · `/previous` · `/pause` · `/resume` · `/stop`\n' +
  '`/queue` · `/nowplaying` · `/volume` · `/loop` · `/shuffle` · `/remove` · `/clear` · `/seek` · `/filter` · `/lyrics`\n' +
  '-# The player message has buttons for all of it.';

const VOICE =
  '### 🔊 Voice\n' +
  '`/room` customise the room you own · `/move` · `/gather` · `/split` · `/disconnect` · `/shake` · `/lock` · `/unlock` · `/locks`\n' +
  '-# Moving people needs the Move Members permission or a staff role.';

const STAFF =
  '### 🛡️ Staff\n' +
  '`/setup` — every setting, and **Quick setup** to get the captcha running in one click\n' +
  '`/captcha test` · `/captcha reset` · `/captcha panel` · `/captcha reload`' +
  (env.dashboard ? '\n`/dashboard` — manage Ditto from the web' : '');

export const helpFeature: Feature = {
  name: 'help',
  commands: [
    {
      data: new SlashCommandBuilder().setName('help').setDescription('What Ditto can do'),
      async run(i) {
        const blocks = ['## 👋 Ditto\nVoice tools, music and a captcha for newcomers.', MUSIC, VOICE];
        if (isPrivileged(i.member)) blocks.push(STAFF);
        return i.reply({ components: [card(COLOR.primary, ...blocks)], flags: MessageFlags.Ephemeral | V2 });
      },
    },
  ],
};
