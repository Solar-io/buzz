/**
 * The @font-face declarations for the font-family preference's non-default
 * families. Inter (the default) is already imported in `main.tsx`.
 *
 * Kept in its own module — NOT in `appearancePrefs.ts`, which stays
 * import-free so `node --test` can load it — and imported once from
 * `main.tsx` next to the Inter import.
 *
 * Weight axis only (`wght.css`) where the family has a variable build: a UI
 * typeface picker needs weights, not width axes. The five families without
 * a variable build (Lato, Poppins, Ubuntu, PT Serif, Fira Sans) ship the
 * 400/700 pair. Every declaration carries `unicode-range`, so the browser
 * downloads only the latin subset of the ONE family `data-font-family`
 * selects — an unused @font-face is a declaration, not a download.
 */
import "@fontsource-variable/roboto/wght.css";
import "@fontsource-variable/open-sans/wght.css";
import "@fontsource-variable/source-sans-3/wght.css";
import "@fontsource-variable/noto-sans/wght.css";
import "@fontsource-variable/montserrat/wght.css";
import "@fontsource-variable/raleway/wght.css";
import "@fontsource-variable/merriweather/wght.css";
import "@fontsource-variable/nunito/wght.css";
import "@fontsource-variable/work-sans/wght.css";
import "@fontsource-variable/ibm-plex-sans/wght.css";
import "@fontsource/lato/400.css";
import "@fontsource/lato/700.css";
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/700.css";
import "@fontsource/ubuntu/400.css";
import "@fontsource/ubuntu/700.css";
import "@fontsource/pt-serif/400.css";
import "@fontsource/pt-serif/700.css";
import "@fontsource/fira-sans/400.css";
import "@fontsource/fira-sans/700.css";
