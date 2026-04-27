/**
 * Registry of all built-in scores that ship with the app.
 *
 * Each entry is a `mxl` — compressed MusicXML served from
 * `public/scores/`.  Uses Vite's `import.meta.env.BASE_URL` so it
 * works both locally (`/scores/…`) and when deployed to a sub-path
 * like `/Luminoir/` on GitHub Pages.
 *
 * `LuminoirApp.loadDemoScore(id)` looks up an entry here and
 * fetches the bytes.
 */

const BASE = import.meta.env.BASE_URL ?? '/';

/**
 * Compressed-MusicXML score on the network.
 * @param {string} title    human-readable name shown in the dropdown
 * @param {string|null} composer composer / artist credit shown in the
 *   dropdown (smaller, dimmer line) and on the paper's top-left.
 *   Pass `null` for traditional / public-domain / no-credit pieces;
 *   the dropdown then collapses to a single line and the paper-side
 *   credit is omitted.
 * @param {string} filename name of the `.mxl` file under `public/scores/`
 */
const mxl = (title, composer, filename) => ({
  kind: 'mxl',
  title,
  composer,
  url: `${BASE}scores/${filename}`,
});

/**
 * Ordered map of built-in scores.  Keys are stable identifiers
 * persisted in the score-select dropdown's `data-value` so the same
 * id can be looked up across reloads.
 *
 * Naming convention:
 *   • `title` — the name of the work itself, no composer / artist
 *     suffix.  Reads cleanly as the prominent first line of every
 *     dropdown entry and as the title rendered on the paper.
 *   • `composer` — composer for classical pieces, performing artist
 *     for popular songs.
 *
 * Where multiple arrangers / publishers were credited in the source
 * MusicXML, we keep the most recognisable single name so the
 * dropdown stays scannable.  If the user really wants the full
 * arranger credits they can open the source file.
 */
export const DemoScores = {
  albatross:           mxl('Albatross',                       'Fleetwood Mac',            'albatross-fleetwood-mac-peter-green.mxl'),
  clairDeLune:         mxl('Clair de Lune',                   'Claude Debussy',           'clair-de-lune-debussy.mxl'),
  doctorWho:           mxl('Doctor Who Theme',                'Ron Grainer',              'doctor-who-theme-ron-grainer-piano-version.mxl'),
  dreamALittleDream:   mxl('Dream a Little Dream of Me',      'Schwandt & Andrée',        'dream-a-little-dream-of-me-schwandt-andree-solo-piano.mxl'),
  perfect:             mxl('Perfect',                         'Ed Sheeran',               'ed-sheeran-perfect-piano-arrangement.mxl'),
  furElise:            mxl('Für Elise',                       'Ludwig van Beethoven',     'fur-elise-beethoven.mxl'),
  hereComesTheSun:     mxl('Here Comes the Sun',              'The Beatles',              'here-comes-the-sun-the-beatles-here-comes-the-sun-piano-solo-the-beatles.mxl'),
  jealousGuy:          mxl('Jealous Guy',                     'John Lennon',              'jealous-guy-john-lennon.mxl'),
  imagine:             mxl('Imagine',                         'John Lennon',              'john-lennon-imagine-theme-piano.mxl'),
  jupiter:             mxl('Jupiter, the Bringer of Jollity', 'Gustav Holst',             'jupiter-the-bringer-of-jollity-gustav-holst-advanced-solo-piano.mxl'),
  kissMe:              mxl('Kiss Me',                         'Ed Sheeran',               'kiss-me-ed-sheeran.mxl'),
  laMer:               mxl('La Mer (Beyond the Sea)',         'Charles Trenet',           'la-mer-beyond-the-sea-charles-trenet.mxl'),
  moonlightSonata:     mxl('Moonlight Sonata — I',            'Ludwig van Beethoven',     'moonlight-sonata-i.mxl'),
  shesAlwaysAWoman:    mxl('She\u2019s Always a Woman',       'Billy Joel',               'shes-always-a-woman-billy-joel-shes-always-a-woman.mxl'),
  soundOfSilence:      mxl('The Sound of Silence',            'Simon & Garfunkel',        'the-sound-of-silence-simon-and-garfunkel.mxl'),
  spongeBob:           mxl('SpongeBob SquarePants Theme',     'Mark Harrison',            'spongebob-theme-piano.mxl'),
  starTrekFirstContact: mxl('Star Trek: First Contact',       'Jerry Goldsmith',          'star-trek-first-contact-jerry-goldsmith.mxl'),
};
