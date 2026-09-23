import { MessageFlags, type Interaction } from 'discord.js';
import { log } from './log.js';
import type { Command, ComponentHandler, Feature } from './types.js';
import { replyError } from './ui.js';

export function createDispatcher(features: Feature[]) {
  const commands = new Map<string, Command>();
  const components = new Map<string, ComponentHandler>();
  for (const f of features) {
    for (const c of f.commands ?? []) commands.set(c.data.name, c);
    for (const [prefix, handler] of Object.entries(f.components ?? {})) components.set(prefix, handler);
  }

  const dispatch = async (i: Interaction) => {
    if (!i.inCachedGuild()) {
      if (i.isRepliable()) await i.reply({ content: 'Ditto ne fonctionne que sur un serveur.', flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      if (i.isChatInputCommand()) await commands.get(i.commandName)?.run(i);
      else if (i.isAutocomplete()) await commands.get(i.commandName)?.autocomplete?.(i);
      else if (i.isMessageComponent()) {
        const [prefix, ...args] = i.customId.split(':');
        await components.get(prefix)?.(i, args);
      }
    } catch (err) {
      log.error('interaction', i.isChatInputCommand() ? `/${i.commandName}` : i.isMessageComponent() ? i.customId : i.type, err);
      if (i.isRepliable()) await replyError(i, 'Une erreur est survenue.').catch(() => {});
    }
  };

  return {
    commands: [...commands.values()],
    handle: (i: Interaction) => void dispatch(i),
  };
}
