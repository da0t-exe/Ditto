import type { Feature } from '../core/types.js';
import { captchaFeature } from './captcha/index.js';
import { rolesFeature } from './roles/index.js';
import { setupFeature } from './setup.js';
import { voiceFeature } from './voice/index.js';

/** L'ordre compte : setup détecte la configuration avant que les autres s'en servent. */
export const features: Feature[] = [setupFeature, rolesFeature, captchaFeature, voiceFeature];
