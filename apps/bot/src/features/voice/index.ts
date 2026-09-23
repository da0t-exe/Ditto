import type { Feature } from '../../core/types.js';
import { gatherBack, shakeStop, voiceCommands } from './commands.js';
import { initLocks, lockCommands, lockComponent } from './lock.js';
import { initPresence } from './presence.js';
import { initRooms, prepareRooms, roomCommand } from './rooms.js';

export const voiceFeature: Feature = {
  name: 'voice',
  commands: [...voiceCommands, ...lockCommands, roomCommand],
  components: { gather: gatherBack, shake: shakeStop, lock: lockComponent },
  init(client) {
    initLocks(client);
    initRooms(client);
    initPresence(client);
  },
  async guildReady(guild) {
    await prepareRooms(guild);
  },
};
