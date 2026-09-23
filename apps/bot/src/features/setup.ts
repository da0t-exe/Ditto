import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  type Guild,
} from 'discord.js';
import { applyDetection, getConfig, hasConfig, updateConfig, type GuildConfig } from '../core/config.js';
import { loc, tr, userLang, type Lang } from '../core/i18n.js';
import { log } from '../core/log.js';
import { requirePrivileged } from '../core/perms.js';
import type { Feature } from '../core/types.js';
import { COLOR } from '../core/ui.js';
import { ensurePanel } from './captcha/index.js';
import { prepareRooms } from './voice/rooms.js';

type Page = 'verify' | 'quarantine' | 'staff' | 'voice';
const PAGES: Page[] = ['verify', 'quarantine', 'staff', 'voice'];

type RoleField = 'memberRole' | 'pendingRole' | 'quarantineRole';
type RoleListField = 'staffRoles';
type ChannelField = 'verifyChannel' | 'logChannel';

const PAGE_LABEL: Record<Page, [string, string]> = {
  verify: ['Verification', 'Vérification'],
  quarantine: ['Quarantine', 'Quarantaine'],
  staff: ['Staff', 'Staff'],
  voice: ['Voice & logs', 'Vocal & logs'],
};

const PAGE_HELP: Record<Page, [string, string]> = {
  verify: [
    'Newcomers get the **pending role** and see only the **verification channel**. Passing the captcha swaps it for the **member role**.\n\n' +
      'To gate the server: take every permission away from @everyone, give them to the member role instead, and let @everyone see only the verification channel.',
    'Les nouveaux reçoivent le **rôle en attente** et ne voient que le **salon de vérification**. Réussir le captcha le remplace par le **rôle membre**.\n\n' +
      'Pour fermer le serveur : retire toutes les permissions de @everyone, donne-les au rôle membre, et laisse @everyone voir seulement le salon de vérification.',
  ],
  quarantine: [
    'Members brought in by a member-pushing bot get the **quarantine role** instead of the captcha. Give that role no access at all and they never see the server.',
    'Les membres amenés par un bot de recrutement reçoivent le **rôle de quarantaine** au lieu du captcha. Ne donne aucun accès à ce rôle : ils ne verront jamais le serveur.',
  ],
  staff: [
    '**Staff** roles can use every Ditto command, including `/setup` and `/captcha`. Administrators and the server owner always can.',
    'Les rôles **staff** peuvent utiliser toutes les commandes de Ditto, dont `/setup` et `/captcha`. Les administrateurs et le propriétaire du serveur le peuvent toujours.',
  ],
  voice: [
    '**Rooms** go back to their original name, limit and permissions when they empty; the first person in owns the room and customises it with `/room`. The **log channel** receives joins, leaves, moves and moderation.',
    'Les **salles** reprennent leur nom, leur limite et leurs permissions d’origine quand elles se vident ; la première personne entrée en est propriétaire et la personnalise avec `/room`. Le **salon de logs** reçoit arrivées, départs, déplacements et modération.',
  ],
};

function row<T extends RoleSelectMenuBuilder | ChannelSelectMenuBuilder | UserSelectMenuBuilder | StringSelectMenuBuilder>(c: T) {
  return new ActionRowBuilder<T>().addComponents(c);
}

function view(guild: Guild, lang: Lang, page: Page, notice?: string) {
  const cfg = getConfig(guild.id);
  const L = (en: string, fr: string) => tr(lang, en, fr);
  const roleIds = (ids: string[]) => ids.filter((id) => guild.roles.cache.has(id));
  const channelIds = (ids: string[]) => ids.filter((id) => guild.channels.cache.has(id));
  const one = (id: string | null) => (id ? [id] : []);
  const id = (field: string) => `setup:set:${field}:${page}`;

  const roleSelect = (field: RoleField | RoleListField, placeholder: string, max: number) => {
    const current = roleIds(Array.isArray(cfg[field]) ? (cfg[field] as string[]) : one(cfg[field] as string | null));
    const b = new RoleSelectMenuBuilder().setCustomId(id(field)).setPlaceholder(placeholder).setMinValues(0).setMaxValues(max);
    if (current.length) b.setDefaultRoles(current);
    return row(b);
  };
  const channelSelect = (field: ChannelField | 'rooms', placeholder: string, types: ChannelType[], max: number) => {
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

  const rows: ActionRowBuilder<
    RoleSelectMenuBuilder | ChannelSelectMenuBuilder | UserSelectMenuBuilder | StringSelectMenuBuilder | ButtonBuilder
  >[] = [];
  const TEXT = [ChannelType.GuildText];

  if (page === 'verify') {
    rows.push(roleSelect('memberRole', L('Member role — given after the captcha', 'Rôle membre — donné après le captcha'), 1));
    rows.push(roleSelect('pendingRole', L('Pending role — held until the captcha', 'Rôle en attente — jusqu’au captcha'), 1));
    rows.push(channelSelect('verifyChannel', L('Verification channel', 'Salon de vérification'), TEXT, 1));
  } else if (page === 'quarantine') {
    rows.push(roleSelect('quarantineRole', L('Quarantine role', 'Rôle de quarantaine'), 1));
    const bots = new UserSelectMenuBuilder()
      .setCustomId(id('quarantineBots'))
      .setPlaceholder(L('Bots whose arrivals are quarantined', 'Bots dont les arrivées vont en quarantaine'))
      .setMinValues(0)
      .setMaxValues(10);
    const known = cfg.quarantineBots.filter((b) => guild.members.cache.has(b));
    if (known.length) bots.setDefaultUsers(known);
    rows.push(row(bots));
  } else if (page === 'staff') {
    rows.push(roleSelect('staffRoles', L('Staff roles', 'Rôles staff'), 25));
  } else {
    rows.push(channelSelect('rooms', L('Rooms that reset when empty', 'Salles qui se réinitialisent'), [ChannelType.GuildVoice], 25));
    rows.push(channelSelect('logChannel', L('Log channel', 'Salon de logs'), TEXT, 1));
    rows.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId(id('features'))
          .setPlaceholder(L('Options', 'Options'))
          .setMinValues(0)
          .setMaxValues(2)
          .addOptions(
            { label: L('Voice log', 'Journal vocal'), value: 'voiceLog', emoji: '📜', default: cfg.voiceLog },
            {
              label: L(`Move deafened members to AFK after ${cfg.afkIdleMinutes} min`, `AFK automatique après ${cfg.afkIdleMinutes} min en sourdine`),
              value: 'autoAfk',
              emoji: '💤',
              default: cfg.autoAfk,
            }
          )
      )
    );
    rows.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId(id('language'))
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(
            { label: L('Language: automatic', 'Langue : automatique'), value: 'auto', emoji: '🌐', default: cfg.language === 'auto' },
            { label: 'English', value: 'en', emoji: '🇬🇧', default: cfg.language === 'en' },
            { label: 'Français', value: 'fr', emoji: '🇫🇷', default: cfg.language === 'fr' }
          )
      )
    );
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...PAGES.map((p) =>
        new ButtonBuilder()
          .setCustomId(`setup:page:${p}`)
          .setLabel(tr(lang, ...PAGE_LABEL[p]))
          .setStyle(p === page ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(p === page)
      ),
      new ButtonBuilder().setCustomId(`setup:detect:${page}`).setLabel(L('Auto-detect', 'Détecter')).setEmoji('🔎').setStyle(ButtonStyle.Secondary)
    )
  );

  const lines = [tr(lang, ...PAGE_HELP[page])];
  const warnings = checkReach(guild, cfg, lang);
  if (warnings.length) lines.push('', ...warnings);
  if (notice) lines.push('', notice);

  const e = new EmbedBuilder()
    .setColor(COLOR.primary)
    .setTitle(`⚙️ ${L('Ditto setup', 'Configuration de Ditto')} — ${tr(lang, ...PAGE_LABEL[page])}`)
    .setDescription(lines.join('\n'));
  return { embeds: [e], components: rows };
}

/** Roles Ditto has to hand out must sit below its own role. */
function checkReach(guild: Guild, cfg: GuildConfig, lang: Lang) {
  const top = guild.members.me?.roles.highest;
  if (!top) return [];
  const ids = [cfg.memberRole, cfg.pendingRole, cfg.quarantineRole].filter((x): x is string => !!x);
  const blocked = ids.map((id) => guild.roles.cache.get(id)).filter((r) => r && top.comparePositionTo(r) <= 0);
  if (!blocked.length) return [];
  const names = blocked.map((r) => `<@&${r!.id}>`).join(' ');
  return [
    tr(
      lang,
      `⚠️ Drag Ditto’s role above ${names} in Server Settings → Roles, or it cannot hand them out.`,
      `⚠️ Place le rôle de Ditto au-dessus de ${names} (Paramètres du serveur → Rôles), sinon il ne peut pas les donner.`
    ),
  ];
}

/** Side effects of a change: refresh the captcha panel, record rooms. */
async function afterChange(guild: Guild, fields: string[]) {
  if (fields.some((f) => ['verifyChannel', 'language'].includes(f))) await ensurePanel(guild).catch(() => {});
  if (fields.includes('rooms')) await prepareRooms(guild).catch((err) => log.warn('setup', err.message));
}

const SINGLE = new Set(['memberRole', 'pendingRole', 'quarantineRole', 'verifyChannel', 'logChannel']);
const LIST = new Set(['staffRoles', 'rooms', 'quarantineBots']);

export const setupFeature: Feature = {
  name: 'setup',

  commands: [
    {
      data: loc(new SlashCommandBuilder(), 'setup', ['Configure Ditto on this server', 'Configurer Ditto sur ce serveur']),
      async run(i) {
        if (!(await requirePrivileged(i))) return;
        return i.reply({ ...view(i.guild, userLang(i), 'verify'), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      },
    },
  ],

  components: {
    async setup(i, [action, field, page]) {
      if (!(await requirePrivileged(i))) return;
      const lang = userLang(i);

      if (action === 'page') return i.update(view(i.guild, lang, field as Page));

      if (action === 'detect') {
        await i.deferUpdate();
        const { filled } = await applyDetection(i.guild);
        await afterChange(i.guild, filled);
        const notice = filled.length
          ? tr(lang, `🔎 Filled in ${filled.length} empty setting(s).`, `🔎 ${filled.length} réglage(s) vide(s) rempli(s).`)
          : tr(lang, '🔎 Nothing new found — settings you already chose are never overwritten.', '🔎 Rien de nouveau : tes choix ne sont jamais écrasés.');
        return i.editReply(view(i.guild, lang, field as Page, notice));
      }

      if (action !== 'set' || !i.isAnySelectMenu()) return;
      const values = i.values;
      const patch: Partial<GuildConfig> = {};
      if (SINGLE.has(field)) Object.assign(patch, { [field]: values[0] ?? null });
      else if (LIST.has(field)) Object.assign(patch, { [field]: values });
      else if (field === 'features') {
        patch.voiceLog = values.includes('voiceLog');
        patch.autoAfk = values.includes('autoAfk');
      } else if (field === 'language') {
        patch.language = (values[0] as GuildConfig['language']) ?? 'auto';
      }
      updateConfig(i.guildId, patch);
      await i.deferUpdate();
      await afterChange(i.guild, [field]);
      return i.editReply(view(i.guild, userLang(i), page as Page));
    },
  },

  async guildReady(guild) {
    if (hasConfig(guild.id)) return;
    const { filled } = await applyDetection(guild);
    log.info('setup', `${guild.name}: first start, ${filled.length} setting(s) detected — run /setup to review`);
  },
};
