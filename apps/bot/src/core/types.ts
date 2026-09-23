import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  Guild,
  MessageComponentInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

export interface Command {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  run(i: ChatInputCommandInteraction<'cached'>): Promise<unknown>;
  autocomplete?(i: AutocompleteInteraction<'cached'>): Promise<unknown>;
}

/** Les customId des composants sont « prefixe:arg1:arg2 ». */
export type ComponentHandler = (i: MessageComponentInteraction<'cached'>, args: string[]) => Promise<unknown>;

export interface Feature {
  name: string;
  commands?: Command[];
  components?: Record<string, ComponentHandler>;
  /** Branche les écouteurs d'événements, avant la connexion. */
  init?(client: Client): void;
  /** Appelé pour chaque serveur une fois le bot prêt (et à chaque nouveau serveur). */
  guildReady?(guild: Guild): Promise<void>;
}
