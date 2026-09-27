/**
 * Captcha categories and their Open Images names. "Confusers" are objects close
 * enough to cause doubt (a taxi when asked for cars): squares that show one are
 * accepted whether they are ticked or not.
 */
export interface CaptchaClass {
  key: string;
  /** Shown in bold under « Select all squares with ». */
  prompt: string;
  names: string[];
  confusers: string[];
}

export const CAPTCHA_CLASSES: CaptchaClass[] = [
  { key: 'traffic_light', prompt: 'traffic lights', names: ['Traffic light'], confusers: [] },
  { key: 'bicycle', prompt: 'bicycles', names: ['Bicycle'], confusers: ['Bicycle wheel'] },
  { key: 'bus', prompt: 'buses', names: ['Bus'], confusers: ['Truck', 'Van'] },
  { key: 'car', prompt: 'cars', names: ['Car'], confusers: ['Taxi', 'Truck', 'Van', 'Limousine', 'Land vehicle', 'Vehicle'] },
  { key: 'motorcycle', prompt: 'motorcycles', names: ['Motorcycle'], confusers: [] },
  { key: 'fire_hydrant', prompt: 'fire hydrants', names: ['Fire hydrant'], confusers: [] },
  { key: 'stop_sign', prompt: 'stop signs', names: ['Stop sign'], confusers: ['Traffic sign'] },
  { key: 'boat', prompt: 'boats', names: ['Boat'], confusers: ['Watercraft', 'Canoe', 'Gondola', 'Barge', 'Jet ski', 'Submarine'] },
  { key: 'palm_tree', prompt: 'palm trees', names: ['Palm tree'], confusers: ['Tree'] },
  { key: 'street_light', prompt: 'street lights', names: ['Street light'], confusers: [] },
  { key: 'stairs', prompt: 'stairs', names: ['Stairs'], confusers: [] },
];

export function promptFor(key: string) {
  return CAPTCHA_CLASSES.find((c) => c.key === key)?.prompt ?? key.replace(/_/g, ' ');
}
