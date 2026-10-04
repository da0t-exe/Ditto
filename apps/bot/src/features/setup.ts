import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  RoleSelectMenuBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  type Guild,
} from 'discord.js';
import { applyDetection, getConfig, hasConfig, updateConfig, type GuildConfig } from '../core/config.js';
import { log } from '../core/log.js';
import { requirePrivileged } from '../core/perms.js';
import type { Feature } from '../core/types.js';
import { COLOR, text, V2 } from '../core/ui.js';
import { ensurePanel, verificationOn } from './captcha/index.js';
import { getPool } from './captcha/pool.js';
import { quickSetup, quickSetupMissing } from './quicksetup.js';
import { prepareRooms } from './voice/rooms.js';

type Page = 'home' | 'verify' | 'quarantine' | 'staff' | 'voice';
type NumberField = 'captchaAttempts' | 'captchaTimeoutMinutes' | 'afkIdleMinutes';
const PAGES: { id: Page; label: string; emoji: string }[] = [
  { id: 'home', label: 'Overview', emoji: '🏠' },
  { id: 'verify', label: 'Captcha', emoji: '🔐' },
  { id: 'quarantine', label: 'Quarantine', emoji: '🙈' },
  { id: 'staff', label: 'Staff', emoji: '🛡️' },
  { id: 'voice', label: 'Voice & logs', emoji: '🔊' },
];

type SelectRow = ActionRowBuilder<RoleSelectMenuBuilder | ChannelSelectMenuBuilder | UserSelectMenuBuilder | StringSelectMenuBuilder>;
const row = (c: RoleSelectMenuBuilder | ChannelSelectMenuBuilder | UserSelectMenuBuilder | StringSelectMenuBuilder) =>
  new ActionRowBuilder<typeof c>().addComponents(c) as SelectRow;

const check = (ok: boolean) => (ok ? '✅' : '⬜');

/** Roles Ditto has to hand out must sit below its own role. */
function reachWarnings(guild: Guild, cfg: GuildConfig) {
  const top = guild.members.me?.roles.highest;
  if (!top) return [];
  const ids = [cfg.memberRole, cfg.pendingRole, cfg.quarantineRole].filter((x): x is string => !!x);
  const blocked = ids.map((id) => guild.roles.cache.get(id)).filter((r) => r && top.comparePositionTo(r) <= 0);
  if (!blocked.length) return [];
  return [`⚠️ Drag Ditto’s role above ${blocked.map((r) => `<@&${r!.id}>`).join(' ')} in **Server Settings → Roles**, or it cannot hand them out.`];
}

function overview(guild: Guild, cfg: GuildConfig) {
  const pool = getPool();
  const lines = [
    `${check(verificationOn(cfg))} **Captcha** — ${
      verificationOn(cfg) ? `newcomers verify in <#${cfg.verifyChannel}>` : 'not set up yet: press **Quick setup**'
    }`,
    `${check(!!cfg.quarantineRole && cfg.quarantineBots.length > 0)} **Quarantine** — ${
      cfg.quarantineRole ? `${cfg.quarantineBots.length} bot(s) watched` : 'off (optional)'
    }`,
    `${check(cfg.staffRoles.length > 0)} **Staff** — ${cfg.staffRoles.length ? cfg.staffRoles.map((id) => `<@&${id}>`).join(' ') : 'only admins and the owner'}`,
    `${check(!!cfg.logChannel)} **Logs** — ${cfg.logChannel ? `<#${cfg.logChannel}>` : 'no log channel'}`,
    `${check(cfg.rooms.length > 0)} **Rooms** — ${cfg.rooms.length ? `${cfg.rooms.length} room(s) reset when empty` : 'none (optional)'}`,
  ];
  const extra = [
    `-# ${pool ? `${pool.images.length} captcha photos` : 'no captcha photos'} · music ready with \`/play\` · type \`/help\` for every command`,
  ];
  return [
    '**Quick setup** creates what is missing — an *Unverified* role, a #verify channel and a private #ditto-logs — hides the server from newcomers until they pass the captcha, and posts the panel. Existing members are not affected, and deleting the *Unverified* role undoes it.',
    lines.join('\n'),
    extra.join('\n'),
  ];
}

const HELP: Record<Exclude<Page, 'home'>, string> = {
  verify:
    'Newcomers get the **pending role** and only see the **verification channel** until they pass. The **member role** is optional: give it if your channels are opened to a role rather than hidden from the pending one.',
  quarantine:
    'Members brought in by a member-pushing bot get the **quarantine role** instead of the captcha. Give that role no access at all and they never see the server.',
  staff:
    '**Staff** roles can use every Ditto command, including `/setup` and `/captcha`. Administrators and the server owner always can.',
  voice:
    '**Rooms** go back to their original name, limit and permissions when they empty; the first person in owns the room and customises it with `/room`. The **log channel** receives joins, moves and moderation.',
};

function view(guild: Guild, page: Page, notice?: string) {
  const cfg = getConfig(guild.id);
  const roleIds = (ids: string[]) => ids.filter((id) => guild.roles.cache.has(id));
  const channelIds = (ids: string[]) => ids.filter((id) => guild.channels.cache.has(id));
  const one = (id: string | null) => (id ? [id] : []);
  const id = (field: string) => `setup:set:${field}:${page}`;

  const roleSelect = (field: 'memberRole' | 'pendingRole' | 'quarantineRole' | 'staffRoles', placeholder: string, max: number) => {
    const current = roleIds(Array.isArray(cfg[field]) ? (cfg[field] as string[]) : one(cfg[field] as string | null));
    const b = new RoleSelectMenuBuilder().setCustomId(id(field)).setPlaceholder(placeholder).setMinValues(0).setMaxValues(max);
    if (current.length) b.setDefaultRoles(current);
    return row(b);
  };
  const channelSelect = (field: 'verifyChannel' | 'logChannel' | 'rooms', placeholder: string, types: ChannelType[], max: number) => {
    const current = channelIds(field === 'rooms' ? cfg.rooms : one(cfg[field]));
    const b = new ChannelSelectMenuBuilder()
      .setCustomId(id(field))
      .setPlaceholder(placeholder)
      .setChannelTypes(types)
      .setMinValues(0)
      .setMaxValues(max);
    if (current.length) b.setDefaultChannels(current);
    return row(b);
  };
  const numberSelect = (field: NumberField, label: (n: number) => string) =>
    row(
      new StringSelectMenuBuilder()
        .setCustomId(id(field))
        .addOptions(NUMBER_CHOICES.get(field)!.map((value) => ({ label: label(value), value: String(value), default: cfg[field] === value })))
    );

  const container = new ContainerBuilder().setAccentColor(COLOR.primary);
  const current = PAGES.find((p) => p.id === page)!;
  container.addTextDisplayComponents(text(`## ⚙️ Ditto setup — ${current.label}`));

  const rows: SelectRow[] = [];
  if (page === 'home') {
    const [intro, status, extra] = overview(guild, cfg);
    container.addTextDisplayComponents(text(intro), text(status), text(extra));
  } else {
    container.addTextDisplayComponents(text(HELP[page]));
    const TEXT = [ChannelType.GuildText];
    if (page === 'verify') {
      rows.push(roleSelect('pendingRole', 'Pending role — held until the captcha', 1));
      rows.push(roleSelect('memberRole', 'Member role — given after the captcha (optional)', 1));
      rows.push(channelSelect('verifyChannel', 'Verification channel', TEXT, 1));
      rows.push(numberSelect('captchaAttempts', (n) => `${n} attempts before a pause`));
      rows.push(numberSelect('captchaTimeoutMinutes', (n) => `Pause of ${n} minutes after the last miss`));
    } else if (page === 'quarantine') {
      rows.push(roleSelect('quarantineRole', 'Quarantine role', 1));
      const bots = new UserSelectMenuBuilder()
        .setCustomId(id('quarantineBots'))
        .setPlaceholder('Bots whose arrivals are quarantined')
        .setMinValues(0)
        .setMaxValues(10);
      const known = cfg.quarantineBots.filter((b) => guild.members.cache.has(b));
      if (known.length) bots.setDefaultUsers(known);
      rows.push(row(bots));
    } else if (page === 'staff') {
      rows.push(roleSelect('staffRoles', 'Staff roles', 25));
    } else {
      rows.push(channelSelect('rooms', 'Rooms that reset when empty', [ChannelType.GuildVoice], 25));
      rows.push(channelSelect('logChannel', 'Log channel', TEXT, 1));
      rows.push(
        row(
          new StringSelectMenuBuilder()
            .setCustomId(id('features'))
            .setPlaceholder('Options')
            .setMinValues(0)
            .setMaxValues(2)
            .addOptions(
              { label: 'Voice log: joins, leaves and moves', value: 'voiceLog', emoji: '📜', default: cfg.voiceLog },
              { label: 'Move deafened members to AFK', value: 'autoAfk', emoji: '💤', default: cfg.autoAfk }
            )
        )
      );
      rows.push(numberSelect('afkIdleMinutes', (n) => `AFK after ${n} minutes deafened`));
    }
  }
  if (rows.length) container.addActionRowComponents(...rows);

  const warnings = reachWarnings(guild, cfg);
  if (warnings.length || notice) {
    container
      .addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(text([...warnings, notice].filter(Boolean).join('\n')));
  }

  container.addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      PAGES.map((p) =>
        new ButtonBuilder()
          .setCustomId(`setup:page:${p.id}`)
          .setLabel(p.label)
          .setEmoji(p.emoji)
          .setStyle(p.id === page ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(p.id === page)
      )
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`setup:quick:${page}`).setLabel('Quick setup').setEmoji('⚡').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`setup:detect:${page}`).setLabel('Auto-detect').setEmoji('🔎').setStyle(ButtonStyle.Secondary)
    )
  );
  return { components: [container] };
}

function confirmQuick(guild: Guild, page: string) {
  const missing = quickSetupMissing(guild);
  const container = new ContainerBuilder()
    .setAccentColor(COLOR.warn)
    .addTextDisplayComponents(
      text(
        '## ⚡ Quick setup\n' +
          'Ditto will:\n' +
          '• create an **Unverified** role, a **#verify** channel and a private **#ditto-logs** channel (only those missing);\n' +
          '• hide every other channel from *Unverified* — newcomers see only #verify until they pass;\n' +
          '• post the Verify panel.\n\n' +
          'Existing members keep their access. To undo it all, delete the *Unverified* role.' +
          (missing.length ? `\n\n❌ Ditto needs the **${missing.join('** and **')}** permission first.` : '')
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`setup:quickgo:${page}`)
          .setLabel('Set it up')
          .setEmoji('⚡')
          .setStyle(ButtonStyle.Success)
          .setDisabled(missing.length > 0),
        new ButtonBuilder().setCustomId(`setup:page:${page}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      )
    );
  return { components: [container] };
}

/** The layouts, for the offline self-test. */
export const setupViews = { view, confirmQuick };

/** Side effects of a change: refresh the captcha panel, record rooms. */
async function afterChange(guild: Guild, fields: string[]) {
  if (fields.some((f) => ['verifyChannel', 'pendingRole', 'memberRole', 'captchaAttempts', 'captchaTimeoutMinutes'].includes(f))) {
    await ensurePanel(guild).catch(() => {});
  }
  if (fields.includes('rooms')) await prepareRooms(guild).catch((err) => log.warn('setup', err.message));
}

const SINGLE = new Set(['memberRole', 'pendingRole', 'quarantineRole', 'verifyChannel', 'logChannel']);
const LIST = new Set(['staffRoles', 'rooms', 'quarantineBots']);
/** The values each numeric setting can take. */
const NUMBER_CHOICES = new Map<NumberField, number[]>([
  ['captchaAttempts', [3, 4, 5, 6]],
  ['captchaTimeoutMinutes', [5, 10, 30, 60]],
  ['afkIdleMinutes', [5, 10, 15, 30, 60]],
]);

/** Applies a change made in /setup. False when the setting or its value is not one Ditto knows. */
export async function applySetting(guild: Guild, field: string, values: string[]) {
  const patch: Partial<GuildConfig> = {};
  const choices = NUMBER_CHOICES.get(field as NumberField);
  if (SINGLE.has(field)) Object.assign(patch, { [field]: values[0] ?? null });
  else if (LIST.has(field)) Object.assign(patch, { [field]: values });
  else if (choices) {
    const n = Number(values[0]);
    if (!choices.includes(n)) return false;
    Object.assign(patch, { [field]: n });
  } else if (field === 'features') {
    patch.voiceLog = values.includes('voiceLog');
    patch.autoAfk = values.includes('autoAfk');
  } else return false;
  updateConfig(guild.id, patch);
  await afterChange(guild, Object.keys(patch));
  return true;
}

export const setupFeature: Feature = {
  name: 'setup',

  commands: [
    {
      data: new SlashCommandBuilder().setName('setup').setDescription('Set Ditto up on this server'),
      async run(i) {
        if (!(await requirePrivileged(i))) return;
        return i.reply({ ...view(i.guild, 'home'), flags: MessageFlags.Ephemeral | V2, allowedMentions: { parse: [] } });
      },
    },
  ],

  components: {
    async setup(i, [action, field, page]) {
      if (!(await requirePrivileged(i))) return;

      if (action === 'page') return i.update(view(i.guild, field as Page));
      if (action === 'quick') return i.update(confirmQuick(i.guild, field));
      if (action === 'quickgo') {
        await i.deferUpdate();
        try {
          const { created, hidden, failed } = await quickSetup(i.guild);
          const notice =
            `⚡ Done: ${created.length ? `created ${created.join(', ')}; ` : ''}${hidden} channel(s) hidden from newcomers` +
            (failed ? ` (${failed} could not be changed — check Ditto’s permissions there)` : '') +
            '. The Verify panel is posted.';
          return i.editReply(view(i.guild, 'home', notice));
        } catch (err) {
          log.error('setup', `${i.guild.name}: quick setup failed:`, err);
          return i.editReply(view(i.guild, 'home', `❌ Quick setup stopped: ${(err as Error).message}`));
        }
      }
      if (action === 'detect') {
        await i.deferUpdate();
        const { filled } = await applyDetection(i.guild);
        await afterChange(i.guild, filled);
        const notice = filled.length
          ? `🔎 Filled in ${filled.length} empty setting(s).`
          : '🔎 Nothing new found — settings you already chose are never overwritten.';
        return i.editReply(view(i.guild, field as Page, notice));
      }

      if (action !== 'set' || !i.isAnySelectMenu()) return;
      await i.deferUpdate();
      await applySetting(i.guild, field, i.values);
      return i.editReply(view(i.guild, page as Page));
    },
  },

  async guildReady(guild) {
    if (hasConfig(guild.id)) return;
    const { filled } = await applyDetection(guild);
    log.info('setup', `${guild.name}: first start, ${filled.length} setting(s) detected — run /setup to review`);
  },
};
