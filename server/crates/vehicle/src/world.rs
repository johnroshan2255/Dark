//! The physics world as the game sets it up (`game/src/physics/PhysicsWorld.ts`): Rapier with gravity 20 (2× real —
//! the drivetrain car runs at 9.81 through its gravity scale), a fixed 1/60 s step, the same collision groups.

use rapier3d::prelude::*;

/// Collision groups — the game's `Groups` (membership bits).
pub mod groups {
    pub const TERRAIN: u32 = 0x0001;
    pub const STATIC: u32 = 0x0002;
    pub const PLAYER: u32 = 0x0004;
    pub const MONSTER: u32 = 0x0008;
    pub const VEHICLE: u32 = 0x0010;
    pub const DEBRIS: u32 = 0x0020;
    pub const VEHICLE_MESH: u32 = 0x0040;
    pub const STATIC_MESH: u32 = 0x0080;
    pub const TERRAIN_MESH: u32 = 0x0100;
}

/// `group(member, filter)` as Rapier groups (the game packs them as `(member << 16) | filter`).
pub fn group(member: u32, filter: u32) -> InteractionGroups {
    InteractionGroups::new(
        Group::from_bits_truncate(member & 0xffff),
        Group::from_bits_truncate(filter & 0xffff),
        InteractionTestMode::And,
    )
}

pub const GRAVITY: f32 = 20.0;
pub const FIXED_DT: f32 = 1.0 / 60.0;

pub struct World {
    pub pw: PhysicsWorld,
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

impl World {
    pub fn new() -> Self {
        let mut pw = PhysicsWorld::new();
        pw.gravity = Vector::new(0.0, -GRAVITY, 0.0);
        pw.integration_parameters.dt = FIXED_DT;
        // NO CONTINUOUS COLLISION (the client has it): Rapier 0.36 sweeps every "fast" dynamic body — one moving more
        // than half its thinnest piece per step, i.e. any car with thin hull pieces above walking pace — and
        // recomputes each convex piece's mass properties per sweep: +32 µs per car per step (3.1 → ~19 ms per 30 Hz
        // tick for 100 cars, measured). Without it a car (≤ 60 m/s: ≤ 1 m per step) can't tunnel the server's
        // terrain (a heightfield + speculative contacts); thin obstacles (posts, trunks) don't exist on the server
        // yet — revisit with them (see docs/VEHICLE_PHYSICS.md).
        pw.integration_parameters.max_ccd_substeps = 0;
        Self { pw }
    }

    /// One fixed step (after every vehicle's `step`).
    pub fn step(&mut self) {
        self.pw.step();
    }

    /// A flat ground box (top at y = 0), as the game's vehicle tests use.
    pub fn add_ground_box(&mut self, half: f32) -> ColliderHandle {
        let body = self.pw.bodies.insert(RigidBodyBuilder::fixed());
        let c = ColliderBuilder::cuboid(half, 0.5, half)
            .translation(Vector::new(0.0, -0.5, 0.0))
            .collision_groups(group(groups::TERRAIN, 0xffff));
        self.pw.colliders.insert_with_parent(c, body, &mut self.pw.bodies)
    }

    /// A static box (any orientation) in the terrain group — ramps and bumps for tests.
    pub fn add_terrain_box(&mut self, half: Vector, at: Vector, rot: Rotation) -> ColliderHandle {
        let body = self.pw.bodies.insert(RigidBodyBuilder::fixed());
        let c = ColliderBuilder::cuboid(half.x, half.y, half.z)
            .position(Pose::from_parts(at, rot))
            .collision_groups(group(groups::TERRAIN, 0xffff));
        self.pw.colliders.insert_with_parent(c, body, &mut self.pw.bodies)
    }

    /// A static box with explicit collision groups (bridge decks, set pieces).
    pub fn add_static_box(
        &mut self,
        half: Vector,
        at: Vector,
        rot: Rotation,
        groups: InteractionGroups,
    ) -> ColliderHandle {
        let body = self.pw.bodies.insert(RigidBodyBuilder::fixed());
        let c = ColliderBuilder::cuboid(half.x, half.y, half.z)
            .position(Pose::from_parts(at, rot))
            .friction(0.8)
            .collision_groups(groups);
        self.pw.colliders.insert_with_parent(c, body, &mut self.pw.bodies)
    }

    /// A static collider of any (shared) shape: the map's trunks, boulders and set pieces.
    pub fn add_static(
        &mut self,
        shape: SharedShape,
        at: Vector,
        rot: Rotation,
        friction: f32,
        groups: InteractionGroups,
    ) -> ColliderHandle {
        let body = self.pw.bodies.insert(RigidBodyBuilder::fixed());
        let c = ColliderBuilder::new(shape)
            .position(Pose::from_parts(at, rot))
            .friction(friction)
            .collision_groups(groups);
        self.pw.colliders.insert_with_parent(c, body, &mut self.pw.bodies)
    }

    /// A height grid as a Rapier heightfield shape (shareable between worlds: one per map, not per room) and where
    /// its collider goes. `heights` is row-major `[iz * n + ix]` (the map's `heights.bin` order), `step` m between
    /// samples, the grid's corner at `origin` (x, z).
    pub fn heightfield_shape(n: usize, step: f32, origin: [f32; 2], heights: &[f32]) -> (SharedShape, Vector) {
        // Rapier: rows run along Z, columns along X, centred on the collider (Array2 is column-major).
        let mut data = vec![0.0; n * n];
        for iz in 0..n {
            for ix in 0..n {
                data[iz + ix * n] = heights[iz * n + ix];
            }
        }
        let size = step * (n - 1) as f32;
        let shape = SharedShape::heightfield(Array2::new(n, n, data), Vector::new(size, 1.0, size));
        (shape, Vector::new(origin[0] + size / 2.0, 0.0, origin[1] + size / 2.0))
    }

    /// The terrain (terrain group, friction 0.9 like the game's ground).
    pub fn add_terrain(&mut self, shape: SharedShape, at: Vector) -> ColliderHandle {
        let hf = ColliderBuilder::new(shape)
            .translation(at)
            .friction(0.9)
            .collision_groups(group(groups::TERRAIN, 0xffff & !groups::VEHICLE_MESH));
        let body = self.pw.bodies.insert(RigidBodyBuilder::fixed());
        self.pw.colliders.insert_with_parent(hf, body, &mut self.pw.bodies)
    }

    /// A height grid as this world's own heightfield (tests; rooms share one shape per map via `add_terrain`).
    pub fn add_heightfield(&mut self, n: usize, step: f32, origin: [f32; 2], heights: &[f32]) -> ColliderHandle {
        let (shape, at) = Self::heightfield_shape(n, step, origin, heights);
        self.add_terrain(shape, at)
    }

    /// First hit of a ray (time of impact along `dir`), ignoring `skip`'s colliders.
    pub fn cast_ray(
        &self,
        origin: Vector,
        dir: Vector,
        max: f32,
        groups: InteractionGroups,
        skip: RigidBodyHandle,
    ) -> Option<f32> {
        let filter = QueryFilter::new().groups(groups).exclude_rigid_body(skip);
        self.pw
            .cast_ray(&Ray::new(origin, dir), max, true, filter)
            .map(|(_, t)| t)
    }

    /// First collider a ray hits — distance and the body it belongs to (None: a fixed collider without one) — ignoring
    /// `skip`'s colliders.
    pub fn cast_ray_body(
        &self,
        origin: Vector,
        dir: Vector,
        max: f32,
        groups: InteractionGroups,
        skip: RigidBodyHandle,
    ) -> Option<(f32, Option<RigidBodyHandle>)> {
        let filter = QueryFilter::new().groups(groups).exclude_rigid_body(skip);
        self.pw
            .cast_ray(&Ray::new(origin, dir), max, true, filter)
            .map(|(h, t)| (t, self.pw.colliders.get(h).and_then(|c| c.parent())))
    }

    /// First surface a ray crosses — distance, normal, the collider's member groups — ignoring `skip`'s colliders
    /// (hollow shapes: a ray from inside or against one meets its far side, not a hit at 0).
    pub fn cast_ray_normal(
        &self,
        origin: Vector,
        dir: Vector,
        max: f32,
        groups: InteractionGroups,
        skip: RigidBodyHandle,
    ) -> Option<(f32, Vector, u32)> {
        let filter = QueryFilter::new().groups(groups).exclude_rigid_body(skip);
        self.pw
            .cast_ray_and_get_normal(&Ray::new(origin, dir), max, false, filter)
            .map(|(h, hit)| {
                let member = self
                    .pw
                    .colliders
                    .get(h)
                    .map_or(0, |c| c.collision_groups().memberships.bits());
                (hit.time_of_impact, hit.normal, member)
            })
    }
}
