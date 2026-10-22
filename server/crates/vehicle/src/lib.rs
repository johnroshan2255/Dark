//! DARK vehicle physics for the server: the game's *Simulation* car (Rapier raycast vehicle + drivetrain), ported
//! from `game/src/gameplay/vehicle/` so the server can own every vehicle's state. Pure: no I/O, no clock, no
//! randomness. See `docs/VEHICLE_PHYSICS.md`.

pub mod control;
pub mod drivetrain;
pub mod spec;
pub mod truck;
pub mod tyre;
pub mod world;

pub use rapier3d;
pub use spec::CarDef;

/// The game's cars (`data/vehicles.json`, exported from the game by `game/scripts/export-vehicles.mjs`), in catalogue
/// order: wire model `k` is `cars()[k - 1]`.
pub fn cars() -> &'static [CarDef] {
    static CARS: std::sync::OnceLock<Vec<CarDef>> = std::sync::OnceLock::new();
    CARS.get_or_init(|| {
        #[derive(serde::Deserialize)]
        struct File {
            cars: Vec<CarDef>,
        }
        let f: File = serde_json::from_str(include_str!("../data/vehicles.json")).expect("data/vehicles.json");
        f.cars
    })
}
pub use truck::{Controls, Truck};
pub use world::World;
