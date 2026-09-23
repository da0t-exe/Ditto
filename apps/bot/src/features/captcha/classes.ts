import type { Lang } from '../../core/i18n.js';

/**
 * Captcha categories and their Open Images names. "Confusers" are objects close
 * enough to cause doubt: a photo containing one is never offered as a wrong
 * answer for that category.
 */
export interface CaptchaClass {
  key: string;
  prompt: Record<Lang, string>;
  names: string[];
  confusers: string[];
}

export const CAPTCHA_CLASSES: CaptchaClass[] = [
  { key: 'traffic_light', prompt: { en: 'traffic lights', fr: 'des feux tricolores' }, names: ['Traffic light'], confusers: [] },
  { key: 'bicycle', prompt: { en: 'bicycles', fr: 'des vélos' }, names: ['Bicycle'], confusers: ['Bicycle wheel'] },
  { key: 'bus', prompt: { en: 'buses', fr: 'des bus' }, names: ['Bus'], confusers: ['Truck', 'Van'] },
  {
    key: 'car',
    prompt: { en: 'cars', fr: 'des voitures' },
    names: ['Car'],
    confusers: ['Taxi', 'Truck', 'Van', 'Limousine', 'Land vehicle', 'Vehicle'],
  },
  { key: 'motorcycle', prompt: { en: 'motorcycles', fr: 'des motos' }, names: ['Motorcycle'], confusers: [] },
  { key: 'fire_hydrant', prompt: { en: 'fire hydrants', fr: "des bouches d'incendie" }, names: ['Fire hydrant'], confusers: [] },
  { key: 'stop_sign', prompt: { en: 'stop signs', fr: 'des panneaux stop' }, names: ['Stop sign'], confusers: ['Traffic sign'] },
  {
    key: 'boat',
    prompt: { en: 'boats', fr: 'des bateaux' },
    names: ['Boat'],
    confusers: ['Watercraft', 'Canoe', 'Gondola', 'Barge', 'Jet ski', 'Submarine'],
  },
  { key: 'palm_tree', prompt: { en: 'palm trees', fr: 'des palmiers' }, names: ['Palm tree'], confusers: ['Tree'] },
  { key: 'street_light', prompt: { en: 'street lights', fr: 'des lampadaires' }, names: ['Street light'], confusers: [] },
  { key: 'stairs', prompt: { en: 'stairs', fr: 'des escaliers' }, names: ['Stairs'], confusers: [] },
];

export function promptFor(key: string, lang: Lang) {
  return CAPTCHA_CLASSES.find((c) => c.key === key)?.prompt[lang] ?? key;
}
