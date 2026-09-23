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

/** Component customIds read « prefix:arg1:arg2 ». */
export type ComponentHandler = (i: MessageComponentInteraction<'cached'>, args: string[]) => Promise<unknown>;

export interface Feature {
  name: string;
  commands?: Command[];
  components?: Record<string, ComponentHandler>;
  /** Wires event listeners, before login. */
  init?(client: Client): void;
  /** Called for every server once the bot is ready, and for every server it joins later. */
  guildReady?(guild: Guild): Promise<void>;
}
