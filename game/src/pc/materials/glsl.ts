/**
 * The shared GLSL (written for three) made PlayCanvas-legal: PlayCanvas's shader processor parses every `uniform`
 * line to build its uniform-buffer layout and rejects several names on one line — `uniform vec3 a, b;` becomes one
 * declaration per name. Comments are stripped first (the processor also reads "uniform" inside a comment line as a
 * declaration); only real declarations at the start of a statement are split.
 */
export function pcGlsl(src: string): string {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  // (lookbehind: several declarations on one line all match — the previous one's `;` is not consumed by its match)
  return noComments.replace(/(?<=^|[;{}\n])(\s*)uniform\s+(\w+)\s+([\w\s,[\]]+?);/g, (m, ws: string, type: string, names: string) =>
    names.includes(',') ? ws + names.split(',').map((n) => `uniform ${type} ${n.trim()};`).join(' ') : m,
  )
}
