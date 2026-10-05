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
 *  'storybook'  the forest-house study: UNLIT hand-painted look (light painted into the colours, no sun
 *               shading/shadows/rim), pale pastel sage palette, stacked-tier brush-fan conifers, pale haze.
 */
export type ArtStyle = 'overland' | 'bright' | 'storybook'

export const ART_STYLES: readonly ArtStyle[] = ['overland', 'bright', 'storybook']

export const ART = { style: 'bright' as ArtStyle }

export const isStorybook = (): boolean => ART.style === 'storybook'
export const isOverland = (): boolean => ART.style === 'overland'

/**
 * Ground palette id handed to the generator workers (WorldFields.palette): the ground/grass albedo is baked
 * into the chunk vertex colours off the main thread, where ART is unknown. 0 = Genshin meadow, 1 = overland straw.
 */
export const groundPalette = (): number => (ART.style === 'overland' ? 1 : 0)
