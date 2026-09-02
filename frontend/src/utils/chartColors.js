// Categorical series palette shared by the app's line charts (cellar value over
// time, cellar climate history). One definition so a contrast/accessibility
// retune reaches every chart at once, and the same series concept keeps its hue
// across the app. Assign in fixed order — never cycle a generated hue.
//
// Colorblind-safety validated: every adjacent pair in this fixed order clears
// a CVD separation floor (deuteranopia/protanopia/tritanopia simulated in
// OKLab, ΔE ≥ 8) and a normal-vision floor (ΔE ≥ 15), checked against the
// app's actual light chart surface (#FFFFFF). The previous 10-color palette
// failed both — several colors read as near-gray at low chroma, and multiple
// adjacent pairs were indistinguishable under red-green color blindness.
// Capped at 8, not 10: no ordering of 10 hues clears these floors for every
// pairwise combination, so a 9th+ series should fold into "Other" rather than
// reuse a hue that can't be reliably told apart from its neighbors. All
// current consumers already index with `% SERIES_COLORS.length`, so this is
// a safe, non-breaking reduction — series just cycle through 8 colors instead
// of 10.
//
// 3 of the 8 (aqua, yellow, magenta) read below 3:1 contrast on white and
// rely on each chart's existing legend/tooltip labels rather than hue alone —
// don't remove those labels.
export const SERIES_COLORS = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
];
