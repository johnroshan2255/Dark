import keyArt from '../assets/ui/key-art.jpg'
import keyArtSmall from '../assets/ui/key-art-sm.jpg'
import './frontend.css'

/**
 * KEY ART — the still, full-screen image behind the front end (main menu, garage, "entering the world"), the same
 * one the loading screen (index.html #boot) shows, so loading → menu is one continuous picture. The 3D world is NOT
 * drawn behind it (Game.render skips frames while `landing`): it streams in under cover and the GPU idles.
 * A slow drift keeps it alive. `key-art.jpg` (1672 px, 252 KB) / `key-art-sm.jpg` (960 px, 88 KB, phones); the truck
 * sits right of centre, so portrait screens crop toward it (frontend.css owns the UI over the bright sunset).
 * @param dim the garage: blurred and darker, no drift (the car photo is the subject there).
 */
export function KeyArt({ dim = false }: { dim?: boolean }) {
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#1a1430' }}>
      {/* (portrait: the picture fills the top 62 % — the truck stays above the buttons — and fades into dusk below) */}
      <style>{'@keyframes keyart-drift{from{transform:scale(1.03) translate(0,0)}to{transform:scale(1.1) translate(-1.5%,-1%)}}.keyart{object-position:72% 50%}.keyart-box{position:absolute;inset:0;overflow:hidden}@media (orientation:portrait){.keyart{object-position:90% 50%}.keyart-box{bottom:38%}.keyart-box::after{content:"";position:absolute;left:0;right:0;bottom:0;height:30%;background:linear-gradient(180deg,rgba(26,20,48,0),#1a1430)}}@media (prefers-reduced-motion:reduce){.keyart{animation:none!important}}'}</style>
      <div className="keyart-box">
        <img
          className="keyart"
          src={keyArt}
          srcSet={`${keyArtSmall} 960w, ${keyArt} 1672w`}
          sizes="100vw"
          alt=""
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', ...(dim ? { filter: 'blur(6px) brightness(0.55) saturate(1.1)', transform: 'scale(1.06)' } : { animation: 'keyart-drift 30s ease-in-out infinite alternate' }) }}
        />
      </div>
    </div>
  )
}
