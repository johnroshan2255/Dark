//! A fixed map's STATIC COLLIDERS exactly as the game builds them (`<map>/statics.bin`, written by
//! `game/scripts/export-statics.mjs` with the game's own code): the trunks and boulders of its scatter (grown from the
//! map's fixed seed, `FixedMap.seed`, the same for every game), its set pieces and plank bridges — the same shapes,
//! poses, collision groups and friction the clients' physics has, so the server's cars hit what the players see.
//! Not in it: the terrain (built from `heights.bin`), the road ribbon's ruts and the rock formations
//! (docs/VEHICLE_PHYSICS.md §9).

use dark_vehicle::rapier3d::prelude::{Rotation, SharedShape, Vector};

/// One collider (world pose).
pub struct Static {
    pub shape: SharedShape,
    pub at: Vector,
    pub rot: Rotation,
    /// The game's packed collision groups, `(member << 16) | filter`.
    pub groups: u32,
    pub friction: f32,
    /// The game breaks it off when hit hard (gameplay/destruction): a car drives through it.
    pub breakable: bool,
    /// A triangle mesh (can't go into a compound shape).
    pub mesh: bool,
}

pub struct Statics {
    /// The seed its scatter grew from (the client's `FixedMap.seed`).
    pub seed: u32,
    pub items: Vec<Static>,
}

const VERSION: u32 = 1;

impl Statics {
    /// Parse `statics.bin` (format: export-statics.mjs).
    pub fn parse(b: &[u8]) -> Result<Statics, String> {
        let mut r = Reader { b, o: 0 };
        if r.take(4)? != b"DKST" {
            return Err("not a statics file".into());
        }
        let version = r.u32()?;
        if version != VERSION {
            return Err(format!("statics version {version}, expected {VERSION}"));
        }
        let seed = r.u32()?;
        let n = r.u32()? as usize;
        let mut items = Vec::with_capacity(n);
        for _ in 0..n {
            let kind = r.u8()?;
            let flags = r.u8()?;
            let groups = r.u32()?;
            let friction = r.f32()?;
            let at = r.vec3()?;
            let rot = if flags & 2 != 0 {
                let (x, y, z, w) = (r.f32()?, r.f32()?, r.f32()?, r.f32()?);
                Rotation::from_xyzw(x, y, z, w).normalize()
            } else {
                Rotation::IDENTITY
            };
            let shape = match kind {
                0 => {
                    let h = r.vec3()?;
                    SharedShape::cuboid(h.x, h.y, h.z)
                }
                1 => {
                    let (hh, rad) = (r.f32()?, r.f32()?);
                    SharedShape::cylinder(hh, rad)
                }
                2 => SharedShape::ball(r.f32()?),
                3 => {
                    let k = r.u16()? as usize;
                    let pts = (0..k).map(|_| r.vec3()).collect::<Result<Vec<_>, _>>()?;
                    SharedShape::convex_hull(&pts).ok_or("degenerate convex hull")?
                }
                4 => {
                    let nv = r.u32()? as usize;
                    let v = (0..nv).map(|_| r.vec3()).collect::<Result<Vec<_>, _>>()?;
                    let nt = r.u32()? as usize;
                    let t = (0..nt)
                        .map(|_| Ok([r.u32()?, r.u32()?, r.u32()?]))
                        .collect::<Result<Vec<_>, String>>()?;
                    SharedShape::trimesh(v, t).map_err(|e| format!("trimesh: {e:?}"))?
                }
                k => return Err(format!("unknown collider kind {k}")),
            };
            items.push(Static {
                shape,
                at,
                rot,
                groups,
                friction,
                breakable: flags & 1 != 0,
                mesh: kind == 4,
            });
        }
        if r.o != b.len() {
            return Err(format!("{} trailing bytes", b.len() - r.o));
        }
        Ok(Statics { seed, items })
    }
}

struct Reader<'a> {
    b: &'a [u8],
    o: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], String> {
        let s = self.b.get(self.o..self.o + n).ok_or("statics file truncated")?;
        self.o += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn vec3(&mut self) -> Result<Vector, String> {
        Ok(Vector::new(self.f32()?, self.f32()?, self.f32()?))
    }
}
