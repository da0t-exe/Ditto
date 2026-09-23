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
import { GRID, makeChallenge, renderChallenge } from './grid.js';
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

/** 16 squares laid out like the picture, then Verify / New image. */
function buttons(s: Session, lang: Lang) {
  const rows = Array.from({ length: GRID }, (_, r) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      Array.from({ length: GRID }, (_, c) => {
        const n = r * GRID + c;
        const on = s.selected.has(n);
        return new ButtonBuilder()
          .setCustomId(`captcha:t:${n}`)
          .setLabel(on ? '✓' : String(n + 1))
          .setStyle(on ? ButtonStyle.Primary : ButtonStyle.Secondary);
      })
    )
  );
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('captcha:ok').setLabel(tr(lang, 'Verify', 'Valider')).setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('captcha:new')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(s.refreshes >= MAX_REFRESH)
    )
  );
  return rows;
}

/** The whole challenge is one picture: instruction, grid and attempts are drawn into it. */
async function picture(s: Session, lang: Lang, notice?: string) {
  const left = MAX_FAILURES - (s.test ? 0 : getState(s.guildId, s.userId).failures);
  const footer =
    notice ??
    (s.test
      ? tr(lang, 'Test mode — your roles will not change', 'Mode test — tes rôles ne changeront pas')
      : tr(lang, `${left} attempt${left > 1 ? 's' : ''} left`, `${left} essai${left > 1 ? 's' : ''} restant${left > 1 ? 's' : ''}`));
  return renderChallenge(
    s.challenge.photo,
    tr(lang, 'Select all squares with', 'Sélectionnez toutes les cases avec'),
    promptFor(s.challenge.target, lang),
    footer,
    s.test ? 'TEST' : undefined
  );
}

async function view(s: Session, lang: Lang, notice?: string) {
  return {
    embeds: [new EmbedBuilder().setColor(COLOR.primary).setImage(`attachment://${FILE}`)],
    components: buttons(s, lang),
    files: [new AttachmentBuilder(await picture(s, lang, notice), { name: FILE })],
  };
}

function panel(guild: Guild) {
  const cfg = getConfig(guild.id);
  const lang = guildLang(guild);
  const e = embed(
    COLOR.primary,
    tr(
      lang,
      `To get into **${guild.name}**, show you are not a robot: press **Verify me** and pick the right squares.\n\n` +
        `You have ${MAX_FAILURES} attempts. After ${MAX_FAILURES} misses you will have to wait ${cfg.captchaTimeoutMinutes} minutes.`,
      `Pour accéder à **${guild.name}**, prouve que tu n'es pas un robot : clique sur **Me vérifier** et sélectionne les bonnes cases.\n\n` +
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

/** Every ticked square is right, and every square that had to be ticked is. */
function isCorrect(s: Session) {
  const { required, optional } = s.challenge;
  const allowed = new Set([...required, ...optional]);
  return required.every((n) => s.selected.has(n)) && [...s.selected].every((n) => allowed.has(n));
}

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
        ? tr(lang, 'The photo pool is not ready yet — it builds itself on start, or run `npm run captcha:fetch`, then `/captcha reload`.', "La réserve de photos n'est pas prête : elle se construit au démarrage, ou lance `npm run captcha:fetch` puis `/captcha reload`.")
        : tr(lang, 'Verification is temporarily unavailable. A staff member will let you in.', 'La vérification est momentanément indisponible. Un membre du staff va t’ouvrir l’accès.')
    );
  }

  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const s = openSession(i.guildId, i.user.id, await makeChallenge(), test);
  const msg = await i.editReply(await view(s, lang));
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
  s.challenge = await makeChallenge();
  s.selected.clear();
  const left = MAX_FAILURES - failures;
  const notice = tr(
    lang,
    `Please try again — ${left} attempt${left > 1 ? 's' : ''} left`,
    `Réessayez — ${left} essai${left > 1 ? 's' : ''} restant${left > 1 ? 's' : ''}`
  );
  return i.editReply({ ...(await view(s, lang, notice)), attachments: [] });
}

async function testResult(i: ButtonInteraction<'cached'>, s: Session, correct: boolean, lang: Lang) {
  closeSession(s);
  const list = (ns: number[]) => ns.map((n) => n + 1).sort((a, b) => a - b).join(', ') || tr(lang, 'none', 'aucune');
  const e = new EmbedBuilder()
    .setColor(correct ? COLOR.success : COLOR.danger)
    .setTitle(correct ? tr(lang, '🧪 Test passed', '🧪 Test réussi') : tr(lang, '🧪 Test failed', '🧪 Test raté'))
    .setDescription(
      [
        `${tr(lang, 'Target:', 'Consigne :')} **${promptFor(s.challenge.target, lang)}**`,
        `${tr(lang, 'Squares to tick:', 'Cases à cocher :')} **${list(s.challenge.required)}**`,
        `${tr(lang, 'Either way:', 'Au choix :')} ${list(s.challenge.optional)}`,
        `${tr(lang, 'Your squares:', 'Tes cases :')} **${list([...s.selected])}**`,
      ].join('\n')
    )
    .setImage(`attachment://${FILE}`);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('captcha:retest').setLabel(tr(lang, 'Play again', 'Rejouer')).setEmoji('🔁').setStyle(ButtonStyle.Primary)
  );
  return i.editReply({ embeds: [e], components: [row], files: [new AttachmentBuilder(await picture(s, lang), { name: FILE })], attachments: [] });
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
        .addSubcommand((s) => loc(s, 'reload', ['Reload the photo pool', 'Recharger la réserve de photos'])),
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
              embeds: [ok(tr(lang, `Pool reloaded: ${pool.images.length} photos, ${pool.classes.length} categories.`, `Réserve rechargée : ${pool.images.length} photos, ${pool.classes.length} catégories.`))],
              flags: MessageFlags.Ephemeral,
            })
          : replyError(i, tr(lang, 'No photo pool found.', 'Aucune réserve de photos trouvée.'));
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
        s.challenge = await makeChallenge();
        s.selected.clear();
        return i.editReply({ ...(await view(s, lang)), attachments: [] });
      }
      if (action === 'ok') {
        const correct = isCorrect(s);
        if (s.test) return testResult(i, s, correct, lang);
        return correct ? succeed(i, s, lang) : fail(i, s, lang);
      }
    },
  },

  init(client) {
    // The console of a hosting panel is not a shell, so the pool builds itself on start.
    if (!getPool() && process.env.CAPTCHA_AUTOFETCH !== '0') {
      log.info('captcha', 'No photo pool in the current format: building it in the background (a few minutes)…');
      buildPool((msg) => log.info('captcha', msg))
        .then(() => reloadPool())
        .catch((err) => log.error('captcha', 'could not build the photo pool:', err));
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
      log.info('captcha', `${guild.name}: panel ready, pool ${pool ? `${pool.images.length} photos` : 'missing'}`);
    }
  },
};
