/**
 * The art style is fixed for a session: chosen from Settings (or ?look=) BEFORE any material, atlas or tree
 * geometry is built, because 'storybook' changes shader programs and geometry — switching it reloads the page
 * (Game.updateSettings). That keeps both styles at zero per-frame cost: nothing is toggled or branched at runtime.
 *
 *  'bright'     Genshin day: lit, cel-shaded, saturated (the default).
 *  'storybook'  the forest-house study: UNLIT hand-painted look (light painted into the colours, no sun
 *               shading/shadows/rim), pale pastel sage palette, stacked-tier brush-fan conifers, pale haze.
 */
export type ArtStyle = 'bright' | 'storybook'

export const ART = { style: 'bright' as ArtStyle }

export const isStorybook = (): boolean => ART.style === 'storybook'
