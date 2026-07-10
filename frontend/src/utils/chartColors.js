// Categorical series palette shared by the app's line charts (cellar value over
// time, cellar climate history). One definition so a contrast/accessibility
// retune reaches every chart at once, and the same series concept keeps its hue
// across the app. Assign in fixed order — never cycle a generated hue.
export const SERIES_COLORS = [
  '#C0504D', '#D4C87A', '#E8A0B0', '#6EC6C6', '#D4A070',
  '#8B6A9A', '#5B8DB8', '#A03648', '#946333', '#3B6D98',
];
