import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  Events,
  MediaGalleryBuilder,
  MessageFlags,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type MessageComponentInteraction,
} from 'discord.js';
import { getConfig, type GuildConfig } from '../../core/config.js';
import { log } from '../../core/log.js';
import { logTo } from '../../core/logs.js';
import { isPrivileged, requirePrivileged } from '../../core/perms.js';
import type { Feature } from '../../core/types.js';
import { card, COLOR, ok, replyError, text, V2 } from '../../core/ui.js';
import { runsOn } from '../../env.js';
import { GRID } from './cells.js';
import { promptFor } from './classes.js';
import { hasReady, nextChallenge, prepareChallenges } from './grid.js';
import { dropOutdatedExtras, getPool, reloadPool } from './pool.js';
import { closeSession, getSession, getState, markVerified, MAX_REFRESH, nextRound, openSession, setState, type Session } from './session.js';

// ---------- Settings ----------

/** The captcha runs once there is a verification channel and a role to swap. */
export const verificationOn = (cfg: GuildConfig) => !!cfg.verifyChannel && !!(cfg.pendingRole || cfg.memberRole);

/** Verified: holds the member role, or — without one — no longer holds the pending role. */
function isVerified(member: GuildMember, cfg: GuildConfig) {
  if (cfg.memberRole) return member.roles.cache.has(cfg.memberRole);
  return !!cfg.pendingRole && !member.roles.cache.has(cfg.pendingRole);
}

// ---------- The challenge message ----------

const fileName = (s: Session) => `captcha-${s.id}.jpg`;

/** 16 buttons laid out like the squares of the picture. */
function tiles(s: Session) {
  return Array.from({ length: GRID }, (_, r) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      Array.from({ length: GRID }, (_, c) => {
        const n = r * GRID + c;
        const on = s.selected.has(n);
        return new ButtonBuilder()
          .setCustomId(`captcha:t:${s.id}:${n}`)
          .setLabel(on ? '✓' : String(n + 1))
          .setStyle(on ? ButtonStyle.Primary : ButtonStyle.Secondary);
      })
    )
  );
}

/** Reload, help and the blue button: « Skip » until a square is ticked, then « Verify », like reCAPTCHA. */
function controls(s: Session) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`captcha:new:${s.id}`)
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(s.refreshes >= MAX_REFRESH),
    new ButtonBuilder().setCustomId(`captcha:help:${s.id}`).setEmoji('ℹ️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`captcha:ok:${s.id}`)
      .setLabel(s.selected.size ? 'Verify' : 'Skip')
      .setStyle(ButtonStyle.Primary)
  );
}

function attemptsLeft(s: Session) {
  if (s.test) return 'Test mode — your roles will not change';
  // At least one: the setting may have been lowered below the misses already made.
  const left = Math.max(1, getConfig(s.guildId).captchaAttempts - getState(s.guildId, s.userId).failures);
  return `${left} attempt${left === 1 ? '' : 's'} left`;
}

function components(s: Session, notice?: string) {
  return [
    new MediaGalleryBuilder().addItems((item) =>
      item.setURL(`attachment://${fileName(s)}`).setDescription(`Select all squares with ${promptFor(s.challenge.target)}`)
    ),
    ...tiles(s),
    controls(s),
    text(notice ? `${notice}\n-# ${attemptsLeft(s)}` : `-# ${attemptsLeft(s)}`),
  ];
}

/** The whole challenge, with its picture. */
function challengeMessage(s: Session, notice?: string) {
  return {
    components: components(s, notice),
    files: [new AttachmentBuilder(s.challenge.image, { name: fileName(s) })],
  };
}

function endCard(color: number, body: string) {
  return { components: [card(color, body)], attachments: [] };
}

// ---------- The panel in the verification channel ----------

function panel(guild: Guild) {
  const cfg = getConfig(guild.id);
  const container = new ContainerBuilder()
    .setAccentColor(COLOR.primary)
    .addSectionComponents((section) =>
      section
        .addTextDisplayComponents(
          text(
            `## 🔐 Verification\nTo get into **${guild.name}**, show you are not a robot.\n` +
              'Press **Verify me**, then tick every square with the object asked.'
          )
        )
        .setButtonAccessory(new ButtonBuilder().setCustomId('captcha:start').setLabel('Verify me').setEmoji('🔐').setStyle(ButtonStyle.Success))
    )
    .addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      text(`-# ${cfg.captchaAttempts} attempts, then a ${cfg.captchaTimeoutMinutes}-minute pause. Stuck? Ask a staff member.`)
    );
  return { components: [container] };
}

/** Posts (or refreshes) the panel in the verification channel. */
export async function ensurePanel(guild: Guild) {
  const cfg = getConfig(guild.id);
  const channel = guild.channels.cache.get(cfg.verifyChannel ?? '');
  if (!channel?.isTextBased() || !verificationOn(cfg)) return false;
  const recent = await channel.messages.fetch({ limit: 10 });
  const mine = recent.find((m) => m.author.id === guild.client.user.id);
  // A panel from an older version (an embed) cannot become a component layout: replace it.
  if (mine?.flags.has(MessageFlags.IsComponentsV2)) await mine.edit({ components: panel(guild).components });
  else {
    await mine?.delete().catch(() => {});
    await channel.send({ ...panel(guild), flags: V2 });
  }
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
  if (!test) {
    if (!verificationOn(cfg)) return replyError(i, 'Verification is not set up yet. A staff member will let you in.');
    if (isVerified(i.member, cfg)) return replyError(i, 'You are already verified 🙂');
    const { lockedUntil } = getState(i.guildId, i.user.id);
    if (lockedUntil > Date.now()) return replyError(i, `Too many misses. You can try again <t:${Math.ceil(lockedUntil / 1000)}:R>.`);
  }
  if (!getPool()) return replyError(i, 'Verification is temporarily unavailable. A staff member will let you in.');

  // With the stock empty a challenge is drawn now, which can take longer than Discord waits for an answer.
  if (!hasReady()) await i.deferReply({ flags: MessageFlags.Ephemeral });
  const s = openSession(i.guildId, i.user.id, await nextChallenge(), test);
  if (i.deferred) await i.editReply({ ...challengeMessage(s), flags: V2 });
  else await i.reply({ ...challengeMessage(s), flags: MessageFlags.Ephemeral | V2 });
}

/** Another picture on the same message, after a miss or a reload. */
async function swapPicture(i: ButtonInteraction<'cached'>, s: Session, notice?: string) {
  if (!hasReady()) await i.deferUpdate();
  nextRound(s, await nextChallenge());
  const view = { ...challengeMessage(s, notice), attachments: [] };
  return i.deferred ? i.editReply(view) : i.update(view);
}

/** Only the buttons changed: the picture already on the message stays. */
async function redrawButtons(i: ButtonInteraction<'cached'>, s: Session) {
  try {
    await i.update({ components: components(s) });
  } catch (err) {
    // Should the attachment reference not carry over, send the picture again.
    log.warn('captcha', `button update failed, sending the picture again: ${(err as Error).message}`);
    await i.update({ ...challengeMessage(s), attachments: [] });
  }
}

async function succeed(i: ButtonInteraction<'cached'>, s: Session) {
  const cfg = getConfig(i.guildId);
  closeSession(s);
  await i.deferUpdate();
  let member: GuildMember = i.member;
  try {
    if (cfg.pendingRole && member.roles.cache.has(cfg.pendingRole)) member = await member.roles.remove(cfg.pendingRole, 'Captcha passed');
    if (cfg.memberRole) member = await member.roles.add(cfg.memberRole, 'Captcha passed');
  } catch (err) {
    log.error('captcha', `could not give roles to ${member.user.tag}:`, (err as Error).message);
    return i.editReply(endCard(COLOR.warn, '### ⚠️ Captcha passed\nBut I could not give you access. A staff member will sort it out.'));
  }
  markVerified(i.guildId, i.user.id);
  logTo(i.guild, `✅ **${member.user.username}** passed the captcha`);
  return i.editReply(endCard(COLOR.success, `### ✅ You are verified\nWelcome to **${i.guild.name}**!`));
}

async function fail(i: ButtonInteraction<'cached'>, s: Session) {
  const cfg = getConfig(i.guildId);
  const failures = getState(i.guildId, i.user.id).failures + 1;

  if (failures >= cfg.captchaAttempts) {
    const until = Date.now() + cfg.captchaTimeoutMinutes * 60_000;
    setState(i.guildId, i.user.id, 0, until);
    closeSession(s);
    await i.update(endCard(COLOR.danger, `### ❌ Too many misses\nYou can try again <t:${Math.ceil(until / 1000)}:R>.`));
    if (i.member.moderatable) {
      await i.member.timeout(cfg.captchaTimeoutMinutes * 60_000, `Failed the captcha ${cfg.captchaAttempts} times`).catch(() => {});
    }
    logTo(i.guild, `⛔ **${i.user.username}** failed the captcha ${cfg.captchaAttempts} times (${cfg.captchaTimeoutMinutes} min timeout)`);
    return;
  }

  setState(i.guildId, i.user.id, failures, 0);
  // reCAPTCHA's own wording.
  const notice = s.challenge.required.length && !s.selected.size ? '❌ **Please select all matching images.**' : '❌ **Please try again.**';
  return swapPicture(i, s, notice);
}

/** The picture again, with the expected answer: for staff trying the captcha. */
function testResultView(s: Session, correct: boolean) {
  const list = (ns: number[]) =>
    ns
      .map((n) => n + 1)
      .sort((a, b) => a - b)
      .join(', ') || 'none';
  const body = [
    correct ? '### 🧪 Test passed' : '### 🧪 Test failed',
    `Target: **${promptFor(s.challenge.target)}**`,
    `Squares to tick: **${list(s.challenge.required)}**`,
    `Either way: ${list(s.challenge.optional)}`,
    `Your squares: **${list([...s.selected])}**`,
  ].join('\n');
  const container = new ContainerBuilder()
    .setAccentColor(correct ? COLOR.success : COLOR.danger)
    .addMediaGalleryComponents((g) => g.addItems((item) => item.setURL(`attachment://${fileName(s)}`)))
    .addTextDisplayComponents(text(body))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('captcha:retest').setLabel('Play again').setEmoji('🔁').setStyle(ButtonStyle.Primary)
      )
    );
  return { components: [container] };
}

async function testResult(i: ButtonInteraction<'cached'>, s: Session, correct: boolean) {
  closeSession(s);
  return i.update(testResultView(s, correct));
}

/** The layouts, for the offline self-test. */
export const captchaViews = { challengeMessage, panel, testResultView };

async function expired(i: MessageComponentInteraction<'cached'>) {
  const body = '### ⌛ This captcha has expired\nStart again from the verification channel.';
  if (i.message.flags.has(MessageFlags.IsComponentsV2)) return i.update(endCard(COLOR.warn, body));
  return replyError(i, 'This captcha has expired. Start again from the verification channel.');
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
  const pending = verificationOn(cfg) ? cfg.pendingRole : null;
  // The pending role goes on first: finding out where a member came from takes a few
  // seconds, and the server has to stay hidden from them in the meantime.
  const pendingError = pending
    ? await member.roles.add(pending, 'Waiting for the captcha').then(
        () => null,
        (err: Error) => err
      )
    : null;

  if (cfg.quarantineRole && cfg.quarantineBots.length && (await joinedViaQuarantineBot(member, cfg.quarantineBots))) {
    await member.roles.add(cfg.quarantineRole, 'Brought in by a member-pushing bot');
    // Quarantined instead of verified: the captcha is not for them.
    if (pending && !pendingError) await member.roles.remove(pending, 'Quarantined').catch(() => {});
    logTo(member.guild, `🙈 **${name}** was brought in by a bot: quarantined`);
    return;
  }
  if (!verificationOn(cfg)) return;
  if (pendingError) throw pendingError;
  logTo(member.guild, `👋 **${name}** joined, captcha pending`);
}

// ---------- Feature ----------

export const captchaFeature: Feature = {
  name: 'captcha',

  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('captcha')
        .setDescription('Verification when members join')
        .addSubcommand((s) => s.setName('test').setDescription('Try the captcha without touching your roles'))
        .addSubcommand((s) =>
          s
            .setName('reset')
            .setDescription('Clear a member’s failed attempts and timeout')
            .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
        )
        .addSubcommand((s) => s.setName('panel').setDescription('Post the panel in the verification channel again'))
        .addSubcommand((s) => s.setName('reload').setDescription('Reload the photo database')),
      async run(i) {
        if (!(await requirePrivileged(i))) return;
        const sub = i.options.getSubcommand();
        if (sub === 'test') return start(i, true);
        if (sub === 'reset') {
          const member = i.options.getMember('member');
          if (!member) return replyError(i, 'Member not found.');
          setState(i.guildId, member.id, 0, 0);
          if (member.isCommunicationDisabled()) await member.timeout(null).catch(() => {});
          return i.reply({ embeds: [ok(`Attempts cleared for ${member}.`)], flags: MessageFlags.Ephemeral });
        }
        if (sub === 'panel') {
          const done = await ensurePanel(i.guild);
          return done
            ? i.reply({ embeds: [ok('Verification panel updated.')], flags: MessageFlags.Ephemeral })
            : replyError(i, 'Verification is not set up — open `/setup` (the quick setup does it in one click).');
        }
        const pool = reloadPool();
        if (!pool) return replyError(i, 'No photo database found.');
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        await prepareChallenges();
        return i.editReply({ embeds: [ok(`Photos reloaded: ${pool.images.length} photos, ${pool.classes.length} categories.`)] });
      },
    },
  ],

  components: {
    async captcha(i, [action, id, arg]) {
      if (!i.isButton()) return;
      if (action === 'start') return start(i, false);
      if (action === 'retest') {
        if (!isPrivileged(i.member)) return replyError(i, 'Staff only.');
        return start(i, true);
      }

      const s = getSession(i.guildId, i.user.id, id);
      if (!s) return expired(i);

      if (action === 't') {
        const n = Number(arg);
        if (s.selected.has(n)) s.selected.delete(n);
        else s.selected.add(n);
        return redrawButtons(i, s);
      }
      if (action === 'help') {
        return i.reply({
          components: [
            card(
              COLOR.primary,
              '### How to pass\n' +
                `1. Look for **${promptFor(s.challenge.target)}** in the picture.\n` +
                '2. Tick every square that shows a part of one — the buttons are laid out like the squares.\n' +
                '3. Press **Verify**. If there is none, press **Skip** without ticking anything.\n\n' +
                '🔄 gives you another picture.'
            ),
          ],
          flags: MessageFlags.Ephemeral | V2,
        });
      }
      if (action === 'new') {
        if (s.refreshes >= MAX_REFRESH) return i.deferUpdate();
        s.refreshes++;
        return swapPicture(i, s);
      }
      if (action === 'ok') {
        const correct = isCorrect(s);
        if (s.test) return testResult(i, s, correct);
        return correct ? succeed(i, s) : fail(i, s);
      }
    },
  },

  init(client) {
    if (dropOutdatedExtras()) log.info('captcha', 'removed the photos built by an older Ditto: they now ship with it');
    // Draw the parts that never change and a few challenges in advance.
    prepareChallenges().catch((err) => log.error('captcha', 'could not prepare challenges:', err));

    client.on(Events.GuildMemberAdd, (member) => {
      if (runsOn(member.guild.id)) onJoin(member).catch((err) => log.warn('captcha', err.message));
    });
    // Access given by hand: drop the pending role.
    client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
      if (!runsOn(newMember.guild.id)) return;
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
      log.info('captcha', `${guild.name}: panel ready, ${pool ? `${pool.images.length} photos` : 'no photos'}`);
    }
  },
};
