import type { Feature } from '../core/types.js';
import { captchaFeature } from './captcha/index.js';
import { rolesFeature } from './roles/index.js';
import { setupFeature } from './setup.js';
import { voiceFeature } from './voice/index.js';

/** Order matters: setup detects the configuration before the others use it. */
export const features: Feature[] = [setupFeature, rolesFeature, captchaFeature, voiceFeature];
