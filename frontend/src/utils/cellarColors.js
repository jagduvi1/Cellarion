// Colorblind-safety validated — same methodology and values as
// chartColors.js's SERIES_COLORS (see that file for the full rationale).
// Kept as a separate export since this palette serves the cellar-accent
// swatch picker (CellarColorPicker.js) rather than chart series, but unified
// on the same validated set rather than maintaining two independently-tuned
// palettes. Capped at 8, not 10, for the same reason: no ordering of 10 hues
// clears the pairwise CVD/normal-vision distinctness floors.
export const CELLAR_COLORS = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
];
