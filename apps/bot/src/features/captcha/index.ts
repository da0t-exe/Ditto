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
import { guildLang, loc, tr, userLang, type Lang } from '../../core/i18n.js';
import { log } from '../../core/log.js';
import { logTo } from '../../core/logs.js';
import { isPrivileged, requirePrivileged } from '../../core/perms.js';
import type { Feature } from '../../core/types.js';
import { COLOR, embed, ok, replyError } from '../../core/ui.js';
import { buildPool } from './build.js';
import { promptFor } from './classes.js';
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

// ---------- Views ----------

function buttons(s: Session, lang: Lang) {
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
      new ButtonBuilder()
        .setCustomId('captcha:ok')
        .setLabel(tr(lang, 'Verify', 'Valider'))
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('captcha:new')
        .setLabel(tr(lang, 'New image', 'Autre image'))
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(s.refreshes >= MAX_REFRESH)
    )
  );
  return rows;
}

function view(s: Session, lang: Lang, notice?: string) {
  const failures = s.test ? 0 : getState(s.guildId, s.userId).failures;
  const prompt = promptFor(s.grid.target, lang);
  const lines = [
    tr(lang, `Select every image with **${prompt}**.`, `Sélectionne toutes les images avec **${prompt}**.`),
    tr(
      lang,
      'The buttons are laid out like the images: tick the right ones, then **Verify**.',
      'Les boutons sont placés comme les images : coche les bonnes cases, puis **Valider**.'
    ),
  ];
  if (notice) lines.push('', notice);
  const e = new EmbedBuilder()
    .setColor(COLOR.primary)
    .setTitle(s.test ? tr(lang, '🧪 Captcha — test', '🧪 Captcha — test') : tr(lang, '🔐 Verification', '🔐 Vérification'))
    .setDescription(lines.join('\n'))
    .setImage(`attachment://${FILE}`)
    .setFooter({
      text: s.test
        ? tr(lang, 'Test mode: your roles will not change', 'Mode test : aucun rôle ne sera modifié')
        : tr(lang, `Attempts left: ${MAX_FAILURES - failures}`, `Essais restants : ${MAX_FAILURES - failures}`),
    });
  return {
    embeds: [e],
    components: buttons(s, lang),
    files: [new AttachmentBuilder(s.grid.image, { name: FILE })],
  };
}

function panel(guild: Guild) {
  const cfg = getConfig(guild.id);
  const lang = guildLang(guild);
  const e = embed(
    COLOR.primary,
    tr(
      lang,
      `To get into **${guild.name}**, show you are not a robot: press **Verify me** and pick the right images.\n\n` +
        `You have ${MAX_FAILURES} attempts. After ${MAX_FAILURES} misses you will have to wait ${cfg.captchaTimeoutMinutes} minutes.`,
      `Pour accéder à **${guild.name}**, prouve que tu n'es pas un robot : clique sur **Me vérifier** et sélectionne les bonnes images.\n\n` +
        `Tu as ${MAX_FAILURES} essais. Après ${MAX_FAILURES} échecs, il faudra attendre ${cfg.captchaTimeoutMinutes} minutes.`
    ),
    tr(lang, '👋 Welcome!', '👋 Bienvenue !')
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('captcha:start')
      .setLabel(tr(lang, 'Verify me', 'Me vérifier'))
      .setEmoji('🔐')
      .setStyle(ButtonStyle.Success)
  );
  return { embeds: [e], components: [row] };
}

/** Posts (or refreshes) the panel in the verification channel. */
export async function ensurePanel(guild: Guild) {
  const cfg = getConfig(guild.id);
  const channel = guild.channels.cache.get(cfg.verifyChannel ?? '');
  if (!channel?.isTextBased()) return false;
  const recent = await channel.messages.fetch({ limit: 10 });
  const mine = recent.find((m) => m.author.id === guild.client.user.id);
  if (mine) await mine.edit(panel(guild));
  else await channel.send(panel(guild));
  return true;
}

// ---------- Flow ----------

async function start(i: ButtonInteraction<'cached'> | ChatInputCommandInteraction<'cached'>, test: boolean) {
  const cfg = getConfig(i.guildId);
  const lang = userLang(i);
  if (!test) {
    if (!cfg.memberRole) {
      return replyError(i, tr(lang, 'Verification is not set up yet. A staff member will let you in.', 'La vérification n’est pas encore configurée. Un membre du staff va t’ouvrir l’accès.'));
    }
    if (i.member.roles.cache.has(cfg.memberRole)) return replyError(i, tr(lang, 'You are already verified 🙂', 'Tu es déjà vérifié 🙂'));
    const { lockedUntil } = getState(i.guildId, i.user.id);
    if (lockedUntil > Date.now()) {
      const when = `<t:${Math.ceil(lockedUntil / 1000)}:R>`;
      return replyError(i, tr(lang, `Too many misses. You can try again ${when}.`, `Trop d'essais ratés. Tu pourras réessayer ${when}.`));
    }
  }
  if (!getPool()) {
    return replyError(
      i,
      test
        ? tr(lang, 'The image pool is not ready yet — it builds itself on first start, or run `npm run captcha:fetch`, then `/captcha reload`.', "La réserve d'images n'est pas prête : elle se construit au premier démarrage, ou lance `npm run captcha:fetch` puis `/captcha reload`.")
        : tr(lang, 'Verification is temporarily unavailable. A staff member will let you in.', 'La vérification est momentanément indisponible. Un membre du staff va t’ouvrir l’accès.')
    );
  }

  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const s = openSession(i.guildId, i.user.id, await makeGrid(), test);
  const msg = await i.editReply(view(s, lang));
  s.messageId = msg.id;
}

async function succeed(i: ButtonInteraction<'cached'>, s: Session, lang: Lang) {
  const cfg = getConfig(i.guildId);
  let member: GuildMember = i.member;
  try {
    if (cfg.pendingRole && member.roles.cache.has(cfg.pendingRole)) member = await member.roles.remove(cfg.pendingRole, 'Captcha passed');
    if (cfg.memberRole) member = await member.roles.add(cfg.memberRole, 'Captcha passed');
  } catch (err) {
    log.error('captcha', `could not give roles to ${member.user.tag}:`, (err as Error).message);
    return i.editReply({
      embeds: [embed(COLOR.warn, tr(lang, 'Captcha passed, but I could not give you access. A staff member will sort it out.', 'Captcha réussi, mais je n’ai pas pu te donner l’accès. Un membre du staff va s’en occuper.'))],
      components: [],
      attachments: [],
    });
  }
  markVerified(i.guildId, i.user.id);
  closeSession(s);
  logTo(i.guild, `✅ **${member.user.username}** passed the captcha`, `✅ **${member.user.username}** a réussi le captcha`);
  return i.editReply({
    embeds: [embed(COLOR.success, tr(lang, `✅ **Verified — welcome to ${i.guild.name}!**`, `✅ **Vérification réussie, bienvenue sur ${i.guild.name} !**`))],
    components: [],
    attachments: [],
  });
}

async function fail(i: ButtonInteraction<'cached'>, s: Session, lang: Lang) {
  const cfg = getConfig(i.guildId);
  const failures = getState(i.guildId, i.user.id).failures + 1;

  if (failures >= MAX_FAILURES) {
    const until = Date.now() + cfg.captchaTimeoutMinutes * 60_000;
    setState(i.guildId, i.user.id, 0, until);
    closeSession(s);
    if (i.member.moderatable) {
      await i.member.timeout(cfg.captchaTimeoutMinutes * 60_000, `Failed the captcha ${MAX_FAILURES} times`).catch(() => {});
    }
    const name = i.user.username;
    logTo(
      i.guild,
      `⛔ **${name}** failed the captcha ${MAX_FAILURES} times (${cfg.captchaTimeoutMinutes} min timeout)`,
      `⛔ **${name}** a raté le captcha ${MAX_FAILURES} fois (pause de ${cfg.captchaTimeoutMinutes} min)`
    );
    const when = `<t:${Math.ceil(until / 1000)}:R>`;
    return i.editReply({
      embeds: [embed(COLOR.danger, tr(lang, `❌ Missed ${MAX_FAILURES} times. You can try again ${when}.`, `❌ Raté ${MAX_FAILURES} fois. Tu pourras réessayer ${when}.`))],
      components: [],
      attachments: [],
    });
  }

  setState(i.guildId, i.user.id, failures, 0);
  s.grid = await makeGrid();
  s.selected.clear();
  const left = MAX_FAILURES - failures;
  const notice = tr(
    lang,
    `❌ Not quite — here is a new image. **${left}** attempt${left > 1 ? 's' : ''} left.`,
    `❌ Raté, voici une nouvelle image. Encore **${left}** essai${left > 1 ? 's' : ''}.`
  );
  return i.editReply({ ...view(s, lang, notice), attachments: [] });
}

async function testResult(i: ButtonInteraction<'cached'>, s: Session, correct: boolean, lang: Lang) {
  closeSession(s);
  const none = tr(lang, 'none', 'aucune');
  const expected = s.grid.answer.map((n) => n + 1).join(', ') || none;
  const chosen = [...s.selected].sort().map((n) => n + 1).join(', ') || none;
  const e = new EmbedBuilder()
    .setColor(correct ? COLOR.success : COLOR.danger)
    .setTitle(correct ? tr(lang, '🧪 Test passed', '🧪 Test réussi') : tr(lang, '🧪 Test failed', '🧪 Test raté'))
    .setDescription(
      [
        `${tr(lang, 'Target:', 'Consigne :')} **${promptFor(s.grid.target, lang)}**`,
        `${tr(lang, 'Expected tiles:', 'Cases attendues :')} **${expected}**`,
        `${tr(lang, 'Your tiles:', 'Cases cochées :')} **${chosen}**`,
      ].join('\n')
    )
    .setImage(`attachment://${FILE}`);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('captcha:retest').setLabel(tr(lang, 'Play again', 'Rejouer')).setEmoji('🔁').setStyle(ButtonStyle.Primary)
  );
  return i.editReply({ embeds: [e], components: [row], files: [new AttachmentBuilder(s.grid.image, { name: FILE })], attachments: [] });
}

// ---------- Arrivals ----------

interface SearchResult {
  members: { member: { user: { id: string } }; join_source_type: number; inviter_id?: string | null }[];
}

/** Brought in by one of the quarantine bots? (member search can take a few seconds to index a join) */
async function joinedViaQuarantineBot(member: GuildMember, bots: string[]) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const res = (await member.client.rest.post(`/guilds/${member.guild.id}/members-search`, {
        body: { limit: 50, sort: 1 },
      })) as SearchResult;
      const hit = res.members.find((m) => m.member.user.id === member.id);
      if (hit) return hit.join_source_type === 1 && !!hit.inviter_id && bots.includes(hit.inviter_id);
    } catch {
      return false;
    }
  }
  return false;
}

async function onJoin(member: GuildMember) {
  if (member.user.bot) return;
  const cfg = getConfig(member.guild.id);
  const name = member.user.username;
  if (cfg.quarantineRole && cfg.quarantineBots.length && (await joinedViaQuarantineBot(member, cfg.quarantineBots))) {
    await member.roles.add(cfg.quarantineRole, 'Brought in by a member-pushing bot');
    logTo(member.guild, `🙈 **${name}** was brought in by a bot: quarantined`, `🙈 **${name}** est arrivé via un bot : mis en quarantaine`);
    return;
  }
  if (cfg.pendingRole && cfg.memberRole) {
    await member.roles.add(cfg.pendingRole, 'Waiting for the captcha');
    logTo(member.guild, `👋 **${name}** joined, captcha pending`, `👋 **${name}** est arrivé, captcha en attente`);
  }
}

// ---------- Feature ----------

export const captchaFeature: Feature = {
  name: 'captcha',

  commands: [
    {
      data: loc(new SlashCommandBuilder(), 'captcha', ['Verification when members join', 'Vérification à l’arrivée'])
        .addSubcommand((s) => loc(s, 'test', ['Try the captcha without touching your roles', 'Tester le captcha sans toucher à tes rôles']))
        .addSubcommand((s) =>
          loc(s, 'reset', ['Clear a member’s failed attempts and timeout', 'Effacer les essais ratés et la pause d’un membre']).addUserOption((o) =>
            loc(o, ['member', 'membre'], ['Member', 'Membre']).setRequired(true)
          )
        )
        .addSubcommand((s) => loc(s, 'panel', ['Post the panel in the verification channel again', 'Remettre le panneau dans le salon de vérification']))
        .addSubcommand((s) => loc(s, 'reload', ['Reload the image pool', 'Recharger la réserve d’images'])),
      async run(i) {
        if (!(await requirePrivileged(i))) return;
        const lang = userLang(i);
        const sub = i.options.getSubcommand();
        if (sub === 'test') return start(i, true);
        if (sub === 'reset') {
          const member = i.options.getMember('member');
          if (!member) return replyError(i, tr(lang, 'Member not found.', 'Membre introuvable.'));
          setState(i.guildId, member.id, 0, 0);
          if (member.isCommunicationDisabled()) await member.timeout(null).catch(() => {});
          return i.reply({ embeds: [ok(tr(lang, `Attempts cleared for ${member}.`, `Essais de ${member} remis à zéro.`))], flags: MessageFlags.Ephemeral });
        }
        if (sub === 'panel') {
          const done = await ensurePanel(i.guild);
          return done
            ? i.reply({ embeds: [ok(tr(lang, 'Verification panel updated.', 'Panneau de vérification à jour.'))], flags: MessageFlags.Ephemeral })
            : replyError(i, tr(lang, 'No verification channel — pick one in `/setup`.', 'Aucun salon de vérification : choisis-en un dans `/setup`.'));
        }
        const pool = reloadPool();
        return pool
          ? i.reply({
              embeds: [ok(tr(lang, `Pool reloaded: ${pool.images.length} images, ${pool.classes.length} categories.`, `Réserve rechargée : ${pool.images.length} images, ${pool.classes.length} catégories.`))],
              flags: MessageFlags.Ephemeral,
            })
          : replyError(i, tr(lang, 'No image pool found.', "Aucune réserve d'images trouvée."));
      },
    },
  ],

  components: {
    async captcha(i, [action, arg]) {
      if (!i.isButton()) return;
      const lang = userLang(i);
      if (action === 'start') return start(i, false);
      if (action === 'retest') {
        if (!isPrivileged(i.member)) return replyError(i, tr(lang, 'Staff only.', 'Réservé au staff.'));
        return start(i, true);
      }

      const s = getSession(i.guildId, i.user.id);
      if (!s || s.messageId !== i.message.id) {
        return i.update({
          embeds: [embed(COLOR.warn, tr(lang, 'This captcha has expired. Start again from the verification channel.', 'Ce captcha a expiré. Relance la vérification.'))],
          components: [],
          attachments: [],
        });
      }

      if (action === 't') {
        const n = Number(arg);
        if (s.selected.has(n)) s.selected.delete(n);
        else s.selected.add(n);
        return i.update({ components: buttons(s, lang) });
      }

      await i.deferUpdate();
      if (action === 'new') {
        if (s.refreshes >= MAX_REFRESH) return;
        s.refreshes++;
        s.grid = await makeGrid();
        s.selected.clear();
        return i.editReply({ ...view(s, lang), attachments: [] });
      }
      if (action === 'ok') {
        const correct = s.selected.size === s.grid.answer.length && s.grid.answer.every((n) => s.selected.has(n));
        if (s.test) return testResult(i, s, correct, lang);
        return correct ? succeed(i, s, lang) : fail(i, s, lang);
      }
    },
  },

  init(client) {
    // The console of a hosting panel is not a shell, so the pool builds itself on first start.
    if (!getPool() && process.env.CAPTCHA_AUTOFETCH !== '0') {
      log.info('captcha', 'No image pool yet: building it in the background (a few minutes)…');
      buildPool((msg) => log.info('captcha', msg))
        .then(() => reloadPool())
        .catch((err) => log.error('captcha', 'could not build the image pool:', err));
    }

    client.on(Events.GuildMemberAdd, (member) => {
      onJoin(member).catch((err) => log.warn('captcha', err.message));
    });
    // Access given by hand: drop the pending role.
    client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
      const cfg = getConfig(newMember.guild.id);
      if (!cfg.memberRole || !cfg.pendingRole) return;
      if (!oldMember.roles.cache.has(cfg.memberRole) && newMember.roles.cache.has(cfg.memberRole) && newMember.roles.cache.has(cfg.pendingRole)) {
        newMember.roles.remove(cfg.pendingRole, 'Verified').catch(() => {});
      }
    });
  },

  async guildReady(guild) {
    if (await ensurePanel(guild).catch(() => false)) {
      const pool = getPool();
      log.info('captcha', `${guild.name}: panel ready, pool ${pool ? `${pool.images.length} images` : 'missing'}`);
    }
  },
};
