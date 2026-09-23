import { MessageFlags, SlashCommandBuilder, type Guild } from 'discord.js';
import { detectConfig, getConfig, hasConfig, saveConfig, type GuildConfig } from '../core/config.js';
import { log } from '../core/log.js';
import { requirePrivileged } from '../core/perms.js';
import type { Feature } from '../core/types.js';
import { COLOR, embed } from '../core/ui.js';

function summary(cfg: GuildConfig) {
  const role = (id: string | null) => (id ? `<@&${id}>` : '❌ introuvable');
  const channel = (id: string | null) => (id ? `<#${id}>` : '❌ introuvable');
  const roles = (ids: string[]) => (ids.length ? ids.map((id) => `<@&${id}>`).join(' ') : '❌ aucun');
  return [
    `**Membres** : ${role(cfg.membersRole)}`,
    `**En vérification** : ${role(cfg.verifyRole)}`,
    `**nope** : ${role(cfg.nopeRole)}${cfg.nopeInviters.length ? ` (arrivées via ${cfg.nopeInviters.map((id) => `<@${id}>`).join(', ')})` : ''}`,
    `**Salon de vérification** : ${channel(cfg.verifyChannel)}`,
    `**Logs** : ${channel(cfg.logChannel)}`,
    `**Tests captcha** : ${channel(cfg.testChannel)}`,
    `**Staff** : ${roles(cfg.staffRoles)}`,
    `**Couleurs** : ${roles(cfg.colorRoles)}`,
    `**Jeux** : ${roles(cfg.gameRoles)}`,
    `**Salles** : ${cfg.rooms.length ? cfg.rooms.map((id) => `<#${id}>`).join(' ') : '❌ aucune'}`,
  ].join('\n');
}

async function detectAndSave(guild: Guild) {
  const cfg = await detectConfig(guild);
  saveConfig(guild.id, cfg);
  return cfg;
}

export const setupFeature: Feature = {
  name: 'setup',
  commands: [
    {
      data: new SlashCommandBuilder().setName('setup').setDescription('Redétecter les rôles et salons de Ditto sur ce serveur'),
      async run(i) {
        if (!(await requirePrivileged(i))) return;
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const cfg = await detectAndSave(i.guild);
        return i.editReply({ embeds: [embed(COLOR.primary, summary(cfg), '⚙️ Configuration détectée')], allowedMentions: { parse: [] } });
      },
    },
  ],
  async guildReady(guild) {
    if (hasConfig(guild.id)) return;
    await detectAndSave(guild);
    const cfg = getConfig(guild.id);
    log.info('setup', `${guild.name} : configuration détectée (membres ${cfg.membersRole ? '✓' : '✗'}, vérif ${cfg.verifyChannel ? '✓' : '✗'})`);
  },
};
