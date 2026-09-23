import { Client, Events, GatewayIntentBits, type Guild } from 'discord.js';
import { env } from './env.js';
import { db } from './core/db.js';
import { createDispatcher } from './core/dispatch.js';
import { log } from './core/log.js';
import { features } from './features/index.js';

if (!env.token) {
  console.error('BOT_TOKEN is missing: copy .env.example to .env and fill it in.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
});

const dispatcher = createDispatcher(features);
for (const f of features) f.init?.(client);
client.on(Events.InteractionCreate, dispatcher.handle);

async function prepareGuild(guild: Guild) {
  if (env.guildIds.length && !env.guildIds.includes(guild.id)) return;
  try {
    await guild.members.fetch();
    // Per-server commands show up instantly, so there is no separate deploy step.
    await guild.commands.set(dispatcher.commands.map((c) => c.data.toJSON()));
    for (const f of features) {
      await f.guildReady?.(guild).catch((err) => log.error(f.name, `${guild.name}:`, err));
    }
    log.info('bot', `${guild.name} ready (${guild.memberCount} members)`);
  } catch (err) {
    log.error('bot', `${guild.name}:`, err);
  }
}

client.once(Events.ClientReady, async (c) => {
  log.info('bot', `Logged in as ${c.user.tag}`);
  // Commands are per server; clear any global ones so nothing shows twice.
  await c.application.commands.set([]).catch(() => {});
  for (const guild of c.guilds.cache.values()) await prepareGuild(guild);
});

client.on(Events.GuildCreate, (guild) => void prepareGuild(guild));

async function shutdown() {
  log.info('bot', 'Shutting down…');
  await client.destroy().catch(() => {});
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (reason) => log.error('bot', 'unhandled rejection:', reason));
process.on('uncaughtException', (err) => log.error('bot', 'uncaught exception:', err));

client.login(env.token);
