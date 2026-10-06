/**
 * The art style is fixed for a session: chosen from Settings (or ?look=) BEFORE any material, atlas or tree
 * geometry is built, because the styles change shader programs and geometry — switching it reloads the page
 * (Game.updateSettings). That keeps every style at zero per-frame cost: nothing is toggled or branched at runtime.
 *
 *  'overland'   the "over the hill" / art of rally look: solid low-poly trees in stacked spiky tiers,
 *               faceted blue-grey boulders, golden straw meadows with green forest islands, warm sun-tinted haze,
 *               soft two-tone shading, bloom, no paint filter / grain. Also the cheapest style (no foliage cards).
 *  'bright'     (default) Genshin: lit, cel-shaded, saturated, fluffy card canopies, hand-painted surfaces, dirt
 *               paths, Sumeru-gold desert, snow-laden Dragonspine conifers.
 *  'genshin'    (default) Genshin Impact matched to reference screenshots (Windrise, Galesong Hill, Springvale):
 *               the 'bright' geometry and shaders with Genshin's own colours and light — soft yellow-green
 *               meadows that keep blue in them, teal conifers, fresh broadleaves, warm-grey cliffs with blue
 *               shadows, a cobalt sky, bright cool fill (light shadows), neutral grade, blue aerial haze.
 *  'storybook'  the forest-house study: UNLIT hand-painted look (light painted into the colours, no sun
 *               shading/shadows/rim), pale pastel sage palette, stacked-tier brush-fan conifers, pale haze.
 */
export type ArtStyle = 'overland' | 'bright' | 'genshin' | 'storybook'

export const ART_STYLES: readonly ArtStyle[] = ['overland', 'bright', 'genshin', 'storybook']

export const ART = { style: 'genshin' as ArtStyle }

export const isStorybook = (): boolean => ART.style === 'storybook'
export const isOverland = (): boolean => ART.style === 'overland'
/** 'genshin' shares every 'bright' code path (geometry, shaders); only colours and light differ. */
export const isGenshin = (): boolean => ART.style === 'genshin'

/**
 * Ground palette id handed to the generator workers (WorldFields.palette): the ground/grass albedo is baked
 * into the chunk vertex colours off the main thread, where ART is unknown. 0 = bright meadow, 1 = overland straw,
 * 2 = Genshin (reference-matched) meadow.
 */
export const groundPalette = (): number => (ART.style === 'overland' ? 1 : ART.style === 'genshin' ? 2 : 0)
