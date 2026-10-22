//! DARK match rules (the "functional core").
//!
//! Nothing here touches sockets, files after load, logging or the wall clock: [`Match`] is advanced with an explicit
//! `now_ms` and returns the packets to send ([`Out`]). That keeps every rule unit-testable and replayable; the server
//! crate is the imperative shell around it (one tokio task per match).
//!
//! Authority model (v1): the game client simulates its own player / vehicle (the same Rapier physics the browser
//! already runs) and streams its pose; the server VALIDATES every pose against the map's heightfield, speed caps,
//! teleport distance and map bounds ([`validate`]) and owns everything shared — the match lifecycle, the safe zone,
//! health, damage (zone, roadkill), eliminations, placement and the winner. Remote players are sent per client by
//! interest management ([`interest`]).

pub mod bots;
pub mod fasthash;
pub mod game;
pub mod interest;
pub mod map;
pub mod nav;
pub mod noise;
pub mod physics;
pub mod rng;
pub mod statics;
pub mod tow;
pub mod validate;
pub mod zone;

pub use game::{Clock, Match, MatchConfig, Out, PlayerView, TickProfile};
pub use map::{MapData, MapError};
