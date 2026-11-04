// A small hand-made list of places to meet (F13). Placeholder until venue details are known: generic names that
// fit most venues. Shown as "Suggested places" and editable per invite (people can also type their own).

export type PlaceType = 'food' | 'coffee' | 'quiet' | 'outdoor' | 'meeting';

export interface Place {
  id: string;
  name: string;
  type: PlaceType;
  quiet?: boolean;
  stepFree?: boolean;
  /** Dietary options people can expect (unverified placeholders). */
  dietary?: string[];
}

export const PLACES: readonly Place[] = [
  { id: 'main-cafe', name: 'Main café, ground floor', type: 'coffee', stepFree: true, dietary: ['vegetarian', 'vegan'] },
  { id: 'lunch-hall', name: 'Lunch hall', type: 'food', stepFree: true, dietary: ['vegetarian', 'vegan', 'gluten-free', 'halal'] },
  { id: 'food-trucks', name: 'Food trucks outside the main entrance', type: 'food', dietary: ['vegetarian'] },
  { id: 'courtyard', name: 'Courtyard benches', type: 'outdoor', quiet: true, stepFree: true },
  { id: 'quiet-room', name: 'Quiet room', type: 'quiet', quiet: true, stepFree: true },
  { id: 'upper-lounge', name: 'Upper-floor lounge', type: 'quiet', quiet: true },
  { id: 'registration', name: 'By the registration desk', type: 'meeting', stepFree: true },
  { id: 'poster-hall-door', name: 'Exhibition hall, main door', type: 'meeting', stepFree: true },
];

export const PLACE_TYPE_LABELS: Record<PlaceType, string> = {
  food: 'Food',
  coffee: 'Coffee',
  quiet: 'Quiet',
  outdoor: 'Outdoors',
  meeting: 'Meeting point',
};
