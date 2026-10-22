//! DARK vehicle physics for the server: the game's *Simulation* car (Rapier raycast vehicle + drivetrain), ported
//! from `game/src/gameplay/vehicle/` so the server can own every vehicle's state. Pure: no I/O, no clock, no
//! randomness. See `docs/VEHICLE_PHYSICS.md`.

pub mod control;
pub mod drivetrain;
pub mod spec;
pub mod truck;
pub mod tyre;
pub mod world;

pub use spec::CarDef;
pub use truck::{Controls, Truck};
pub use world::World;
