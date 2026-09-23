/**
 * Catégories du captcha, avec leurs noms dans Open Images.
 * Les « confusers » sont des objets assez proches pour semer le doute : une image
 * qui en contient n'est jamais proposée comme « mauvaise réponse » pour cette catégorie.
 */
export interface CaptchaClass {
  key: string;
  prompt: string;
  names: string[];
  confusers: string[];
}

export const CAPTCHA_CLASSES: CaptchaClass[] = [
  { key: 'traffic_light', prompt: 'des feux tricolores', names: ['Traffic light'], confusers: [] },
  { key: 'bicycle', prompt: 'des vélos', names: ['Bicycle'], confusers: ['Bicycle wheel'] },
  { key: 'bus', prompt: 'des bus', names: ['Bus'], confusers: ['Truck', 'Van'] },
  {
    key: 'car',
    prompt: 'des voitures',
    names: ['Car'],
    confusers: ['Taxi', 'Truck', 'Van', 'Limousine', 'Land vehicle', 'Vehicle'],
  },
  { key: 'motorcycle', prompt: 'des motos', names: ['Motorcycle'], confusers: [] },
  { key: 'fire_hydrant', prompt: "des bouches d'incendie", names: ['Fire hydrant'], confusers: [] },
  { key: 'stop_sign', prompt: 'des panneaux stop', names: ['Stop sign'], confusers: ['Traffic sign'] },
  {
    key: 'boat',
    prompt: 'des bateaux',
    names: ['Boat'],
    confusers: ['Watercraft', 'Canoe', 'Gondola', 'Barge', 'Jet ski', 'Submarine'],
  },
  { key: 'palm_tree', prompt: 'des palmiers', names: ['Palm tree'], confusers: ['Tree'] },
  { key: 'street_light', prompt: 'des lampadaires', names: ['Street light'], confusers: [] },
  { key: 'stairs', prompt: 'des escaliers', names: ['Stairs'], confusers: [] },
];
