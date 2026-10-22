//! Behaviour of the server's car on its own (Stage B acceptance): driving + braking, suspension over bumps, holding
//! on a slope, car ⇄ car collisions, a heightfield. The car is the golden traces' pickup (the game's numbers).

use dark_vehicle::spec::CarDef;
use dark_vehicle::{Controls, Truck, World};
use rapier3d::prelude::{Rotation, Vector};

fn pickup() -> CarDef {
    let path = format!("{}/golden/drive-pickup.json", env!("CARGO_MANIFEST_DIR"));
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    serde_json::from_value(v["def"].clone()).unwrap()
}

fn run(world: &mut World, cars: &mut [&mut Truck], secs: f64, mut each: impl FnMut(&World, &[&mut Truck])) {
    for _ in 0..(secs * 60.0).round() as usize {
        for c in cars.iter_mut() {
            c.step(world, 1.0 / 60.0);
        }
        world.step();
        each(world, cars);
    }
}

fn speed(world: &World, t: &Truck) -> f64 {
    let v = world.pw.bodies[t.body].linvel();
    (v.x as f64).hypot(v.z as f64)
}

fn up(world: &World, t: &Truck) -> f64 {
    t.axes(world).u[1]
}

#[test]
fn drives_and_brakes_on_the_flat() {
    let mut w = World::new();
    w.add_ground_box(2000.0);
    let def = pickup();
    let mut t = Truck::new(&mut w, &def, None);
    t.place(&mut w, 0.0, 0.0, 0.0, 0.0, 0.0);
    t.controls = Controls {
        throttle: 1.0,
        ..Default::default()
    };
    run(&mut w, &mut [&mut t], 6.0, |_, _| {});
    let v = speed(&w, &t);
    assert!(v > 15.0, "0–6 s at full throttle only reached {v:.1} m/s");
    let p0 = t.position(&w);
    t.controls = Controls {
        throttle: -1.0,
        ..Default::default()
    };
    // (held at a standstill the stick selects reverse after 0.3 s, as in the game: measure where it stopped)
    let mut stopped_at = None;
    let mut p1 = p0;
    let mut k = 0;
    run(&mut w, &mut [&mut t], 6.0, |w, c| {
        k += 1;
        if stopped_at.is_none() && speed(w, c[0]) < 0.3 {
            stopped_at = Some(k);
            p1 = c[0].position(w);
        }
    });
    let dist = (p1[2] - p0[2]).abs();
    // ~0.6–0.9 g on asphalt (a 1989 pickup, no ABS): v²/(2·a)
    let a = v * v / (2.0 * dist);
    println!(
        "braking from {v:.1} m/s: {dist:.1} m (≈ {:.2} g), stopped after {:?} steps",
        a / 9.81,
        stopped_at
    );
    assert!(stopped_at.is_some(), "never stopped");
    assert!((0.4..1.1).contains(&(a / 9.81)), "braking {:.2} g is off", a / 9.81);
    assert!(up(&w, &t) > 0.99, "not upright after braking");
}

#[test]
fn suspension_rides_over_bumps() {
    let mut w = World::new();
    w.add_ground_box(2000.0);
    // 12 cm planks across the road every 6 m
    for k in 0..15 {
        let z = -20.0 - k as f32 * 6.0;
        w.add_terrain_box(
            Vector::new(6.0, 0.06, 0.15),
            Vector::new(0.0, 0.0, z),
            Rotation::IDENTITY,
        );
    }
    let def = pickup();
    let mut t = Truck::new(&mut w, &def, None);
    t.place(&mut w, 0.0, 0.0, 0.0, 0.0, 0.0);
    t.controls = Controls {
        throttle: 0.6,
        ..Default::default()
    };
    let (mut max_lift, mut min_up, mut max_y) = (0.0f64, 1.0f64, 0.0f64);
    run(&mut w, &mut [&mut t], 14.0, |w, c| {
        for wh in &c[0].wheels {
            max_lift = max_lift.max(wh.lift);
        }
        min_up = min_up.min(up(w, c[0]));
        max_y = max_y.max(c[0].position(w)[1]);
    });
    let p = t.position(&w);
    println!(
        "over the planks: wheel lift ≤ {max_lift:.3} m, body up ≥ {min_up:.3}, body y ≤ {max_y:.2}, end z {:.1}, speed {:.1}",
        p[2],
        speed(&w, &t)
    );
    assert!(p[2] < -110.0, "stuck on the planks (z {:.1})", p[2]);
    assert!(
        max_lift > 0.03,
        "the wheels never moved over the bumps ({max_lift:.3} m)"
    );
    assert!(min_up > 0.9, "tipped over a 12 cm plank (up {min_up:.3})");
    assert!(max_y < 1.0, "thrown into the air (y {max_y:.2})");
}

#[test]
fn holds_still_parked_on_a_slope() {
    let mut w = World::new();
    let deg = 20.0f32.to_radians();
    w.add_terrain_box(
        Vector::new(30.0, 0.5, 30.0),
        Vector::new(0.0, -0.5, 0.0),
        Rotation::from_rotation_x(deg),
    );
    let def = pickup();
    let mut t = Truck::new(&mut w, &def, None);
    // on the slope's surface at the centre, facing uphill (−Z climbs: rotation about +X tilts −Z up)
    t.place(&mut w, 0.0, 0.3, 0.0, 0.0, deg as f64);
    t.controls = Controls {
        parked: true,
        ..Default::default()
    };
    run(&mut w, &mut [&mut t], 1.0, |_, _| {});
    let p0 = t.position(&w);
    run(&mut w, &mut [&mut t], 5.0, |_, _| {});
    let p1 = t.position(&w);
    let slide = ((p1[0] - p0[0]).powi(2) + (p1[2] - p0[2]).powi(2)).sqrt();
    println!("parked on 20°: slid {slide:.3} m in 5 s, up {:.3}", up(&w, &t));
    assert!(slide < 0.15, "slid {slide:.2} m parked on 20°");
    assert!(up(&w, &t) > 0.9);
}

#[test]
fn two_cars_collide_and_exchange_momentum() {
    let mut w = World::new();
    w.add_ground_box(2000.0);
    let def = pickup();
    let mut a = Truck::new(&mut w, &def, None);
    let mut b = Truck::new(&mut w, &def, None);
    a.place(&mut w, 0.0, 0.0, 0.0, 0.0, 0.0);
    b.place(&mut w, 0.0, 0.0, -40.0, 0.0, 0.0); // 40 m ahead, same heading, standing
    a.controls = Controls {
        throttle: 1.0,
        ..Default::default()
    };
    let (mut b_max, mut min_gap) = (0.0f64, f64::INFINITY);
    run(&mut w, &mut [&mut a, &mut b], 6.0, |w, c| {
        b_max = b_max.max(speed(w, c[1]));
        let (pa, pb) = (c[0].position(w), c[1].position(w));
        min_gap = min_gap.min(((pa[0] - pb[0]).powi(2) + (pa[2] - pb[2]).powi(2)).sqrt());
    });
    println!("rear-end: B pushed to {b_max:.1} m/s, closest centres {min_gap:.2} m");
    assert!(b_max > 2.0, "B was not pushed ({b_max:.1} m/s) — passed through?");
    // two 5.2 m long bodies: centres can't come closer than ~ a body length end to end
    assert!(min_gap > 3.5, "bodies interpenetrated (centres {min_gap:.2} m apart)");
    assert!(up(&w, &a) > 0.8 && up(&w, &b) > 0.8);
}

#[test]
fn a_pile_up_stays_solid() {
    let mut w = World::new();
    w.add_ground_box(2000.0);
    let def = pickup();
    // 8 cars driving at one point from all sides
    let mut cars: Vec<Truck> = (0..8)
        .map(|k| {
            let a = k as f64 * std::f64::consts::TAU / 8.0;
            let mut t = Truck::new(&mut w, &def, None);
            // heading toward the centre: game yaw 0 = −Z
            let (x, z) = (a.sin() * 35.0, -a.cos() * 35.0);
            t.place(&mut w, x, 0.0, z, (x).atan2(-z) + std::f64::consts::PI, 0.0);
            t.controls = Controls {
                throttle: 1.0,
                ..Default::default()
            };
            t
        })
        .collect();
    let mut min_gap = f64::INFINITY;
    let mut refs: Vec<&mut Truck> = cars.iter_mut().collect();
    run(&mut w, &mut refs, 8.0, |w, c| {
        for i in 0..c.len() {
            for j in i + 1..c.len() {
                let (p, q) = (c[i].position(w), c[j].position(w));
                min_gap = min_gap.min(((p[0] - q[0]).powi(2) + (p[2] - q[2]).powi(2)).sqrt());
            }
        }
    });
    let ups: Vec<f64> = cars.iter().map(|c| up(&w, c)).collect();
    let ys: Vec<f64> = cars.iter().map(|c| c.position(&w)[1]).collect();
    println!("pile-up of 8: closest centres {min_gap:.2} m, up {ups:.2?}, y {ys:.2?}");
    assert!(min_gap > 1.5, "cars passed into each other ({min_gap:.2} m)");
    assert!(
        ys.iter().all(|&y| y > -0.5 && y < 6.0),
        "a car fell through or flew off: {ys:?}"
    );
}

#[test]
fn drives_over_a_heightfield() {
    let mut w = World::new();
    // 257 × 257 samples, 2 m apart (the map's grid): rolling hills ±3 m
    let n = 257;
    let mut h = vec![0.0f32; n * n];
    for iz in 0..n {
        for ix in 0..n {
            let (x, z) = (ix as f32 * 2.0, iz as f32 * 2.0);
            h[iz * n + ix] = 3.0 * (x / 40.0).sin() * (z / 55.0).cos();
        }
    }
    w.add_heightfield(n, 2.0, [-256.0, -256.0], &h);
    let ground = |x: f64, z: f64| {
        let (fx, fz) = ((x + 256.0) / 2.0, (z + 256.0) / 2.0);
        let (ix, iz) = (fx.floor() as usize, fz.floor() as usize);
        let (tx, tz) = (fx - ix as f64, fz - iz as f64);
        let s = |i: usize, j: usize| h[j * n + i] as f64;
        let a = s(ix, iz) + (s(ix + 1, iz) - s(ix, iz)) * tx;
        let b = s(ix, iz + 1) + (s(ix + 1, iz + 1) - s(ix, iz + 1)) * tx;
        a + (b - a) * tz
    };
    let def = pickup();
    let mut t = Truck::new(&mut w, &def, None);
    t.place(&mut w, 0.0, ground(0.0, 100.0) + 0.1, 100.0, 0.0, 0.0);
    t.controls = Controls {
        throttle: 0.8,
        steer: 0.15,
        ..Default::default()
    };
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    run(&mut w, &mut [&mut t], 10.0, |w, c| {
        let p = c[0].position(w);
        let above = p[1] - ground(p[0], p[2]);
        lo = lo.min(above);
        hi = hi.max(above);
    });
    let p = t.position(&w);
    println!(
        "heightfield: body origin {lo:.2}…{hi:.2} m above the ground, end ({:.0}, {:.0}), speed {:.1}",
        p[0],
        p[2],
        speed(&w, &t)
    );
    assert!(lo > -0.3, "sank into the heightfield ({lo:.2} m)");
    assert!(hi < 2.0, "flew off the hills ({hi:.2} m)");
    assert!(speed(&w, &t) > 5.0);
}

#[test]
fn the_games_cars_load_and_drive() {
    let cars = dark_vehicle::cars();
    assert_eq!(
        cars.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["pickup", "gwagen", "zuk"]
    );
    for def in cars {
        assert!(
            def.dims.hulls.as_ref().is_some_and(|h| h.len() > 10),
            "{}: no hulls",
            def.id
        );
        let mut w = World::new();
        w.add_ground_box(2000.0);
        let mut t = Truck::new(&mut w, def, None);
        t.drivetrain.aids = dark_vehicle::spec::AidLevel::Full;
        t.offroad_assist = true;
        t.place(&mut w, 0.0, 0.0, 0.0, 0.0, 0.0);
        run(&mut w, &mut [&mut t], 1.0, |_, _| {});
        let y0 = t.position(&w)[1];
        t.controls = Controls {
            throttle: 1.0,
            ..Default::default()
        };
        run(&mut w, &mut [&mut t], 5.0, |_, _| {});
        let p = t.position(&w);
        println!(
            "{}: settled at y {y0:.3}, after 5 s full throttle z {:.1} at {:.1} m/s, up {:.3}",
            def.id,
            p[2],
            speed(&w, &t),
            up(&w, &t)
        );
        assert!(y0.abs() < 0.2, "{}: rests at y {y0:.2} (hulls in the ground?)", def.id);
        assert!(speed(&w, &t) > 12.0, "{}", def.id);
        assert!(up(&w, &t) > 0.98, "{}", def.id);
    }
}
