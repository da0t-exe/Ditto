import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
} from 'discord.js';
import { getConfig } from '../../core/config.js';
import { log } from '../../core/log.js';
import { logTo } from '../../core/logs.js';
import { isPrivileged, requirePrivileged } from '../../core/perms.js';
import type { Feature } from '../../core/types.js';
import { COLOR, embed, ok, replyError } from '../../core/ui.js';
import { pickerView } from '../roles/picker.js';
import { buildPool } from './build.js';
import { makeGrid } from './grid.js';
import { getPool, reloadPool } from './pool.js';
import {
  closeSession,
  getSession,
  getState,
  markVerified,
  MAX_FAILURES,
  MAX_REFRESH,
  openSession,
  setState,
  type Session,
} from './session.js';

const FILE = 'captcha.jpg';

// ---------- Affichage ----------

function buttons(s: Session) {
  const rows = [0, 1, 2].map((r) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      [0, 1, 2].map((c) => {
        const n = r * 3 + c;
        return new ButtonBuilder()
          .setCustomId(`captcha:t:${n}`)
          .setLabel(String(n + 1))
          .setStyle(s.selected.has(n) ? ButtonStyle.Primary : ButtonStyle.Secondary);
      })
    )
  );
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('captcha:ok').setLabel('Valider').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('captcha:new')
        .setLabel('Autre image')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(s.refreshes >= MAX_REFRESH)
    )
  );
  return rows;
}

function view(s: Session, notice?: string) {
  const failures = s.test ? 0 : getState(s.guildId, s.userId).failures;
  const lines = [
    `Sélectionne toutes les images avec **${s.grid.prompt}**.`,
    'Les boutons sont placés comme les images : coche les bonnes cases, puis **Valider**.',
  ];
  if (notice) lines.push('', notice);
  const e = new EmbedBuilder()
    .setColor(COLOR.primary)
    .setTitle(s.test ? '🧪 Captcha — test' : '🔐 Vérification')
    .setDescription(lines.join('\n'))
    .setImage(`attachment://${FILE}`)
    .setFooter({
      text: s.test ? 'Mode test : aucun rôle ne sera modifié' : `Essais restants : ${MAX_FAILURES - failures}`,
    });
  return {
    embeds: [e],
    components: buttons(s),
    files: [new AttachmentBuilder(s.grid.image, { name: FILE })],
  };
}

function panel(guild: Guild) {
  const cfg = getConfig(guild.id);
  const e = embed(
    COLOR.primary,
    [
      `Pour accéder à **${guild.name}**, prouve que tu n'es pas un robot :`,
      'clique sur **Me vérifier** et sélectionne les bonnes images.',
      '',
      `Tu as ${MAX_FAILURES} essais. Après ${MAX_FAILURES} échecs, il faudra attendre ${cfg.captchaTimeoutMinutes} minutes.`,
    ].join('\n'),
    '👋 Bienvenue !'
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('captcha:start').setLabel('Me vérifier').setEmoji('🔐').setStyle(ButtonStyle.Success)
  );
  return { embeds: [e], components: [row] };
}

/** Place (ou remet à jour) le panneau dans le salon de vérification. */
async function ensurePanel(guild: Guild) {
  const cfg = getConfig(guild.id);
  const channel = guild.channels.cache.get(cfg.verifyChannel ?? '');
  if (!channel?.isTextBased()) return false;
  const recent = await channel.messages.fetch({ limit: 10 });
  const mine = recent.find((m) => m.author.id === guild.client.user.id);
  if (mine) await mine.edit(panel(guild));
  else await channel.send(panel(guild));
  return true;
}

// ---------- Déroulement ----------

async function start(i: ButtonInteraction<'cached'> | ChatInputCommandInteraction<'cached'>, test: boolean) {
  const cfg = getConfig(i.guildId);
  if (!test) {
    if (cfg.membersRole && i.member.roles.cache.has(cfg.membersRole)) return replyError(i, 'Tu es déjà vérifié 🙂');
    const { lockedUntil } = getState(i.guildId, i.user.id);
    if (lockedUntil > Date.now()) {
      return replyError(i, `Trop d'essais ratés. Tu pourras réessayer <t:${Math.ceil(lockedUntil / 1000)}:R>.`);
    }
  }
  if (!getPool()) {
    return replyError(
      i,
      test
        ? "La réserve d'images n'est pas prête : lance `npm run captcha:fetch`, puis `/captcha reload`."
        : 'La vérification est momentanément indisponible. Un membre du staff va t’ouvrir l’accès.'
    );
  }

  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const s = openSession(i.guildId, i.user.id, await makeGrid(), test);
  const msg = await i.editReply(view(s));
  s.messageId = msg.id;
}

async function succeed(i: ButtonInteraction<'cached'>, s: Session) {
  const cfg = getConfig(i.guildId);
  let member: GuildMember = i.member;
  try {
    if (cfg.verifyRole && member.roles.cache.has(cfg.verifyRole)) member = await member.roles.remove(cfg.verifyRole, 'Captcha réussi');
    if (cfg.membersRole) member = await member.roles.add(cfg.membersRole, 'Captcha réussi');
  } catch (err) {
    log.error('captcha', `rôles non attribués à ${member.user.tag}:`, (err as Error).message);
    return i.editReply({
      embeds: [embed(COLOR.warn, 'Captcha réussi, mais je n’ai pas pu te donner l’accès. Un membre du staff va s’en occuper.')],
      components: [],
      attachments: [],
    });
  }
  markVerified(i.guildId, i.user.id);
  closeSession(s);
  logTo(i.guild, `✅ **${member.user.username}** a réussi le captcha`);
  return i.editReply({ ...pickerView(member, '✅ **Vérification réussie, bienvenue !**\n'), attachments: [] });
}

async function fail(i: ButtonInteraction<'cached'>, s: Session) {
  const cfg = getConfig(i.guildId);
  const failures = getState(i.guildId, i.user.id).failures + 1;

  if (failures >= MAX_FAILURES) {
    const until = Date.now() + cfg.captchaTimeoutMinutes * 60_000;
    setState(i.guildId, i.user.id, 0, until);
    closeSession(s);
    if (i.member.moderatable) {
      await i.member.timeout(cfg.captchaTimeoutMinutes * 60_000, 'Captcha raté 3 fois').catch(() => {});
    }
    logTo(i.guild, `⛔ **${i.user.username}** a raté le captcha ${MAX_FAILURES} fois (pause de ${cfg.captchaTimeoutMinutes} min)`);
    return i.editReply({
      embeds: [embed(COLOR.danger, `❌ Raté ${MAX_FAILURES} fois. Tu pourras réessayer <t:${Math.ceil(until / 1000)}:R>.`)],
      components: [],
      attachments: [],
    });
  }

  setState(i.guildId, i.user.id, failures, 0);
  s.grid = await makeGrid();
  s.selected.clear();
  const left = MAX_FAILURES - failures;
  return i.editReply({ ...view(s, `❌ Raté, voici une nouvelle image. Encore **${left}** essai${left > 1 ? 's' : ''}.`), attachments: [] });
}

async function testResult(i: ButtonInteraction<'cached'>, s: Session, correct: boolean) {
  closeSession(s);
  const expected = s.grid.answer.map((n) => n + 1).join(', ') || 'aucune';
  const chosen = [...s.selected].sort().map((n) => n + 1).join(', ') || 'aucune';
  const e = new EmbedBuilder()
    .setColor(correct ? COLOR.success : COLOR.danger)
    .setTitle(correct ? '🧪 Test réussi' : '🧪 Test raté')
    .setDescription(
      [
        `Consigne : **${s.grid.prompt}**`,
        `Cases attendues : **${expected}**`,
        `Cases cochées : **${chosen}**`,
        '',
        'Si une case attendue te semble fausse, dis-le : on affinera les images.',
      ].join('\n')
    )
    .setImage(`attachment://${FILE}`);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('captcha:retest').setLabel('Rejouer').setEmoji('🔁').setStyle(ButtonStyle.Primary)
  );
  return i.editReply({ embeds: [e], components: [row], files: [new AttachmentBuilder(s.grid.image, { name: FILE })], attachments: [] });
}

// ---------- Arrivées ----------

interface SearchResult {
  members: { member: { user: { id: string } }; join_source_type: number; inviter_id?: string | null }[];
}

/** Arrivé via un des bots « nope » ? (la recherche de membres peut mettre quelques secondes à indexer) */
async function joinedViaNopeBot(member: GuildMember, inviters: string[]) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const res = (await member.client.rest.post(`/guilds/${member.guild.id}/members-search`, {
        body: { limit: 50, sort: 1 },
      })) as SearchResult;
      const hit = res.members.find((m) => m.member.user.id === member.id);
      if (hit) return hit.join_source_type === 1 && !!hit.inviter_id && inviters.includes(hit.inviter_id);
    } catch {
      return false;
    }
  }
  return false;
}

async function onJoin(member: GuildMember) {
  if (member.user.bot) return;
  const cfg = getConfig(member.guild.id);
  if (cfg.nopeRole && cfg.nopeInviters.length && (await joinedViaNopeBot(member, cfg.nopeInviters))) {
    await member.roles.add(cfg.nopeRole, 'Arrivé via un bot de recrutement');
    logTo(member.guild, `🙈 **${member.user.username}** est arrivé via un bot : rôle nope`);
    return;
  }
  if (cfg.verifyRole) await member.roles.add(cfg.verifyRole, 'En attente du captcha');
  logTo(member.guild, `👋 **${member.user.username}** est arrivé, captcha en attente`);
}

// ---------- Fonction ----------

export const captchaFeature: Feature = {
  name: 'captcha',

  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('captcha')
        .setDescription('Vérification à l’arrivée')
        .addSubcommand((s) => s.setName('test').setDescription('Tester le captcha sans toucher à tes rôles'))
        .addSubcommand((s) =>
          s
            .setName('reset')
            .setDescription('Effacer les essais ratés et la pause d’un membre')
            .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
        )
        .addSubcommand((s) => s.setName('panel').setDescription('Remettre le panneau dans le salon de vérification'))
        .addSubcommand((s) => s.setName('reload').setDescription('Recharger la réserve d’images')),
      async run(i) {
        if (!(await requirePrivileged(i))) return;
        const sub = i.options.getSubcommand();
        if (sub === 'test') return start(i, true);
        if (sub === 'reset') {
          const member = i.options.getMember('membre');
          if (!member) return replyError(i, 'Membre introuvable.');
          setState(i.guildId, member.id, 0, 0);
          if (member.isCommunicationDisabled()) await member.timeout(null).catch(() => {});
          return i.reply({ embeds: [ok(`Essais de ${member} remis à zéro.`)], flags: MessageFlags.Ephemeral });
        }
        if (sub === 'panel') {
          const done = await ensurePanel(i.guild);
          return done
            ? i.reply({ embeds: [ok('Panneau de vérification à jour.')], flags: MessageFlags.Ephemeral })
            : replyError(i, 'Salon de vérification introuvable (lance `/setup`).');
        }
        const pool = reloadPool();
        return pool
          ? i.reply({
              embeds: [ok(`Réserve rechargée : ${pool.images.length} images, ${pool.classes.length} catégories.`)],
              flags: MessageFlags.Ephemeral,
            })
          : replyError(i, "Aucune réserve d'images trouvée.");
      },
    },
  ],

  components: {
    async captcha(i, [action, arg]) {
      if (!i.isButton()) return;
      if (action === 'start') return start(i, false);
      if (action === 'retest') {
        if (!isPrivileged(i.member)) return replyError(i, 'Réservé au staff.');
        return start(i, true);
      }

      const s = getSession(i.guildId, i.user.id);
      if (!s || s.messageId !== i.message.id) {
        return i.update({ embeds: [embed(COLOR.warn, 'Ce captcha a expiré. Relance la vérification.')], components: [], attachments: [] });
      }

      if (action === 't') {
        const n = Number(arg);
        if (s.selected.has(n)) s.selected.delete(n);
        else s.selected.add(n);
        return i.update({ components: buttons(s) });
      }

      await i.deferUpdate();
      if (action === 'new') {
        if (s.refreshes >= MAX_REFRESH) return;
        s.refreshes++;
        s.grid = await makeGrid();
        s.selected.clear();
        return i.editReply({ ...view(s), attachments: [] });
      }
      if (action === 'ok') {
        const correct =
          s.selected.size === s.grid.answer.length && s.grid.answer.every((n) => s.selected.has(n));
        if (s.test) return testResult(i, s, correct);
        return correct ? succeed(i, s) : fail(i, s);
      }
    },
  },

  init(client) {
    // Sur Pterodactyl, la console n'est pas un terminal : la réserve se construit toute seule au premier démarrage.
    if (!getPool() && process.env.CAPTCHA_AUTOFETCH !== '0') {
      log.info('captcha', "Réserve d'images absente : téléchargement en arrière-plan (quelques minutes)…");
      buildPool((msg) => log.info('captcha', msg))
        .then(() => reloadPool())
        .catch((err) => log.error('captcha', 'construction de la réserve impossible :', err));
    }

    client.on(Events.GuildMemberAdd, (member) => {
      onJoin(member).catch((err) => log.warn('captcha', err.message));
    });
    // Accès donné à la main par le staff : on retire le rôle d'attente.
    client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
      const cfg = getConfig(newMember.guild.id);
      if (!cfg.membersRole || !cfg.verifyRole) return;
      if (!oldMember.roles.cache.has(cfg.membersRole) && newMember.roles.cache.has(cfg.membersRole) &&
          newMember.roles.cache.has(cfg.verifyRole)) {
        newMember.roles.remove(cfg.verifyRole, 'Vérifié').catch(() => {});
      }
    });
  },

  async guildReady(guild) {
    if (await ensurePanel(guild).catch(() => false)) {
      const pool = getPool();
      log.info('captcha', `${guild.name} : panneau prêt, réserve ${pool ? `${pool.images.length} images` : 'absente'}`);
    }
  },
};
