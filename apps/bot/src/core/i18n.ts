import type { Guild, LocalizationMap } from 'discord.js';
import { getConfig } from './config.js';

export type Lang = 'en' | 'fr';

/** Language of messages everyone sees (panels, logs): the server setting, else the server's Discord language. */
export function guildLang(guild: Guild): Lang {
  const { language } = getConfig(guild.id);
  if (language !== 'auto') return language;
  return guild.preferredLocale?.startsWith('fr') ? 'fr' : 'en';
}

/** Language of a reply only one person sees: the server setting, else that person's Discord language. */
export function userLang(i: { locale: string; guildId: string | null }): Lang {
  const language = i.guildId ? getConfig(i.guildId).language : 'auto';
  if (language !== 'auto') return language;
  return i.locale.startsWith('fr') ? 'fr' : 'en';
}

export const tr = (lang: Lang, en: string, fr: string) => (lang === 'fr' ? fr : en);

interface Localizable {
  setName(name: string): unknown;
  setNameLocalizations(localizations: LocalizationMap | null): unknown;
  setDescription(description: string): unknown;
  setDescriptionLocalizations(localizations: LocalizationMap | null): unknown;
}

/** English name and description, with French shown to French Discord clients. */
export function loc<T extends Localizable>(builder: T, name: string | [string, string], description: [string, string]): T {
  const [en, fr] = typeof name === 'string' ? [name, name] : name;
  builder.setName(en);
  if (fr !== en) builder.setNameLocalizations({ fr });
  builder.setDescription(description[0]);
  builder.setDescriptionLocalizations({ fr: description[1] });
  return builder;
}
