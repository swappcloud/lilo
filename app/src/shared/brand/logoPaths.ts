/**
 * The LILO vector logo, in a 400x400 box (the mark) plus the wordmark.
 *
 * The mark is a speech bubble split into ink and paper by an S curve, with a
 * waveform on each side. `index.html` carries a copy of these paths for the
 * startup splash (it renders before the bundle); keep them in sync.
 */

/** Bubble outline: a 118-radius circle centred at (200, 196) with two tails. */
export const MARK_BODY_D =
  "M260.8,94.9Q275.5,86.1 300.6,80.2 Q293.6,116.6 310.9,155.6A118,118 0 0 1 130.6,291.5Q115.8,299.4 86.5,309.5 Q102.2,270.2 88.4,234.4A118,118 0 0 1 260.8,94.9Z";

/** Region painted in ink: right of the S that divides the bubble. */
export const MARK_SPLIT_D =
  "M200,-80L200,78 A59,59 0 0 0 200,196 A59,59 0 0 1 200,314 L200,480L480,480L480,-80Z";

/** Waveform on the ink side, drawn in paper. */
export const MARK_UPPER_WAVE_D =
  "M187,146 L197.3,146 L200.5,143.3 L203.7,149.3 L207,138.5 L210.5,155.3 L214,131 L217.5,159.5 L221,137.8 L224.3,150.5 L227.5,143.6 L230.7,146 L241,146";

/** Waveform on the paper side, drawn in ink. */
export const MARK_LOWER_WAVE_D =
  "M161,244 L171.3,244 L174.5,241.3 L177.7,247.3 L181,236.5 L184.5,253.3 L188,229 L191.5,257.5 L195,235.8 L198.3,248.5 L201.5,241.6 L204.7,244 L215,244";

/** Tight crop of the mark (outline stroke included). */
export const MARK_VIEWBOX = "65.8 61.8 268.5 268.5";

/** "LILO" set in the brand face, as outlines. */
export const WORDMARK_D =
  "M361.8 234V158H380.2V217.7H414.1V234ZM430.9,234H449.3V158H430.9ZM471.4 234V158H489.8V217.7H523.7V234ZM575.1 235.1Q566.5 235.1 559.3 232.2Q552.1 229.2 546.8 223.9Q541.5 218.6 538.6 211.4Q535.7 204.2 535.7 195.7Q535.7 187.1 538.6 179.9Q541.5 172.7 546.8 167.5Q552.1 162.2 559.3 159.2Q566.5 156.3 575.1 156.3Q583.7 156.3 590.8 159.2Q598 162.2 603.3 167.5Q608.6 172.8 611.5 180Q614.4 187.1 614.4 195.6Q614.4 204.2 611.5 211.4Q608.6 218.6 603.3 223.9Q598 229.2 590.8 232.2Q583.7 235.1 575.1 235.1ZM575.1 217.8Q579.5 217.8 583.3 216.1Q587 214.5 589.8 211.5Q592.6 208.5 594.1 204.5Q595.6 200.5 595.6 195.7Q595.6 190.9 594.1 186.9Q592.6 182.9 589.8 179.9Q587 176.9 583.3 175.2Q579.5 173.6 575.1 173.6Q570.6 173.6 566.8 175.2Q563.1 176.9 560.3 179.8Q557.5 182.8 556 186.8Q554.5 190.9 554.5 195.7Q554.5 200.5 556 204.5Q557.5 208.6 560.3 211.5Q563.1 214.5 566.8 216.1Q570.6 217.8 575.1 217.8Z";

export const WORDMARK_VIEWBOX = "340 150 290 92";
