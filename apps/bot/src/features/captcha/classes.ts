import type { Lang } from '../../core/i18n.js';

/**
 * Captcha categories and their Open Images names. "Confusers" are objects close
 * enough to cause doubt (a taxi when asked for cars): squares that show one are
 * accepted whether they are ticked or not.
 */
export interface CaptchaClass {
  key: string;
  /** Shown in capitals under « Select all squares with ». */
  prompt: Record<Lang, string>;
  names: string[];
  confusers: string[];
}

export const CAPTCHA_CLASSES: CaptchaClass[] = [
  { key: 'traffic_light', prompt: { en: 'traffic lights', fr: 'feux tricolores' }, names: ['Traffic light'], confusers: [] },
  { key: 'bicycle', prompt: { en: 'bicycles', fr: 'vélos' }, names: ['Bicycle'], confusers: ['Bicycle wheel'] },
  { key: 'bus', prompt: { en: 'buses', fr: 'bus' }, names: ['Bus'], confusers: ['Truck', 'Van'] },
  {
    key: 'car',
    prompt: { en: 'cars', fr: 'voitures' },
    names: ['Car'],
    confusers: ['Taxi', 'Truck', 'Van', 'Limousine', 'Land vehicle', 'Vehicle'],
  },
  { key: 'motorcycle', prompt: { en: 'motorcycles', fr: 'motos' }, names: ['Motorcycle'], confusers: [] },
  { key: 'fire_hydrant', prompt: { en: 'fire hydrants', fr: "bouches d'incendie" }, names: ['Fire hydrant'], confusers: [] },
  { key: 'stop_sign', prompt: { en: 'stop signs', fr: 'panneaux stop' }, names: ['Stop sign'], confusers: ['Traffic sign'] },
  {
    key: 'boat',
    prompt: { en: 'boats', fr: 'bateaux' },
    names: ['Boat'],
    confusers: ['Watercraft', 'Canoe', 'Gondola', 'Barge', 'Jet ski', 'Submarine'],
  },
  { key: 'palm_tree', prompt: { en: 'palm trees', fr: 'palmiers' }, names: ['Palm tree'], confusers: ['Tree'] },
  { key: 'street_light', prompt: { en: 'street lights', fr: 'lampadaires' }, names: ['Street light'], confusers: [] },
  { key: 'stairs', prompt: { en: 'stairs', fr: 'escaliers' }, names: ['Stairs'], confusers: [] },
];

export function promptFor(key: string, lang: Lang) {
  return CAPTCHA_CLASSES.find((c) => c.key === key)?.prompt[lang] ?? key;
}
