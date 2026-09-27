import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, Events, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requirePrivileged } from '../core/perms.js';
import type { Feature } from '../core/types.js';
import { COLOR, text, V2 } from '../core/ui.js';
import { createLoginLink } from '../dashboard/auth.js';
import { dashboardUrl, startDashboard } from '../dashboard/server.js';
import { env } from '../env.js';

export const dashboardFeature: Feature = {
  name: 'dashboard',

  commands: env.dashboard
    ? [
        {
          data: new SlashCommandBuilder().setName('dashboard').setDescription('Get a private link to manage Ditto from the web'),
          async run(i) {
            if (!(await requirePrivileged(i))) return;
            const code = createLoginLink(i.guildId, i.user.id);
            const base = dashboardUrl();
            const container = new ContainerBuilder()
              .setAccentColor(COLOR.primary)
              .addTextDisplayComponents(
                text(
                  '## 🌐 Ditto dashboard\n' +
                    `This link logs you in to **${i.guild.name}** — it works once, for 10 minutes. Do not share it.` +
                    (base
                      ? ''
                      : `\n\nOpen the dashboard (port **${env.dashboardPort}** of the machine running Ditto) and paste this login code:\n\`${code}\`\n-# Set DASHBOARD_URL so this becomes a button.`)
                )
              );
            if (base) {
              container.addActionRowComponents(
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                  new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open the dashboard').setEmoji('🌐').setURL(`${base}/#login=${code}`)
                )
              );
            }
            return i.reply({ components: [container], flags: MessageFlags.Ephemeral | V2 });
          },
        },
      ]
    : [],

  init(client) {
    if (env.dashboard) client.once(Events.ClientReady, () => startDashboard(client));
  },
};
